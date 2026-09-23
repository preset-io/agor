import type {
  OpenCodeCheckpointAdmission,
  OpenCodeCheckpointAttempt,
  OpenCodeCheckpointBinding,
  OpenCodeCheckpointCleanupWork,
  OpenCodeCheckpointDeleteResult,
  OpenCodeCleanupCursor,
  OpenCodeNativeStateAttempt,
} from '@agor/core/types';
import { isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { isCoordinatedOpenCodeNativeStateAttempt } from '../../types/opencode-native-state.js';
import { lockSessionBranchForAdmission } from '../branch-admission';
import type { Database } from '../client';
import {
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { opencodeCheckpointAttempts, sessions, tasks } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { EntityNotFoundError, RepositoryError } from './base';
import type { TaskRuntimeAuthorityScope } from './tasks';

type AttemptRow = typeof opencodeCheckpointAttempts.$inferSelect;

function tenantId(): string {
  return getCurrentTenantId() ?? 'default';
}

function iso(value: Date | string | null): string | null {
  return value == null ? null : value instanceof Date ? value.toISOString() : value;
}

function expose(row: AttemptRow): OpenCodeCheckpointAttempt {
  return {
    ...row,
    binding: row.binding as OpenCodeCheckpointBinding,
    sealed_manifest: row.sealed_manifest as OpenCodeNativeStateAttempt | null,
    input_read_closed_at: iso(row.input_read_closed_at),
    retired_at: iso(row.retired_at),
    delete_observed_at: iso(row.delete_observed_at),
    delete_retry_at: iso(row.delete_retry_at),
    holder_closed_observed_at: iso(row.holder_closed_observed_at),
    holder_observation_retry_at: iso(row.holder_observation_retry_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

const CLEANUP_LANES = ['retire', 'retry_delete', 'observe', 'recheck_absent'] as const;
const MAX_IDENTITIES_PER_LANE = 8;
const MAX_CLEANUP_BACKOFF_MS = 24 * 60 * 60 * 1_000;

function nextLane(lane: OpenCodeCleanupCursor['nextLane']): OpenCodeCleanupCursor['nextLane'] {
  return CLEANUP_LANES[(CLEANUP_LANES.indexOf(lane) + 1) % CLEANUP_LANES.length];
}

function emptyCleanupCursor(): OpenCodeCleanupCursor {
  return {
    version: 1,
    nextLane: 'retire',
    lanes: {
      retire: { cursorAttemptNo: 0, roundHighWatermark: 0 },
      retry_delete: { cursorAttemptNo: 0, roundHighWatermark: 0 },
      observe: { cursorAttemptNo: 0, roundHighWatermark: 0 },
      recheck_absent: { cursorAttemptNo: 0, roundHighWatermark: 0 },
    },
  };
}

function readCleanupCursor(value: unknown): OpenCodeCleanupCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCleanupCursor();
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    !CLEANUP_LANES.includes(source.nextLane as never) ||
    !source.lanes ||
    typeof source.lanes !== 'object' ||
    Array.isArray(source.lanes)
  ) {
    return emptyCleanupCursor();
  }
  const lanes = source.lanes as Record<string, unknown>;
  const result = emptyCleanupCursor();
  result.nextLane = source.nextLane as OpenCodeCleanupCursor['nextLane'];
  for (const lane of CLEANUP_LANES) {
    const entry = lanes[lane];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return emptyCleanupCursor();
    const pair = entry as Record<string, unknown>;
    if (
      ![pair.cursorAttemptNo, pair.roundHighWatermark].every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
      )
    )
      return emptyCleanupCursor();
    result.lanes[lane] = {
      cursorAttemptNo: pair.cursorAttemptNo as number,
      roundHighWatermark: pair.roundHighWatermark as number,
    };
  }
  return result;
}

function retryAt(now: Date, failures: number): Date {
  return new Date(
    now.getTime() + Math.min(MAX_CLEANUP_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 16))
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function exactManifest(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Coordinates managed OpenCode read pins, output ownership, and permanent
 * retirement. Every method is a short DB-only unit; filesystem/Cloud work is
 * deliberately owned by callers after these transactions commit.
 */
export class OpenCodeCheckpointAttemptRepository {
  constructor(private readonly db: Database) {}

  async begin(input: {
    taskId: string;
    holderInstanceId: string;
    binding: OpenCodeCheckpointBinding;
    storeId?: string;
    authority?: TaskRuntimeAuthorityScope;
    assertRuntimeAuthority?: (
      tx: Database,
      taskId: string,
      authority: TaskRuntimeAuthorityScope
    ) => Promise<void>;
    now?: Date;
  }): Promise<OpenCodeCheckpointAdmission> {
    const tenant = tenantId();
    if (!input.holderInstanceId || input.binding.holderInstanceId !== input.holderInstanceId) {
      throw new RepositoryError('OpenCode holder identity does not match its immutable binding');
    }
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, input.taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', input.taskId);

    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, input.taskId));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, input.taskId)).one();
        if (!task || task.session_id !== session.session_id)
          throw new EntityNotFoundError('Task', input.taskId);
        if (input.authority && input.assertRuntimeAuthority) {
          await input.assertRuntimeAuthority(tx, task.task_id, input.authority);
        }
        const current = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.task_id, input.taskId)
            )
          )
          .one();
        const taskIsActive =
          task.data.managed_opencode_protocol === 3 &&
          session.agentic_tool === 'opencode' &&
          session.sdk_home_scope === 'execution_home' &&
          !isTerminalTaskStatus(task.status) &&
          task.created_by === session.created_by &&
          !!task.executor_connected_at &&
          [TaskStatus.RUNNING, TaskStatus.AWAITING_INPUT, TaskStatus.AWAITING_PERMISSION].includes(
            task.status as never
          );
        if (current) {
          if (
            !taskIsActive ||
            current.retired_at ||
            current.write_state !== 'open' ||
            current.holder_instance_id !== input.holderInstanceId ||
            !exactManifest(current.binding, input.binding)
          ) {
            return { outcome: 'rejected', code: 'already_admitted' } as const;
          }
          const pinnedInput = current.input_task_id
            ? await select(tx)
                .from(opencodeCheckpointAttempts)
                .where(
                  and(
                    eq(opencodeCheckpointAttempts.tenant_id, tenant),
                    eq(opencodeCheckpointAttempts.session_id, session.session_id),
                    eq(opencodeCheckpointAttempts.store_id, current.input_store_id!),
                    eq(opencodeCheckpointAttempts.task_id, current.input_task_id)
                  )
                )
                .one()
            : null;
          const pinnedManifest = pinnedInput?.sealed_manifest as OpenCodeNativeStateAttempt | null;
          if (
            current.input_task_id &&
            (!pinnedInput ||
              pinnedInput.retired_at ||
              pinnedInput.write_state !== 'sealed' ||
              !isCoordinatedOpenCodeNativeStateAttempt(pinnedManifest) ||
              pinnedManifest.attemptTaskId !== current.input_task_id ||
              pinnedManifest.storeId !== current.input_store_id)
          )
            throw new RepositoryError(
              'OpenCode admission input pin no longer resolves to its sealed object'
            );
          return {
            outcome: 'admitted',
            attempt: expose(current),
            input: pinnedManifest,
          } as const;
        }
        const pointer = session.data.sdk_native_state;
        if (pointer !== undefined && !isCoordinatedOpenCodeNativeStateAttempt(pointer)) {
          return { outcome: 'rejected', code: 'legacy_state' } as const;
        }
        if (!taskIsActive) {
          return { outcome: 'rejected', code: 'task_not_active' } as const;
        }
        const storeId =
          session.data.sdk_native_state_store_id ??
          pointer?.storeId ??
          input.storeId ??
          generateId();
        if (pointer && pointer.storeId !== storeId)
          throw new RepositoryError('Accepted OpenCode state does not match the immutable store');
        if (
          session.data.sdk_native_state_store_id &&
          input.storeId &&
          session.data.sdk_native_state_store_id !== input.storeId
        ) {
          throw new RepositoryError('OpenCode checkpoint store identity is immutable');
        }
        if (
          input.binding.tenantId !== tenant ||
          input.binding.sessionId !== session.session_id ||
          input.binding.taskId !== task.task_id ||
          input.binding.storeId !== storeId ||
          input.binding.ownerUserId !== session.created_by ||
          input.binding.protocol !== 3
        ) {
          throw new RepositoryError(
            'OpenCode checkpoint binding does not match the locked Task and Session'
          );
        }
        const attemptNo = await select(tx, {
          value: sql<number>`COALESCE(MAX(${opencodeCheckpointAttempts.attempt_no}), 0) + 1`,
        })
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, session.session_id)
            )
          )
          .one();
        if (!attemptNo || !Number.isSafeInteger(attemptNo.value) || attemptNo.value < 1) {
          throw new RepositoryError('OpenCode attempt sequence is unavailable');
        }
        let inputAttempt: AttemptRow | null = null;
        if (pointer) {
          inputAttempt = await select(tx)
            .from(opencodeCheckpointAttempts)
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id),
                eq(opencodeCheckpointAttempts.store_id, pointer.storeId),
                eq(opencodeCheckpointAttempts.task_id, pointer.attemptTaskId)
              )
            )
            .one();
          if (
            !inputAttempt ||
            inputAttempt.retired_at ||
            inputAttempt.write_state !== 'sealed' ||
            !exactManifest(inputAttempt.sealed_manifest, pointer)
          ) {
            throw new RepositoryError(
              'Accepted OpenCode checkpoint has no matching sealed live ledger row'
            );
          }
        }
        const now = input.now ?? new Date();
        const row = await insert(tx, opencodeCheckpointAttempts)
          .values({
            tenant_id: tenant,
            attempt_id: generateId(),
            owner_user_id: session.created_by,
            session_id: session.session_id,
            task_id: task.task_id,
            store_id: storeId,
            attempt_no: attemptNo.value,
            holder_instance_id: input.holderInstanceId,
            binding: input.binding,
            input_store_id: inputAttempt?.store_id ?? null,
            input_task_id: inputAttempt?.task_id ?? null,
            write_state: 'open',
            created_at: now,
            updated_at: now,
          })
          .returning()
          .one();
        if (session.data.sdk_native_state_store_id !== storeId) {
          await update(tx, sessions)
            .set({
              data: { ...session.data, sdk_native_state_store_id: storeId },
              updated_at: now,
            })
            .where(eq(sessions.session_id, session.session_id))
            .run();
        }
        return {
          outcome: 'admitted',
          attempt: expose(row),
          input: pointer ?? null,
        } as const;
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  async closeRead(
    taskId: string,
    holderId: string,
    expectedInput: { storeId: string; taskId: string },
    now = new Date()
  ): Promise<void> {
    await this.mutateAttempt(taskId, holderId, async (tx, row) => {
      if (row.retired_at)
        throw new RepositoryError('Retired OpenCode input cannot be reopened or changed');
      if (
        row.input_task_id !== expectedInput.taskId ||
        row.input_store_id !== expectedInput.storeId
      ) {
        throw new RepositoryError('OpenCode read close does not match the granted input');
      }
      if (row.input_read_closed_at) return;
      await update(tx, opencodeCheckpointAttempts)
        .set({ input_read_closed_at: now, updated_at: now })
        .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
        .run();
    });
  }

  async seal(
    taskId: string,
    holderId: string,
    manifest: OpenCodeNativeStateAttempt,
    now = new Date()
  ): Promise<void> {
    if (!isCoordinatedOpenCodeNativeStateAttempt(manifest))
      throw new RepositoryError('Only v3 OpenCode state can be sealed');
    await this.mutateAttempt(taskId, holderId, async (tx, row, task) => {
      if (
        row.retired_at ||
        row.write_state === 'abandoned' ||
        manifest.attemptTaskId !== row.task_id ||
        manifest.storeId !== row.store_id
      ) {
        throw new RepositoryError(
          'OpenCode output is retired, abandoned, or bound to another object'
        );
      }
      if (
        isTerminalTaskStatus(task.status) ||
        task.status === TaskStatus.STOPPING ||
        !task.executor_connected_at
      ) {
        throw new RepositoryError('OpenCode output cannot seal after Task termination or Stop');
      }
      if (row.input_task_id && !row.input_read_closed_at) {
        throw new RepositoryError(
          'OpenCode output cannot seal while its granted input remains pinned'
        );
      }
      if (row.write_state === 'sealed') {
        if (!exactManifest(row.sealed_manifest, manifest))
          throw new RepositoryError('OpenCode seal retry changed its manifest');
        return;
      }
      await update(tx, opencodeCheckpointAttempts)
        .set({ write_state: 'sealed', sealed_manifest: manifest, updated_at: now })
        .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
        .run();
    });
  }

  async abandon(taskId: string, holderId: string, now = new Date()): Promise<void> {
    await this.mutateAttempt(taskId, holderId, async (tx, row) => {
      if (row.retired_at) throw new RepositoryError('Retired OpenCode output cannot be changed');
      if (row.input_task_id && !row.input_read_closed_at) {
        throw new RepositoryError('OpenCode input must be closed before abandoning its output');
      }
      if (row.write_state === 'open') {
        await update(tx, opencodeCheckpointAttempts)
          .set({ write_state: 'abandoned', updated_at: now })
          .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
          .run();
      }
    });
  }

  /**
   * Reserve at most one cleanup operation, persisting lane progress and the
   * retirement tombstone before any caller can touch the filesystem. Every
   * lane scans a finite high-watermark and rotates after at most eight rows.
   */
  async prepareCleanup(
    taskId: string,
    holderId: string,
    now = new Date()
  ): Promise<OpenCodeCheckpointCleanupWork> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', taskId);
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, taskId));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
        if (!task || task.session_id !== session.session_id)
          throw new EntityNotFoundError('Task', taskId);
        const owner = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.task_id, taskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
            )
          )
          .one();
        if (
          !owner ||
          owner.retired_at ||
          task.data.managed_opencode_protocol !== 3 ||
          !task.executor_connected_at ||
          isTerminalTaskStatus(task.status)
        ) {
          throw new RepositoryError(
            'Cleanup reservation requires the active admitted OpenCode holder'
          );
        }
        const state = session.data as Record<string, unknown>;
        // Legacy/uncertain state disables reclamation as well as new admission.
        const pointer = state.sdk_native_state;
        if (pointer !== undefined && !isCoordinatedOpenCodeNativeStateAttempt(pointer)) {
          return { kind: 'none' };
        }
        const maxRow = await select(tx, {
          value: sql<number>`COALESCE(MAX(${opencodeCheckpointAttempts.attempt_no}), 0)`,
        })
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, session.session_id)
            )
          )
          .one();
        const maximum = Number(maxRow?.value ?? 0);
        const cursor = readCleanupCursor(state.opencode_cleanup_cursor);
        let lane = cursor.nextLane;
        const readPage = async (selectedLane: typeof lane, pageCursor: number, high: number) =>
          select(tx)
            .from(opencodeCheckpointAttempts)
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id),
                sql`${opencodeCheckpointAttempts.attempt_no} > ${pageCursor}`,
                sql`${opencodeCheckpointAttempts.attempt_no} <= ${high}`,
                selectedLane === 'retire'
                  ? isNull(opencodeCheckpointAttempts.retired_at)
                  : selectedLane === 'retry_delete'
                    ? and(
                        sql`${opencodeCheckpointAttempts.retired_at} IS NOT NULL`,
                        isNull(opencodeCheckpointAttempts.delete_observed_at)
                      )
                    : selectedLane === 'recheck_absent'
                      ? sql`${opencodeCheckpointAttempts.retired_at} IS NOT NULL AND ${opencodeCheckpointAttempts.delete_observed_at} IS NOT NULL`
                      : sql`(${opencodeCheckpointAttempts.write_state} = 'open' OR (${opencodeCheckpointAttempts.input_task_id} IS NOT NULL AND ${opencodeCheckpointAttempts.input_read_closed_at} IS NULL))`,
                selectedLane === 'retry_delete'
                  ? or(
                      isNull(opencodeCheckpointAttempts.delete_retry_at),
                      lte(opencodeCheckpointAttempts.delete_retry_at, now)
                    )
                  : undefined,
                selectedLane === 'recheck_absent'
                  ? and(
                      isNotNull(opencodeCheckpointAttempts.delete_retry_at),
                      lte(opencodeCheckpointAttempts.delete_retry_at, now)
                    )
                  : undefined,
                selectedLane === 'observe'
                  ? and(
                      isNull(opencodeCheckpointAttempts.holder_closed_observed_at),
                      or(
                        isNull(opencodeCheckpointAttempts.holder_observation_retry_at),
                        lte(opencodeCheckpointAttempts.holder_observation_retry_at, now)
                      )
                    )
                  : undefined
              )
            )
            .orderBy(asc(opencodeCheckpointAttempts.attempt_no))
            .limit(MAX_IDENTITIES_PER_LANE)
            .all();

        for (let laneOffset = 0; laneOffset < CLEANUP_LANES.length; laneOffset += 1) {
          let laneState = cursor.lanes[lane];
          if (
            laneState.roundHighWatermark === 0 ||
            laneState.cursorAttemptNo >= laneState.roundHighWatermark
          ) {
            laneState = { cursorAttemptNo: 0, roundHighWatermark: maximum };
            cursor.lanes[lane] = laneState;
          }
          if (laneState.roundHighWatermark === 0) {
            lane = nextLane(lane);
            continue;
          }
          const page = await readPage(
            lane,
            laneState.cursorAttemptNo,
            laneState.roundHighWatermark
          );
          for (const candidate of page) {
            laneState.cursorAttemptNo = candidate.attempt_no;
            if (lane === 'retry_delete' || lane === 'recheck_absent') {
              if (
                pointer &&
                pointer.storeId === candidate.store_id &&
                pointer.attemptTaskId === candidate.task_id
              ) {
                throw new RepositoryError(
                  'A tombstone unexpectedly names the currently accepted checkpoint'
                );
              }
              if (candidate.store_id !== state.sdk_native_state_store_id) continue;
              await this.lockAttempt(tx, candidate);
              cursor.nextLane = nextLane(lane);
              await this.saveCleanupCursor(tx, session, cursor, now);
              return {
                kind: 'delete',
                object: { storeId: candidate.store_id, taskId: candidate.task_id },
              };
            }
            const candidateTask = await select(tx)
              .from(tasks)
              .where(eq(tasks.task_id, candidate.task_id))
              .one();
            if (
              !candidateTask ||
              candidate.owner_user_id !== session.created_by ||
              candidate.store_id !== state.sdk_native_state_store_id ||
              candidate.binding.sessionId !== session.session_id ||
              candidate.binding.tenantId !== tenant ||
              candidate.binding.ownerUserId !== candidate.owner_user_id ||
              candidate.binding.taskId !== candidate.task_id ||
              candidate.binding.storeId !== candidate.store_id ||
              candidate.binding.holderInstanceId !== candidate.holder_instance_id
            ) {
              continue;
            }
            if (lane === 'observe') {
              if (
                !isTerminalTaskStatus(candidateTask.status) ||
                candidate.holder_closed_observed_at
              )
                continue;
              await this.lockAttempt(tx, candidate);
              const retry = retryAt(now, candidate.holder_observation_failure_count);
              await update(tx, opencodeCheckpointAttempts)
                .set({
                  holder_observation_retry_at: retry,
                  updated_at: now,
                })
                .where(eq(opencodeCheckpointAttempts.attempt_id, candidate.attempt_id))
                .run();
              cursor.nextLane = nextLane(lane);
              await this.saveCleanupCursor(tx, session, cursor, now);
              return { kind: 'observe', attemptId: candidate.attempt_id };
            }
            const sealed =
              candidate.write_state === 'sealed' &&
              isCoordinatedOpenCodeNativeStateAttempt(candidate.sealed_manifest) &&
              candidate.sealed_manifest.storeId === candidate.store_id &&
              candidate.sealed_manifest.attemptTaskId === candidate.task_id;
            if (
              lane !== 'retire' ||
              !isTerminalTaskStatus(candidateTask.status) ||
              (candidate.write_state !== 'sealed' && candidate.write_state !== 'abandoned') ||
              (candidate.write_state === 'sealed' && !sealed) ||
              (candidate.input_task_id !== null && candidate.input_read_closed_at === null) ||
              (pointer &&
                pointer.storeId === candidate.store_id &&
                pointer.attemptTaskId === candidate.task_id)
            ) {
              continue;
            }
            const openReader = await select(tx, {
              attempt_id: opencodeCheckpointAttempts.attempt_id,
            })
              .from(opencodeCheckpointAttempts)
              .where(
                and(
                  eq(opencodeCheckpointAttempts.tenant_id, tenant),
                  eq(opencodeCheckpointAttempts.session_id, session.session_id),
                  eq(opencodeCheckpointAttempts.input_store_id, candidate.store_id),
                  eq(opencodeCheckpointAttempts.input_task_id, candidate.task_id),
                  isNull(opencodeCheckpointAttempts.input_read_closed_at)
                )
              )
              .limit(1)
              .one();
            if (openReader) continue;
            await this.lockAttempt(tx, candidate);
            const lockedCandidate = await select(tx)
              .from(opencodeCheckpointAttempts)
              .where(eq(opencodeCheckpointAttempts.attempt_id, candidate.attempt_id))
              .one();
            if (!lockedCandidate || lockedCandidate.retired_at) continue;
            await update(tx, opencodeCheckpointAttempts)
              .set({ retired_at: now, updated_at: now })
              .where(
                and(
                  eq(opencodeCheckpointAttempts.attempt_id, candidate.attempt_id),
                  isNull(opencodeCheckpointAttempts.retired_at)
                )
              )
              .run();
            cursor.nextLane = nextLane(lane);
            await this.saveCleanupCursor(tx, session, cursor, now);
            return {
              kind: 'delete',
              object: { storeId: candidate.store_id, taskId: candidate.task_id },
            };
          }
          if (page.length < MAX_IDENTITIES_PER_LANE)
            laneState.cursorAttemptNo = laneState.roundHighWatermark;
          lane = nextLane(lane);
        }
        cursor.nextLane = lane;
        await this.saveCleanupCursor(tx, session, cursor, now);
        return { kind: 'none' };
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Load only the immutable persisted locator for this exact due observation. */
  async loadObservationBinding(
    taskId: string,
    holderId: string,
    attemptId: string
  ): Promise<OpenCodeCheckpointBinding> {
    const tenant = tenantId();
    const current = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!current) throw new EntityNotFoundError('Task', taskId);
    const work = await select(this.db)
      .from(opencodeCheckpointAttempts)
      .where(
        and(
          eq(opencodeCheckpointAttempts.tenant_id, tenant),
          eq(opencodeCheckpointAttempts.session_id, current.session_id),
          eq(opencodeCheckpointAttempts.attempt_id, attemptId)
        )
      )
      .one();
    const owner = await select(this.db)
      .from(opencodeCheckpointAttempts)
      .where(
        and(
          eq(opencodeCheckpointAttempts.tenant_id, tenant),
          eq(opencodeCheckpointAttempts.session_id, current.session_id),
          eq(opencodeCheckpointAttempts.task_id, taskId),
          eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
        )
      )
      .one();
    if (
      !work ||
      !owner ||
      owner.retired_at ||
      work.holder_closed_observed_at ||
      (work.write_state !== 'open' && (!work.input_task_id || work.input_read_closed_at))
    ) {
      throw new RepositoryError('OpenCode observation identity is no longer eligible');
    }
    return work.binding as OpenCodeCheckpointBinding;
  }

  /** Persist Cloud's exact-container observation and recover only that holder's open I/O phases. */
  async recordHolderObservation(
    currentTaskId: string,
    currentHolderId: string,
    attemptId: string,
    outcome: 'verified_closed' | 'still_present' | 'unknown',
    errorCode?: string,
    now = new Date()
  ): Promise<void> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, currentTaskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', currentTaskId);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        const current = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.task_id, currentTaskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, currentHolderId)
            )
          )
          .one();
        const target = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.attempt_id, attemptId)
            )
          )
          .one();
        if (!current || current.retired_at || !target || target.holder_closed_observed_at) return;
        const taskIds = [...new Set([currentTaskId, target.task_id])].sort();
        for (const id of taskIds) await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, id));
        const targetTask = await select(tx)
          .from(tasks)
          .where(eq(tasks.task_id, target.task_id))
          .one();
        const caller = await select(tx).from(tasks).where(eq(tasks.task_id, currentTaskId)).one();
        if (
          !targetTask ||
          !caller ||
          !isTerminalTaskStatus(targetTask.status) ||
          target.binding.holderInstanceId !== target.holder_instance_id ||
          target.binding.taskId !== target.task_id ||
          target.binding.sessionId !== route.session_id
        )
          return;
        const attemptIds = [...new Set([current.attempt_id, target.attempt_id])].sort();
        for (const id of attemptIds)
          await lockRowForUpdate(
            tx,
            this.db,
            opencodeCheckpointAttempts,
            eq(opencodeCheckpointAttempts.attempt_id, id)
          );
        const lockedTarget = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, target.attempt_id))
          .one();
        if (!lockedTarget || lockedTarget.holder_closed_observed_at) return;
        if (outcome === 'verified_closed') {
          await update(tx, opencodeCheckpointAttempts)
            .set({
              holder_closed_observed_at: now,
              holder_observation_retry_at: null,
              holder_observation_last_error: null,
              ...(lockedTarget.input_task_id && !lockedTarget.input_read_closed_at
                ? { input_read_closed_at: now }
                : {}),
              ...(lockedTarget.write_state === 'open' ? { write_state: 'abandoned' as const } : {}),
              updated_at: now,
            })
            .where(eq(opencodeCheckpointAttempts.attempt_id, lockedTarget.attempt_id))
            .run();
          return;
        }
        const failures = lockedTarget.holder_observation_failure_count + 1;
        await update(tx, opencodeCheckpointAttempts)
          .set({
            holder_observation_failure_count: failures,
            holder_observation_retry_at: retryAt(now, failures),
            holder_observation_last_error: (errorCode ?? outcome).slice(0, 96),
            updated_at: now,
          })
          .where(eq(opencodeCheckpointAttempts.attempt_id, lockedTarget.attempt_id))
          .run();
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Record one deletion outcome for an exact permanent tombstone. */
  async acknowledgeDelete(
    taskId: string,
    holderId: string,
    object: { storeId: string; taskId: string },
    result: OpenCodeCheckpointDeleteResult,
    now = new Date()
  ): Promise<void> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', taskId);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, taskId));
        const caller = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
        const current = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.task_id, taskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
            )
          )
          .one();
        const target = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.store_id, object.storeId),
              eq(opencodeCheckpointAttempts.task_id, object.taskId)
            )
          )
          .one();
        if (!caller || !current || current.retired_at || !target || !target.retired_at) {
          throw new RepositoryError(
            'Deletion acknowledgement requires an active holder and exact tombstone'
          );
        }
        if (
          session.data.sdk_native_state?.storeId === object.storeId &&
          session.data.sdk_native_state?.attemptTaskId === object.taskId
        ) {
          throw new RepositoryError('Accepted OpenCode state cannot be deleted');
        }
        await this.lockAttempt(tx, target);
        const lockedTarget = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, target.attempt_id))
          .one();
        if (!lockedTarget?.retired_at)
          throw new RepositoryError('OpenCode tombstone changed before acknowledgement');
        if (result.outcome === 'deleted') {
          await update(tx, opencodeCheckpointAttempts)
            .set({
              delete_observed_at: now,
              delete_retry_at: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
              delete_last_error: null,
              updated_at: now,
            })
            .where(eq(opencodeCheckpointAttempts.attempt_id, lockedTarget.attempt_id))
            .run();
        } else {
          const failures = lockedTarget.delete_failure_count + 1;
          await update(tx, opencodeCheckpointAttempts)
            .set({
              delete_failure_count: failures,
              delete_retry_at: retryAt(now, failures),
              delete_last_error: result.errorCode.slice(0, 96),
              updated_at: now,
            })
            .where(eq(opencodeCheckpointAttempts.attempt_id, lockedTarget.attempt_id))
            .run();
        }
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  private async lockAttempt(tx: Database, row: AttemptRow): Promise<void> {
    await lockRowForUpdate(
      tx,
      this.db,
      opencodeCheckpointAttempts,
      eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id)
    );
  }

  private async saveCleanupCursor(
    tx: Database,
    session: typeof sessions.$inferSelect,
    cursor: OpenCodeCleanupCursor,
    now: Date
  ): Promise<void> {
    await update(tx, sessions)
      .set({
        data: { ...session.data, opencode_cleanup_cursor: cursor } as typeof session.data,
        updated_at: now,
      })
      .where(eq(sessions.session_id, session.session_id))
      .run();
  }

  private async mutateAttempt(
    taskId: string,
    holderId: string,
    mutation: (tx: Database, row: AttemptRow, task: typeof tasks.$inferSelect) => Promise<void>
  ): Promise<void> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', taskId);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, taskId));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
        if (!task || task.session_id !== route.session_id)
          throw new EntityNotFoundError('Task', taskId);
        const row = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.task_id, taskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
            )
          )
          .one();
        if (!row) throw new RepositoryError('OpenCode holder is not admitted for this Task');
        await lockRowForUpdate(
          tx,
          this.db,
          opencodeCheckpointAttempts,
          eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id)
        );
        await mutation(tx, row, task);
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }
}
