import type { EffortLevel } from '@agor/core/types';
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

async function submittedPrompt(effort?: EffortLevel) {
  const prompt = vi.fn(async () => ({ error: { name: 'PromptError' } }));
  const stream = (async function* () {})();
  const client = {
    event: { subscribe: vi.fn(async () => ({ stream })) },
    session: {
      messages: vi.fn(async () => ({ data: [], error: undefined })),
      prompt,
    },
  };
  const tool = new OpenCodeTool({});
  const executeTask = (
    tool as unknown as {
      executeTask(
        client: unknown,
        input: unknown,
        context: unknown,
        callbacks: undefined,
        registerStop: (stop: () => Promise<void>) => void,
        sanitizer: { error(value: unknown): Error }
      ): Promise<unknown>;
    }
  ).executeTask.bind(tool);

  await expect(
    executeTask(
      client,
      {
        agorSessionId: 'session-1',
        taskId: 'task-1',
        prompt: 'Continue',
        agorAssistantMessageId: 'message-1',
        effort,
        signal: new AbortController().signal,
      },
      {
        opencodeSessionId: 'opencode-session-1',
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

function assertPairAvailable(input: {
  providerId: string;
  modelId: string;
  connected: string[];
  catalogProviders: Array<{ id: string; models: Record<string, unknown> }>;
  effort?: EffortLevel;
}) {
  const tool = new OpenCodeTool({});
  const client = {
    config: {
      providers: vi.fn(async () => ({
        data: { providers: input.catalogProviders },
        error: undefined,
      })),
    },
    provider: {
      list: vi.fn(async () => ({ data: { connected: input.connected }, error: undefined })),
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
  ).assertExplicitModelAvailable(
    client,
    '/workspace',
    input.providerId,
    input.modelId,
    input.effort
  );
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

describe('OpenCodeTool stale-catalog admission', () => {
  // A fresh server can serve a stale bundled catalog for its whole lifetime;
  // the curated pinned-runtime catalog acts as the secondary witness.
  const staleGoCatalog = [
    {
      id: 'opencode-go',
      models: { 'kimi-k3': { id: 'kimi-k3', options: { apiKey: 'must-not-cross' } } },
    },
  ];

  it('admits a curated pinned-runtime pair missing from a connected provider stale snapshot', async () => {
    await expect(
      assertPairAvailable({
        providerId: 'opencode-go',
        modelId: 'qwen3.8-flash',
        connected: ['opencode-go'],
        catalogProviders: staleGoCatalog,
      })
    ).resolves.toBeUndefined();
  });

  it('still requires live connection evidence for a curated pair', async () => {
    const error = await assertPairAvailable({
      providerId: 'opencode-go',
      modelId: 'qwen3.8-flash',
      connected: [],
      catalogProviders: staleGoCatalog,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/provider\/model is not available/i);
  });

  it('rejects a genuinely absent pair deterministically without exposing catalog secrets', async () => {
    const error = await assertPairAvailable({
      providerId: 'opencode-go',
      modelId: 'no-such-model',
      connected: ['opencode-go'],
      catalogProviders: staleGoCatalog,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/provider\/model is not available/i);
    expect((error as Error).message).not.toContain('must-not-cross');
  });

  it('defers effort validation to the runtime for a witness-admitted pair', async () => {
    await expect(
      assertPairAvailable({
        providerId: 'opencode-go',
        modelId: 'qwen3.8-flash',
        connected: ['opencode-go'],
        catalogProviders: staleGoCatalog,
        effort: 'max',
      })
    ).resolves.toBeUndefined();
  });
});
