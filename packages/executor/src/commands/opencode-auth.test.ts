import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  close: vi.fn(async () => undefined),
  start: vi.fn(),
  sanitizeError: vi.fn((value: unknown) =>
    value instanceof Error ? value : new Error(String(value))
  ),
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn(() => runtime.clients.shift()),
}));

vi.mock('../sdk-handlers/opencode/managed-server.js', async () => {
  const actual = await vi.importActual<typeof import('../sdk-handlers/opencode/managed-server.js')>(
    '../sdk-handlers/opencode/managed-server.js'
  );
  return {
    ...actual,
    startManagedOpenCodeServer: runtime.start,
    verifyOpenCodeAuthFileBoundary: vi.fn(async () => undefined),
  };
});

import { executeCommand } from './index';

const providerList = (connected: string[]) => ({
  data: {
    all: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding' },
      { id: 'zhipuai-coding-plan', name: 'GLM Coding Plan' },
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
    instance: { dispose: vi.fn(async () => ({ data: true })) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.clients = [];
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

describe('opencode.auth executor command', () => {
  it('connects Kimi through generic native API auth and verifies status on a fresh server', async () => {
    const mutationClient = client();
    const verificationClient = client(['kimi-for-coding']);
    runtime.clients.push(mutationClient, verificationClient);

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
            configured: true,
            status: 'configured',
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
    expect(runtime.start).toHaveBeenCalledTimes(2);
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

  it('keeps the native method index and completes auto OAuth on one server before fresh verification', async () => {
    const authClient = client([], {
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
    const verificationClient = client(['openai'], {
      openai: [
        { type: 'oauth', label: 'ChatGPT browser' },
        { type: 'oauth', label: 'ChatGPT headless' },
      ],
    });
    verificationClient.provider.list.mockResolvedValue({
      data: {
        all: [{ id: 'openai', name: 'OpenAI' }],
        connected: ['openai'],
        default: {},
      },
    });
    runtime.clients.push(authClient, verificationClient);
    const events: unknown[] = [];

    const { handleOpenCodeOAuth } = await import('./opencode-auth');
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
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: 'openai', configured: true }),
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

    const { handleOpenCodeOAuth } = await import('./opencode-auth');
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
          expect.objectContaining({ id: 'openai', configured: true }),
        ]),
      }),
    });
  });

  it('delivers one bounded code callback to the same native auth client without exposing it', async () => {
    const authClient = client();
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
    const verificationClient = client(['openai']);
    verificationClient.provider.list.mockResolvedValue({
      data: {
        all: [{ id: 'openai', name: 'OpenAI' }],
        connected: ['openai'],
        default: {},
      },
    });
    runtime.clients.push(authClient, verificationClient);
    const events: unknown[] = [];

    const { handleOpenCodeOAuth } = await import('./opencode-auth');
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

  it('disconnects GLM generically and verifies it is absent on a fresh server', async () => {
    const mutationClient = client(['zhipuai-coding-plan']);
    const verificationClient = client([]);
    runtime.clients.push(mutationClient, verificationClient);

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
            configured: false,
            status: 'disconnected',
          }),
        ]),
      }),
    });
    expect(runtime.start).toHaveBeenCalledTimes(2);
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
