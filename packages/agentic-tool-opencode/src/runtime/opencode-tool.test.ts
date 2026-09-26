import {
  renderAgorSessionIdentity,
  renderAgorSystemPrompt,
} from '@agor/core/templates/session-context';
import type { EffortLevel, SessionID } from '@agor/core/types';
import type { createOpencodeClient } from '@opencode-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeCleanupUnverifiedError } from './managed-server.js';
import { OpenCodeTool } from './opencode-tool.js';

type AbortResponse = { data: boolean; error: undefined } | { data: undefined; error: unknown };

type AbortClient = {
  session: {
    abort: (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<AbortResponse>;
  };
};

function abortActiveSession(client: AbortClient): Promise<void> {
  const tool = new OpenCodeTool({});
  return (
    tool as unknown as {
      abortActiveSession(
        client: AbortClient,
        openCodeSessionId: string,
        directory: string
      ): Promise<void>;
    }
  ).abortActiveSession(client, 'session-1', '/workspace');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function settleRuntimeCleanup(
  activeSessionAbort: Promise<void>,
  collectorStop: Promise<void>,
  close: () => Promise<void>
): Promise<void> {
  const tool = new OpenCodeTool({});
  return (
    tool as unknown as {
      settleRuntimeCleanup(
        activeSessionAbort: Promise<void>,
        collectorStop: Promise<void>,
        close: () => Promise<void>
      ): Promise<void>;
    }
  ).settleRuntimeCleanup(activeSessionAbort, collectorStop, close);
}

async function submittedPrompt(
  effort?: EffortLevel,
  identity: { agorSessionId?: SessionID; existingOpenCodeSessionId?: string } = {
    agorSessionId: 'session-1' as SessionID,
  },
  userPrompt = 'Continue'
) {
  type PromptRequest = Parameters<ReturnType<typeof createOpencodeClient>['session']['prompt']>[0];
  const prompt = vi.fn(async (_request: PromptRequest) => ({ error: { name: 'PromptError' } }));
  const stream = (async function* () {})();
  const client = {
    event: { subscribe: vi.fn(async () => ({ stream })) },
    session: {
      create: vi.fn(async () => ({ data: { id: 'opencode-session-1' } })),
      get: vi.fn(async () => ({ data: { id: 'opencode-session-1' } })),
      messages: vi.fn(async () => ({ data: [], error: undefined })),
      prompt,
    },
  };
  const tool = new OpenCodeTool({});
  const runtime = tool as unknown as {
    resolveSession(
      client: unknown,
      input: unknown
    ): Promise<{ openCodeSessionId: string; sessionWasCreated: boolean }>;
    executeTask(
      client: unknown,
      input: unknown,
      context: unknown,
      callbacks: undefined,
      registerStop: (stop: () => Promise<void>) => void,
      sanitizer: { error(value: unknown): Error }
    ): Promise<unknown>;
  };
  const input = {
    ...identity,
    taskId: 'task-1',
    prompt: userPrompt,
    agorAssistantMessageId: 'message-1',
    effort,
    signal: new AbortController().signal,
    title: 'Test session',
    directory: '/workspace',
    persistOpenCodeSessionId: vi.fn(),
  };
  const resolved = await runtime.resolveSession(client, input);
  expect(resolved.sessionWasCreated).toBe(!identity.existingOpenCodeSessionId);
  expect(client.session.create).toHaveBeenCalledTimes(identity.existingOpenCodeSessionId ? 0 : 1);
  expect(client.session.get).toHaveBeenCalledTimes(identity.existingOpenCodeSessionId ? 1 : 0);

  await expect(
    runtime.executeTask(
      client,
      input,
      {
        opencodeSessionId: resolved.openCodeSessionId,
        provider: 'openai',
        model: 'gpt-test',
        branchPath: '/workspace',
      },
      undefined,
      () => undefined,
      { error: (value) => (value instanceof Error ? value : new Error(String(value))) }
    )
  ).rejects.toThrow(/prompt failed/i);

  return prompt.mock.calls[0]?.[0];
}

function assertExplicitModelAvailable(model: Record<string, unknown>, effort?: EffortLevel) {
  const tool = new OpenCodeTool({});
  const client = {
    config: {
      providers: vi.fn(async () => ({
        data: { providers: [{ id: 'openai', models: { 'gpt-test': model } }] },
        error: undefined,
      })),
    },
    provider: {
      list: vi.fn(async () => ({ data: { connected: ['openai'] }, error: undefined })),
    },
  };
  return (
    tool as unknown as {
      assertExplicitModelAvailable(
        client: unknown,
        directory: string,
        provider: string,
        model: string,
        effort?: EffortLevel
      ): Promise<void>;
    }
  ).assertExplicitModelAvailable(client, '/workspace', 'openai', 'gpt-test', effort);
}

describe('OpenCodeTool abort cleanup', () => {
  it('keeps the managed server alive until active-session abort settles', async () => {
    const activeSessionAbort = deferred<void>();
    const collectorStop = deferred<void>();
    const close = vi.fn(async () => undefined);
    const cleanup = settleRuntimeCleanup(activeSessionAbort.promise, collectorStop.promise, close);

    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    activeSessionAbort.resolve();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    collectorStop.resolve();

    await expect(cleanup).resolves.toBeUndefined();
  });

  it('still closes the managed server when active-session abort fails', async () => {
    const abortFailure = new OpenCodeCleanupUnverifiedError('abort transport failed');
    const close = vi.fn(async () => undefined);

    await expect(
      settleRuntimeCleanup(Promise.reject(abortFailure), Promise.resolve(), close)
    ).rejects.toBe(abortFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves a successful SDK abort response', async () => {
    const abort = vi.fn(async () => ({ data: true, error: undefined }) as const);

    await expect(abortActiveSession({ session: { abort } })).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { directory: '/workspace' },
    });
  });

  it('converts a thrown SDK abort error into cleanup-unverified failure', async () => {
    const sdkError = new Error('abort transport failed');
    const abort = vi.fn(async () => {
      throw sdkError;
    });

    await expect(abortActiveSession({ session: { abort } })).rejects.toMatchObject({
      name: 'OpenCodeCleanupUnverifiedError',
      cause: sdkError,
    });
  });

  it.each([
    ['negative', { data: false, error: undefined }],
    ['error', { data: undefined, error: { name: 'NotFoundError' } }],
  ] as const)(
    'converts an SDK %s abort response into cleanup-unverified failure',
    async (_, reply) => {
      const abort = vi.fn(async () => reply);

      await expect(abortActiveSession({ session: { abort } })).rejects.toBeInstanceOf(
        OpenCodeCleanupUnverifiedError
      );
    }
  );
});

describe('OpenCodeTool prompt variants', () => {
  it('sends fresh system identity on first/resumed requests without changing user text', async () => {
    const staticPrompt = await renderAgorSystemPrompt();
    const userPrompt = '  Continue\nwith the exact user prompt.\n';
    for (const identity of [
      { agorSessionId: 'tenant-A-session' as SessionID },
      {
        agorSessionId: 'tenant-A-session' as SessionID,
        existingOpenCodeSessionId: 'opencode-session-1',
      },
      { agorSessionId: 'tenant-B-session' as SessionID },
    ]) {
      const request = await submittedPrompt(undefined, identity, userPrompt);
      expect(request?.body?.parts).toEqual([{ type: 'text', text: userPrompt }]);
      expect(request?.body?.system).toBe(
        `${staticPrompt}\n\n${renderAgorSessionIdentity(identity.agorSessionId)}`
      );
      expect(request?.body?.system).not.toContain('opencode-session-1');
      if (identity.agorSessionId === 'tenant-B-session') {
        expect(request?.body?.system).not.toContain('tenant-A-session');
      }
    }
  });

  it('retains only static orientation when runtime identity is absent', async () => {
    // Production requires an Agor ID; defend the request boundary against an
    // absent runtime value without substituting the provider session ID.
    const request = await submittedPrompt(undefined, {});

    expect(request?.body?.system).toBe(await renderAgorSystemPrompt());
    expect(request?.body?.parts).toEqual([{ type: 'text', text: 'Continue' }]);
  });

  it('submits the configured Agor effort as the native prompt variant alongside the Agor system prompt', async () => {
    const request = await submittedPrompt('max');

    expect(request?.body).toMatchObject({ variant: 'max' });
    expect(request?.body?.system).toContain('Agor Session Context');
    expect(request?.body?.system).toContain('agor_sessions_get_current_context');
  });

  it('admits an effort exposed as a native model variant', async () => {
    await expect(
      assertExplicitModelAvailable({ id: 'gpt-test', variants: { max: {} } }, 'max')
    ).resolves.toBeUndefined();
  });

  it('rejects an unsupported effort before prompt submission without exposing catalog secrets', async () => {
    const error = await assertExplicitModelAvailable(
      {
        id: 'gpt-test',
        variants: { high: { apiKey: 'must-not-cross' } },
      },
      'max'
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/reasoning effort.*not available/i);
    expect((error as Error).message).not.toContain('must-not-cross');
  });

  it('omits the native prompt variant but still submits the Agor system prompt when effort is unset', async () => {
    const request = await submittedPrompt();

    expect(request?.body).not.toHaveProperty('variant');
    expect(request?.body?.system).toContain('Agor Session Context');
  });
});
