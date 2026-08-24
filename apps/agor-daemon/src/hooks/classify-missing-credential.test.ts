import { SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import { resolveApiKey } from '@agor/core/config';
import type { SessionRepository, TaskRepository } from '@agor/core/db';
import type { HookContext, Message, Session, Task } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertExternalProviderFailureMetadataAllowed,
  classifyMissingCredentialFailure,
  protectExternalProviderFailureMetadata,
} from './classify-missing-credential';

vi.mock('@agor/core/config', () => ({ resolveApiKey: vi.fn() }));

const TOOL_DISPLAY_NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode' };

function makeContext(data: Partial<Message> | undefined): HookContext {
  return {
    data,
    params: {
      provider: 'socketio',
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          task_id: 'task-1',
          session_id: 'session-1',
        },
      },
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

  const zeroTurnBillingResult: Partial<Message> = {
    ...zeroTurnResult,
    content: [{ type: 'text', text: 'Credit balance is too low' }],
  };

  const sdkErrorBillingResult: Partial<Message> = {
    ...zeroTurnResult,
    type: 'system',
    role: MessageRole.SYSTEM,
    content: [
      {
        type: 'text',
        text: 'Agent SDK error (error_during_execution): Credit balance is too low',
      },
    ],
    metadata: { is_meta: true, is_provider_failure_result: true },
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

  it('lets missing credential classification win over billing-like provider text', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      connection: {},
      source: 'none',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnBillingResult }));
    const result = ctx.data as Message;

    expect(result.metadata).toMatchObject({
      error_kind: 'missing_credential',
      tool: 'claude-code',
    });
    expect(result.content).toBe(
      'This session needs to be connected to Claude Code before it can run.'
    );
    expect(result.content).not.toContain('Credit balance is too low');
  });

  it('uses fixed generic recovery instead of inferring credit state from provider prose', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnBillingResult }));
    const result = ctx.data as Message;

    expect(result.metadata?.error_kind).toBeUndefined();
    expect(result.type).toBe('assistant');
    expect(result.content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
    expect(result.content).not.toContain('Credit balance is too low');
    expect(result.content_preview).not.toContain('Credit balance is too low');
  });

  it('uses the same fixed recovery for a real SDK-shaped provider failure result', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...sdkErrorBillingResult }));
    const result = ctx.data as Message;

    expect(result.metadata?.error_kind).toBeUndefined();
    expect(result.content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
    expect(result.content).not.toContain('Credit balance is too low');
  });

  it('never passes an unclassified executor provider failure body through persistence', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });
    const sentinel = 'SENTINEL_DAEMON_PROVIDER_FAILURE';

    const ctx = await runHook()(
      makeContext({
        ...sdkErrorBillingResult,
        content: [{ type: 'text', text: `provider returned ${sentinel}` }],
      })
    );

    expect(JSON.stringify(ctx.data)).not.toContain(sentinel);
    expect((ctx.data as Message).content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
  });

  it.each([
    'payment_required',
    'insufficient_quota',
    'quota_exhausted',
    'billing_hard_limit_reached',
    'Credit balance is too low',
    '429 Too Many Requests',
  ])('does not derive recovery authority from provider text: %s', async (providerText) => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(
      makeContext({
        ...zeroTurnResult,
        content: [{ type: 'text', text: providerText }],
      })
    );

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
    expect(JSON.stringify(ctx.data)).not.toContain(providerText);
  });

  it('sanitizes zero-turn output even when an API key resolved', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).type).toBe('assistant');
    expect((ctx.data as Message).content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
  });

  it('does not classify a normal assistant message without the zero-turn marker', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: 'sk-ant-user-key',
      connection: { ANTHROPIC_API_KEY: 'sk-ant-user-key' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(
      makeContext({
        ...zeroTurnBillingResult,
        metadata: {},
      })
    );

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toEqual(zeroTurnBillingResult.content);
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it('does not classify a client-forged zero-turn marker outside executor scope', async () => {
    const context = makeContext({ ...zeroTurnBillingResult });
    context.params = {
      provider: 'socketio',
      authentication: { strategy: 'jwt', payload: { sub: 'user-1' } },
    } as never;

    const ctx = await runHook()(context);

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toEqual(zeroTurnBillingResult.content);
    expect(taskRepository.findById).not.toHaveBeenCalled();
  });

  it('rejects provider-failure markers attributed to another task or session', async () => {
    const wrongTask = makeContext({ ...zeroTurnBillingResult });
    const payload = wrongTask.params.authentication?.payload as Record<string, unknown>;
    wrongTask.params.authentication = {
      strategy: 'jwt',
      payload: { ...payload, task_id: 'task-2' },
    };
    await expect(runHook()(wrongTask)).rejects.toThrow('this task executor');

    const wrongSession = makeContext({ ...zeroTurnBillingResult });
    const sessionPayload = wrongSession.params.authentication?.payload as Record<string, unknown>;
    wrongSession.params.authentication = {
      strategy: 'jwt',
      payload: { ...sessionPayload, session_id: 'session-2' },
    };
    await expect(runHook()(wrongSession)).rejects.toThrow('this task executor');
    expect(taskRepository.findById).not.toHaveBeenCalled();
  });

  it('sanitizes zero-turn output with a Claude subscription token', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      connection: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
      source: 'user',
      useNativeAuth: false,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).type).toBe('assistant');
    expect((ctx.data as Message).content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
  });

  it('sanitizes zero-turn output when native auth is configured', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      apiKey: undefined,
      connection: {},
      source: 'user',
      useNativeAuth: true,
    });

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
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

  it('swallows resolution errors only after closing the zero-turn body', async () => {
    vi.mocked(resolveApiKey).mockRejectedValue(new Error('boom'));

    const ctx = await runHook()(makeContext({ ...zeroTurnResult }));

    expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
    expect((ctx.data as Message).content).toBe(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE);
  });

  it('does not log exception objects when classification fails', async () => {
    const sentinel = 'SENTINEL_CLASSIFIER_EXCEPTION';
    vi.mocked(resolveApiKey).mockRejectedValue(new Error(sentinel));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runHook()(makeContext({ ...sdkErrorBillingResult }));
      expect(JSON.stringify(error.mock.calls)).not.toContain(sentinel);
      expect(error).toHaveBeenCalledWith(
        '[classifyMissingCredentialFailure] classification failed'
      );
    } finally {
      error.mockRestore();
    }
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

describe('protectExternalProviderFailureMetadata', () => {
  const protect = protectExternalProviderFailureMetadata(async () => null);

  it('rejects externally supplied recovery-panel metadata', async () => {
    const context = makeContext({
      metadata: { error_kind: 'provider_credit_exhausted', tool: 'claude-code' },
    });

    await expect(protect(context)).rejects.toThrow(
      'Provider failure metadata can only be classified by the daemon'
    );
  });

  it('allows executor markers before daemon classification and internal projections', async () => {
    const externalContext = makeContext({ metadata: { is_zero_turn_result: true } });
    await expect(protect(externalContext)).resolves.toBe(externalContext);

    const internalContext = makeContext({
      metadata: { error_kind: 'missing_credential', tool: 'claude-code' },
    });
    internalContext.params.provider = undefined;
    await expect(protect(internalContext)).resolves.toBe(internalContext);
  });

  it.each([
    ['clearing metadata', { metadata: {} }],
    ['changing the classified tool', { metadata: { tool: 'codex' } }],
    ['changing the message type', { type: 'assistant' }],
    ['changing the message role', { role: MessageRole.ASSISTANT }],
  ])('rejects external patch attempts at %s', async (_label, data) => {
    const context = makeContext(data);
    context.method = 'patch';
    context.id = 'message-1';

    const patchProtect = protectExternalProviderFailureMetadata(
      async () =>
        ({
          metadata: { error_kind: 'provider_credit_exhausted', tool: 'claude-code' },
        }) as Message
    );

    await expect(patchProtect(context)).rejects.toThrow(
      'Provider failure classification is daemon-owned'
    );
  });

  it('allows external content patches to ordinary messages', async () => {
    const context = makeContext({ content: 'edited', content_preview: 'edited preview' });
    context.method = 'patch';
    context.id = 'message-1';

    const loadMessage = vi.fn().mockResolvedValue({ metadata: {} } as Message);
    const patchProtect = protectExternalProviderFailureMetadata(loadMessage);

    await expect(patchProtect(context)).resolves.toBe(context);
    expect(loadMessage).toHaveBeenCalledWith('message-1');
  });

  it('rejects forged recovery metadata in bulk payloads', () => {
    expect(() =>
      assertExternalProviderFailureMetadataAllowed([
        { type: 'user', content: 'safe' },
        { metadata: { error_kind: 'provider_credit_exhausted', tool: 'claude-code' } },
      ])
    ).toThrow('Provider failure metadata can only be classified by the daemon');
  });

  it('allows ordinary executor bulk messages and their classification markers', () => {
    expect(() =>
      assertExternalProviderFailureMetadataAllowed([
        { metadata: { is_zero_turn_result: true } },
        { metadata: { is_provider_failure_result: true } },
      ])
    ).not.toThrow();
  });
});
