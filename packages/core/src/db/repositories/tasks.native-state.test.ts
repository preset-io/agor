/**
 * Hosted OpenCode native-state publication through the task completion
 * transition (`context/explorations/opencode-cloud.md` §5 step 5).
 */

import type { Task, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest } from '../test-helpers';
import { RepositoryError } from './base';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointAttemptRepository } from './opencode-checkpoint-attempts';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';

let branchCounter = 1;

async function createSession(db: Database): Promise<UUID> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `native-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'test-branch',
    ref: 'main',
    branch_unique_id: branchCounter++,
    path: '/tmp/test/branch',
    created_by: 'test-user' as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'opencode',
    created_by: 'test-user' as UUID,
  });
  return session.session_id;
}

async function runningTask(db: Database, sessionId: UUID): Promise<Task> {
  const taskRepo = new TaskRepository(db);
  const created = await taskRepo.create({
    task_id: generateId(),
    session_id: sessionId,
    created_by: 'test-user',
    full_prompt: 'Continue',
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
  });
  const connection = await taskRepo.connectExecutor(created.task_id);
  if (!connection) throw new Error('executor connection failed');
  await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
  return connection.task;
}

async function attemptFor(
  db: Database,
  task: Task,
  sessionId: string,
  overrides: Record<string, unknown> = {}
) {
  const holderId = generateId();
  const storeId = generateId();
  const binding = {
    protocol: 3 as const,
    tenantId: 'default',
    ownerUserId: 'test-user',
    sessionId,
    taskId: task.task_id,
    storeId,
    holderInstanceId: holderId,
    locator: {
      runId: generateId(),
      cellId: generateId(),
      tenantId: 'default',
      ownerRuntimeUserId: 'test-user',
      sessionId,
      taskId: task.task_id,
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
      imageIdentity: `registry.example/agor/executor@sha256:${'d'.repeat(64)}`,
    },
  };
  await new OpenCodeCheckpointAttemptRepository(db).begin({
    taskId: task.task_id,
    holderInstanceId: holderId,
    binding,
    storeId,
  });
  const manifest = {
    version: 3 as const,
    storeId,
    openCodeVersion: '1.18.31',
    attemptTaskId: task.task_id,
    digest: `sha256:${'b'.repeat(64)}`,
    bytes: 167936,
    openCodeSessionId: 'ses_accepted',
    publishedAt: '2026-09-10T22:18:55.000Z',
    ...overrides,
  };
  await new OpenCodeCheckpointAttemptRepository(db).seal(task.task_id, holderId, manifest);
  return { manifest, holderId };
}

describe('TaskRepository.completeWithNativeStatePublication', () => {
  dbTest('settles pre-admission failure only while no attempt exists', async ({ db }) => {
    const sessionId = await createSession(db);
    const taskRepo = new TaskRepository(db);
    const unadmitted = await runningTask(db, sessionId);
    await expect(
      taskRepo.updateFromExecutor(unadmitted.task_id, {
        status: TaskStatus.FAILED,
        error_message: 'admission failed',
      })
    ).resolves.toMatchObject({ status: TaskStatus.FAILED });

    const admitted = await runningTask(db, sessionId);
    await attemptFor(db, admitted, sessionId);
    await expect(
      taskRepo.updateFromExecutor(admitted.task_id, { status: TaskStatus.FAILED })
    ).rejects.toThrow(/holder/);
    expect((await taskRepo.findById(admitted.task_id))?.status).toBe(TaskStatus.RUNNING);
  });

  dbTest(
    'accepts a pre-admission Stop report but never a holder-less post-begin report',
    async ({ db }) => {
      const sessionId = await createSession(db);
      const taskRepo = new TaskRepository(db);
      const unadmitted = await runningTask(db, sessionId);
      const first = await taskRepo.claimTermination({
        taskId: unadmitted.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped',
      });
      if (first.outcome !== 'claimed') throw new Error('Stop claim did not succeed');
      await expect(
        taskRepo.recordExecutorQuiescence({
          task_id: unadmitted.task_id,
          requested_at: first.task.termination_request!.requested_at,
        })
      ).resolves.toMatchObject({ status: TaskStatus.STOPPING });

      const admitted = await runningTask(db, sessionId);
      await attemptFor(db, admitted, sessionId);
      const second = await taskRepo.claimTermination({
        taskId: admitted.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped',
      });
      if (second.outcome !== 'claimed') throw new Error('Stop claim did not succeed');
      await expect(
        taskRepo.recordExecutorQuiescence({
          task_id: admitted.task_id,
          requested_at: second.task.termination_request!.requested_at,
        })
      ).rejects.toThrow(/holder/);
    }
  );
  dbTest('rejects generic managed completion before and after seal', async ({ db }) => {
    const sessionId = await createSession(db);
    const task = await runningTask(db, sessionId);
    const taskRepo = new TaskRepository(db);

    await expect(taskRepo.update(task.task_id, { status: TaskStatus.COMPLETED })).rejects.toThrow(
      /requires sealed publication/
    );
    const { manifest, holderId } = await attemptFor(db, task, sessionId);
    await expect(taskRepo.update(task.task_id, { status: TaskStatus.COMPLETED })).rejects.toThrow(
      /requires sealed publication/
    );
    expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.RUNNING);
    expect((await new SessionRepository(db).findById(sessionId))?.sdk_native_state).toBeUndefined();

    await expect(
      taskRepo.completeWithNativeStatePublication(
        task.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: manifest },
        holderId
      )
    ).resolves.toMatchObject({ status: TaskStatus.COMPLETED });
  });
  dbTest(
    'fences an SDK-health termination claim with the holder inside its write',
    async ({ db }) => {
      const sessionId = await createSession(db);
      const task = await runningTask(db, sessionId);
      const { holderId } = await attemptFor(db, task, sessionId);
      const taskRepo = new TaskRepository(db);
      await expect(
        taskRepo.claimTermination({
          taskId: task.task_id,
          cause: 'sdk_health_failure',
          errorMessage: 'stalled',
        })
      ).rejects.toThrow(/holder/);
      await expect(
        taskRepo.claimTermination({
          taskId: task.task_id,
          cause: 'sdk_health_failure',
          errorMessage: 'stalled',
          holderInstanceId: generateId(),
        })
      ).rejects.toThrow(/holder/);
      const claim = await taskRepo.claimTermination({
        taskId: task.task_id,
        cause: 'sdk_health_failure',
        errorMessage: 'stalled',
        holderInstanceId: holderId,
      });
      expect(claim).toMatchObject({ outcome: 'claimed', task: { status: TaskStatus.STOPPING } });
    }
  );
  dbTest('publishes the pointer and native session id together with completion', async ({ db }) => {
    const sessionId = await createSession(db);
    const task = await runningTask(db, sessionId);
    const { manifest: attempt, holderId } = await attemptFor(db, task, sessionId);

    const completed = await new TaskRepository(db).completeWithNativeStatePublication(
      task.task_id,
      { status: TaskStatus.COMPLETED, native_state_attempt: attempt },
      holderId
    );

    expect(completed.status).toBe(TaskStatus.COMPLETED);
    expect(completed.native_state_attempt).toEqual(attempt);
    const session = await new SessionRepository(db).findById(sessionId);
    expect(session?.sdk_native_state).toEqual(attempt);
    expect(session?.sdk_session_id).toBe('ses_accepted');
  });

  dbTest(
    'refuses a late publication once the task is terminal (stale writer fence)',
    async ({ db }) => {
      const sessionId = await createSession(db);
      const task = await runningTask(db, sessionId);
      const taskRepo = new TaskRepository(db);
      const { manifest: attempt, holderId } = await attemptFor(db, task, sessionId);
      await taskRepo.update(task.task_id, {
        status: TaskStatus.FAILED,
        error_message: 'force-failed',
      });

      await expect(
        taskRepo.completeWithNativeStatePublication(
          task.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: attempt,
          },
          holderId
        )
      ).rejects.toThrow(RepositoryError);
      const session = await new SessionRepository(db).findById(sessionId);
      expect(session?.sdk_native_state).toBeUndefined();
      expect(session?.sdk_session_id).toBeUndefined();
      expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.FAILED);
    }
  );

  dbTest(
    'rejects malformed pointers, foreign task ids, and non-completed statuses',
    async ({ db }) => {
      const sessionId = await createSession(db);
      const task = await runningTask(db, sessionId);
      const taskRepo = new TaskRepository(db);
      const { manifest: attempt, holderId } = await attemptFor(db, task, sessionId);

      await expect(
        taskRepo.completeWithNativeStatePublication(
          task.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: { ...attempt, digest: 'md5:nope' } as never,
          },
          holderId
        )
      ).rejects.toThrow(/malformed/);
      await expect(
        taskRepo.completeWithNativeStatePublication(
          task.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: { ...attempt, attemptTaskId: generateId() },
          },
          holderId
        )
      ).rejects.toThrow(/must name the completing task/);
      await expect(
        taskRepo.completeWithNativeStatePublication(
          task.task_id,
          {
            status: TaskStatus.FAILED,
            native_state_attempt: attempt,
          },
          holderId
        )
      ).rejects.toThrow(/completed status/);
      expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.RUNNING);
      expect(
        (await new SessionRepository(db).findById(sessionId))?.sdk_native_state
      ).toBeUndefined();
    }
  );
});
