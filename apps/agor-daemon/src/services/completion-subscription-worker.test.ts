import {
  BranchRepository,
  CompletionSubscriptionRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, CompletionSubscription, SessionID, TaskID, UserID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  CompletionSubscriptionWorker,
  completionCallbackTaskMetadata,
  completionTerminalStatusForTask,
  renderTerminalCallback,
} from './completion-subscription-worker';

let branchSequence = 91_000;

describe('completionTerminalStatusForTask', () => {
  it.each([
    [TaskStatus.COMPLETED, 'completed'],
    [TaskStatus.FAILED, 'failed'],
    [TaskStatus.STOPPED, 'cancelled'],
    [TaskStatus.TIMED_OUT, 'timed_out'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(completionTerminalStatusForTask({ status })).toBe(expected);
  });
});

it('redacts downstream identity, result, links, path, and failure reason after access loss', () => {
  const subscription = {
    subscription_id: 'subscription-private',
    origin_session_id: 'origin-session',
    origin_task_id: 'origin-task',
    terminal_snapshot: {
      session_id: 'private-session',
      task_id: 'private-task',
      status: 'failed',
      completed_at: '2026-08-26T08:00:00.000Z',
      reason: 'secret downstream failure detail',
    },
    path: [{ session_id: 'private-session', task_id: 'private-task' }],
  } as CompletionSubscription;

  const rendered = renderTerminalCallback({
    subscription,
    authorized: false,
    terminalResult: 'secret final response',
    branchUrl: 'https://private.invalid/branch',
    issueUrl: 'https://private.invalid/issue',
    pullRequestUrl: 'https://private.invalid/pull',
  });

  expect(rendered).toContain('**failed**');
  expect(rendered).toContain('omitted because the requesting user no longer has access');
  expect(rendered).not.toContain('private-session');
  expect(rendered).not.toContain('private-task');
  expect(rendered).not.toContain('secret downstream failure detail');
  expect(rendered).not.toContain('secret final response');
  expect(rendered).not.toContain('private.invalid');

  const metadata = completionCallbackTaskMetadata({
    subscription,
    terminal: subscription.terminal_snapshot!,
    deliveryTaskId: 'delivery-task' as TaskID,
    authorized: false,
  });
  expect(metadata).not.toHaveProperty('child_session_id');
  expect(metadata).not.toHaveProperty('child_task_id');
  expect(metadata).toMatchObject({
    completion_subscription_id: 'subscription-private',
    initial_message_id: 'delivery-task',
  });
});

dbTest(
  'restart reconciliation delivers one terminal callback with configured links',
  async ({ db }) => {
    const user = await new UsersRepository(db).create({
      user_id: generateId(),
      email: `${generateId()}@example.invalid`,
      name: 'Callback test user',
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `callback-${generateId()}`,
      name: 'Callback fixture',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/callback.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branches = new BranchRepository(db);
    const sessions = new SessionRepository(db);
    const tasks = new TaskRepository(db);
    const makeSession = async (title: string) => {
      const branch = await branches.create({
        branch_id: generateId() as BranchID,
        repo_id: repo.repo_id,
        name: `${title}-${generateId()}`,
        ref: 'main',
        branch_unique_id: branchSequence++,
        path: `/tmp/${generateId()}`,
        created_by: user.user_id,
      });
      await branches.addOwner(branch.branch_id, user.user_id);
      const session = await sessions.create({
        session_id: generateId() as SessionID,
        branch_id: branch.branch_id,
        created_by: user.user_id as UserID,
        agentic_tool: 'codex',
        status: SessionStatus.IDLE,
        title,
        tasks: [],
      });
      return { branch, session };
    };
    const origin = await makeSession('origin');
    const terminal = await makeSession('terminal');
    const originTask = await tasks.create({
      task_id: generateId() as TaskID,
      session_id: origin.session.session_id,
      created_by: user.user_id,
      full_prompt: 'request work',
      status: TaskStatus.RUNNING,
      tool_use_count: 0,
    });
    const terminalTask = await tasks.create({
      task_id: generateId() as TaskID,
      session_id: terminal.session.session_id,
      created_by: user.user_id,
      full_prompt: 'perform work',
      status: TaskStatus.RUNNING,
      tool_use_count: 0,
    });
    const subscription = await new CompletionSubscriptionRepository(db).createRoot({
      requested_by_user_id: user.user_id as UserID,
      origin_session_id: origin.session.session_id,
      origin_task_id: originTask.task_id,
      callback_session_id: origin.session.session_id,
      root_session_id: terminal.session.session_id,
      root_task_id: terminalTask.task_id,
      root_branch_id: terminal.branch.branch_id,
    });
    await tasks.update(terminalTask.task_id, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-08-26T08:00:00.000Z',
    });

    const emitted = vi.fn();
    const triggerQueueProcessing = vi.fn(async () => undefined);
    const app = {
      service: vi.fn((name: string) => {
        if (name === 'users') return { get: vi.fn(async () => user) };
        if (name === 'sessions') {
          return {
            get: vi.fn(async (id: string) => {
              const session = await sessions.findById(id);
              if (!session) throw new Error('session not found');
              return {
                ...session,
                url: `https://ui.example.invalid/ui/s/${session.session_id}/`,
              };
            }),
            triggerQueueProcessing,
          };
        }
        if (name === 'tasks') {
          return {
            get: vi.fn(async (id: string) => {
              const task = await tasks.findById(id);
              if (!task) throw new Error('task not found');
              return task;
            }),
            emit: emitted,
          };
        }
        if (name === 'messages') return { find: vi.fn(async () => []) };
        if (name === 'branches') {
          return {
            get: vi.fn(async (id: string) => {
              const branch = await branches.findById(id);
              if (!branch) throw new Error('branch not found');
              return { ...branch, url: `https://ui.example.invalid/ui/b/${branch.branch_id}/` };
            }),
          };
        }
        throw new Error(`unexpected service ${name}`);
      }),
    } as unknown as Application;

    const firstWorker = new CompletionSubscriptionWorker(db, app, { tenantId: 'default' });
    await firstWorker.checkOnce();
    const delivered = await new CompletionSubscriptionRepository(db).get(
      subscription.subscription_id
    );
    expect(delivered).toMatchObject({ state: 'delivered', terminal_status: 'completed' });
    const deliveryTask = await tasks.findById(delivered.delivery_task_id!);
    expect(deliveryTask?.full_prompt).toContain('https://ui.example.invalid/ui/s/');
    expect(deliveryTask?.full_prompt).toContain('https://ui.example.invalid/ui/b/');
    expect(triggerQueueProcessing).toHaveBeenCalledTimes(1);

    // A fresh dispatcher instance sees the durable delivered state and creates
    // no second recipient-visible task.
    const restartedWorker = new CompletionSubscriptionWorker(db, app, { tenantId: 'default' });
    await restartedWorker.checkOnce();
    const originTasks = await tasks.findBySession(origin.session.session_id);
    expect(originTasks.filter((task) => task.metadata?.completion_subscription_id)).toHaveLength(1);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(triggerQueueProcessing).toHaveBeenCalledTimes(1);
  }
);
