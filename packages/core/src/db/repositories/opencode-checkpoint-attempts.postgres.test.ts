import type { UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { isPostgresDatabase, select, update } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { opencodeCheckpointAttempts, tasks as taskRows } from '../schema';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointAttemptRepository } from './opencode-checkpoint-attempts';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'OpenCode checkpoint attempts PostgreSQL concurrency',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
      if (!isPostgresDatabase(dbA) || !isPostgresDatabase(dbB)) {
        throw new Error('PostgreSQL concurrency test requires PostgreSQL');
      }
      await dbA.execute(sql`SET TIME ZONE 'UTC'`);
      await dbB.execute(sql`SET TIME ZONE 'UTC'`);
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function createManagedSession() {
      const ownerId = generateId() as UUID;
      await new UsersRepository(dbA).create({
        user_id: ownerId,
        email: `opencode-attempt-${ownerId}@example.invalid`,
        role: 'member',
      });
      const repo = await new RepoRepository(dbA).create({
        repo_id: generateId(),
        slug: `opencode-attempt-${generateId()}`,
        name: 'OpenCode race',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/opencode.git',
        local_path: '/tmp/opencode-race',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(dbA).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'opencode-race',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
        path: `/tmp/opencode-race/${generateId()}`,
        created_by: ownerId,
      });
      const session = await new SessionRepository(dbA).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: ownerId,
      });
      return { ownerId, sessionId: session.session_id };
    }

    async function createManagedTask(sessionId: UUID, ownerId: UUID, db: Database = dbA) {
      const tasks = new TaskRepository(db);
      const created = await tasks.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'concurrent OpenCode holder admission',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        tool_use_count: 0,
        git_state: { ref_at_start: 'main', sha_at_start: 'postgres-race' },
      });
      const connected = await tasks.connectExecutor(created.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasks.stampManagedOpenCodeProtocol(created.task_id);
      return connected.task;
    }

    function binding(
      sessionId: string,
      taskId: string,
      ownerId: string,
      storeId: string,
      holderId: string
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
          namespace: 'runtime-test',
          jobName: `job-${taskId}`,
          jobUid: generateId(),
          podName: `pod-${taskId}`,
          podUid: generateId(),
          containerName: 'executor' as const,
          containerId: `containerd://${generateId()}`,
          restartCount: 0 as const,
          imageIdentity: `sha256:${'c'.repeat(64)}`,
        },
      };
    }

    it('serializes two independent database connections to one immutable admitted holder', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const holderA = generateId();
      const holderB = generateId();
      const first = new OpenCodeCheckpointAttemptRepository(dbA);
      const second = new OpenCodeCheckpointAttemptRepository(dbB);
      const results = await Promise.all([
        first.begin({
          taskId: task.task_id,
          holderInstanceId: holderA,
          storeId,
          binding: binding(sessionId, task.task_id, ownerId, storeId, holderA),
        }),
        second.begin({
          taskId: task.task_id,
          holderInstanceId: holderB,
          storeId,
          binding: binding(sessionId, task.task_id, ownerId, storeId, holderB),
        }),
      ]);

      expect(results.filter((result) => result.outcome === 'admitted')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual([
        { outcome: 'rejected', code: 'already_admitted' },
      ]);
      const winner = results.find((result) => result.outcome === 'admitted');
      if (winner?.outcome !== 'admitted') throw new Error('No holder was admitted');
      expect([holderA, holderB]).toContain(winner.attempt.holder_instance_id);
      await expect(
        first.begin({
          taskId: task.task_id,
          holderInstanceId: winner.attempt.holder_instance_id,
          storeId,
          binding: binding(
            sessionId,
            task.task_id,
            ownerId,
            storeId,
            winner.attempt.holder_instance_id
          ),
        })
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'already_admitted' });
    });

    it('serializes completion against cleanup so a published attempt cannot be retired', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const holderId = generateId();
      const bindingValue = binding(sessionId, task.task_id, ownerId, storeId, holderId);
      const attemptsA = new OpenCodeCheckpointAttemptRepository(dbA);
      const attemptsB = new OpenCodeCheckpointAttemptRepository(dbB);
      const grant = await attemptsA.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: bindingValue,
      });
      if (grant.outcome !== 'admitted') throw new Error('holder was not admitted');
      const published = {
        version: 3 as const,
        storeId,
        attemptTaskId: task.task_id,
        digest: `sha256:${'e'.repeat(64)}`,
        bytes: 1024,
        openCodeSessionId: 'pg-race',
        openCodeVersion: '1.18.31',
        publishedAt: new Date().toISOString(),
      };
      await attemptsA.seal(task.task_id, holderId, published);

      const [completion, cleanup] = await Promise.allSettled([
        new TaskRepository(dbA).completeWithNativeStatePublication(
          task.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: published,
          },
          holderId
        ),
        attemptsB.prepareCleanup(task.task_id, holderId),
      ]);
      expect(completion.status).toBe('fulfilled');
      const saved = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .one();
      expect(saved?.retired_at).toBeNull();
      if (cleanup.status === 'fulfilled') {
        expect(cleanup.value).not.toEqual({
          kind: 'delete',
          object: { storeId, taskId: task.task_id },
        });
      }
    });

    it('serializes a reader close against retirement and never deletes an open input', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const firstTask = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const firstHolder = generateId();
      const firstBinding = binding(sessionId, firstTask.task_id, ownerId, storeId, firstHolder);
      const attemptsA = new OpenCodeCheckpointAttemptRepository(dbA);
      const attemptsB = new OpenCodeCheckpointAttemptRepository(dbB);
      const first = await attemptsA.begin({
        taskId: firstTask.task_id,
        holderInstanceId: firstHolder,
        storeId,
        binding: firstBinding,
      });
      if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
      const firstManifest = {
        version: 3 as const,
        storeId,
        attemptTaskId: firstTask.task_id,
        digest: `sha256:${'f'.repeat(64)}`,
        bytes: 1024,
        openCodeSessionId: 'pg-reader-race',
        openCodeVersion: '1.18.31',
        publishedAt: new Date().toISOString(),
      };
      await attemptsA.seal(firstTask.task_id, firstHolder, firstManifest);
      await new TaskRepository(dbA).completeWithNativeStatePublication(
        firstTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: firstManifest,
        },
        firstHolder
      );

      const slowReader = await createManagedTask(sessionId, ownerId);
      const slowHolder = generateId();
      const slow = await attemptsA.begin({
        taskId: slowReader.task_id,
        holderInstanceId: slowHolder,
        storeId,
        binding: binding(sessionId, slowReader.task_id, ownerId, storeId, slowHolder),
      });
      if (slow.outcome !== 'admitted' || !slow.input || slow.input.version !== 3) {
        throw new Error('slow reader was not admitted to a coordinated v3 input');
      }
      expect(slow.input.attemptTaskId).toBe(firstTask.task_id);
      await update(dbA, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, slowReader.task_id))
        .run();

      const publisher = await createManagedTask(sessionId, ownerId);
      const publisherHolder = generateId();
      const next = await attemptsA.begin({
        taskId: publisher.task_id,
        holderInstanceId: publisherHolder,
        storeId,
        binding: binding(sessionId, publisher.task_id, ownerId, storeId, publisherHolder),
      });
      if (next.outcome !== 'admitted' || !next.input || next.input.version !== 3) {
        throw new Error('publisher did not pin accepted v3 state');
      }
      await attemptsA.closeRead(publisher.task_id, publisherHolder, {
        storeId: next.input.storeId,
        taskId: next.input.attemptTaskId,
      });
      const nextManifest = {
        ...firstManifest,
        attemptTaskId: publisher.task_id,
        digest: `sha256:${'1'.repeat(64)}`,
        publishedAt: new Date().toISOString(),
      };
      await attemptsA.seal(publisher.task_id, publisherHolder, nextManifest);
      await new TaskRepository(dbA).completeWithNativeStatePublication(
        publisher.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: nextManifest,
        },
        publisherHolder
      );

      const collector = await createManagedTask(sessionId, ownerId);
      const collectorHolder = generateId();
      const collection = await attemptsA.begin({
        taskId: collector.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: binding(sessionId, collector.task_id, ownerId, storeId, collectorHolder),
      });
      if (collection.outcome !== 'admitted') throw new Error('collector was not admitted');

      const [, work] = await Promise.all([
        attemptsA.closeRead(slowReader.task_id, slowHolder, {
          storeId: slow.input.storeId,
          taskId: firstTask.task_id,
        }),
        attemptsB.prepareCleanup(collector.task_id, collectorHolder),
      ]);
      const old = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      const reader = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, slowReader.task_id))
        .one();
      if (old?.retired_at) {
        expect(work).toEqual({ kind: 'delete', object: { storeId, taskId: firstTask.task_id } });
        expect(reader?.input_read_closed_at).not.toBeNull();
      } else {
        expect(reader?.input_read_closed_at).not.toBeNull();
        expect(work.kind).not.toBe('delete');
      }
    });
  }
);
