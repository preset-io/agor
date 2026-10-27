import {
  renderAgorSessionIdentity,
  renderAgorSystemPrompt,
} from '@agor/core/templates/session-context';
import type { EffortLevel, SessionID } from '@agor/core/types';
import type { createOpencodeClient } from '@opencode-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeCleanupUnverifiedError } from './managed-server.js';
import {
  type OpenCodeCanUseToolCallback,
  OpenCodeInteractionTimeoutError,
  type OpenCodeRetryBudget,
  OpenCodeTool,
  openCodePartialMessage,
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

async function submittedPrompt(
  effort?: EffortLevel,
  identity: { agorSessionId?: SessionID; existingOpenCodeSessionId?: string } = {
    agorSessionId: 'session-1' as SessionID,
  },
  userPrompt = 'Continue',
  mcpSignInNotice?: string
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
        mcpSignInNotice,
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

  it('appends the MCP sign-in notice to the per-turn system context, not the user text', async () => {
    const request = await submittedPrompt(
      undefined,
      { agorSessionId: 'session-1' as SessionID },
      'Continue',
      '## MCP servers that need sign-in'
    );
    expect(request?.body?.system).toBe(
      `${await renderAgorSystemPrompt()}\n\n${renderAgorSessionIdentity('session-1' as SessionID)}\n\n## MCP servers that need sign-in`
    );
    expect(request?.body?.parts).toEqual([{ type: 'text', text: 'Continue' }]);
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

describe('OpenCodeTool provider failures', () => {
  async function failedTurn(events: unknown[], retryBudget?: OpenCodeRetryBudget) {
    const stream = (async function* () {
      for (const event of events) yield event;
      await new Promise(() => undefined);
    })();
    const client = {
      event: { subscribe: vi.fn(async () => ({ stream })) },
      session: {
        messages: vi.fn(async () => ({ data: [], error: undefined })),
        // OpenCode's prompt call blocks while it retries the provider.
        prompt: vi.fn(() => new Promise(() => undefined)),
      },
    };
    const runtime = new OpenCodeTool({ retryBudget }) as unknown as {
      executeTask(...args: unknown[]): Promise<unknown>;
    };
    const started = Date.now();
    const result = runtime.executeTask(
      client,
      {
        agorSessionId: 'session-1',
        taskId: 'task-1',
        prompt: 'hi',
        agorAssistantMessageId: 'message-1',
        signal: new AbortController().signal,
        title: 'Test',
        directory: '/workspace',
        persistOpenCodeSessionId: vi.fn(),
      },
      {
        opencodeSessionId: 'opencode-session-1',
        provider: 'any-provider',
        model: 'any-model',
        branchPath: '/workspace',
      },
      undefined,
      () => undefined,
      { error: (value: unknown) => (value instanceof Error ? value : new Error(String(value))) }
    );
    return { result, started };
  }

  const retry = (attempt: number, message: string, nextInMs = 1_000) => ({
    type: 'session.status',
    properties: {
      sessionID: 'opencode-session-1',
      status: { type: 'retry', attempt, message, next: Date.now() + nextInMs },
    },
  });

  it('fails fast with the provider reason once the retry budget is spent', async () => {
    const { result, started } = await failedTurn([
      retry(1, 'Insufficient balance'),
      retry(2, 'Insufficient balance'),
      retry(3, 'Insufficient balance'),
    ]);
    await expect(result).rejects.toThrow(
      'OpenCode prompt failed for any-provider/any-model: gave up after 3 provider retries: Insufficient balance'
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails after the wait budget when no further retry event arrives', async () => {
    const { result, started } = await failedTurn([retry(1, 'Insufficient balance', 10)], {
      maxRetries: 2,
      maxWaitMs: 100,
    });
    await expect(result).rejects.toThrow(
      'OpenCode prompt failed for any-provider/any-model: gave up after 0.1s of provider retries: Insufficient balance'
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops the wait budget once the model produces output after a retry', async () => {
    const { result } = await failedTurn(
      [
        retry(1, 'overloaded', 10),
        {
          type: 'message.updated',
          properties: { info: { id: 'a-1', sessionID: 'opencode-session-1', role: 'assistant' } },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'p-1',
              sessionID: 'opencode-session-1',
              messageID: 'a-1',
              type: 'text',
              text: '',
            },
          },
        },
        {
          type: 'message.part.delta',
          properties: {
            sessionID: 'opencode-session-1',
            messageID: 'a-1',
            partID: 'p-1',
            field: 'text',
            delta: 'Hi',
          },
        },
      ],
      { maxRetries: 2, maxWaitMs: 100 }
    );
    const outcome = await Promise.race([
      result.then(
        () => 'resolved',
        (error: Error) => error.message
      ),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 400)),
    ]);
    expect(outcome).toBe('still running');
  });

  it('surfaces the provider error message instead of a generic reconnect hint', async () => {
    const { result } = await failedTurn([
      {
        type: 'session.error',
        properties: {
          sessionID: 'opencode-session-1',
          error: { name: 'APIError', data: { message: 'model not found', statusCode: 404 } },
        },
      },
    ]);
    await expect(result).rejects.toThrow(
      'OpenCode prompt failed for any-provider/any-model: model not found'
    );
  });
});

describe('OpenCodeTool permission rejections', () => {
  const SESSION = 'opencode-session-1';
  const MCP_TOOL = 'agor_session1_server1_github_delete_repo';
  const assistant = {
    type: 'message.updated',
    properties: { info: { id: 'a-1', sessionID: SESSION, role: 'assistant' } },
  };
  const part = (id: string, type: 'text' | 'reasoning') => ({
    type: 'message.part.updated',
    properties: { part: { id, sessionID: SESSION, messageID: 'a-1', type, text: '' } },
  });
  const delta = (partID: string, value: string) => ({
    type: 'message.part.delta',
    properties: { sessionID: SESSION, messageID: 'a-1', partID, field: 'text', delta: value },
  });
  const asked = (id: string, permission: string) => ({
    type: 'permission.asked',
    properties: {
      id,
      sessionID: SESSION,
      permission,
      patterns: ['*'],
      // Tool input: must never reach a log line or the feedback.
      metadata: { command: 'echo do-not-log-this-argument' },
    },
  });
  const idle = { type: 'session.idle', properties: { sessionID: SESSION } };

  /**
   * Drive one turn. After each permission request the stream waits for Agor's
   * reply before going on, the way OpenCode's agent loop does, so a turn that
   * reaches idle has carried on past the rejection.
   */
  function permissionTurn(options: {
    permission: string;
    permissionMode?: string;
    canUseTool?: OpenCodeCanUseToolCallback;
    mcpToolPermissions?: ReadonlyMap<string, 'allow' | 'ask' | 'deny'>;
    /** A parallel request OpenCode has already settled by the time Agor answers it. */
    settledSibling?: string;
  }) {
    const replied = deferred<void>();
    const reply = vi.fn(async (request: Record<string, unknown>) => {
      replied.resolve();
      return request.requestID === 'per-2'
        ? {
            data: undefined,
            error: { _tag: 'PermissionNotFoundError', requestID: 'per-2', message: 'not found' },
          }
        : { data: true, error: undefined };
    });
    const stream = (async function* () {
      yield assistant;
      yield part('r-1', 'reasoning');
      yield delta('r-1', 'Thinking about it.');
      yield asked('per-1', options.permission);
      if (options.settledSibling) yield asked('per-2', options.settledSibling);
      await replied.promise;
      yield part('t-1', 'text');
      yield delta('t-1', 'Carrying on without it.');
      yield idle;
    })();
    // What OpenCode records once the model has read the rejection and moved on.
    const transcript = [
      {
        info: { id: 'a-1', sessionID: SESSION, role: 'assistant' },
        parts: [
          {
            id: 'tool-1',
            type: 'tool',
            callID: 'call-1',
            tool: options.permission,
            state: { status: 'error', input: {}, error: 'The user rejected permission…' },
          },
          { id: 't-1', type: 'text', text: 'Carrying on without it.' },
        ],
      },
    ];
    const client = {
      event: { subscribe: vi.fn(async () => ({ stream })) },
      session: {
        messages: vi
          .fn()
          .mockResolvedValueOnce({ data: [], error: undefined })
          .mockResolvedValue({ data: transcript, error: undefined }),
        prompt: vi.fn(async () => ({ data: {}, error: undefined })),
      },
    };
    const runtime = new OpenCodeTool({
      createPermissionCallback: () => options.canUseTool,
    }) as unknown as { executeTask(...args: unknown[]): Promise<unknown> };
    const result = runtime.executeTask(
      client,
      {
        agorSessionId: 'session-1',
        taskId: 'task-1',
        prompt: 'hi',
        agorAssistantMessageId: 'message-1',
        permissionMode: options.permissionMode,
        signal: new AbortController().signal,
        title: 'Test',
        directory: '/workspace',
        persistOpenCodeSessionId: vi.fn(),
      },
      {
        opencodeSessionId: SESSION,
        provider: 'zai-coding-plan',
        model: 'glm-5.3',
        branchPath: '/workspace',
        mcpToolPermissions: options.mcpToolPermissions,
      },
      undefined,
      () => undefined,
      {
        text: (value: string) => value,
        error: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
      },
      { permission: { reply } }
    ) as Promise<{
      finalMessage: { content: string };
      permissionRejections: Array<{ permission: string; reason: string }>;
    }>;
    return { result, reply };
  }

  it.each([
    {
      name: 'an MCP tool denied by tool_permissions in yolo',
      permission: MCP_TOOL,
      permissionMode: 'yolo',
      mcpToolPermissions: new Map([[MCP_TOOL, 'deny' as const]]),
      reason: 'tool_permissions_deny',
      feedback: /blocked `agor_session1_server1_github_delete_repo`.*deny in tool_permissions/,
    },
    {
      name: 'an MCP tool set to ask in yolo, which nobody can approve',
      permission: MCP_TOOL,
      permissionMode: 'yolo',
      mcpToolPermissions: new Map([[MCP_TOOL, 'ask' as const]]),
      reason: 'tool_permissions_ask_unavailable',
      feedback: /requires approval in tool_permissions/,
    },
    {
      name: 'the disabled question tool',
      permission: 'question',
      permissionMode: 'yolo',
      reason: 'agor_disabled_tool',
      feedback: /Agor disables `question`; ask the user in plain text/,
    },
    {
      name: 'a user denial',
      permission: 'bash',
      permissionMode: 'default',
      canUseTool: vi.fn(async () => ({ behavior: 'deny' as const })),
      reason: 'user_denied',
      feedback: /The user denied permission for `bash`/,
    },
    {
      name: 'a request with no approval channel outside auto-allow modes',
      permission: 'bash',
      permissionMode: 'default',
      reason: 'no_approval_channel',
      feedback: /no approval channel/,
    },
  ])('rejects $name with feedback and lets the turn finish', async (testCase) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result, reply } = permissionTurn(testCase);

      const outcome = await result;
      expect(outcome.finalMessage.content).toBe('Carrying on without it.');
      expect(outcome.permissionRejections).toEqual([
        { permission: testCase.permission, reason: testCase.reason },
      ]);
      expect(reply).toHaveBeenCalledOnce();
      const request = reply.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        requestID: 'per-1',
        directory: '/workspace',
        reply: 'reject',
      });
      // A `message` makes OpenCode raise a correctable tool error instead of
      // stopping its loop; it must explain the rule without echoing tool input.
      expect(request?.message).toMatch(testCase.feedback);
      expect(request?.message).not.toContain('do-not-log-this-argument');

      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain(`"${testCase.permission}"`);
      expect(logged).toContain(testCase.reason);
      expect(logged).not.toContain('do-not-log-this-argument');
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['yolo', 'bypassPermissions', 'allow-all'])(
    'allows an ordinary permission once in %s without an approval channel',
    async (mode) => {
      const { result, reply } = permissionTurn({ permission: 'bash', permissionMode: mode });

      await expect(result).resolves.toMatchObject({ permissionRejections: [] });
      expect(reply).toHaveBeenCalledWith({
        requestID: 'per-1',
        directory: '/workspace',
        reply: 'once',
      });
    }
  );

  it('lets the turn finish when a parallel request was already settled by the rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result, reply } = permissionTurn({
        permission: MCP_TOOL,
        permissionMode: 'yolo',
        mcpToolPermissions: new Map([[MCP_TOOL, 'deny' as const]]),
        settledSibling: 'bash',
      });

      const outcome = await result;
      expect(outcome.finalMessage.content).toBe('Carrying on without it.');
      expect(outcome.permissionRejections).toEqual([
        { permission: MCP_TOOL, reason: 'tool_permissions_deny' },
      ]);
      expect(reply).toHaveBeenCalledTimes(2);
      expect(reply).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestID: 'per-2', reply: 'once' })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('still fails the turn on an approval timeout, naming the permission', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result, reply } = permissionTurn({
        permission: 'bash',
        permissionMode: 'default',
        canUseTool: vi.fn(async () => ({ behavior: 'deny' as const, timedOut: true })),
      });

      const failure = await result.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OpenCodeInteractionTimeoutError);
      expect((failure as Error).message).toBe(
        'OpenCode permission "bash" was rejected (approval_timed_out)'
      );
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ requestID: 'per-1', reply: 'reject' })
      );
      // Reasoning streamed before the timeout survives the failure.
      expect(openCodePartialMessage(failure)).toEqual({
        content: '',
        contentBlocks: [{ type: 'thinking', text: 'Thinking about it.' }],
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps streamed reasoning and text on a failed turn, redacted', async () => {
    const stream = (async function* () {
      yield assistant;
      yield part('r-1', 'reasoning');
      yield delta('r-1', 'Weighing secret-token options.');
      yield part('t-1', 'text');
      yield delta('t-1', 'Partial answer');
      yield {
        type: 'session.error',
        properties: { sessionID: SESSION, error: { name: 'APIError', data: { message: 'boom' } } },
      };
      await new Promise(() => undefined);
    })();
    const client = {
      event: { subscribe: vi.fn(async () => ({ stream })) },
      session: {
        messages: vi.fn(async () => ({ data: [], error: undefined })),
        prompt: vi.fn(() => new Promise(() => undefined)),
      },
    };
    const runtime = new OpenCodeTool({}) as unknown as {
      executeTask(...args: unknown[]): Promise<unknown>;
    };
    const failure = await runtime
      .executeTask(
        client,
        {
          agorSessionId: 'session-1',
          taskId: 'task-1',
          prompt: 'hi',
          agorAssistantMessageId: 'message-1',
          signal: new AbortController().signal,
          title: 'Test',
          directory: '/workspace',
          persistOpenCodeSessionId: vi.fn(),
        },
        { opencodeSessionId: SESSION, provider: 'p', model: 'm', branchPath: '/workspace' },
        undefined,
        () => undefined,
        {
          text: (value: string) => value.replaceAll('secret-token', '[REDACTED]'),
          error: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
        },
        { permission: { reply: vi.fn() } }
      )
      .catch((error: unknown) => error);

    expect((failure as Error).message).toBe('OpenCode prompt failed for p/m: boom');
    expect(openCodePartialMessage(failure)).toEqual({
      content: 'Partial answer',
      contentBlocks: [
        { type: 'thinking', text: 'Weighing [REDACTED] options.' },
        { type: 'text', text: 'Partial answer' },
      ],
    });
  });
});

describe('OpenCodeTool protected invocation config', () => {
  it('keeps the agent loop going on deny without dropping other experimental settings', () => {
    const tool = new OpenCodeTool({}) as unknown as {
      protectedInvocationConfig(config: Record<string, unknown>): Record<string, unknown>;
    };

    const config = tool.protectedInvocationConfig({
      mcp: {},
      experimental: { mcp_timeout: 5_000, continue_loop_on_deny: false },
    });

    expect(config.experimental).toEqual({ mcp_timeout: 5_000, continue_loop_on_deny: true });
  });
});
