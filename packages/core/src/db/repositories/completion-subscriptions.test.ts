import type {
  BranchID,
  CompletionSubscriptionID,
  SessionID,
  TaskID,
  UserID,
  UUID,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { runWithTenantDatabaseTransaction } from '../tenant-scope';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import {
  CompletionContinuationConflictError,
  CompletionSubscriptionRepository,
} from './completion-subscriptions';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

let branchSequence = 60_000;

async function seedSession(db: Database, title: string) {
  const userId = generateId() as UserID;
  await new UsersRepository(db).create({
    user_id: userId as UUID,
    email: `${userId}@example.test`,
    name: title,
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `completion-${generateId()}`,
    name: 'Completion propagation fixture',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/completion.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `completion-${generateId()}`,
    ref: 'main',
    branch_unique_id: branchSequence++,
    path: `/tmp/${generateId()}`,
    created_by: userId as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id,
    created_by: userId,
    agentic_tool: 'codex',
    status: SessionStatus.IDLE,
    title,
    tasks: [],
  });
  return { userId, branch, session };
}

async function seedTask(db: Database, sessionId: SessionID, userId: UserID, prompt: string) {
  return new TaskRepository(db).create({
    task_id: generateId() as TaskID,
    session_id: sessionId,
    created_by: userId,
    full_prompt: prompt,
    status: TaskStatus.RUNNING,
    tool_use_count: 0,
  });
}

describe('CompletionSubscriptionRepository', () => {
  dbTest('moves terminal ownership through a designated descendant chain', async ({ db }) => {
    const origin = await seedSession(db, 'origin');
    const root = await seedSession(db, 'root');
    const child = await seedSession(db, 'child');
    const grandchild = await seedSession(db, 'grandchild');
    const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
    const rootTask = await seedTask(db, root.session.session_id, root.userId, 'delegate');
    const childTask = await seedTask(db, child.session.session_id, child.userId, 'do work');
    const grandchildTask = await seedTask(
      db,
      grandchild.session.session_id,
      grandchild.userId,
      'finish work'
    );
    const subscriptions = new CompletionSubscriptionRepository(db);
    const created = await subscriptions.createRoot({
      requested_by_user_id: origin.userId,
      origin_session_id: origin.session.session_id,
      origin_task_id: originTask.task_id,
      callback_session_id: origin.session.session_id,
      root_session_id: root.session.session_id,
      root_task_id: rootTask.task_id,
      root_branch_id: root.branch.branch_id,
    });

    const delegated = await subscriptions.designateContinuation({
      subscription_id: created.subscription_id,
      from_task_id: rootTask.task_id,
      to_session_id: child.session.session_id,
      to_task_id: childTask.task_id,
      to_branch_id: child.branch.branch_id,
    });
    expect(delegated).toMatchObject({
      state: 'delegated',
      active_task_id: childTask.task_id,
    });
    expect(delegated.path).toHaveLength(2);

    const delegatedAgain = await subscriptions.designateContinuation({
      subscription_id: created.subscription_id,
      from_task_id: childTask.task_id,
      to_session_id: grandchild.session.session_id,
      to_task_id: grandchildTask.task_id,
      to_branch_id: grandchild.branch.branch_id,
    });
    expect(delegatedAgain).toMatchObject({
      state: 'delegated',
      active_task_id: grandchildTask.task_id,
    });
    expect(delegatedAgain.path).toHaveLength(3);

    await expect(
      subscriptions.markTerminalForTask(rootTask.task_id, {
        session_id: root.session.session_id,
        task_id: rootTask.task_id,
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
    ).resolves.toBeNull();
    await expect(
      subscriptions.markTerminalForTask(childTask.task_id, {
        session_id: child.session.session_id,
        task_id: childTask.task_id,
        branch_id: child.branch.branch_id,
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
    ).resolves.toBeNull();
    const terminal = await subscriptions.markTerminalForTask(grandchildTask.task_id, {
      session_id: grandchild.session.session_id,
      task_id: grandchildTask.task_id,
      branch_id: grandchild.branch.branch_id,
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    expect(terminal).toMatchObject({
      state: 'terminal_pending',
      terminal_status: 'completed',
      active_task_id: grandchildTask.task_id,
    });
    await expect(
      subscriptions.markTerminalForTask(grandchildTask.task_id, terminal!.terminal_snapshot!)
    ).resolves.toBeNull();
  });

  dbTest('captures a designated child terminal outcome', async ({ db }) => {
    const origin = await seedSession(db, 'origin');
    const child = await seedSession(db, 'child');
    const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
    const childTask = await seedTask(db, child.session.session_id, child.userId, 'do work');
    const subscriptions = new CompletionSubscriptionRepository(db);
    await subscriptions.createRoot({
      requested_by_user_id: origin.userId,
      origin_session_id: origin.session.session_id,
      origin_task_id: originTask.task_id,
      callback_session_id: origin.session.session_id,
      root_session_id: child.session.session_id,
      root_task_id: childTask.task_id,
      root_branch_id: child.branch.branch_id,
    });
    const terminal = await subscriptions.markTerminalForTask(childTask.task_id, {
      session_id: child.session.session_id,
      task_id: childTask.task_id,
      branch_id: child.branch.branch_id,
      status: 'failed',
      completed_at: new Date().toISOString(),
      reason: 'executor failed',
    });
    expect(terminal).toMatchObject({
      state: 'terminal_pending',
      terminal_status: 'failed',
      active_task_id: childTask.task_id,
    });
    await expect(
      subscriptions.markTerminalForTask(childTask.task_id, terminal!.terminal_snapshot!)
    ).resolves.toBeNull();
  });

  dbTest('rejects a second continuation and enforces maximum depth', async ({ db }) => {
    const origin = await seedSession(db, 'origin');
    const root = await seedSession(db, 'root');
    const child = await seedSession(db, 'child');
    const other = await seedSession(db, 'other');
    const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
    const rootTask = await seedTask(db, root.session.session_id, root.userId, 'delegate');
    const childTask = await seedTask(db, child.session.session_id, child.userId, 'child');
    const otherTask = await seedTask(db, other.session.session_id, other.userId, 'other');
    const subscriptions = new CompletionSubscriptionRepository(db);
    const created = await subscriptions.createRoot({
      requested_by_user_id: origin.userId,
      origin_session_id: origin.session.session_id,
      origin_task_id: originTask.task_id,
      callback_session_id: origin.session.session_id,
      root_session_id: root.session.session_id,
      root_task_id: rootTask.task_id,
      max_depth: 2,
    });
    await subscriptions.designateContinuation({
      subscription_id: created.subscription_id,
      from_task_id: rootTask.task_id,
      to_session_id: child.session.session_id,
      to_task_id: childTask.task_id,
    });
    await expect(
      subscriptions.designateContinuation({
        subscription_id: created.subscription_id,
        from_task_id: rootTask.task_id,
        to_session_id: other.session.session_id,
        to_task_id: otherTask.task_id,
      })
    ).rejects.toBeInstanceOf(CompletionContinuationConflictError);
    await expect(
      subscriptions.designateContinuation({
        subscription_id: created.subscription_id,
        from_task_id: childTask.task_id,
        to_session_id: other.session.session_id,
        to_task_id: otherTask.task_id,
      })
    ).rejects.toThrow('maximum depth');
  });

  dbTest('rejects a continuation cycle', async ({ db }) => {
    const origin = await seedSession(db, 'origin');
    const root = await seedSession(db, 'root');
    const child = await seedSession(db, 'child');
    const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
    const rootTask = await seedTask(db, root.session.session_id, root.userId, 'delegate');
    const childTask = await seedTask(db, child.session.session_id, child.userId, 'child');
    const subscriptions = new CompletionSubscriptionRepository(db);
    const created = await subscriptions.createRoot({
      requested_by_user_id: origin.userId,
      origin_session_id: origin.session.session_id,
      origin_task_id: originTask.task_id,
      callback_session_id: origin.session.session_id,
      root_session_id: root.session.session_id,
      root_task_id: rootTask.task_id,
      max_depth: 4,
    });
    await subscriptions.designateContinuation({
      subscription_id: created.subscription_id,
      from_task_id: rootTask.task_id,
      to_session_id: child.session.session_id,
      to_task_id: childTask.task_id,
    });

    await expect(
      subscriptions.designateContinuation({
        subscription_id: created.subscription_id,
        from_task_id: childTask.task_id,
        to_session_id: root.session.session_id,
        to_task_id: rootTask.task_id,
      })
    ).rejects.toThrow('cycle');
  });

  dbTest(
    'restart discovery selects terminal work but does not poll running work',
    async ({ db }) => {
      const origin = await seedSession(db, 'origin');
      const root = await seedSession(db, 'root');
      const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
      const rootTask = await seedTask(db, root.session.session_id, root.userId, 'work');
      const subscriptions = new CompletionSubscriptionRepository(db);
      const created = await subscriptions.createRoot({
        requested_by_user_id: origin.userId,
        origin_session_id: origin.session.session_id,
        origin_task_id: originTask.task_id,
        callback_session_id: origin.session.session_id,
        root_session_id: root.session.session_id,
        root_task_id: rootTask.task_id,
      });

      expect(await subscriptions.findActiveRefs(db)).toEqual([]);
      await new TaskRepository(db).update(rootTask.task_id, {
        status: TaskStatus.COMPLETED,
        completed_at: new Date().toISOString(),
      });
      expect(await subscriptions.findActiveRefs(db)).toEqual([
        { tenant_id: 'default', subscription_id: created.subscription_id },
      ]);
    }
  );

  dbTest('rolls back child Task admission when continuation designation fails', async ({ db }) => {
    const child = await seedSession(db, 'child');
    const rejectedTaskId = generateId() as TaskID;

    await expect(
      runWithTenantDatabaseTransaction(db, undefined, async (transaction) => {
        await new TaskRepository(transaction).createPending({
          task_id: rejectedTaskId,
          session_id: child.session.session_id,
          created_by: child.userId,
          full_prompt: 'must roll back',
          status: TaskStatus.QUEUED,
          metadata: {
            completion_subscription_id: generateId() as CompletionSubscriptionID,
          },
        });
        await new CompletionSubscriptionRepository(transaction).designateContinuation({
          subscription_id: generateId() as CompletionSubscriptionID,
          from_task_id: generateId() as TaskID,
          to_session_id: child.session.session_id,
          to_task_id: rejectedTaskId,
        });
      })
    ).rejects.toThrow();

    expect(await new TaskRepository(db).findById(rejectedTaskId)).toBeNull();
  });

  dbTest(
    'retains origin audit IDs and fails safely when active work is deleted',
    async ({ db }) => {
      const origin = await seedSession(db, 'origin');
      const root = await seedSession(db, 'root');
      const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
      const rootTask = await seedTask(db, root.session.session_id, root.userId, 'work');
      const subscriptions = new CompletionSubscriptionRepository(db);
      const created = await subscriptions.createRoot({
        requested_by_user_id: origin.userId,
        origin_session_id: origin.session.session_id,
        origin_task_id: originTask.task_id,
        callback_session_id: origin.session.session_id,
        root_session_id: root.session.session_id,
        root_task_id: rootTask.task_id,
      });
      await new SessionRepository(db).delete(root.session.session_id);
      await subscriptions.markMissingActive(created.subscription_id, null);
      expect(await subscriptions.get(created.subscription_id)).toMatchObject({
        origin_session_id: origin.session.session_id,
        origin_task_id: originTask.task_id,
        active_task_id: null,
        state: 'terminal_pending',
        terminal_status: 'failed',
      });
    }
  );

  dbTest('retries delivery durably and converges on one delivery task', async ({ db }) => {
    const origin = await seedSession(db, 'origin');
    const root = await seedSession(db, 'root');
    const originTask = await seedTask(db, origin.session.session_id, origin.userId, 'request');
    const rootTask = await seedTask(db, root.session.session_id, root.userId, 'work');
    const subscriptions = new CompletionSubscriptionRepository(db);
    const created = await subscriptions.createRoot({
      requested_by_user_id: origin.userId,
      origin_session_id: origin.session.session_id,
      origin_task_id: originTask.task_id,
      callback_session_id: origin.session.session_id,
      root_session_id: root.session.session_id,
      root_task_id: rootTask.task_id,
    });
    await subscriptions.markTerminalForTask(rootTask.task_id, {
      session_id: root.session.session_id,
      task_id: rootTask.task_id,
      status: 'timed_out',
      completed_at: new Date().toISOString(),
      reason: 'deadline exceeded',
    });
    expect(
      await subscriptions.recordDeliveryFailure(created.subscription_id, 'transient')
    ).toMatchObject({ state: 'delivery_failed', delivery_attempt_count: 1 });
    const deliveryTaskId = generateId() as TaskID;
    await new TaskRepository(db).createPending({
      task_id: deliveryTaskId,
      session_id: origin.session.session_id,
      created_by: origin.userId,
      full_prompt: 'terminal callback',
      status: TaskStatus.QUEUED,
    });
    await subscriptions.recordDelivered(created.subscription_id, deliveryTaskId);
    await subscriptions.recordDelivered(created.subscription_id, generateId() as TaskID);
    expect(await subscriptions.get(created.subscription_id)).toMatchObject({
      state: 'delivered',
      delivery_task_id: deliveryTaskId,
      terminal_status: 'timed_out',
    });
  });
});
