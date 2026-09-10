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

// ── Hosted managed-projection turns ────────────────────────────────────────
// A real child process is replaced by an event emitter that announces the
// loopback listener; the SDK client is a fake whose behavior each test picks.

vi.mock('./native-state.js', () => ({
  publishOpenCodeCheckpoint: vi.fn(async () => ({
    version: 1,
    attemptTaskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 4096,
    openCodeSessionId: 'opencode-session-1',
    publishedAt: '2026-09-10T22:18:55.000Z',
  })),
}));

async function managedTurn(behavior: 'prompt-fails' | 'completes') {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { publishOpenCodeCheckpoint } = await import('./native-state.js');
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      return true;
    }),
  });
  const spawn = vi.fn(() => {
    setTimeout(
      () => child.stdout.write('opencode server listening on http://127.0.0.1:43210\n'),
      0
    );
    return child as never;
  });
  const key = 'sk-ant-managed-secret';
  const authContent = JSON.stringify({ anthropic: { type: 'api', key } });
  const events =
    behavior === 'completes'
      ? [
          {
            type: 'message.updated',
            properties: { info: { id: 'm-1', sessionID: 'opencode-session-1', role: 'assistant' } },
          },
          { type: 'session.idle', properties: { sessionID: 'opencode-session-1' } },
        ]
      : [];
  // Hand-rolled iterator: a pending next() resolves as done once the collector
  // calls return(), which an async generator blocked on a promise cannot do.
  let release: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = [...events];
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const event = pending.shift();
          if (event) return { value: event, done: false as const };
          await closed;
          return { value: undefined, done: true as const };
        },
        async return() {
          release?.();
          return { value: undefined, done: true as const };
        },
      };
    },
    return: async () => {
      release?.();
      return { value: undefined, done: true as const };
    },
  };
  let prompted = false;
  const client = {
    config: {
      providers: vi.fn(async () => ({
        data: {
          providers: [{ id: 'anthropic', models: { 'claude-test': { id: 'claude-test' } } }],
        },
        error: undefined,
      })),
    },
    provider: {
      list: vi.fn(async () => ({ data: { connected: ['anthropic'] }, error: undefined })),
    },
    event: { subscribe: vi.fn(async () => ({ stream })) },
    session: {
      create: vi.fn(async () => ({ data: { id: 'opencode-session-1' } })),
      get: vi.fn(async () => ({ data: { id: 'opencode-session-1' } })),
      messages: vi.fn(async () => ({
        data: prompted
          ? [
              {
                info: { id: 'm-1', sessionID: 'opencode-session-1', role: 'assistant' },
                parts: [{ id: 'p-1', type: 'text', text: 'done' }],
              },
            ]
          : [],
        error: undefined,
      })),
      prompt: vi.fn(async () => {
        prompted = true;
        return behavior === 'prompt-fails'
          ? { error: { name: 'PromptError', message: `provider rejected ${key}` } }
          : { data: {}, error: undefined };
      }),
      abort: vi.fn(async () => ({ data: true, error: undefined })),
    },
  };
  const persistOpenCodeSessionId = vi.fn(async () => undefined);
  const tool = new OpenCodeTool({
    resolveBinary: async () => '/packaged/opencode',
    spawn,
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    createClient: (() => client) as never,
    resolveInvocationConfig: async () => ({ mcp: {} }),
    eventDrainMs: 0,
  });
  const nativeState = {
    scratchRoot: '/scratch/task-1',
    xdg: {
      data: '/scratch/task-1/xdg-data',
      config: '/scratch/task-1/xdg-config',
      cache: '/scratch/task-1/xdg-cache',
      state: '/scratch/task-1/xdg-state',
    },
    liveDbPath: '/scratch/task-1/opencode.db',
    attemptsDir: '/home/user/attempts',
  };
  const run = tool.runTurn({
    agorSessionId: 'session-1' as SessionID,
    taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e' as never,
    prompt: 'Continue',
    agorAssistantMessageId: 'message-1' as never,
    title: 'Managed',
    directory: '/workspace',
    provider: 'anthropic',
    model: 'claude-test',
    signal: new AbortController().signal,
    managed: { authContent, authSecrets: [key, authContent], nativeState, accepted: null },
    persistOpenCodeSessionId,
  });
  return {
    run,
    spawn,
    key,
    authContent,
    nativeState,
    persistOpenCodeSessionId,
    publishOpenCodeCheckpoint,
  };
}

describe('OpenCodeTool managed projection', () => {
  it('projects credentials and scratch roots onto the child only and publishes after a completed turn', async () => {
    const {
      run,
      spawn,
      authContent,
      nativeState,
      persistOpenCodeSessionId,
      publishOpenCodeCheckpoint,
    } = await managedTurn('completes');
    const result = await run;
    const env = (
      spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    )[2].env;
    expect(env).toMatchObject({
      XDG_DATA_HOME: nativeState.xdg.data,
      XDG_CONFIG_HOME: nativeState.xdg.config,
      XDG_CACHE_HOME: nativeState.xdg.cache,
      XDG_STATE_HOME: nativeState.xdg.state,
      OPENCODE_DB: nativeState.liveDbPath,
      OPENCODE_AUTH_CONTENT: authContent,
    });
    expect(process.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(persistOpenCodeSessionId).not.toHaveBeenCalled();
    expect(publishOpenCodeCheckpoint).toHaveBeenCalledWith(nativeState, {
      taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
      openCodeSessionId: 'opencode-session-1',
    });
    expect(result.nativeStateAttempt?.openCodeSessionId).toBe('opencode-session-1');
  });

  it('redacts projected keys from a failed turn and publishes nothing', async () => {
    const { run, key, persistOpenCodeSessionId, publishOpenCodeCheckpoint } =
      await managedTurn('prompt-fails');
    vi.mocked(publishOpenCodeCheckpoint).mockClear();
    let failure: Error | undefined;
    try {
      await run;
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(`${failure?.message}\n${failure?.stack ?? ''}`).not.toContain(key);
    expect(publishOpenCodeCheckpoint).not.toHaveBeenCalled();
    expect(persistOpenCodeSessionId).not.toHaveBeenCalled();
  });
});
