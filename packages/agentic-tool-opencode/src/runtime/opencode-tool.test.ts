import type { EffortLevel, MessageID, SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { type ManagedOpenCodeServer, OpenCodeCleanupUnverifiedError } from './managed-server.js';
import {
  OpenCodeTool,
  type OpenCodeToolDependencies,
  type RunOpenCodeTurnInput,
} from './opencode-tool.js';

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

function inspectPairAvailability(input: {
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
      inspectExplicitModelAvailability(
        client: unknown,
        directory: string,
        provider: string,
        model: string,
        effort?: EffortLevel
      ): Promise<'available' | 'curated-refresh-required'>;
    }
  ).inspectExplicitModelAvailability(
    client,
    '/workspace',
    input.providerId,
    input.modelId,
    input.effort
  );
}

function coldCatalogHarness(input: {
  abortDuringRefresh?: boolean;
  model?: string;
  omitDataHome?: boolean;
  refreshedModelAvailable?: boolean;
  refreshFailure?: Error;
  restartFailure?: Error;
  warm?: boolean;
}) {
  const events: string[] = [];
  const controller = new AbortController();
  const servers: ManagedOpenCodeServer[] = [];
  let starts = 0;
  let cacheRefreshed = Boolean(input.warm);
  const startManagedServer = vi.fn(async () => {
    starts += 1;
    events.push(`start:${starts}`);
    if (starts === 2 && input.restartFailure) throw input.restartFailure;
    const index = starts;
    const server: ManagedOpenCodeServer = {
      baseUrl: `http://server-${index}`,
      authorization: `Basic server-${index}`,
      sanitizer: {
        text: (value) => value,
        error: (value) => (value instanceof Error ? value : new Error(String(value))),
      },
      close: vi.fn(async () => {
        events.push(`close:${index}`);
      }),
    };
    servers.push(server);
    return server;
  });
  const refreshModels = vi.fn(async () => {
    events.push('refresh');
    if (input.abortDuringRefresh) {
      controller.abort();
      throw new Error('native refresh aborted');
    }
    if (input.refreshFailure) throw input.refreshFailure;
    cacheRefreshed = true;
  });
  const createClient = ((options: { baseUrl?: string }) => {
    const executingFreshCatalog =
      options.baseUrl === 'http://server-2' &&
      cacheRefreshed &&
      input.refreshedModelAvailable !== false;
    const warmCatalog = options.baseUrl === 'http://server-1' && input.warm;
    const models =
      executingFreshCatalog || warmCatalog
        ? { 'grok-4.6': { id: 'grok-4.6' } }
        : { 'kimi-k3': { id: 'kimi-k3', options: { apiKey: 'must-not-cross' } } };
    return {
      config: {
        providers: vi.fn(async () => ({
          data: { providers: [{ id: 'opencode-go', models }] },
          error: undefined,
        })),
      },
      provider: {
        list: vi.fn(async () => ({
          data: { connected: ['opencode-go'] },
          error: undefined,
        })),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: 'native-session' }, error: undefined })),
      },
    };
  }) as NonNullable<OpenCodeToolDependencies['createClient']>;
  const tool = new OpenCodeTool({
    resolveInvocationConfig: async () => ({ mcp: {} }),
    startManagedServer,
    refreshModels,
    createClient,
  });
  const executeTask = vi.fn(async () => {
    events.push('prompt');
    return {
      content: 'GROK_4_6_OPENCODE_GO_OK',
      contentBlocks: [],
      toolUses: [],
      metadata: {},
    };
  });
  (
    tool as unknown as {
      executeTask: typeof executeTask;
    }
  ).executeTask = executeTask;
  const persistOpenCodeSessionId = vi.fn(async () => undefined);
  const turn: RunOpenCodeTurnInput = {
    agorSessionId: 'agor-session' as SessionID,
    taskId: 'task' as TaskID,
    prompt: 'Return the smoke marker',
    agorAssistantMessageId: 'message' as MessageID,
    title: 'Cold catalog smoke',
    directory: '/workspace',
    provider: 'opencode-go',
    model: input.model ?? 'grok-4.6',
    mcpToken: 'must-not-cross',
    dataHome: input.omitDataHome
      ? undefined
      : '/home/alice/.local/share/agor/opencode/private-namespace',
    signal: controller.signal,
    persistOpenCodeSessionId,
  };
  return {
    events,
    executeTask,
    persistOpenCodeSessionId,
    refreshModels,
    run: () => tool.runTurn(turn),
    servers,
    startManagedServer,
    turn,
  };
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

describe('OpenCodeTool stale-catalog detection', () => {
  // A fresh server can serve a stale bundled catalog for its whole lifetime;
  // curated membership is only a signal to refresh and restart it.
  const staleGoCatalog = [
    {
      id: 'opencode-go',
      models: { 'kimi-k3': { id: 'kimi-k3', options: { apiKey: 'must-not-cross' } } },
    },
  ];

  it('detects a curated pair that requires refresh without treating it as executable', async () => {
    await expect(
      inspectPairAvailability({
        providerId: 'opencode-go',
        modelId: 'qwen3.8-flash',
        connected: ['opencode-go'],
        catalogProviders: staleGoCatalog,
      })
    ).resolves.toBe('curated-refresh-required');

    await expect(
      assertPairAvailable({
        providerId: 'opencode-go',
        modelId: 'qwen3.8-flash',
        connected: ['opencode-go'],
        catalogProviders: staleGoCatalog,
      })
    ).rejects.toThrow(/provider\/model is not available/i);
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

  it('does not use a curated pair to bypass exact effort validation', async () => {
    await expect(
      assertPairAvailable({
        providerId: 'opencode-go',
        modelId: 'qwen3.8-flash',
        connected: ['opencode-go'],
        catalogProviders: staleGoCatalog,
        effort: 'max',
      })
    ).rejects.toThrow(/provider\/model is not available/i);
  });
});

describe('OpenCodeTool cold model catalog lifecycle', () => {
  it('refreshes the private cache, restarts, exactly revalidates, and prompts on the new server', async () => {
    const harness = coldCatalogHarness({});

    await expect(harness.run()).resolves.toMatchObject({
      openCodeSessionId: 'native-session',
      sessionWasCreated: true,
      finalMessage: { content: 'GROK_4_6_OPENCODE_GO_OK' },
    });

    expect(harness.events).toEqual([
      'start:1',
      'close:1',
      'refresh',
      'start:2',
      'prompt',
      'close:2',
    ]);
    expect(harness.refreshModels).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'opencode-go',
        dataHome: harness.turn.dataHome,
        signal: harness.turn.signal,
      }),
      expect.any(Object)
    );
    expect(harness.executeTask).toHaveBeenCalledOnce();
    expect(harness.persistOpenCodeSessionId).toHaveBeenCalledWith('native-session');
  });

  it('leaves warm-cache execution unchanged without a refresh or restart', async () => {
    const harness = coldCatalogHarness({ warm: true });

    await expect(harness.run()).resolves.toMatchObject({
      finalMessage: { content: 'GROK_4_6_OPENCODE_GO_OK' },
    });

    expect(harness.events).toEqual(['start:1', 'prompt', 'close:1']);
    expect(harness.refreshModels).not.toHaveBeenCalled();
    expect(harness.startManagedServer).toHaveBeenCalledOnce();
  });

  it('fails safely when the cache refresh fails and does not submit a prompt', async () => {
    const harness = coldCatalogHarness({
      refreshFailure: new Error('refresh exposed must-not-cross'),
    });

    const failure = await harness.run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not refresh/i);
    expect((failure as Error).message).not.toContain('must-not-cross');
    expect(((failure as Error).cause as Error | undefined)?.message).not.toContain(
      'must-not-cross'
    );
    expect(harness.events).toEqual(['start:1', 'close:1', 'refresh']);
    expect(harness.executeTask).not.toHaveBeenCalled();
  });

  it('preserves task cancellation during refresh without restarting or prompting', async () => {
    const harness = coldCatalogHarness({ abortDuringRefresh: true });

    await expect(harness.run()).rejects.toThrow(/turn was aborted during model catalog refresh/i);

    expect(harness.events).toEqual(['start:1', 'close:1', 'refresh']);
    expect(harness.startManagedServer).toHaveBeenCalledOnce();
    expect(harness.executeTask).not.toHaveBeenCalled();
  });

  it('preserves an unverified refresh cleanup failure instead of masking it as refresh failure', async () => {
    const harness = coldCatalogHarness({
      refreshFailure: new OpenCodeCleanupUnverifiedError('refresh cleanup must-not-cross'),
    });

    const failure = await harness.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: 'OpenCodeCleanupUnverifiedError' });
    expect((failure as Error).message).not.toContain('must-not-cross');
    expect(harness.events).toEqual(['start:1', 'close:1', 'refresh']);
    expect(harness.executeTask).not.toHaveBeenCalled();
  });

  it('does not refresh an inherited shared cache when the private data home is missing', async () => {
    const harness = coldCatalogHarness({ omitDataHome: true });

    await expect(harness.run()).rejects.toThrow(/provider\/model is not available/i);

    expect(harness.events).toEqual(['start:1', 'close:1']);
    expect(harness.refreshModels).not.toHaveBeenCalled();
    expect(harness.executeTask).not.toHaveBeenCalled();
  });

  it('does not retry a genuinely unavailable non-curated model', async () => {
    const harness = coldCatalogHarness({ model: 'no-such-model' });

    await expect(harness.run()).rejects.toThrow(/provider\/model is not available/i);

    expect(harness.events).toEqual(['start:1', 'close:1']);
    expect(harness.refreshModels).not.toHaveBeenCalled();
    expect(harness.executeTask).not.toHaveBeenCalled();
  });

  it('fails safely when the refreshed server cannot restart', async () => {
    const harness = coldCatalogHarness({
      restartFailure: new Error('restart exposed must-not-cross'),
    });

    const failure = await harness.run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not reload/i);
    expect((failure as Error).message).not.toContain('must-not-cross');
    expect(harness.events).toEqual(['start:1', 'close:1', 'refresh', 'start:2']);
    expect(harness.executeTask).not.toHaveBeenCalled();
  });

  it('fails closed when the restarted executing server still lacks the exact pair', async () => {
    const harness = coldCatalogHarness({ refreshedModelAvailable: false });

    await expect(harness.run()).rejects.toThrow(/provider\/model is not available/i);

    expect(harness.events).toEqual(['start:1', 'close:1', 'refresh', 'start:2', 'close:2']);
    expect(harness.executeTask).not.toHaveBeenCalled();
    expect(harness.persistOpenCodeSessionId).not.toHaveBeenCalled();
  });
});
