import type {
  OpenCodeCheckpointAdmission,
  OpenCodeCheckpointManifest,
  OpenCodeCheckpointObject,
} from '@agor/core/types';
import { TaskStatus, TERMINAL_TASK_STATUSES } from '@agor/core/types';
import { and, asc, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { isOpenCodeCheckpointManifest } from '../../types/opencode-native-state';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { opencodeCheckpointAttempts, sessions, type TaskRow, tasks } from '../schema';
import { RepositoryError } from './base';

export const MAX_OPENCODE_CLEANUP_OBJECTS = 20;
const attempts = opencodeCheckpointAttempts;

/** The admitted attempt whose Job performs cleanup. */
type CleanupHolder = Pick<
  typeof opencodeCheckpointAttempts.$inferSelect,
  'session_id' | 'task_id' | 'owner_user_id'
>;

/** Hosted OpenCode checkpoint ledger; the invariants are in context/explorations/opencode-cloud.md. */
export class OpenCodeCheckpointRepository {
  constructor(private readonly db: Database) {}

  /** Admit one executor holder for a managed OpenCode Task and hand it its input and cleanup work. */
  async begin(
    taskId: string,
    holderId: string,
    actorUserId: string
  ): Promise<OpenCodeCheckpointAdmission> {
    try {
      return await runDatabaseTransaction(
        this.db,
        async (tx) => {
          const task = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
          const session = task
            ? await select(tx).from(sessions).where(eq(sessions.session_id, task.session_id)).one()
            : undefined;
          if (
            !task ||
            !session ||
            session.agentic_tool !== 'opencode' ||
            task.created_by !== actorUserId ||
            // Only a branch-home Session's checkpoints are reachable from a collaborator's Job.
            (session.sdk_home_scope !== 'branch' && session.created_by !== actorUserId) ||
            !task.executor_connected_at ||
            (task.status !== TaskStatus.RUNNING &&
              task.status !== TaskStatus.AWAITING_PERMISSION &&
              task.status !== TaskStatus.AWAITING_INPUT)
          ) {
            throw new RepositoryError('Managed OpenCode Task is not active for this prompter');
          }

          const existing = await select(tx)
            .from(attempts)
            .where(eq(attempts.task_id, taskId))
            .one();
          if (existing) {
            if (existing.holder_instance_id !== holderId || existing.state !== 'open') {
              return { outcome: 'duplicate' } as const;
            }
            // A retried begin whose first response was lost resumes the same admission.
            const input = existing.input_task_id
              ? await select(tx)
                  .from(attempts)
                  .where(eq(attempts.task_id, existing.input_task_id))
                  .one()
              : undefined;
            return this.admitted(tx, input?.manifest ?? null, existing.input_task_id, existing);
          }

          const accepted = await select(tx)
            .from(attempts)
            .where(and(eq(attempts.session_id, session.session_id), eq(attempts.state, 'accepted')))
            .one();
          const now = new Date();
          const attempt = {
            attempt_id: generateId(),
            session_id: session.session_id,
            task_id: taskId,
            owner_user_id: actorUserId,
            holder_instance_id: holderId,
            input_task_id: accepted?.task_id ?? null,
            state: 'open' as const,
            manifest: null,
            created_at: now,
            updated_at: now,
          };
          await insert(tx, attempts).values(attempt).run();
          return this.admitted(tx, accepted?.manifest ?? null, accepted?.task_id ?? null, attempt);
        },
        { sqliteImmediate: true, sqliteBusyRetries: 9 }
      );
    } catch (error) {
      // A concurrent duplicate may win the unique task insert; report it as the loser.
      const winner = await select(this.db)
        .from(attempts)
        .where(eq(attempts.task_id, taskId))
        .one()
        .catch(() => undefined);
      if (winner && winner.holder_instance_id !== holderId) return { outcome: 'duplicate' };
      throw error;
    }
  }

  private async admitted(
    tx: Database,
    input: OpenCodeCheckpointManifest | null,
    inputTaskId: string | null,
    holder: CleanupHolder
  ): Promise<OpenCodeCheckpointAdmission> {
    if (inputTaskId && !isOpenCodeCheckpointManifest(input)) {
      // Never restart an existing conversation as empty when its record is unusable.
      throw new RepositoryError('The accepted OpenCode checkpoint record is invalid');
    }
    return {
      outcome: 'admitted',
      input,
      cleanup: (await this.cleanupCandidates(tx, holder)).map(({ sessionId, taskId }) => ({
        sessionId,
        taskId,
      })),
    };
  }

  /** Never-restorable attempts in the store the holder's Job mounts: its branch-home Session, or its own home. */
  private async cleanupCandidates(
    db: Database,
    holder: CleanupHolder,
    only?: readonly string[]
  ): Promise<Array<OpenCodeCheckpointObject & { attemptId: string }>> {
    const holderSession = await select(db, { scope: sessions.sdk_home_scope })
      .from(sessions)
      .where(eq(sessions.session_id, holder.session_id))
      .one();
    const store =
      holderSession?.scope === 'branch'
        ? eq(attempts.session_id, holder.session_id)
        : and(
            eq(attempts.owner_user_id, holder.owner_user_id),
            // A deleted Session's scope is unknown; a branch-home file of one stays until its branch home is removed.
            or(isNull(sessions.session_id), ne(sessions.sdk_home_scope, 'branch'))
          );
    const rows = await select(db, {
      attemptId: attempts.attempt_id,
      sessionId: attempts.session_id,
      taskId: attempts.task_id,
    })
      .from(attempts)
      .leftJoin(sessions, eq(sessions.session_id, attempts.session_id))
      .leftJoin(tasks, eq(tasks.task_id, attempts.task_id))
      .where(
        and(
          store,
          ne(attempts.task_id, holder.task_id),
          only ? inArray(attempts.task_id, [...only]) : undefined,
          or(
            isNull(sessions.session_id),
            eq(attempts.state, 'superseded'),
            and(
              eq(attempts.state, 'open'),
              or(isNull(tasks.task_id), inArray(tasks.status, [...TERMINAL_TASK_STATUSES]))
            )
          )
        )
      )
      .orderBy(asc(attempts.created_at))
      .limit(only ? only.length : MAX_OPENCODE_CLEANUP_OBJECTS)
      .all();
    return rows;
  }

  /** Forget attempts whose files the admitted executor removed; rechecks eligibility first. */
  async acknowledgeCleanup(
    taskId: string,
    holderId: string,
    deleted: readonly OpenCodeCheckpointObject[]
  ): Promise<void> {
    if (deleted.length === 0) return;
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        const holder = await select(tx).from(attempts).where(eq(attempts.task_id, taskId)).one();
        if (!holder || holder.holder_instance_id !== holderId || holder.state !== 'open') {
          throw new RepositoryError('OpenCode checkpoint cleanup requires the admitted holder');
        }
        const eligible = await this.cleanupCandidates(
          tx,
          holder,
          deleted.map((object) => object.taskId)
        );
        const confirmed = eligible.filter((row) =>
          deleted.some(
            (object) => object.taskId === row.taskId && object.sessionId === row.sessionId
          )
        );
        if (confirmed.length === 0) return;
        await deleteFrom(tx, attempts)
          .where(
            inArray(
              attempts.attempt_id,
              confirmed.map((row) => row.attemptId)
            )
          )
          .run();
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }
}

/** Accept a sealed checkpoint inside the executor's locked, non-terminal completion transaction. */
export async function acceptOpenCodeCheckpoint(
  tx: Database,
  db: Database,
  task: TaskRow,
  holderId: string,
  manifest: unknown
): Promise<void> {
  if (!isOpenCodeCheckpointManifest(manifest) || manifest.taskId !== task.task_id) {
    throw new RepositoryError('OpenCode checkpoint manifest does not describe this Task');
  }
  await lockRowForUpdate(tx, db, attempts, eq(attempts.task_id, task.task_id));
  const attempt = await select(tx).from(attempts).where(eq(attempts.task_id, task.task_id)).one();
  if (!attempt || attempt.holder_instance_id !== holderId || attempt.state !== 'open') {
    throw new RepositoryError('OpenCode checkpoint holder is not admitted for this Task');
  }
  const acceptedWhere = and(
    eq(attempts.session_id, attempt.session_id),
    eq(attempts.state, 'accepted')
  ) as SQL;
  await lockRowForUpdate(tx, db, attempts, acceptedWhere);
  const accepted = await select(tx).from(attempts).where(acceptedWhere).one();
  if ((accepted?.task_id ?? null) !== attempt.input_task_id) {
    throw new RepositoryError('OpenCode checkpoint input is no longer the accepted checkpoint');
  }
  if (accepted?.manifest && accepted.manifest.openCodeSessionId !== manifest.openCodeSessionId) {
    throw new RepositoryError('OpenCode checkpoint continues a different native session');
  }
  const now = new Date();
  if (accepted) {
    await update(tx, attempts)
      .set({ state: 'superseded', updated_at: now })
      .where(eq(attempts.attempt_id, accepted.attempt_id))
      .run();
  }
  await update(tx, attempts)
    .set({ state: 'accepted', manifest, updated_at: now })
    .where(eq(attempts.attempt_id, attempt.attempt_id))
    .run();
}

/** A hosted OpenCode Task that began a checkpoint must complete with it. */
export async function assertNoOpenOpenCodeCheckpoint(tx: Database, taskId: string): Promise<void> {
  const open = await select(tx, { attempt_id: attempts.attempt_id })
    .from(attempts)
    .where(and(eq(attempts.task_id, taskId), eq(attempts.state, 'open')))
    .one();
  if (open) throw new RepositoryError('Hosted OpenCode completion requires its sealed checkpoint');
}
