import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository } from '@agor/core/db';
import type { HookContext, Message, Session, Task } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMissingCredentialFailure } from './classify-missing-credential';

vi.mock('@agor/core/config', () => ({ resolveApiKey: vi.fn() }));

const TOOL_DISPLAY_NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode' };

function makeContext(data: Partial<Message> | undefined): HookContext {
  return {
    data,
    params: {
      provider: 'socketio',
      authentication: { strategy: 'jwt' },
      task_id: 'task-1',
      session_id: 'session-1',
    },
  } as unknown as HookContext;
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

  const explicitCredentialFailure: Partial<Message> = {
    task_id: 'task-1' as Message['task_id'],
    session_id: 'session-1' as Message['session_id'],
    type: 'system',
    role: MessageRole.SYSTEM,
    content: 'No scoped claude-code credential is configured.',
    metadata: {
      is_task_failure: true,
      is_missing_credential_failure: true,
    },
  };

  const zeroTurnResult: Partial<Message> = {
    task_id: 'task-1' as Message['task_id'],
    session_id: 'session-1' as Message['session_id'],
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    content: [{ type: 'text', text: 'upstream auth failure text' }],
    metadata: { is_zero_turn_result: true },
  };

  it('normalizes an explicit executor credential-preflight failure', async () => {
    const ctx = await runHook()(makeContext({ ...explicitCredentialFailure }));
    const result = ctx.data as Message;

    expect(result.metadata).toMatchObject({
      error_kind: 'missing_credential',
      tool: 'claude-code',
    });
    expect(result.type).toBe('system');
    expect(result.role).toBe(MessageRole.SYSTEM);
    expect(result.content).toBe(
      'This session needs to be connected to Claude Code before it can run.'
    );
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('does not mask an unrelated task failure when no credential is currently configured', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      source: 'none',
      useNativeAuth: false,
    });
    const unrelatedFailure = {
      ...explicitCredentialFailure,
      content: 'Git checkout failed',
      metadata: { is_task_failure: true },
    };

    const ctx = await runHook()(makeContext(unrelatedFailure));

    expect((ctx.data as Message).content).toBe('Git checkout failed');
    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('classifies a zero-turn result when no provider credential resolved', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      connection: {},
      source: 'none',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBe('missing_credential');
    expect((ctx.data as Message).type).toBe('system');
  });

  it('preserves legitimate zero-turn output when an API key resolved', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).type).toBe('assistant');
  });

  it('preserves legitimate zero-turn output with a Claude subscription token', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).type).toBe('assistant');
  });

  it('preserves zero-turn output when native auth is configured', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      connection: {},
      source: 'user',
      useNativeAuth: true,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
  });

  it('rejects mismatched task/session associations', async () => {
    taskRepository.findById = vi.fn().mockResolvedValue(makeTask({ session_id: 'session-2' }));

    const ctx = await runHook()(makeContext({ ...explicitCredentialFailure }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
  });

  it('ignores classification markers from a normal user request', async () => {
    const context = makeContext({ ...explicitCredentialFailure });
    context.params = {
      provider: 'socketio',
      authentication: { strategy: 'jwt', payload: { sub: 'user-1' } },
    } as never;

    const ctx = await runHook()(context);

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect(taskRepository.findById).not.toHaveBeenCalled();
  });

  it('falls through for unmapped tools and missing records', async () => {
    sessionsRepository.findById = vi
      .fn()
      .mockResolvedValue(makeSession({ agentic_tool: 'opencode' }));
    let ctx = await runHook()(makeContext({ ...explicitCredentialFailure }));
    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();

    taskRepository.findById = vi.fn().mockResolvedValue(null);
    ctx = await runHook()(makeContext({ ...explicitCredentialFailure }));
    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
  });

  it('swallows resolution errors and leaves the zero-turn message untouched', async () => {
    vi.mocked(resolveApiKey).mockRejectedValue(new Error('boom'));

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toEqual(zeroTurnResult.content);
  });

  it('is a no-op without data or a classification marker', async () => {
    expect((await runHook()(makeContext(undefined))).data).toBeUndefined();

    const ctx = await runHook()(
      makeContext({
        task_id: 'task-1' as Message['task_id'],
        session_id: 'session-1' as Message['session_id'],
        metadata: {},
      })
    );
    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });
});
