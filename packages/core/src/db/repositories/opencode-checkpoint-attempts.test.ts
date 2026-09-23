import type { UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { select, update } from '../database-wrapper';
import { opencodeCheckpointAttempts, sessions, tasks as taskRows } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { dbTest, ensureTestUser } from '../test-helpers';
import { BranchMaintenanceRepository } from './branch-maintenance';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointAttemptRepository } from './opencode-checkpoint-attempts';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

let branchCounter = 20_000;

async function newTask(db: Database) {
  const ownerId = generateId() as UUID;
  await ensureTestUser(db, ownerId);
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `checkpoint-${generateId()}`,
    name: 'Checkpoint test',
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'checkpoint',
    ref: 'main',
    branch_unique_id: branchCounter++,
    path: '/tmp/checkpoint',
    created_by: ownerId,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'opencode',
    created_by: ownerId,
  });
  const tasks = new TaskRepository(db);
  const created = await tasks.create({
    task_id: generateId(),
    session_id: session.session_id,
    created_by: ownerId,
    full_prompt: 'continue',
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
  });
  const connected = await tasks.connectExecutor(created.task_id);
  if (!connected) throw new Error('Task connection failed');
  await tasks.stampManagedOpenCodeProtocol(created.task_id);
  return { ownerId, sessionId: session.session_id, task: connected.task };
}

function binding(
  sessionId: string,
  taskId: string,
  storeId: string,
  holderId: string,
  ownerId: string
) {
  return {
    protocol: 3 as const,
    tenantId: 'default',
    ownerUserId: ownerId,
    sessionId,
    taskId,
    storeId,
    holderInstanceId: holderId,
    locator: {
      runId: generateId(),
      cellId: generateId(),
      tenantId: 'default',
      ownerRuntimeUserId: ownerId,
      sessionId,
      taskId,
      storeId,
      holderInstanceId: holderId,
      namespace: 'tenant-ns',
      jobName: 'executor-job',
      jobUid: generateId(),
      podName: 'executor-pod',
      podUid: generateId(),
      containerName: 'executor' as const,
      containerId: `containerd://${generateId()}`,
      restartCount: 0 as const,
      imageIdentity: `registry.example/agor/executor@sha256:${'c'.repeat(64)}`,
    },
  };
}

function manifest(taskId: string, storeId: string) {
  return {
    version: 3 as const,
    storeId,
    openCodeVersion: '1.18.31',
    attemptTaskId: taskId,
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 4096,
    openCodeSessionId: 'ses_checkpoint',
    publishedAt: new Date().toISOString(),
  };
}

describe('OpenCodeCheckpointAttemptRepository', () => {
  dbTest(
    'serializes concurrent distinct holders before either receives a grant',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const repoA = new OpenCodeCheckpointAttemptRepository(db);
      const repoB = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderA = generateId();
      const holderB = generateId();
      const results = await Promise.all([
        repoA.begin({
          taskId: task.task_id,
          holderInstanceId: holderA,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, holderA, ownerId),
        }),
        repoB.begin({
          taskId: task.task_id,
          holderInstanceId: holderB,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, holderB, ownerId),
        }),
      ]);

      expect(results.filter((result) => result.outcome === 'admitted')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual([
        { outcome: 'rejected', code: 'already_admitted' },
      ]);
      const admitted = results.find((result) => result.outcome === 'admitted');
      if (admitted?.outcome !== 'admitted') throw new Error('no holder was admitted');
      expect([holderA, holderB]).toContain(admitted.attempt.holder_instance_id);
    }
  );

  dbTest(
    'commits one exact holder, pins only accepted input, and seals idempotently',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const repo = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const immutableBinding = binding(sessionId, task.task_id, storeId, holderId, ownerId);
      const grant = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        binding: immutableBinding,
        storeId,
      });
      expect(grant.outcome).toBe('admitted');
      if (grant.outcome !== 'admitted') throw new Error('Admission was not granted');
      expect(grant.input).toBeNull();
      expect(grant.attempt).toMatchObject({
        task_id: task.task_id,
        session_id: sessionId,
        store_id: storeId,
        holder_instance_id: holderId,
        attempt_no: 1,
        write_state: 'open',
        retired_at: null,
      });
      await expect(new SessionRepository(db).delete(sessionId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );

      const repeated = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        binding: immutableBinding,
        storeId,
      });
      expect(repeated.outcome).toBe('admitted');
      const loserHolder = generateId();
      const duplicate = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: loserHolder,
        binding: binding(sessionId, task.task_id, storeId, loserHolder, ownerId),
        storeId,
      });
      expect(duplicate).toMatchObject({ outcome: 'rejected', code: 'already_admitted' });

      const published = manifest(task.task_id, storeId);
      await repo.seal(task.task_id, holderId, published);
      await expect(repo.seal(task.task_id, holderId, published)).resolves.toBeUndefined();
      await expect(
        repo.seal(task.task_id, holderId, { ...published, bytes: 8192 })
      ).rejects.toThrow(/changed its manifest/);
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          binding: immutableBinding,
          storeId,
        })
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'already_admitted' });
      const saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .one();
      expect(saved?.write_state).toBe('sealed');
      expect(saved?.sealed_manifest).toEqual(published);

      // Generic Session writes must not erase the store identity established by
      // the grant, even though it is intentionally absent from the public DTO.
      const before = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(before?.data.sdk_native_state_store_id).toBe(storeId);
      await new SessionRepository(db).update(sessionId, { title: 'metadata only' });
      const after = await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one();
      expect(after?.data.sdk_native_state_store_id).toBe(storeId);

      await update(db, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, task.task_id))
        .run();
      const session = await select(db, { branch_id: sessions.branch_id })
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!session) throw new Error('Session missing');
      await expect(
        runWithTenantDatabaseScope(db, 'default', (scoped) =>
          new BranchMaintenanceRepository(scoped).claim(session.branch_id, 'delete')
        )
      ).rejects.toThrow(/opencode_native_state_handoff_required/);
      await expect(new UsersRepository(db).delete(ownerId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );
    }
  );

  dbTest(
    'bounded cleanup rotation reaches a healthy successor beyond 32 ineligible rows',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const history: Array<{ taskId: string; holderId: string }> = [];
      let currentTask = firstTask;

      const nextManagedTask = async () => {
        const created = await taskRepo.create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'fair cleanup progression',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'cleanup-fairness' },
        });
        const connected = await taskRepo.connectExecutor(created.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
        return connected.task;
      };

      for (let index = 0; index < 35; index += 1) {
        const holderId = generateId();
        const admitted = await attempts.begin({
          taskId: currentTask.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, currentTask.task_id, storeId, holderId, ownerId),
        });
        if (admitted.outcome !== 'admitted') throw new Error('history holder was not admitted');
        if (admitted.input?.version === 3) {
          await attempts.closeRead(currentTask.task_id, holderId, {
            storeId: admitted.input.storeId,
            taskId: admitted.input.attemptTaskId,
          });
        } else if (admitted.input) {
          throw new Error('test history requires a coordinated v3 input');
        }
        const published = {
          version: 3 as const,
          storeId,
          attemptTaskId: currentTask.task_id,
          digest: `sha256:${String(index).padStart(64, '0')}`,
          bytes: 1024,
          openCodeSessionId: 'cleanup-fairness',
          openCodeVersion: '1.18.31',
          publishedAt: new Date(Date.now() + index).toISOString(),
        };
        await attempts.seal(currentTask.task_id, holderId, published);
        await taskRepo.completeWithNativeStatePublication(
          currentTask.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: published,
          },
          holderId
        );
        history.push({ taskId: currentTask.task_id, holderId });

        // Supersede the preceding accepted pointer before corrupting its binding.
        // Cleanup must treat these 33 terminal-looking ledger rows as ineligible.
        if (index > 0 && index - 1 < 33) {
          const ineligible = history[index - 1]!;
          const row = await select(db)
            .from(opencodeCheckpointAttempts)
            .where(eq(opencodeCheckpointAttempts.task_id, ineligible.taskId))
            .one();
          if (!row) throw new Error('history attempt disappeared');
          await update(db, opencodeCheckpointAttempts)
            .set({
              binding: { ...row.binding, sessionId: generateId() },
            })
            .where(eq(opencodeCheckpointAttempts.task_id, ineligible.taskId))
            .run();
        }
        if (index < 34) currentTask = await nextManagedTask();
      }

      const healthyTask = history[33]!;
      const collectorTask = await nextManagedTask();
      const collectorHolder = generateId();
      const collector = await attempts.begin({
        taskId: collectorTask.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: binding(sessionId, collectorTask.task_id, storeId, collectorHolder, ownerId),
      });
      if (collector.outcome !== 'admitted') throw new Error('collector was not admitted');

      let work = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
      expect(work.kind).toBe('none');
      const afterFirst = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      const cleanupCursor = afterFirst?.data.opencode_cleanup_cursor as
        | { lanes?: { retire?: { cursorAttemptNo?: number } } }
        | undefined;
      expect(cleanupCursor?.lanes?.retire?.cursorAttemptNo).toBe(8);

      let calls = 1;
      while (work.kind === 'none' && calls < 8) {
        work = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
        calls += 1;
      }
      expect(calls).toBe(5);
      expect(work).toEqual({
        kind: 'delete',
        object: { storeId, taskId: healthyTask.taskId },
      });
      const retired = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, healthyTask.taskId))
        .one();
      expect(retired?.retired_at).not.toBeNull();
      expect(retired?.delete_observed_at).toBeNull();
    }
  );

  dbTest(
    'retries failed deletes and rechecks acknowledged absence without clearing tombstones',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const firstHolder = generateId();
      const first = await attempts.begin({
        taskId: firstTask.task_id,
        holderInstanceId: firstHolder,
        storeId,
        binding: binding(sessionId, firstTask.task_id, storeId, firstHolder, ownerId),
      });
      if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
      const firstManifest = manifest(firstTask.task_id, storeId);
      await attempts.seal(firstTask.task_id, firstHolder, firstManifest);
      await taskRepo.completeWithNativeStatePublication(
        firstTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: firstManifest,
        },
        firstHolder
      );

      const createNextTask = async () => {
        const created = await taskRepo.create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'delete retry',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'delete-retry' },
        });
        const connected = await taskRepo.connectExecutor(created.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
        return connected.task;
      };
      const publisher = await createNextTask();
      const publisherHolder = generateId();
      const next = await attempts.begin({
        taskId: publisher.task_id,
        holderInstanceId: publisherHolder,
        storeId,
        binding: binding(sessionId, publisher.task_id, storeId, publisherHolder, ownerId),
      });
      if (next.outcome !== 'admitted' || next.input?.version !== 3) {
        throw new Error('publisher did not pin the accepted v3 input');
      }
      await attempts.closeRead(publisher.task_id, publisherHolder, {
        storeId,
        taskId: firstTask.task_id,
      });
      const nextManifest = {
        ...manifest(publisher.task_id, storeId),
        publishedAt: '2026-09-23T00:00:00.000Z',
      };
      await attempts.seal(publisher.task_id, publisherHolder, nextManifest);
      await taskRepo.completeWithNativeStatePublication(
        publisher.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: nextManifest,
        },
        publisherHolder
      );

      const collector = await createNextTask();
      const collectorHolder = generateId();
      const collectorGrant = await attempts.begin({
        taskId: collector.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: binding(sessionId, collector.task_id, storeId, collectorHolder, ownerId),
      });
      if (collectorGrant.outcome !== 'admitted') throw new Error('collector was not admitted');

      const now = new Date('2026-09-23T12:00:00.000Z');
      const tombstone = await attempts.prepareCleanup(collector.task_id, collectorHolder, now);
      expect(tombstone).toEqual({ kind: 'delete', object: { storeId, taskId: firstTask.task_id } });
      if (tombstone.kind !== 'delete') throw new Error('expected tombstone reservation');
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        {
          outcome: 'failed',
          errorCode: 'WORKER_TIMEOUT',
        },
        now
      );
      let saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved).toMatchObject({
        delete_failure_count: 1,
        delete_last_error: 'WORKER_TIMEOUT',
        delete_observed_at: null,
        delete_retry_at: new Date(now.getTime() + 2_000),
      });

      await expect(
        attempts.prepareCleanup(collector.task_id, collectorHolder, new Date(now.getTime() + 1_999))
      ).resolves.toEqual({ kind: 'none' });
      const retry = await attempts.prepareCleanup(
        collector.task_id,
        collectorHolder,
        new Date(now.getTime() + 2_000)
      );
      expect(retry).toEqual(tombstone);
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        {
          outcome: 'deleted',
        },
        new Date(now.getTime() + 2_000)
      );
      saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved?.retired_at).not.toBeNull();
      expect(saved?.delete_observed_at).toEqual(new Date(now.getTime() + 2_000));
      expect(saved?.delete_retry_at).toEqual(
        new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000)
      );

      const recheck = await attempts.prepareCleanup(
        collector.task_id,
        collectorHolder,
        new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000)
      );
      expect(recheck).toEqual(tombstone);
      const afterRecheckReservation = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(afterRecheckReservation?.retired_at).not.toBeNull();
      expect(afterRecheckReservation?.delete_observed_at).not.toBeNull();
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        { outcome: 'deleted' },
        new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000)
      );
      const afterRecheck = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(afterRecheck?.retired_at).not.toBeNull();
      expect(afterRecheck?.delete_retry_at).toBeNull();
    }
  );

  dbTest(
    'reclaims healthy hourly turns across four days without a growing backlog',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const epoch = Date.parse('2026-09-01T00:00:00.000Z');
      let currentTask = firstTask;
      for (let hour = 0; hour < 96; hour += 1) {
        const now = new Date(epoch + hour * 60 * 60 * 1_000);
        const holderId = generateId();
        const grant = await attempts.begin({
          taskId: currentTask.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, currentTask.task_id, storeId, holderId, ownerId),
        });
        if (grant.outcome !== 'admitted') throw new Error('hourly holder was not admitted');
        if (grant.input?.version === 3) {
          await attempts.closeRead(currentTask.task_id, holderId, {
            storeId,
            taskId: grant.input.attemptTaskId,
          });
        }
        // A healthy worker slot can reserve again after each fast completed
        // operation, but never reserves a batch ahead of the filesystem worker.
        for (let slot = 0; slot < 4; slot += 1) {
          const work = await attempts.prepareCleanup(currentTask.task_id, holderId, now);
          if (work.kind === 'delete') {
            await attempts.acknowledgeDelete(
              currentTask.task_id,
              holderId,
              work.object,
              { outcome: 'deleted' },
              now
            );
          } else if (work.kind === 'observe') {
            throw new Error('healthy finished holders have closure evidence');
          }
        }
        const published = {
          ...manifest(currentTask.task_id, storeId),
          publishedAt: now.toISOString(),
        };
        await attempts.seal(currentTask.task_id, holderId, published);
        await taskRepo.completeWithNativeStatePublication(
          currentTask.task_id,
          { status: TaskStatus.COMPLETED, native_state_attempt: published },
          holderId
        );
        await update(db, opencodeCheckpointAttempts)
          .set({ holder_closed_observed_at: now })
          .where(eq(opencodeCheckpointAttempts.task_id, currentTask.task_id))
          .run();
        if (hour === 47 || hour === 95) {
          const rows = await select(db)
            .from(opencodeCheckpointAttempts)
            .where(eq(opencodeCheckpointAttempts.session_id, sessionId))
            .all();
          const neverDeleted = rows.filter(
            (row: typeof opencodeCheckpointAttempts.$inferSelect) =>
              !row.delete_observed_at && row.task_id !== currentTask.task_id
          );
          expect(neverDeleted.length).toBeLessThanOrEqual(4);
        }
        if (hour < 95) {
          const created = await taskRepo.create({
            task_id: generateId(),
            session_id: sessionId,
            created_by: ownerId,
            full_prompt: 'hourly turn',
            status: TaskStatus.DISPATCHING,
            message_range: { start_index: 0, end_index: 0, start_timestamp: now.toISOString() },
            git_state: { ref_at_start: 'main', sha_at_start: 'hourly-cleanup' },
          });
          const connected = await taskRepo.connectExecutor(created.task_id);
          if (!connected) throw new Error('hourly task did not connect');
          await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
          currentTask = connected.task;
        }
      }
    }
  );

  dbTest('leaves a legacy pointer untouched and refuses first-use admission', async ({ db }) => {
    const { ownerId, sessionId, task } = await newTask(db);
    const oldPointer = {
      version: 2,
      openCodeVersion: '1.18.31',
      attemptTaskId: generateId(),
      digest: `sha256:${'b'.repeat(64)}`,
      bytes: 100,
      openCodeSessionId: 'legacy',
      publishedAt: new Date().toISOString(),
    };
    const row = await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one();
    if (!row) throw new Error('Session missing');
    await update(db, sessions)
      .set({ data: { ...row.data, sdk_native_state: oldPointer as never } })
      .where(eq(sessions.session_id, sessionId))
      .run();
    const holderId = generateId();
    const result = await new OpenCodeCheckpointAttemptRepository(db).begin({
      taskId: task.task_id,
      holderInstanceId: holderId,
      binding: binding(sessionId, task.task_id, generateId(), holderId, ownerId),
    });
    expect(result).toEqual({ outcome: 'rejected', code: 'legacy_state' });
    const unchanged = await select(db)
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .one();
    expect(unchanged?.data.sdk_native_state).toEqual(oldPointer);
    await expect(new SessionRepository(db).delete(sessionId)).rejects.toThrow(
      /opencode_native_state_handoff_required/
    );
  });

  dbTest(
    'keeps a superseded input pinned after force-fail until exact holder death evidence',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const firstHolder = generateId();
      const firstStore = generateId();
      const first = await attempts.begin({
        taskId: firstTask.task_id,
        holderInstanceId: firstHolder,
        storeId: firstStore,
        binding: binding(sessionId, firstTask.task_id, firstStore, firstHolder, ownerId),
      });
      if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
      const firstManifest = manifest(firstTask.task_id, firstStore);
      await attempts.seal(firstTask.task_id, firstHolder, firstManifest);
      await taskRepo.completeWithNativeStatePublication(
        firstTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: firstManifest,
        },
        firstHolder
      );

      const createNextTask = async () => {
        const created = await taskRepo.create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'continue checkpoint attempt',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
        });
        const connected = await taskRepo.connectExecutor(created.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
        return connected.task;
      };

      const abandonedTask = await createNextTask();
      const abandonedHolder = generateId();
      const abandoned = await attempts.begin({
        taskId: abandonedTask.task_id,
        holderInstanceId: abandonedHolder,
        storeId: firstStore,
        binding: binding(sessionId, abandonedTask.task_id, firstStore, abandonedHolder, ownerId),
      });
      if (abandoned.outcome !== 'admitted') throw new Error('second holder was not admitted');
      expect(abandoned.input).toEqual(firstManifest);
      // A force-failed Task can be terminal while its already-granted native file
      // read is still live. This models coordinator release without IO closure.
      await update(db, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, abandonedTask.task_id))
        .run();

      const publisherTask = await createNextTask();
      const publisherHolder = generateId();
      const publisher = await attempts.begin({
        taskId: publisherTask.task_id,
        holderInstanceId: publisherHolder,
        storeId: firstStore,
        binding: binding(sessionId, publisherTask.task_id, firstStore, publisherHolder, ownerId),
      });
      if (publisher.outcome !== 'admitted') throw new Error('publisher holder was not admitted');
      await attempts.closeRead(publisherTask.task_id, publisherHolder, {
        storeId: firstStore,
        taskId: firstTask.task_id,
      });
      const publisherManifest = manifest(publisherTask.task_id, firstStore);
      await attempts.seal(publisherTask.task_id, publisherHolder, publisherManifest);
      await taskRepo.completeWithNativeStatePublication(
        publisherTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: publisherManifest,
        },
        publisherHolder
      );

      const collectorTask = await createNextTask();
      const collectorHolder = generateId();
      const collector = await attempts.begin({
        taskId: collectorTask.task_id,
        holderInstanceId: collectorHolder,
        storeId: firstStore,
        binding: binding(sessionId, collectorTask.task_id, firstStore, collectorHolder, ownerId),
      });
      if (collector.outcome !== 'admitted') throw new Error('collector holder was not admitted');
      const work = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
      expect(work).toEqual({ kind: 'observe', attemptId: abandoned.attempt.attempt_id });

      const bindingForOldHolder = await attempts.loadObservationBinding(
        collectorTask.task_id,
        collectorHolder,
        abandoned.attempt.attempt_id
      );
      expect(bindingForOldHolder).toEqual(abandoned.attempt.binding);
      await attempts.recordHolderObservation(
        collectorTask.task_id,
        collectorHolder,
        abandoned.attempt.attempt_id,
        'verified_closed'
      );
      const oldAttempt = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(oldAttempt?.retired_at).toBeNull();

      await expect(
        attempts.prepareCleanup(collectorTask.task_id, collectorHolder)
      ).resolves.toEqual({
        kind: 'delete',
        object: { storeId: firstStore, taskId: firstTask.task_id },
      });
      const retired = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(retired?.retired_at).toBeTruthy();
    }
  );
});
