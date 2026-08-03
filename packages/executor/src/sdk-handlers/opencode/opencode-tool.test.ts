import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { PermissionScope } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../permissions/permission-service.js';
import type { StreamingCallbacks } from '../base/index.js';
import { OpenCodeTool, resolvePackagedOpenCodeBinary } from './opencode-tool.js';

vi.mock('../../config.js', () => ({
  getDaemonUrl: vi.fn().mockResolvedValue('http://127.0.0.1:3030'),
}));

vi.mock('../base/mcp-scoping.js', () => ({
  getMcpServersForSession: vi.fn().mockResolvedValue([]),
}));

type SpawnCall = {
  executable: string;
  args: readonly string[];
  options: {
    cwd?: string;
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
    stdio?: readonly string[];
  };
};

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: NodeJS.Signals[] = [];
  exitCode: number | null = null;

  constructor(private readonly exitOn: NodeJS.Signals | undefined = 'SIGTERM') {
    super();
  }

  ready(url: string): void {
    queueMicrotask(() => this.stdout.write(`opencode server listening on ${url}\n`));
  }

  exit(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (signal === this.exitOn) queueMicrotask(() => this.exit(0));
    return true;
  }
}

function createClient(overrides?: {
  create?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  prompt?: ReturnType<typeof vi.fn>;
  messages?: ReturnType<typeof vi.fn>;
  subscribe?: ReturnType<typeof vi.fn>;
  abort?: ReturnType<typeof vi.fn>;
  configProviders?: ReturnType<typeof vi.fn>;
  providerList?: ReturnType<typeof vi.fn>;
  sessionId?: string;
}) {
  const sessionId = overrides?.sessionId ?? 'oc-new';
  const messages =
    overrides?.messages ??
    vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: [
          {
            info: {
              id: 'assistant-1',
              sessionID: sessionId,
              role: 'assistant',
              time: { created: 1 },
            },
            parts: [
              {
                id: 'part-1',
                sessionID: sessionId,
                messageID: 'assistant-1',
                type: 'text',
                text: 'done',
              },
            ],
          },
        ],
      });
  return {
    config: {
      providers:
        overrides?.configProviders ??
        vi.fn().mockResolvedValue({
          data: {
            providers: [
              {
                id: 'test-provider',
                models: { 'test-model': { id: 'test-model' } },
              },
            ],
            default: {},
          },
        }),
    },
    provider: {
      list:
        overrides?.providerList ??
        vi.fn().mockResolvedValue({
          data: {
            all: [{ id: 'test-provider', name: 'Test Provider' }],
            connected: ['test-provider'],
            default: {},
          },
        }),
    },
    session: {
      create: overrides?.create ?? vi.fn().mockResolvedValue({ data: { id: 'oc-new' } }),
      get: overrides?.get ?? vi.fn().mockResolvedValue({ data: { id: 'oc-existing' } }),
      prompt:
        overrides?.prompt ??
        vi.fn().mockResolvedValue({
          data: {
            info: { id: 'assistant-1' },
            parts: [{ id: 'part-1', type: 'text', text: 'done' }],
          },
        }),
      messages,
      abort: overrides?.abort ?? vi.fn().mockResolvedValue({ data: true }),
    },
    event: {
      subscribe:
        overrides?.subscribe ??
        vi.fn().mockResolvedValue({
          stream: [
            {
              type: 'message.updated',
              properties: {
                info: { id: 'assistant-1', sessionID: sessionId, role: 'assistant' },
              },
            },
            {
              type: 'session.idle',
              properties: { sessionID: sessionId },
            },
          ],
        }),
    },
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({ data: true }),
  };
}

function makeTool(options?: {
  client?: ReturnType<typeof createClient>;
  child?: FakeChild;
  spawnCalls?: SpawnCall[];
  spawn?: (executable: string, args: readonly string[], options: SpawnCall['options']) => FakeChild;
  resolveInvocationConfig?: ReturnType<typeof vi.fn>;
  useDefaultInvocationConfig?: boolean;
  sessionMCPRepo?: object;
  mcpServerRepo?: object;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  permissionService?: object;
  messagesRepo?: object;
  messagesService?: object;
  tasksService?: object;
  sessionsService?: object;
  randomBytes?: ReturnType<typeof vi.fn>;
}) {
  const client = options?.client ?? createClient();
  const child = options?.child ?? new FakeChild();
  const spawnCalls = options?.spawnCalls ?? [];
  const createClientSpy = vi.fn().mockReturnValue(client);
  const sequence = makeToolSequence++;
  const uniqueSecret = Buffer.from(`unique-secret-material-${sequence}`);

  const tool = new OpenCodeTool({
    sessionMCPRepo: options?.sessionMCPRepo as never,
    mcpServerRepo: options?.mcpServerRepo as never,
    resolveBinary: vi.fn().mockResolvedValue('/package/opencode-ai/bin/.opencode'),
    spawn: ((executable: string, args: readonly string[], spawnOptions: SpawnCall['options']) => {
      if (options?.spawn) return options.spawn(executable, args, spawnOptions);
      spawnCalls.push({ executable, args, options: spawnOptions });
      child.ready(`http://127.0.0.1:${54_000 + sequence}`);
      return child;
    }) as never,
    createClient: createClientSpy as never,
    resolveInvocationConfig: options?.useDefaultInvocationConfig
      ? undefined
      : (options?.resolveInvocationConfig ?? vi.fn().mockResolvedValue({ mcp: {} })),
    randomBytes: (options?.randomBytes ?? vi.fn().mockReturnValue(uniqueSecret)) as never,
    fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    readinessTimeoutMs: options?.readinessTimeoutMs ?? 50,
    shutdownTimeoutMs: options?.shutdownTimeoutMs ?? 10,
    permissionService: options?.permissionService as never,
    messagesRepo: options?.messagesRepo as never,
    messagesService: options?.messagesService as never,
    tasksService: options?.tasksService as never,
    sessionsService: options?.sessionsService as never,
  });

  return { tool, child, client, spawnCalls, createClientSpy };
}

let makeToolSequence = 1;

function input(overrides: Record<string, unknown> = {}) {
  return {
    agorSessionId: '00000000-0000-7000-8000-000000000001',
    taskId: '00000000-0000-7000-8000-000000000002',
    prompt: 'Do the work',
    agorAssistantMessageId: '00000000-0000-7000-8000-000000000004',
    title: 'Managed turn',
    directory: '/worktree',
    provider: 'test-provider',
    model: 'test-model',
    mcpToken: 'mcp-secret',
    signal: new AbortController().signal,
    persistOpenCodeSessionId: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePermissionTurn(options: {
  decision?: Record<string, unknown>;
  permissionMode?: string;
  requests?: Array<Record<string, unknown>>;
  withDependencies?: boolean;
}) {
  const permissionService = {
    emitRequest: vi.fn().mockResolvedValue(undefined),
    waitForDecision: vi.fn().mockResolvedValue(
      options.decision ?? {
        requestId: 'agor-request',
        taskId: '00000000-0000-7000-8000-000000000002',
        allow: true,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'user-1',
      }
    ),
    cancelPendingRequests: vi.fn(),
  };
  const messages: unknown[] = [];
  const messagesRepo = { findBySessionId: vi.fn(async () => messages) };
  const messagesService = {
    create: vi.fn(async (message) => {
      messages.push(message);
      return message;
    }),
    patch: vi.fn().mockResolvedValue({}),
  };
  const tasksService = { patch: vi.fn().mockResolvedValue({}) };
  const sessionsService = { patch: vi.fn().mockResolvedValue({}) };
  const requests = options.requests ?? [
    {
      type: 'permission.asked',
      properties: {
        id: 'oc-permission',
        sessionID: 'oc-new',
        permission: 'bash',
        patterns: ['git status'],
        metadata: { command: 'git status' },
      },
    },
  ];
  const client = createClient({
    subscribe: vi.fn().mockResolvedValue({
      stream: [
        ...requests,
        {
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
          },
        },
        { type: 'session.idle', properties: { sessionID: 'oc-new' } },
      ],
    }),
  });
  const withDependencies = options.withDependencies ?? true;
  const made = makeTool({
    client,
    ...(withDependencies
      ? {
          permissionService,
          messagesRepo,
          messagesService,
          tasksService,
          sessionsService,
          sessionMCPRepo: { listServers: vi.fn().mockResolvedValue([]) },
          mcpServerRepo: {},
        }
      : {}),
  });
  return {
    ...made,
    client,
    permissionService,
    messagesService,
    tasksService,
    sessionsService,
    turnInput: input({ permissionMode: options.permissionMode ?? 'default' }),
  };
}

describe('OpenCodeTool managed turn', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pins the SDK and packaged CLI as the exact 1.14.33 pair', async () => {
    const executorPackage = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8')
    );
    const openCodePackage = JSON.parse(
      await readFile(
        new URL('../../../../agentic-tool-opencode/package.json', import.meta.url),
        'utf8'
      )
    );
    const corePackage = JSON.parse(
      await readFile(new URL('../../../../core/package.json', import.meta.url), 'utf8')
    );
    const publishedPackage = JSON.parse(
      await readFile(new URL('../../../../agor-live/package.json', import.meta.url), 'utf8')
    );
    const publishedLock = JSON.parse(
      await readFile(new URL('../../../../agor-live/package-lock.json', import.meta.url), 'utf8')
    );

    expect(executorPackage.dependencies['@agor/agentic-tool-opencode']).toBe('workspace:*');
    expect(executorPackage.dependencies).not.toHaveProperty('@opencode-ai/sdk');
    expect(executorPackage.dependencies).not.toHaveProperty('opencode-ai');
    expect(openCodePackage.dependencies).toMatchObject({
      '@opencode-ai/sdk': '1.14.33',
      'opencode-ai': '1.14.33',
    });
    expect(corePackage.dependencies).not.toHaveProperty('@opencode-ai/sdk');
    expect(publishedPackage.dependencies).toMatchObject({
      '@opencode-ai/sdk': '1.14.33',
      'opencode-ai': '1.14.33',
    });
    expect(publishedLock.packages['node_modules/@opencode-ai/sdk'].version).toBe('1.14.33');
    expect(publishedLock.packages['node_modules/opencode-ai'].version).toBe('1.14.33');
  });

  it('streams real deltas around prompt settlement but returns transcript truth', async () => {
    let resolvePrompt!: (value: unknown) => void;
    let promptResolved = false;
    const prompt = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        })
    );
    const observed: string[] = [];
    const subscribe = vi.fn().mockResolvedValue({
      stream: (async function* () {
        yield {
          type: 'message.updated',
          properties: {
            info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
          },
        };
        yield {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part-1',
              sessionID: 'oc-new',
              messageID: 'assistant-1',
              type: 'text',
              text: 'first second',
            },
          },
        };
        yield {
          type: 'message.part.delta',
          properties: {
            sessionID: 'oc-new',
            messageID: 'assistant-1',
            partID: 'part-1',
            field: 'text',
            delta: 'first ',
          },
        };
        yield {
          type: 'message.part.delta',
          properties: {
            sessionID: 'oc-new',
            messageID: 'assistant-1',
            partID: 'part-1',
            field: 'text',
            delta: 'second',
          },
        };
        promptResolved = true;
        resolvePrompt({ data: { info: {}, parts: [{ type: 'text', text: 'truncated' }] } });
        await new Promise((resolve) => setImmediate(resolve));
        yield {
          type: 'message.part.delta',
          properties: {
            sessionID: 'oc-new',
            messageID: 'assistant-1',
            partID: 'part-1',
            field: 'text',
            delta: ' final',
          },
        };
        yield { type: 'session.idle', properties: { sessionID: 'oc-new' } };
      })(),
    });
    const messages = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: [
          {
            info: {
              id: 'assistant-1',
              sessionID: 'oc-new',
              role: 'assistant',
              time: { created: 1 },
            },
            parts: [
              {
                id: 'part-1',
                sessionID: 'oc-new',
                messageID: 'assistant-1',
                type: 'text',
                text: 'authoritative transcript',
              },
            ],
          },
        ],
      });
    const client = createClient({ prompt, subscribe, messages });
    const { tool } = makeTool({ client });
    const prePromptResolutionChunks: string[] = [];
    const postPromptResolutionChunks: string[] = [];
    const callbacks = {
      onStreamStart: vi.fn(async (id) => observed.push(`start:${id}`)),
      onStreamChunk: vi.fn(async (_id, chunk) => {
        observed.push(chunk);
        (promptResolved ? postPromptResolutionChunks : prePromptResolutionChunks).push(chunk);
      }),
      onStreamEnd: vi.fn(async (id) => observed.push(`end:${id}`)),
      onStreamError: vi.fn(),
    } satisfies StreamingCallbacks;

    const result = await tool.runTurn(input(), callbacks);

    expect(observed).toEqual([
      'start:00000000-0000-7000-8000-000000000004',
      'first ',
      'second',
      ' final',
      'end:00000000-0000-7000-8000-000000000004',
    ]);
    expect(result.finalMessage).toMatchObject({
      content: 'authoritative transcript',
      contentBlocks: [{ type: 'text', text: 'authoritative transcript' }],
    });
    expect(prePromptResolutionChunks).toEqual(['first ', 'second']);
    expect(postPromptResolutionChunks).toEqual([' final']);
    expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(prompt.mock.invocationCallOrder[0]);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('fails when the event stream closes before terminal evidence', async () => {
    const client = createClient({
      subscribe: vi.fn().mockResolvedValue({
        stream: [
          {
            type: 'message.updated',
            properties: {
              info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
            },
          },
        ],
      }),
    });
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn(),
      cancelPendingRequests: vi.fn(),
    };
    const { tool, child } = makeTool({ client, permissionService });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'event stream closed before the active turn became idle'
    );
    expect(client.session.abort).toHaveBeenCalledOnce();
    expect(permissionService.cancelPendingRequests).toHaveBeenCalledOnce();
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('continues local cleanup when the provider abort request fails', async () => {
    const client = createClient({
      abort: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      subscribe: vi.fn().mockResolvedValue({ stream: [] }),
    });
    const { tool, child } = makeTool({ client });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'event stream closed before the active turn became idle'
    );
    expect(client.session.abort).toHaveBeenCalledOnce();
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('routes an interactive one-time approval through Agor and replies once', async () => {
    const permissionService = {
      emitRequest: vi.fn().mockResolvedValue(undefined),
      waitForDecision: vi.fn().mockResolvedValue({
        requestId: 'agor-request',
        taskId: '00000000-0000-7000-8000-000000000002',
        allow: true,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'user-1',
      }),
      cancelPendingRequests: vi.fn(),
    };
    const messagesRepo = { findBySessionId: vi.fn().mockResolvedValue([]) };
    const messagesService = {
      create: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
    };
    const tasksService = { patch: vi.fn().mockResolvedValue({}) };
    const sessionsService = { patch: vi.fn().mockResolvedValue({}) };
    const client = createClient({
      subscribe: vi.fn().mockResolvedValue({
        stream: [
          {
            type: 'permission.asked',
            properties: {
              id: 'oc-permission',
              sessionID: 'oc-new',
              permission: 'bash',
              patterns: ['git status'],
              metadata: { command: 'git status' },
            },
          },
          {
            type: 'message.updated',
            properties: {
              info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'oc-new' } },
        ],
      }),
    });
    const { tool } = makeTool({
      client,
      permissionService,
      messagesRepo,
      messagesService,
      tasksService,
      sessionsService,
      sessionMCPRepo: { listServers: vi.fn().mockResolvedValue([]) },
      mcpServerRepo: {},
    });
    const abortController = new AbortController();

    await tool.runTurn(input({ signal: abortController.signal, permissionMode: 'default' }));

    expect(permissionService.waitForDecision).toHaveBeenCalledWith(
      expect.any(String),
      '00000000-0000-7000-8000-000000000002',
      '00000000-0000-7000-8000-000000000001',
      abortController.signal
    );
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: 'oc-new', permissionID: 'oc-permission' },
      query: { directory: '/worktree' },
      body: { response: 'once' },
    });
    expect(messagesService.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'permission_request' })
    );
    expect(messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({ status: 'approved' }),
      })
    );
  });

  it('maps an automatic allow-all mode to once without prompting', async () => {
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn(),
      cancelPendingRequests: vi.fn(),
    };
    const client = createClient({
      subscribe: vi.fn().mockResolvedValue({
        stream: [
          {
            type: 'permission.updated',
            properties: {
              id: 'oc-permission',
              sessionID: 'oc-new',
              type: 'bash',
              pattern: 'git status',
              metadata: {},
            },
          },
          {
            type: 'message.updated',
            properties: {
              info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'oc-new' } },
        ],
      }),
    });
    const { tool } = makeTool({
      client,
      permissionService,
      messagesRepo: { findBySessionId: vi.fn().mockResolvedValue([]) },
      messagesService: { create: vi.fn(), patch: vi.fn() },
      tasksService: { patch: vi.fn() },
      sessionsService: { patch: vi.fn() },
      sessionMCPRepo: { listServers: vi.fn().mockResolvedValue([]) },
      mcpServerRepo: {},
    });

    await tool.runTurn(input({ permissionMode: 'bypassPermissions' }));

    expect(permissionService.waitForDecision).not.toHaveBeenCalled();
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: 'once' } })
    );
  });

  it('handles a read permission in yolo mode without waiting for a decision', async () => {
    const scenario = makePermissionTurn({
      permissionMode: 'yolo',
      requests: [
        {
          type: 'permission.asked',
          properties: {
            id: 'oc-read-permission',
            sessionID: 'oc-new',
            permission: 'read',
            patterns: ['src/index.ts'],
            metadata: { path: 'src/index.ts' },
          },
        },
      ],
    });

    await scenario.tool.runTurn(scenario.turnInput);

    expect(scenario.permissionService.waitForDecision).not.toHaveBeenCalled();
    expect(scenario.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.objectContaining({ permissionID: 'oc-read-permission' }),
        body: { response: 'once' },
      })
    );
  });

  it('replies reject and fails the turn when Agor denies the permission', async () => {
    const scenario = makePermissionTurn({
      decision: {
        requestId: 'agor-request',
        taskId: '00000000-0000-7000-8000-000000000002',
        allow: false,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'user-1',
      },
    });

    await expect(scenario.tool.runTurn(scenario.turnInput)).rejects.toThrow(
      'OpenCode permission was rejected'
    );
    expect(scenario.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: 'reject' } })
    );
    expect(scenario.messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({ status: 'denied' }),
      })
    );
    expect(scenario.tasksService.patch).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' })
    );
    expect(scenario.sessionsService.patch).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'idle' })
    );
  });

  it('maps an applicable remembered approval with a stable pattern to always', async () => {
    const scenario = makePermissionTurn({
      decision: {
        requestId: 'agor-request',
        taskId: '00000000-0000-7000-8000-000000000002',
        allow: true,
        remember: true,
        scope: PermissionScope.PROJECT,
        decidedBy: 'user-1',
      },
    });

    await scenario.tool.runTurn(scenario.turnInput);

    expect(scenario.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: 'always' } })
    );
  });

  it('does not persist a remembered approval without a stable OpenCode pattern', async () => {
    const scenario = makePermissionTurn({
      decision: {
        requestId: 'agor-request',
        taskId: '00000000-0000-7000-8000-000000000002',
        allow: true,
        remember: true,
        scope: PermissionScope.PROJECT,
        decidedBy: 'user-1',
      },
      requests: [
        {
          type: 'permission.asked',
          properties: {
            id: 'oc-permission',
            sessionID: 'oc-new',
            permission: 'bash',
            patterns: [],
            metadata: {},
          },
        },
      ],
    });

    await scenario.tool.runTurn(scenario.turnInput);

    expect(scenario.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: 'once' } })
    );
  });

  it.each([
    {
      name: 'timeout',
      decision: {
        allow: false,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'system',
        timedOut: true,
      },
      status: 'timed_out',
    },
    {
      name: 'cancellation',
      decision: {
        allow: false,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'system',
        reason: 'Cancelled',
      },
      status: 'denied',
    },
  ])(
    'maps $name to reject and patches the existing request state',
    async ({ decision, status }) => {
      const scenario = makePermissionTurn({
        decision: {
          requestId: 'agor-request',
          taskId: '00000000-0000-7000-8000-000000000002',
          ...decision,
        },
      });

      await expect(scenario.tool.runTurn(scenario.turnInput)).rejects.toThrow(
        'OpenCode permission was rejected'
      );
      expect(scenario.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
        expect.objectContaining({ body: { response: 'reject' } })
      );
      expect(scenario.messagesService.patch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: expect.objectContaining({ status }),
        })
      );
    }
  );

  it('fails closed in headless mode even when configured to allow all', async () => {
    const scenario = makePermissionTurn({
      permissionMode: 'bypassPermissions',
      withDependencies: false,
    });

    await expect(scenario.tool.runTurn(scenario.turnInput)).rejects.toThrow(
      'OpenCode permission was rejected'
    );
    expect(scenario.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: 'reject' } })
    );
    expect(scenario.permissionService.waitForDecision).not.toHaveBeenCalled();
  });

  it('uses the task AbortSignal to cancel an in-flight Agor permission wait', async () => {
    const abortController = new AbortController();
    const permissionService = new PermissionService(async (event) => {
      if (event === 'permission:request') abortController.abort('User Stop');
    }, 100);
    const client = createClient({
      subscribe: vi.fn().mockResolvedValue({
        stream: [
          {
            type: 'permission.asked',
            properties: {
              id: 'oc-permission',
              sessionID: 'oc-new',
              permission: 'bash',
              patterns: ['git status'],
              metadata: {},
            },
          },
        ],
      }),
    });
    const { tool } = makeTool({
      client,
      permissionService,
      messagesRepo: { findBySessionId: vi.fn().mockResolvedValue([]) },
      messagesService: {
        create: vi.fn().mockResolvedValue({}),
        patch: vi.fn().mockResolvedValue({}),
      },
      tasksService: { patch: vi.fn().mockResolvedValue({}) },
      sessionsService: { patch: vi.fn().mockResolvedValue({}) },
      sessionMCPRepo: { listServers: vi.fn().mockResolvedValue([]) },
      mcpServerRepo: {},
    });

    await expect(
      tool.runTurn(input({ signal: abortController.signal, permissionMode: 'default' }))
    ).rejects.toThrow('OpenCode turn was aborted');
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: 'reject' } })
    );
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal })
    );
  });

  it('serializes concurrent permission events and patches each request message', async () => {
    const request = (id: string, pattern: string) => ({
      type: 'permission.asked',
      properties: {
        id,
        sessionID: 'oc-new',
        permission: 'bash',
        patterns: [pattern],
        metadata: { command: pattern },
      },
    });
    const scenario = makePermissionTurn({
      requests: [request('oc-first', 'git status'), request('oc-second', 'git diff')],
    });
    let active = 0;
    let maxActive = 0;
    scenario.permissionService.waitForDecision.mockImplementation(async (requestId, taskId) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return {
        requestId,
        taskId,
        allow: true,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'user-1',
      };
    });

    await scenario.tool.runTurn(scenario.turnInput);

    expect(maxActive).toBe(1);
    expect(scenario.messagesService.create).toHaveBeenCalledTimes(2);
    expect(scenario.messagesService.patch).toHaveBeenCalledTimes(2);
    expect(scenario.client.postSessionIdPermissionsPermissionId.mock.calls).toEqual([
      [expect.objectContaining({ path: expect.objectContaining({ permissionID: 'oc-first' }) })],
      [expect.objectContaining({ path: expect.objectContaining({ permissionID: 'oc-second' }) })],
    ]);
  });

  it('settles collector cancellation before returning a reconciled turn', async () => {
    let collectorSettled = false;
    const subscribe = vi.fn(async (options: { signal?: AbortSignal }) => ({
      stream: (async function* () {
        try {
          yield {
            type: 'message.updated',
            properties: {
              info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
            },
          };
          yield { type: 'session.idle', properties: { sessionID: 'oc-new' } };
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        } finally {
          collectorSettled = true;
        }
      })(),
    }));
    const { tool } = makeTool({ client: createClient({ subscribe }) });

    await expect(tool.runTurn(input())).resolves.toMatchObject({ sessionWasCreated: true });
    expect(collectorSettled).toBe(true);
  });

  it('still terminates the managed child when collector shutdown fails', async () => {
    let index = 0;
    const rawCleanupError = new Error('collector shutdown failed with mcp-secret');
    Object.assign(rawCleanupError, {
      response: { headers: { authorization: 'Bearer mcp-secret' } },
    });
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const events = [
          {
            type: 'message.updated',
            properties: {
              info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'oc-new' } },
        ];
        const value = events[index++];
        return value ? { done: false as const, value } : { done: true as const, value: undefined };
      },
      async return() {
        throw rawCleanupError;
      },
    };
    const { tool, child } = makeTool({
      client: createClient({ subscribe: vi.fn().mockResolvedValue({ stream }) }),
    });

    let rejection: unknown;
    try {
      await tool.runTurn(input());
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(rawCleanupError);
    expect(inspect(rejection, { depth: null })).not.toContain('mcp-secret');
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('bounds a never-settling iterator return and collector before closing the child', async () => {
    let index = 0;
    const never = new Promise<never>(() => undefined);
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const events = [
          {
            type: 'message.updated',
            properties: {
              info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'oc-new' } },
        ];
        const value = events[index++];
        return value ? { done: false as const, value } : never;
      },
      return() {
        return never;
      },
    };
    const { tool, child } = makeTool({
      client: createClient({ subscribe: vi.fn().mockResolvedValue({ stream }) }),
      shutdownTimeoutMs: 5,
    });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'OpenCode event collector did not settle within the shutdown timeout'
    );
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('fails rather than using prompt parts when the final transcript has no assistant output', async () => {
    const messages = vi.fn().mockResolvedValueOnce({ data: [] }).mockResolvedValue({ data: [] });
    const { tool } = makeTool({ client: createClient({ messages }) });

    await expect(tool.runTurn(input())).rejects.toThrow('no new assistant output');
  });

  it('resolves the executable only from the packaged CLI native binary', async () => {
    const binary = await resolvePackagedOpenCodeBinary();

    expect(binary).toMatch(/opencode-ai@1\.14\.33.+opencode-ai[/\\]bin[/\\]\.opencode$/);
  });

  it('starts only the packaged native binary on loopback port zero inside the executor group', async () => {
    const { tool, spawnCalls } = makeTool();

    await tool.runTurn(input(), undefined as unknown as StreamingCallbacks);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      executable: '/package/opencode-ai/bin/.opencode',
      args: ['serve', '--hostname=127.0.0.1', '--port=0'],
      options: {
        cwd: '/worktree',
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    });
    expect(spawnCalls[0].options.env?.PATH).toBe(process.env.PATH);
  });

  it('uses independent server credentials and authenticated clients for concurrent turns', async () => {
    const calls: SpawnCall[] = [];
    const first = makeTool({ spawnCalls: calls });
    const second = makeTool({ spawnCalls: calls });

    await Promise.all([first.tool.runTurn(input()), second.tool.runTurn(input())]);

    const firstPassword = calls[0].options.env?.OPENCODE_SERVER_PASSWORD;
    const secondPassword = calls[1].options.env?.OPENCODE_SERVER_PASSWORD;
    expect(firstPassword).toBeTruthy();
    expect(secondPassword).toBeTruthy();
    expect(firstPassword).not.toBe(secondPassword);
    expect(first.createClientSpy.mock.calls[0][0].headers.Authorization).toMatch(/^Basic /);
    expect(second.createClientSpy.mock.calls[0][0].headers.Authorization).toMatch(/^Basic /);
    expect(first.createClientSpy.mock.calls[0][0].headers.Authorization).not.toBe(
      second.createClientSpy.mock.calls[0][0].headers.Authorization
    );
    expect(first.createClientSpy.mock.calls[0][0].baseUrl).not.toBe(
      second.createClientSpy.mock.calls[0][0].baseUrl
    );
  });

  it('resolves invocation MCP configuration before spawn and prompt', async () => {
    const order: string[] = [];
    const resolveInvocationConfig = vi.fn(async () => {
      order.push('mcp');
      return { mcp: { agor_test: { type: 'remote', url: 'http://daemon/mcp' } } };
    });
    const client = createClient({
      prompt: vi.fn(async () => {
        order.push('prompt');
        return { data: { info: {}, parts: [{ type: 'text', text: 'done' }] } };
      }),
    });
    const { tool, spawnCalls } = makeTool({ client, resolveInvocationConfig });
    const turnInput = input({
      persistOpenCodeSessionId: vi.fn(async () => order.push('persist')),
    });

    await tool.runTurn(turnInput);

    expect(order).toEqual(['mcp', 'persist', 'prompt']);
    expect(JSON.parse(spawnCalls[0].options.env?.OPENCODE_CONFIG_CONTENT ?? '')).toMatchObject({
      mcp: { agor_test: { type: 'remote', url: 'http://daemon/mcp' } },
      permission: { '*': 'ask', bash: 'ask', edit: 'ask' },
    });
  });

  it('forces invocation-scoped permission interception over permissive project configuration', async () => {
    const { tool, spawnCalls, client } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo: {},
      mcpServerRepo: {},
    });

    await tool.runTurn(input());

    expect(JSON.parse(spawnCalls[0].options.env?.OPENCODE_CONFIG_CONTENT ?? '')).toMatchObject({
      permission: { '*': 'ask' },
      agent: {
        'agor-managed': {
          mode: 'primary',
          permission: { '*': 'ask', bash: 'ask', edit: 'ask' },
        },
      },
    });
    expect(JSON.parse(spawnCalls[0].options.env?.OPENCODE_PERMISSION ?? '')).toMatchObject({
      '*': 'ask',
      bash: 'ask',
      edit: 'ask',
    });
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ agent: 'agor-managed' }) })
    );
  });

  it('requires the built-in Agor MCP token before spawn', async () => {
    const { tool, spawnCalls, client } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo: {},
      mcpServerRepo: {},
    });

    await expect(tool.runTurn(input({ mcpToken: undefined }))).rejects.toThrow(
      'OpenCode requires the built-in Agor MCP token'
    );
    expect(spawnCalls).toHaveLength(0);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('places the required Agor and attached MCP servers in invocation config before spawn', async () => {
    const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
    vi.mocked(getMcpServersForSession).mockResolvedValueOnce([
      {
        source: 'session-assigned',
        server: {
          mcp_server_id: '00000000-0000-7000-8000-000000000099',
          name: 'Local tools',
          transport: 'stdio',
          command: '/usr/bin/local-mcp',
          args: ['--safe'],
          env: { MODE: 'managed' },
        },
      } as never,
    ]);
    const sessionMCPRepo = {};
    const mcpServerRepo = {};
    const { tool, spawnCalls } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo,
      mcpServerRepo,
    });

    await tool.runTurn(input());

    expect(getMcpServersForSession).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000001',
      expect.objectContaining({ sessionMCPRepo, mcpServerRepo, mode: 'strict' })
    );
    expect(JSON.parse(spawnCalls[0].options.env?.OPENCODE_CONFIG_CONTENT ?? '')).toMatchObject({
      permission: { '*': 'ask', bash: 'ask', edit: 'ask' },
      mcp: {
        agor_000000000000700080000000: {
          type: 'remote',
          url: 'http://127.0.0.1:3030/mcp',
          enabled: true,
          headers: { Authorization: 'Bearer mcp-secret' },
        },
        agor_000000000000700080000000_000000000000700080000000_local_tools: {
          type: 'local',
          command: ['/usr/bin/local-mcp', '--safe'],
          environment: { MODE: 'managed' },
          enabled: true,
        },
      },
    });
  });

  it('places authenticated remote MCP headers in invocation config before spawn', async () => {
    const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
    vi.mocked(getMcpServersForSession).mockResolvedValueOnce([
      {
        source: 'session-assigned',
        server: {
          mcp_server_id: '00000000-0000-7000-8000-000000000099',
          name: 'Remote tools',
          transport: 'http',
          url: 'http://127.0.0.1:4100/mcp',
          auth: { type: 'bearer', token: 'attached-bearer-token' },
        },
      } as never,
    ]);
    const { tool, spawnCalls } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo: {},
      mcpServerRepo: {},
    });

    await tool.runTurn(input());

    expect(JSON.parse(spawnCalls[0].options.env?.OPENCODE_CONFIG_CONTENT ?? '')).toMatchObject({
      mcp: {
        agor_000000000000700080000000_000000000000700080000000_remote_tools: {
          type: 'remote',
          url: 'http://127.0.0.1:4100/mcp',
          headers: { Authorization: 'Bearer attached-bearer-token' },
        },
      },
    });
  });

  it('fails closed before spawn if strict resolution returns required remote auth without a header', async () => {
    const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
    vi.mocked(getMcpServersForSession).mockResolvedValueOnce([
      {
        source: 'session-assigned',
        server: {
          mcp_server_id: '00000000-0000-7000-8000-000000000099',
          name: 'Missing bearer',
          transport: 'http',
          url: 'http://127.0.0.1:4100/mcp',
          auth: { type: 'bearer' },
        },
      } as never,
    ]);
    const { tool, spawnCalls, client } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo: {},
      mcpServerRepo: {},
    });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'Attached MCP server Missing bearer did not resolve a usable Authorization header'
    );
    expect(spawnCalls).toHaveLength(0);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('fails closed before spawn when required remote JWT authentication fails', async () => {
    const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
    vi.mocked(getMcpServersForSession).mockResolvedValueOnce([
      {
        source: 'session-assigned',
        server: {
          mcp_server_id: '00000000-0000-7000-8000-000000000099',
          name: 'Rejected JWT',
          transport: 'http',
          url: 'http://127.0.0.1:4100/mcp',
          auth: {
            type: 'jwt',
            api_url: 'http://127.0.0.1:4101/token',
            api_token: 'jwt-client',
            api_secret: 'jwt-secret',
          },
        },
      } as never,
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'rejected jwt-secret',
    } as Response);
    const { tool, spawnCalls, client } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo: {},
      mcpServerRepo: {},
    });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'Attached MCP server Rejected JWT authentication failed'
    );
    expect(spawnCalls).toHaveLength(0);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('does not spawn or prompt when required MCP resolution fails', async () => {
    const client = createClient();
    const { tool, spawnCalls } = makeTool({
      client,
      resolveInvocationConfig: vi.fn().mockRejectedValue(new Error('attached MCP unavailable')),
    });

    await expect(tool.runTurn(input())).rejects.toThrow('attached MCP unavailable');
    expect(spawnCalls).toHaveLength(0);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('normalizes invocation-resolution failures before fatal rethrow', async () => {
    const previousDeclared = process.env.AGOR_USER_ENV_KEYS;
    const previousDeclaredValue = process.env.OPENCODE_DECLARED_VALUE;
    const previousNamedValue = process.env.OPENCODE_RESOLVER_TOKEN;
    process.env.AGOR_USER_ENV_KEYS = 'OPENCODE_DECLARED_VALUE';
    process.env.OPENCODE_DECLARED_VALUE = 'declared-process-secret';
    process.env.OPENCODE_RESOLVER_TOKEN = 'secret-named-process-value';
    const rawError = new Error(
      'attached MCP unavailable: mcp-secret declared-process-secret secret-named-process-value'
    );
    Object.assign(rawError, {
      response: {
        headers: { authorization: 'Bearer mcp-secret' },
        nested: { token: 'mcp-secret' },
      },
    });
    const client = createClient();
    const { tool, spawnCalls } = makeTool({
      client,
      resolveInvocationConfig: vi.fn().mockRejectedValue(rawError),
    });

    try {
      let rejection: unknown;
      try {
        await tool.runTurn(input());
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBe(rawError);
      expect(Object.keys(rejection as Error)).toEqual([]);
      const inspected = inspect(rejection, { depth: null });
      expect(inspected).not.toContain('mcp-secret');
      expect(inspected).not.toContain('declared-process-secret');
      expect(inspected).not.toContain('secret-named-process-value');
      expect(spawnCalls).toHaveLength(0);
      expect(client.session.prompt).not.toHaveBeenCalled();
    } finally {
      if (previousDeclared === undefined) delete process.env.AGOR_USER_ENV_KEYS;
      else process.env.AGOR_USER_ENV_KEYS = previousDeclared;
      if (previousDeclaredValue === undefined) delete process.env.OPENCODE_DECLARED_VALUE;
      else process.env.OPENCODE_DECLARED_VALUE = previousDeclaredValue;
      if (previousNamedValue === undefined) delete process.env.OPENCODE_RESOLVER_TOKEN;
      else process.env.OPENCODE_RESOLVER_TOKEN = previousNamedValue;
    }
  });

  it('normalizes managed spawn failures before fatal rethrow', async () => {
    const password = Buffer.alloc(32, 88).toString('base64url');
    let rawError: Error | undefined;
    const client = createClient();
    const { tool, spawnCalls } = makeTool({
      client,
      randomBytes: vi.fn().mockReturnValue(Buffer.alloc(32, 88)),
      spawn: (_executable, _args, options) => {
        rawError = new Error(`spawn failed with ${options.env?.OPENCODE_SERVER_PASSWORD}`);
        Object.assign(rawError, {
          response: {
            headers: { authorization: `Basic ${password}` },
            nested: { token: 'mcp-secret' },
          },
        });
        throw rawError;
      },
    });

    let rejection: unknown;
    try {
      await tool.runTurn(input());
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(rawError);
    expect(Object.keys(rejection as Error)).toEqual([]);
    const formatted = inspect(rejection, { depth: null });
    expect(formatted).not.toContain(password);
    expect(formatted).not.toContain('mcp-secret');
    expect(spawnCalls).toHaveLength(0);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('fails closed before spawn when an attached MCP server is incomplete', async () => {
    const { getMcpServersForSession } = await import('../base/mcp-scoping.js');
    vi.mocked(getMcpServersForSession).mockResolvedValueOnce([
      {
        source: 'session-assigned',
        server: {
          mcp_server_id: '00000000-0000-7000-8000-000000000099',
          name: 'Broken tools',
          transport: 'stdio',
        },
      } as never,
    ]);
    const { tool, spawnCalls, client } = makeTool({
      useDefaultInvocationConfig: true,
      sessionMCPRepo: {},
      mcpServerRepo: {},
    });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'Attached MCP server Broken tools is missing its command'
    );
    expect(spawnCalls).toHaveLength(0);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('persists a newly created session before submitting its first prompt', async () => {
    const order: string[] = [];
    const client = createClient({
      sessionId: 'oc-created',
      create: vi.fn(async () => {
        order.push('create');
        return { data: { id: 'oc-created' } };
      }),
      prompt: vi.fn(async () => {
        order.push('prompt');
        return { data: { info: {}, parts: [{ type: 'text', text: 'done' }] } };
      }),
    });
    const persistOpenCodeSessionId = vi.fn(async () => order.push('persist'));
    const { tool } = makeTool({ client });

    const result = await tool.runTurn(input({ persistOpenCodeSessionId }));

    expect(order).toEqual(['create', 'persist', 'prompt']);
    expect(persistOpenCodeSessionId).toHaveBeenCalledWith('oc-created');
    expect(result).toMatchObject({ openCodeSessionId: 'oc-created', sessionWasCreated: true });
  });

  it('admits an available explicit pair on the same server before session creation and prompt', async () => {
    const order: string[] = [];
    const client = createClient({
      sessionId: 'oc-created',
      configProviders: vi.fn(async () => {
        order.push('admit');
        return {
          data: {
            providers: [
              {
                id: 'openai',
                models: { 'gpt-5': { id: 'gpt-5' } },
              },
            ],
            default: { openai: 'gpt-5' },
          },
        };
      }),
      providerList: vi.fn(async () => ({
        data: {
          all: [{ id: 'openai', name: 'OpenAI' }],
          connected: ['openai'],
          default: {},
        },
      })),
      create: vi.fn(async () => {
        order.push('create');
        return { data: { id: 'oc-created' } };
      }),
      prompt: vi.fn(async () => {
        order.push('prompt');
        return { data: { info: {}, parts: [{ type: 'text', text: 'done' }] } };
      }),
    });
    const persistOpenCodeSessionId = vi.fn(async () => order.push('persist'));
    const { tool, createClientSpy } = makeTool({ client });

    await tool.runTurn(
      input({
        provider: 'openai',
        model: 'gpt-5',
        persistOpenCodeSessionId,
      })
    );

    expect(order).toEqual(['admit', 'create', 'persist', 'prompt']);
    expect(client.config.providers).toHaveBeenCalledWith({
      query: { directory: '/worktree' },
    });
    expect(client.provider.list).toHaveBeenCalledWith({
      query: { directory: '/worktree' },
    });
    expect(createClientSpy).toHaveBeenCalledOnce();
  });

  it('rejects a catalog-only provider before session or prompt traffic', async () => {
    const configProviders = vi.fn().mockResolvedValue({
      data: {
        providers: [{ id: 'openai', models: { 'gpt-5': { id: 'gpt-5' } } }],
        default: { openai: 'gpt-5' },
      },
    });
    const providerList = vi.fn().mockResolvedValue({
      data: {
        all: [{ id: 'openai', name: 'OpenAI' }],
        connected: [],
        default: {},
      },
    });
    const client = createClient({ configProviders, providerList });
    const { tool, child } = makeTool({ client });

    const persistOpenCodeSessionId = vi.fn();
    await expect(
      tool.runTurn(
        input({
          provider: 'openai',
          model: 'gpt-5',
          persistOpenCodeSessionId,
        })
      )
    ).rejects.toThrow(
      'The selected OpenCode provider/model is not available for this session owner and branch configuration'
    );

    expect(configProviders).toHaveBeenCalledOnce();
    expect(providerList).toHaveBeenCalledOnce();
    expect(client.session.get).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(client.event.subscribe).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(persistOpenCodeSessionId).not.toHaveBeenCalled();
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('names the safe pair and recovery action when prompt authentication fails', async () => {
    const secret = 'provider-secret-at-/private/auth/path';
    const client = createClient({
      prompt: vi.fn().mockResolvedValue({
        error: { message: `Unauthorized ${secret}` },
      }),
    });
    const { tool } = makeTool({ client });

    let failure: unknown;
    try {
      await tool.runTurn(input());
    } catch (error) {
      failure = error;
    }

    const formatted = inspect(failure);
    expect(formatted).toContain('OpenCode prompt failed for test-provider/test-model');
    expect(formatted).toContain(
      'Reconnect test-provider in OpenCode settings or choose another provider/model'
    );
    expect(formatted).not.toContain(secret);
    expect(formatted).not.toContain('/private/auth/path');
  });

  it('rejects a missing pair before config, child process, session, subscription, or prompt work', async () => {
    const client = createClient();
    const spawn = vi.fn();
    const resolveInvocationConfig = vi.fn();
    const { tool } = makeTool({ client, spawn, resolveInvocationConfig });

    await expect(tool.runTurn(input({ provider: undefined, model: undefined }))).rejects.toThrow(
      /select.*provider.*model/i
    );

    expect(resolveInvocationConfig).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(client.config.providers).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.event.subscribe).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('validates a stored session and fails without replacement when it cannot resume', async () => {
    const client = createClient({
      get: vi.fn().mockResolvedValue({ error: { name: 'NotFoundError' } }),
    });
    const { tool, child } = makeTool({ client });

    await expect(tool.runTurn(input({ existingOpenCodeSessionId: 'oc-missing' }))).rejects.toThrow(
      'Unable to resume stored OpenCode session oc-missing'
    );
    expect(client.session.get).toHaveBeenCalledWith({
      path: { id: 'oc-missing' },
      query: { directory: '/worktree' },
    });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('redacts generated credentials from bounded readiness failures', async () => {
    const child = new FakeChild();
    const spawnCalls: SpawnCall[] = [];
    const attachedSecret = 'attached-provider-secret';
    const { tool } = makeTool({
      child,
      spawnCalls,
      readinessTimeoutMs: 50,
      resolveInvocationConfig: vi.fn().mockResolvedValue({
        mcp: {
          attached: {
            type: 'local',
            command: ['/bin/mcp'],
            environment: { UNUSUAL_CREDENTIAL_NAME: attachedSecret },
          },
        },
      }),
      spawn: (executable: string, args: readonly string[], options: SpawnCall['options']) => {
        spawnCalls.push({ executable, args, options });
        queueMicrotask(() => {
          child.stderr.write(
            `failed with ${options.env?.OPENCODE_SERVER_PASSWORD}, mcp-secret, and ${attachedSecret}\n`
          );
          child.exit(1);
        });
        return child;
      },
    });

    const promise = tool.runTurn(input());
    await expect(promise).rejects.toThrow('[REDACTED]');
    await expect(promise).rejects.not.toThrow(
      spawnCalls[0].options.env?.OPENCODE_SERVER_PASSWORD ?? 'missing-secret'
    );
    await expect(promise).rejects.not.toThrow('mcp-secret');
    await expect(promise).rejects.not.toThrow(attachedSecret);
  });

  it('normalizes post-readiness failures into fresh safe errors before callbacks and rethrow', async () => {
    const providerSecret = 'provider-post-readiness-secret';
    const attachedMcpSecret = 'attached-mcp-post-readiness-secret';
    const password = Buffer.alloc(32, 77).toString('base64url');
    const rawFailure = [password, 'mcp-secret', providerSecret, attachedMcpSecret].join(' :: ');
    const rawCause = new Error(`nested cause ${providerSecret}`);
    Object.assign(rawCause, {
      response: { headers: { authorization: `Bearer ${attachedMcpSecret}` } },
    });
    const rawError = new Error(rawFailure, { cause: rawCause });
    Object.assign(rawError, {
      response: {
        headers: { authorization: `Basic ${password}` },
        nested: { providerKey: providerSecret, mcpToken: 'mcp-secret' },
      },
    });
    const client = createClient({
      subscribe: vi.fn().mockResolvedValue({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message.updated',
              properties: {
                info: { id: 'assistant-1', sessionID: 'oc-new', role: 'assistant' },
              },
            };
            yield {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'part-1',
                  sessionID: 'oc-new',
                  messageID: 'assistant-1',
                  type: 'text',
                },
              },
            };
            yield {
              type: 'message.part.delta',
              properties: {
                sessionID: 'oc-new',
                messageID: 'assistant-1',
                partID: 'part-1',
                field: 'text',
                delta: 'started',
              },
            };
            throw rawError;
          },
        },
      }),
    });
    const onStreamError = vi.fn();
    const { tool } = makeTool({
      client,
      randomBytes: vi.fn().mockReturnValue(Buffer.alloc(32, 77)),
      resolveInvocationConfig: vi.fn().mockResolvedValue({
        mcp: {
          attached: {
            type: 'remote',
            url: 'http://127.0.0.1/mcp',
            headers: { Authorization: `Bearer ${attachedMcpSecret}` },
          },
        },
        provider: { proof: { options: { apiKey: providerSecret } } },
      }),
    });

    let rejection: unknown;
    try {
      await tool.runTurn(input(), {
        onStreamStart: vi.fn(),
        onStreamChunk: vi.fn(),
        onStreamEnd: vi.fn(),
        onStreamError,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(rawError);
    const callbackFailure = onStreamError.mock.calls[0]?.[1] as Error;
    expect(callbackFailure).not.toBe(rawError);
    expect(Object.keys(callbackFailure)).toEqual([]);
    expect(Object.keys(callbackFailure.cause as Error)).toEqual([]);
    expect(callbackFailure.message).toContain('[REDACTED]');
    const formatted = inspect([callbackFailure, rejection], { depth: null });
    for (const secret of [password, 'mcp-secret', providerSecret, attachedMcpSecret]) {
      expect(formatted).not.toContain(secret);
    }
  });

  it('rejects a readiness line that is not an authenticated loopback endpoint', async () => {
    const child = new FakeChild();
    const { tool } = makeTool({
      child,
      spawn: () => {
        child.ready('http://0.0.0.0:4096');
        return child;
      },
    });

    await expect(tool.runTurn(input())).rejects.toThrow(
      'OpenCode reported a non-loopback readiness URL'
    );
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('cleans up a readiness timeout and escalates to SIGKILL within the configured bound', async () => {
    const child = new FakeChild('SIGKILL');
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn(),
      cancelPendingRequests: vi.fn(),
    };
    const { tool } = makeTool({
      child,
      permissionService,
      readinessTimeoutMs: 5,
      shutdownTimeoutMs: 5,
      spawn: () => child,
    });

    await expect(tool.runTurn(input())).rejects.toThrow('timed out');
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(permissionService.cancelPendingRequests).toHaveBeenCalledOnce();
  });

  it('does not return normally until the managed server child exit is observed', async () => {
    const child = new FakeChild();
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn(),
      cancelPendingRequests: vi.fn(),
    };
    let exited = false;
    child.on('exit', () => {
      exited = true;
    });
    const { tool } = makeTool({ child, permissionService });

    await expect(tool.runTurn(input())).resolves.toMatchObject({ sessionWasCreated: true });
    expect(exited).toBe(true);
    expect(child.kills).toEqual(['SIGTERM']);
    expect(permissionService.cancelPendingRequests).toHaveBeenCalledOnce();
    expect(permissionService.cancelPendingRequests).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000001'
    );
  });

  it('observes an abort-triggered cleanup rejection until the main finally awaits it', async () => {
    const abortController = new AbortController();
    const child = new FakeChild('SIGHUP');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const client = createClient({
      prompt: vi.fn(async () => {
        abortController.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { data: { info: {}, parts: [{ type: 'text', text: 'done' }] } };
      }),
    });
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn(),
      cancelPendingRequests: vi.fn(),
    };
    const { tool } = makeTool({ client, child, shutdownTimeoutMs: 1, permissionService });

    try {
      await expect(tool.runTurn(input({ signal: abortController.signal }))).rejects.toThrow(
        'OpenCode server did not exit after bounded SIGTERM/SIGKILL cleanup'
      );
      expect(unhandled).toEqual([]);
      expect(client.session.abort).toHaveBeenCalledOnce();
      expect(permissionService.cancelPendingRequests).toHaveBeenCalledOnce();
      expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
