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
import { MessageRole } from '@agor/core/types';
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

  describe('zero-token "success" pathway (claude CLI reports success but never called the model)', () => {
    // Reproduces the live repro from a fresh no-credential container: the SDK's
    // result event has subtype 'success' with zero real assistant turns, so
    // message-processor.ts synthesizes the result text into a plain assistant
    // message instead of throwing — no `is_task_failure` marker exists for
    // this pathway, so classification falls back to the zero-token signal.
    const zeroTokenAssistantMessage: Partial<Message> = {
      task_id: 'task-1' as Message['task_id'],
      session_id: 'session-1' as Message['session_id'],
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
      metadata: { tokens: { input: 0, output: 0 } },
    };

    it('classifies a zero-token assistant message when no credential resolves anywhere', async () => {
      vi.mocked(resolveApiKey).mockResolvedValue({
        apiKey: undefined,
        source: 'none',
        useNativeAuth: true,
      });

      const ctx = await runHook()(makeContext({ ...zeroTokenAssistantMessage }));
      const result = ctx.data as Message;

      expect(result.metadata?.error_kind).toBe('missing_credential');
      expect(result.metadata?.tool).toBe('claude-code');
      // Normalized onto system/SYSTEM so the UI has one render branch
      // regardless of which SDK pathway produced the classification.
      expect(result.type).toBe('system');
      expect(result.role).toBe(MessageRole.SYSTEM);
      expect(JSON.stringify(result.content)).not.toContain('/login');
    });

    it('does not classify (and does not touch) a real assistant reply with nonzero tokens', async () => {
      const realReply: Partial<Message> = {
        task_id: 'task-1' as Message['task_id'],
        session_id: 'session-1' as Message['session_id'],
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        content: [{ type: 'text', text: 'Here is the answer.' }],
        metadata: { tokens: { input: 512, output: 24 } },
      };

      const ctx = await runHook()(makeContext({ ...realReply }));

      expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
      expect((ctx.data as Message).type).toBe('assistant');
      expect(resolveApiKey).not.toHaveBeenCalled();
    });

    it('does not reclassify legitimate zero-token output (e.g. /cost) when the user IS authenticated', async () => {
      // Same structural shape as a genuine auth failure (zero tokens, no
      // is_task_failure marker) — this is the local-slash-command case the
      // heuristic can't structurally distinguish from an auth failure.
      // resolveApiKey is the actual arbiter: a real credential means this
      // output is left completely untouched.
      vi.mocked(resolveApiKey).mockResolvedValue({
        apiKey: 'sk-ant-user-key',
        source: 'user',
        useNativeAuth: false,
      });

      const localCommandOutput: Partial<Message> = {
        task_id: 'task-1' as Message['task_id'],
        session_id: 'session-1' as Message['session_id'],
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        content: [{ type: 'text', text: 'Total cost: $0.42' }],
        metadata: { tokens: { input: 0, output: 0 } },
      };

      const ctx = await runHook()(makeContext({ ...localCommandOutput }));
      const result = ctx.data as Message;

      expect(result.metadata?.error_kind).toBeUndefined();
      expect(result.type).toBe('assistant');
      expect(result.role).toBe(MessageRole.ASSISTANT);
      expect(JSON.stringify(result.content)).toContain('Total cost');
    });

    it('does not trigger for user- or system-role messages even with zero tokens', async () => {
      const userMessage: Partial<Message> = {
        task_id: 'task-1' as Message['task_id'],
        session_id: 'session-1' as Message['session_id'],
        type: 'user',
        role: MessageRole.USER,
        content: 'hello',
        metadata: { tokens: { input: 0, output: 0 } },
      };

      const ctx = await runHook()(makeContext({ ...userMessage }));

      expect((ctx.data as Message).metadata?.error_kind).toBeUndefined();
      expect(resolveApiKey).not.toHaveBeenCalled();
    });
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
