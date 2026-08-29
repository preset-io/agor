import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  close: vi.fn(async () => undefined),
  ensureDataHome: vi.fn(async () => undefined),
  readAuthFile: vi.fn(),
  resolveBinary: vi.fn(),
  start: vi.fn(),
  verifyAuthFileBoundary: vi.fn(async () => undefined),
  sanitizeError: vi.fn((value: unknown) =>
    value instanceof Error ? value : new Error(String(value))
  ),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: runtime.readAuthFile };
});

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn(() => runtime.clients.shift()),
}));

import {
  handleOpenCodeAuth,
  handleOpenCodeOAuth as handleOpenCodeOAuthWithRuntime,
  type OpenCodeAuthPayload,
  type OpenCodeCommandOptions,
  type OpenCodeOAuthPayload,
} from './auth-handler.js';

const runtimeDependencies = {
  ensureOpenCodeDataHome: runtime.ensureDataHome,
  startManagedOpenCodeServer: runtime.start,
  verifyOpenCodeAuthFileBoundary: runtime.verifyAuthFileBoundary,
  resolveOpenCodeBinary: runtime.resolveBinary,
};

function executeCommand(payload: OpenCodeAuthPayload, options: OpenCodeCommandOptions = {}) {
  return handleOpenCodeAuth(payload, options, runtimeDependencies);
}

function handleOpenCodeOAuth(
  payload: OpenCodeOAuthPayload,
  options: OpenCodeCommandOptions,
  emit: Parameters<typeof handleOpenCodeOAuthWithRuntime>[2],
  readCode?: Parameters<typeof handleOpenCodeOAuthWithRuntime>[3]
) {
  return handleOpenCodeOAuthWithRuntime(payload, options, emit, readCode, runtimeDependencies);
}

const providerList = (connected: string[]) => ({
  data: {
    all: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding' },
      { id: 'zhipuai-coding-plan', name: 'GLM Coding Plan' },
      { id: 'opencode', name: 'OpenCode Zen' },
      { id: 'openai', name: 'OpenAI' },
    ],
    connected,
    default: {},
  },
});

function client(
  connected: string[] = [],
  authMethods: Record<string, unknown[]> = {
    'kimi-for-coding': [],
    'zhipuai-coding-plan': [],
    opencode: [],
  }
) {
  return {
    auth: {
      set: vi.fn(async () => ({ data: true })),
      remove: vi.fn(async () => ({ data: true })),
    },
    provider: {
      list: vi.fn(async () => providerList(connected)),
      auth: vi.fn(async () => ({ data: authMethods })),
      oauth: {
        authorize: vi.fn(),
        callback: vi.fn(),
      },
    },
    config: {
      providers: vi.fn(async () => ({
        data: {
          providers: providerList([]).data.all.map((provider) => ({
            ...provider,
            models: {
              [`${provider.id}-default`]: {
                id: `${provider.id}-default`,
                name: `${provider.name} default`,
                status: 'active',
              },
            },
          })),
          default: Object.fromEntries(
            providerList([]).data.all.map((provider) => [provider.id, `${provider.id}-default`])
          ),
        },
      })),
      get: vi.fn(async () => ({ data: {} })),
    },
    instance: { dispose: vi.fn(async () => ({ data: true })) },
  };
}

beforeEach(() => {
  // These integration tests exercise the source-checkout SDK path regardless
  // of whether their parent Agor executor is itself a managed installation.
  vi.stubEnv('AGOR_MANAGED_AGENTIC_TOOLS', '0');
  vi.clearAllMocks();
  runtime.clients = [];
  runtime.readAuthFile.mockResolvedValue('{}');
  runtime.resolveBinary.mockResolvedValue({ executable: 'opencode', argsPrefix: [] });
  runtime.start.mockImplementation(async () => ({
    baseUrl: 'http://127.0.0.1:1234',
    authorization: 'Basic synthetic',
    sanitizer: {
      text: (value: string) => value,
      error: runtime.sanitizeError,
    },
    close: runtime.close,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('opencode.auth executor command', () => {
  it('returns configured known choices without starting an OpenCode server', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ openai: { type: 'api', key: 'must-not-cross' } })
    );

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'read-model-catalog' },
    });

    expect(runtime.ensureDataHome).toHaveBeenCalledWith(
      '/home/alice/.local/share/agor/opencode/opaque'
    );
    expect(runtime.verifyAuthFileBoundary).toHaveBeenCalledWith(
      '/home/alice/.local/share/agor/opencode/opaque',
      { allowMissing: true }
    );
    expect(runtime.start).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        runtimeVersion: expect.any(String),
        suggestedSelection: {
          providerId: 'openai',
          modelId: 'gpt-5.6-terra-pro',
        },
        providers: expect.arrayContaining([
          expect.objectContaining({ id: 'openai', availableForSelection: true }),
          expect.objectContaining({ id: 'opencode', availableForSelection: true }),
        ]),
      }),
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
  });

  it('reports an unresolved pinned binary as runtime-unavailable before any server work', async () => {
    runtime.resolveBinary.mockRejectedValue(
      new Error("OpenCode CLI 1.18.20 is incompatible with Agor's pinned SDK 1.14.33.")
    );

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'OPENCODE_RUNTIME_UNAVAILABLE',
        message: "OpenCode CLI 1.18.20 is incompatible with Agor's pinned SDK 1.14.33.",
      },
    });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('serves the known model catalog even when the pinned binary is unresolved', async () => {
    runtime.resolveBinary.mockRejectedValue(new Error('no binary'));

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'read-model-catalog' },
    });

    expect(result).toMatchObject({ success: true });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('returns one secret-safe branch-scoped configuration snapshot from one server', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ openai: { type: 'api', key: 'must-not-cross' } })
    );
    const discoveryClient = client(['openai'], { openai: [] });
    discoveryClient.provider.list.mockResolvedValue({
      data: {
        all: [{ id: 'openai', name: 'OpenAI' }],
        connected: ['openai'],
        default: {},
      },
    });
    discoveryClient.config.providers.mockResolvedValue({
      data: {
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            key: 'must-not-cross',
            models: {
              'gpt-next': {
                id: 'gpt-next',
                name: 'GPT Next',
                status: 'active',
                options: { apiKey: 'must-not-cross' },
              },
            },
          },
        ],
        default: { openai: 'gpt-next' },
      },
    });
    discoveryClient.config.get.mockResolvedValue({
      data: { model: 'openai/gpt-next', provider: { openai: { apiKey: 'must-not-cross' } } },
    });
    runtime.clients.push(discoveryClient);

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover', directory: '/worktrees/authorized-branch' },
    } as never);

    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.verifyAuthFileBoundary.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.start.mock.invocationCallOrder[0]!
    );
    expect(runtime.start).toHaveBeenCalledWith(
      expect.objectContaining({
        dataHome: '/home/alice/.local/share/agor/opencode/opaque',
        directory: '/worktrees/authorized-branch',
      })
    );
    expect(discoveryClient.provider.auth).toHaveBeenCalledWith({
      directory: '/worktrees/authorized-branch',
    });
    expect(result).toEqual({
      success: true,
      data: {
        runtime: 'available',
        runtimeVersion: '1.14.33',
        projectConfigured: { providerId: 'openai', modelId: 'gpt-next' },
        suggestedSelection: { providerId: 'openai', modelId: 'gpt-next' },
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            runtimeAvailable: true,
            credentialPresence: 'present',
            authMethods: [],
            suggestedModel: 'gpt-next',
            models: [{ id: 'gpt-next', name: 'GPT Next', status: 'active' }],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/must-not-cross|\/home\/alice/);
  });

  it('prefers the first credentialed provider with an active native default', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ 'kimi-for-coding': { type: 'api', key: 'must-not-cross' } })
    );
    runtime.clients.push(client(['kimi-for-coding', 'opencode']));

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        suggestedSelection: {
          providerId: 'kimi-for-coding',
          modelId: 'kimi-for-coding-default',
        },
      }),
    });
  });

  it('falls back to the first runtime-available provider when no credential is saved', async () => {
    runtime.clients.push(client(['opencode']));

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        suggestedSelection: { providerId: 'opencode', modelId: 'opencode-default' },
      }),
    });
  });

  it('separates runtime availability from saved credential presence, including Zen', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({
        'kimi-for-coding': { type: 'api', key: 'must-not-cross' },
      })
    );
    runtime.clients.push(client(['kimi-for-coding', 'opencode']));

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'kimi-for-coding',
            runtimeAvailable: true,
            credentialPresence: 'present',
          }),
          expect.objectContaining({
            id: 'zhipuai-coding-plan',
            runtimeAvailable: false,
            credentialPresence: 'absent',
          }),
          expect.objectContaining({
            id: 'opencode',
            runtimeAvailable: true,
            credentialPresence: 'absent',
          }),
        ]),
      }),
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
  });

  it('retains saved providers that disappear from the current runtime catalog', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ 'removed-provider': { type: 'api', key: 'must-not-cross' } })
    );
    runtime.clients.push(client(['opencode']));

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          {
            id: 'removed-provider',
            name: 'removed-provider',
            runtimeAvailable: false,
            credentialPresence: 'present',
            authMethods: [],
            models: [],
          },
        ]),
      }),
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
  });

  it('reports unknown credential presence when native auth evidence is missing', async () => {
    runtime.readAuthFile.mockRejectedValue(
      Object.assign(new Error('missing private path'), { code: 'ENOENT' })
    );
    runtime.clients.push(client(['opencode']));

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'opencode',
            runtimeAvailable: true,
            credentialPresence: 'unknown',
          }),
        ]),
      }),
    });
    expect(JSON.stringify(result)).not.toContain('private path');
  });

  it('connects Kimi and returns the updated configuration from the same server', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ 'kimi-for-coding': { type: 'api', key: 'must-not-cross' } })
    );
    const mutationClient = client(['kimi-for-coding']);
    runtime.clients.push(mutationClient);

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: {
        operation: 'connect-api-key',
        providerId: 'kimi-for-coding',
        apiKey: 'synthetic-kimi-key',
        metadata: { accountId: 'synthetic-account' },
      },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'kimi-for-coding',
            runtimeAvailable: true,
            credentialPresence: 'present',
          }),
        ]),
      }),
    });
    expect(mutationClient.auth.set).toHaveBeenCalledWith({
      providerID: 'kimi-for-coding',
      auth: {
        type: 'api',
        key: 'synthetic-kimi-key',
        metadata: { accountId: 'synthetic-account' },
      },
    });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.verifyAuthFileBoundary).toHaveBeenNthCalledWith(
      1,
      '/home/alice/.local/share/agor/opencode/opaque',
      { allowMissing: true }
    );
    expect(runtime.verifyAuthFileBoundary.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.start.mock.invocationCallOrder[0]!
    );
    expect(runtime.verifyAuthFileBoundary.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      mutationClient.auth.set.mock.invocationCallOrder[0]!
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-kimi-key');
    expect(JSON.stringify(result)).not.toContain('/home/alice');
  });

  it('preserves pinned native API prompts and conditional metadata during discovery', async () => {
    runtime.clients.push(
      client([], {
        'kimi-for-coding': [
          {
            type: 'api',
            label: 'Workspace key',
            prompts: [
              {
                type: 'select',
                key: 'region',
                message: 'Region',
                options: [{ label: 'US', value: 'us', hint: 'United States' }],
              },
              {
                type: 'text',
                key: 'account',
                message: 'Account',
                placeholder: 'acct-123',
                when: { key: 'region', op: 'eq', value: 'us' },
              },
            ],
          },
        ],
      })
    );

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'kimi-for-coding',
            authMethods: [
              {
                index: 0,
                type: 'api',
                label: 'Workspace key',
                prompts: [
                  {
                    type: 'select',
                    key: 'region',
                    message: 'Region',
                    options: [{ label: 'US', value: 'us', hint: 'United States' }],
                  },
                  {
                    type: 'text',
                    key: 'account',
                    message: 'Account',
                    placeholder: 'acct-123',
                    when: { key: 'region', op: 'eq', value: 'us' },
                  },
                ],
              },
            ],
          }),
        ]),
      }),
    });
  });

  it('keeps the native method index and returns OAuth configuration from the same server', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ openai: { type: 'oauth', refresh: 'must-not-cross' } })
    );
    const authClient = client(['openai'], {
      openai: [
        { type: 'oauth', label: 'ChatGPT browser' },
        {
          type: 'oauth',
          label: 'ChatGPT headless',
          prompts: [
            {
              type: 'select',
              key: 'region',
              message: 'Region',
              options: [{ label: 'US', value: 'us' }],
            },
          ],
        },
      ],
    });
    authClient.provider.oauth.authorize.mockResolvedValue({
      data: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Open the synthetic authorization page.',
      },
    });
    authClient.provider.oauth.callback.mockResolvedValue({ data: true });
    runtime.clients.push(authClient);
    const events: unknown[] = [];

    const result = await handleOpenCodeOAuth(
      {
        command: 'opencode.auth',
        dataHome: '/home/alice/.local/share/agor/opencode/opaque',
        params: {
          operation: 'connect-oauth',
          providerId: 'openai',
          method: 1,
          inputs: { region: 'us' },
        },
      } as never,
      {},
      (event) => events.push(event)
    );

    expect(authClient.provider.oauth.authorize).toHaveBeenCalledWith({
      providerID: 'openai',
      method: 1,
      inputs: { region: 'us' },
      directory: '/home/alice/.local/share/agor/opencode/opaque',
    });
    expect(authClient.provider.oauth.callback).toHaveBeenCalledWith({
      providerID: 'openai',
      method: 1,
      directory: '/home/alice/.local/share/agor/opencode/opaque',
    });
    expect(events).toEqual([
      {
        type: 'authorized',
        authorization: {
          url: 'http://127.0.0.1:9898/authorize',
          method: 'auto',
          instructions: 'Open the synthetic authorization page.',
        },
      },
      { type: 'callback-started' },
    ]);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'openai',
            runtimeAvailable: true,
            credentialPresence: 'present',
          }),
        ]),
      }),
    });
  });

  it('closes a denied OAuth runtime without changing a previously configured connection', async () => {
    const authClient = client(['openai']);
    authClient.provider.oauth.authorize.mockResolvedValue({
      data: {
        url: 'http://127.0.0.1:9898/authorize?secret=synthetic',
        method: 'auto',
        instructions: 'Synthetic instruction code 1234',
      },
    });
    authClient.provider.oauth.callback.mockResolvedValue({ error: { name: 'denied' } });
    runtime.clients.push(authClient);

    const result = await handleOpenCodeOAuth(
      {
        command: 'opencode.auth',
        dataHome: '/home/alice/.local/share/agor/opencode/opaque',
        params: {
          operation: 'connect-oauth',
          providerId: 'openai',
          method: 1,
        },
      } as never,
      {},
      () => undefined
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'OPENCODE_AUTH_FAILED',
        message: 'OpenCode provider operation failed without exposing credential details.',
      },
    });
    expect(authClient.auth.set).not.toHaveBeenCalled();
    expect(authClient.auth.remove).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('synthetic');
    expect(JSON.stringify(result)).not.toContain('/home/alice');

    const preservedClient = client(['openai']);
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ openai: { type: 'oauth', refresh: 'must-not-cross' } })
    );
    preservedClient.provider.list.mockResolvedValue({
      data: {
        all: [{ id: 'openai', name: 'OpenAI' }],
        connected: ['openai'],
        default: {},
      },
    });
    runtime.clients.push(preservedClient);
    const preservedConnection = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);
    expect(preservedConnection).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'openai',
            runtimeAvailable: true,
            credentialPresence: 'present',
          }),
        ]),
      }),
    });
  });

  it('delivers one bounded code callback to the same native auth client without exposing it', async () => {
    runtime.readAuthFile.mockResolvedValue(
      JSON.stringify({ openai: { type: 'oauth', refresh: 'must-not-cross' } })
    );
    const authClient = client(['openai']);
    authClient.provider.oauth.authorize.mockResolvedValue({
      data: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'code',
        instructions: 'Paste the one-time code.',
      },
    });
    authClient.provider.oauth.callback.mockImplementation(async ({ code }) => {
      expect(code).toBe('synthetic-one-time-code');
      return { data: true };
    });
    runtime.clients.push(authClient);
    const events: unknown[] = [];

    const result = await handleOpenCodeOAuth(
      {
        command: 'opencode.auth',
        dataHome: '/home/alice/.local/share/agor/opencode/opaque',
        params: {
          operation: 'connect-oauth',
          providerId: 'openai',
          method: 1,
        },
      } as never,
      {},
      (event) => events.push(event),
      async () => 'synthetic-one-time-code'
    );

    expect(authClient.provider.oauth.callback).toHaveBeenCalledWith({
      providerID: 'openai',
      method: 1,
      code: 'synthetic-one-time-code',
      directory: '/home/alice/.local/share/agor/opencode/opaque',
    });
    expect(events).toEqual([
      {
        type: 'authorized',
        authorization: {
          url: 'http://127.0.0.1:9898/authorize',
          method: 'code',
          instructions: 'Paste the one-time code.',
        },
      },
      { type: 'callback-started' },
    ]);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-one-time-code');
    expect(JSON.stringify(result)).not.toContain('/home/alice');
  });

  it('disconnects GLM and returns the updated configuration from the same server', async () => {
    runtime.readAuthFile
      .mockResolvedValueOnce(
        JSON.stringify({ 'zhipuai-coding-plan': { type: 'api', key: 'must-not-cross' } })
      )
      .mockResolvedValue('{}');
    const mutationClient = client([]);
    runtime.clients.push(mutationClient);

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: {
        operation: 'disconnect',
        providerId: 'zhipuai-coding-plan',
      },
    } as never);

    expect(mutationClient.auth.remove).toHaveBeenCalledWith({
      providerID: 'zhipuai-coding-plan',
    });
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'zhipuai-coding-plan',
            runtimeAvailable: false,
            credentialPresence: 'absent',
          }),
        ]),
      }),
    });
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('awaits instance disposal before closing the managed child', async () => {
    const order: string[] = [];
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const discoveryClient = client();
    discoveryClient.instance.dispose.mockImplementation(async () => {
      order.push('dispose-start');
      await disposeGate;
      order.push('dispose-end');
      return { data: true };
    });
    runtime.close.mockImplementation(async () => {
      order.push('close');
    });
    runtime.clients.push(discoveryClient);

    const pending = executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    await vi.waitFor(() => expect(order).toContain('dispose-start'));
    expect(runtime.close).not.toHaveBeenCalled();
    releaseDispose();
    const result = await pending;
    expect(result.success).toBe(true);
    expect(order).toEqual(['dispose-start', 'dispose-end', 'close']);
  });

  it('always closes and preserves disposal and close failures for sanitization', async () => {
    const discoveryClient = client();
    discoveryClient.instance.dispose.mockRejectedValue(new Error('dispose failed'));
    runtime.close.mockRejectedValue(new Error('close failed'));
    runtime.clients.push(discoveryClient);

    const result = await executeCommand({
      command: 'opencode.auth',
      dataHome: '/home/alice/.local/share/agor/opencode/opaque',
      params: { operation: 'discover' },
    } as never);

    expect(result.success).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
    const preserved = runtime.sanitizeError.mock.calls.at(-1)?.[0];
    expect(preserved).toBeInstanceOf(Error);
    expect(inspect((preserved as Error).cause, { depth: null })).toContain('dispose failed');
    expect(inspect((preserved as Error).cause, { depth: null })).toContain('close failed');
    expect(JSON.stringify(result)).not.toContain('dispose failed');
    expect(JSON.stringify(result)).not.toContain('close failed');
  });
});
