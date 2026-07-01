/**
 * Tests for `classifyMissingCredentialFailure` — the before-create hook on
 * the `messages` service that swaps the raw provider CLI/SDK error text for
 * a structured "missing credential" classification.
 *
 * The behavior under test: classification must be driven entirely by
 * `resolveApiKey`'s resolution result (user > config.yaml > env > native
 * auth) — never by inspecting the error text itself — and must never touch
 * messages the executor didn't mark as a task-failure notice.
 */

import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository } from '@agor/core/db';
import type { HookContext, Message, Session, Task } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMissingCredentialFailure } from './classify-missing-credential';

vi.mock('@agor/core/config', () => ({
  resolveApiKey: vi.fn(),
}));

const TOOL_DISPLAY_NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode' };

function makeContext(data: Partial<Message> | undefined): HookContext {
  return { data } as unknown as HookContext;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return { task_id: 'task-1', session_id: 'session-1', created_by: 'user-1', ...overrides } as Task;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return { session_id: 'session-1', agentic_tool: 'claude-code', ...overrides } as Session;
}

describe('classifyMissingCredentialFailure', () => {
  let taskRepository: Pick<TaskRepository, 'findById'>;
  let sessionsRepository: Pick<SessionRepository, 'findById'>;

  beforeEach(() => {
    vi.mocked(resolveApiKey).mockReset();
    taskRepository = { findById: vi.fn().mockResolvedValue(makeTask()) };
    sessionsRepository = { findById: vi.fn().mockResolvedValue(makeSession()) };
  });

  function runHook() {
    return classifyMissingCredentialFailure(
      {} as never,
      taskRepository,
      sessionsRepository,
      TOOL_DISPLAY_NAMES
    );
  }

  const failureMessage: Partial<Message> = {
    task_id: 'task-1' as Message['task_id'],
    session_id: 'session-1' as Message['session_id'],
    content: 'Claude SDK error after 3 messages: Not logged in · Please run /login',
    metadata: { is_task_failure: true },
  };

  it('classifies as missing_credential when no credential resolves anywhere', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: true,
    });

    const ctx = await runHook()(makeContext({ ...failureMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBe('missing_credential');
    expect((ctx.data as Message).metadata?.tool).toBe('claude-code');
    // Raw stderr text must not survive into the persisted content.
    expect((ctx.data as Message).content).not.toContain('/login');
  });

  it('does not classify when a workspace/env-level credential resolves', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-env-key',
      source: 'env',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...failureMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toBe(failureMessage.content);
  });

  it('does not classify when a per-user credential resolves', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...failureMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
  });

  it('does not classify unrelated messages (no is_task_failure marker)', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: true,
    });

    const rateLimitMessage: Partial<Message> = {
      task_id: 'task-1' as Message['task_id'],
      session_id: 'session-1' as Message['session_id'],
      content: 'Rate limited, retrying...',
      metadata: {},
    };

    const ctx = await runHook()(makeContext({ ...rateLimitMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('is a no-op when context.data is undefined', async () => {
    const ctx = await runHook()(makeContext(undefined));
    expect(ctx.data).toBeUndefined();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('falls through untouched for tools with no mapped API key (e.g. opencode)', async () => {
    sessionsRepository.findById = vi
      .fn()
      .mockResolvedValue(makeSession({ agentic_tool: 'opencode' }));

    const ctx = await runHook()(makeContext({ ...failureMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('falls through untouched when the task or session cannot be found', async () => {
    taskRepository.findById = vi.fn().mockResolvedValue(null);

    const ctx = await runHook()(makeContext({ ...failureMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('swallows classification errors and leaves the message untouched', async () => {
    vi.mocked(resolveApiKey).mockRejectedValue(new Error('boom'));

    const ctx = await runHook()(makeContext({ ...failureMessage }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toBe(failureMessage.content);
  });
});
