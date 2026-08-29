// @vitest-environment jsdom

import type { AgorClient } from '@agor/core/client';
import type { OpenCodeProviderSettings as Settings } from '@agor/core/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeProviderSettings } from './OpenCodeProviderSettings.js';

const initial: Settings = {
  runtime: 'available',
  runtimeVersion: '1.14.33',
  isolation: { mode: 'simple', boundary: 'logical' },
  providers: [
    {
      id: 'moonshotai',
      name: 'Kimi',
      runtimeAvailable: false,
      credentialPresence: 'absent',
      models: [],
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
              options: [{ label: 'US', value: 'us' }],
            },
            {
              type: 'text',
              key: 'accountId',
              message: 'Account ID',
              when: { key: 'region', op: 'eq', value: 'us' },
            },
          ],
        },
      ],
    },
    {
      id: 'zhipuai',
      name: 'GLM',
      runtimeAvailable: true,
      credentialPresence: 'present',
      models: [],
      authMethods: [],
    },
  ],
};
const copySuccessfully = async () => true;

function renderSettings(
  service: {
    find: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  },
  copyText = vi.fn(copySuccessfully)
) {
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  render(
    <AntApp>
      <OpenCodeProviderSettings client={client} copyText={copyText} />
    </AntApp>
  );
}

type AuthServiceMock = Parameters<typeof renderSettings>[0];

function createAuthService(overrides: Partial<AuthServiceMock> = {}): AuthServiceMock {
  return {
    find: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function singleProviderSettings(
  id: string,
  name: string,
  authMethods: Settings['providers'][number]['authMethods'] = []
): Settings {
  return {
    ...initial,
    providers: [
      {
        id,
        name,
        runtimeAvailable: false,
        credentialPresence: 'absent',
        models: [],
        authMethods,
      },
    ],
  };
}

function deviceCodeAttempt(attemptId: string) {
  return {
    attemptId,
    providerId: 'openai',
    phase: 'awaiting_callback' as const,
    expiresAt: '2026-08-05T12:00:00.000Z',
    authorization: {
      url: 'https://auth.openai.com/device',
      method: 'auto' as const,
      instructions: 'Enter code ABCD-12345',
    },
  };
}

describe('OpenCodeProviderSettings', () => {
  it('surfaces the server-provided load failure message instead of the generic fallback', async () => {
    const service = createAuthService({
      find: vi
        .fn()
        .mockRejectedValue(
          new Error("OpenCode CLI 1.18.20 is incompatible with Agor's pinned SDK 1.14.33.")
        ),
    });

    renderSettings(service);

    expect(
      await screen.findByText(
        "OpenCode CLI 1.18.20 is incompatible with Agor's pinned SDK 1.14.33."
      )
    ).toBeTruthy();
    expect(screen.queryByText('OpenCode provider settings could not be loaded.')).toBeNull();
  });

  it('keeps the selected provider credential draft isolated from visible runtime providers', async () => {
    const providers: Settings = {
      ...initial,
      providers: [
        {
          id: 'opencode',
          name: 'OpenCode Zen',
          runtimeAvailable: true,
          credentialPresence: 'unknown',
          models: [],
          authMethods: [],
        },
        {
          id: 'kimi-for-coding',
          name: 'Kimi for Coding',
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: [],
        },
      ],
    };
    const service = createAuthService({ find: vi.fn().mockResolvedValue(providers) });
    renderSettings(service);

    expect(await screen.findByText('OpenCode Zen')).toBeInTheDocument();
    expect(screen.queryByLabelText('OpenCode Zen API key')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.click(await screen.findByText('Kimi for Coding'));
    const kimiKey = await screen.findByLabelText('Kimi for Coding API key');
    expect(screen.queryByLabelText('OpenCode Zen API key')).not.toBeInTheDocument();

    fireEvent.change(kimiKey, { target: { value: 'synthetic-kimi-key' } });
    expect(kimiKey).toHaveValue('synthetic-kimi-key');
    expect(screen.queryByDisplayValue('synthetic-kimi-key')).toBe(kimiKey);

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.click((await screen.findAllByText('OpenCode Zen')).at(-1)!);
    await waitFor(() =>
      expect(screen.queryByLabelText('Kimi for Coding API key')).not.toBeInTheDocument()
    );
    expect(await screen.findByLabelText('OpenCode Zen API key')).toHaveValue('');
  });

  it('keeps a native-scale catalog progressive and renders only configured plus selected providers', async () => {
    const nativeScale: Settings = {
      ...initial,
      providers: [
        ...Array.from({ length: 170 }, (_, index) => ({
          id: `provider-${index}`,
          name: `Provider ${index}`,
          runtimeAvailable: false,
          credentialPresence: 'absent' as const,
          models: [],
          authMethods: [],
        })),
        ...initial.providers,
      ],
    };
    const service = createAuthService({ find: vi.fn().mockResolvedValue(nativeScale) });
    renderSettings(service);

    expect(await screen.findByText('GLM')).toBeInTheDocument();
    expect(screen.queryByText('Provider 169')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Kimi API key')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider to connect' }), {
      target: { value: 'Kimi' },
    });
    fireEvent.click(await screen.findByText('Kimi'));

    const kimiKey = await screen.findByLabelText('Kimi API key');
    expect(screen.queryByText('Provider 169')).not.toBeInTheDocument();

    fireEvent.change(kimiKey, { target: { value: 'must-not-survive-provider-switch' } });
    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider to connect' }), {
      target: { value: 'Provider 169' },
    });
    fireEvent.click(await screen.findByText('Provider 169'));
    expect(screen.queryByLabelText('Kimi API key')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider to connect' }), {
      target: { value: 'Kimi' },
    });
    fireEvent.click(await screen.findByText('Kimi'));
    expect(await screen.findByLabelText('Kimi API key')).toHaveValue('');
  });

  it('clears provider form secrets when the authenticated client scope changes', async () => {
    const scoped = (id: string, name: string): Settings => ({
      ...initial,
      providers: [
        {
          id,
          name,
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: [],
        },
      ],
    });
    const serviceA = {
      find: vi.fn().mockResolvedValue(scoped('provider-a', 'Provider A')),
      get: vi.fn(),
      create: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    const serviceB = {
      find: vi.fn().mockResolvedValue(scoped('provider-b', 'Provider B')),
      get: vi.fn(),
      create: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    const clientA = { service: vi.fn(() => serviceA) } as unknown as AgorClient;
    const clientB = { service: vi.fn(() => serviceB) } as unknown as AgorClient;
    const { rerender } = render(
      <AntApp>
        <OpenCodeProviderSettings client={clientA} copyText={copySuccessfully} />
      </AntApp>
    );

    fireEvent.change(await screen.findByLabelText('Provider A API key'), {
      target: { value: 'must-not-survive-subject-switch' },
    });
    rerender(
      <AntApp>
        <OpenCodeProviderSettings client={clientB} copyText={copySuccessfully} />
      </AntApp>
    );

    expect(document.body.textContent).not.toContain('must-not-survive-subject-switch');
    expect(await screen.findByLabelText('Provider B API key')).toHaveValue('');
    expect(screen.queryByLabelText('Provider A API key')).not.toBeInTheDocument();
  });

  it('discards a deferred API connect result after the authenticated client scope changes', async () => {
    const providerId = 'shared-provider';
    const scopeA = singleProviderSettings(providerId, 'Provider A');
    const scopeB = singleProviderSettings(providerId, 'Provider B');
    const configuredA: Settings = {
      ...scopeA,
      providers: [
        {
          ...scopeA.providers[0],
          runtimeAvailable: true,
          credentialPresence: 'present',
        },
      ],
    };
    const configuredB: Settings = {
      ...scopeB,
      providers: [
        {
          ...scopeB.providers[0],
          runtimeAvailable: true,
          credentialPresence: 'present',
        },
      ],
    };
    const connectA = deferred<Settings>();
    const connectB = deferred<Settings>();
    const serviceA = {
      find: vi.fn().mockResolvedValue(scopeA),
      get: vi.fn(),
      create: vi.fn().mockReturnValue(connectA.promise),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    const serviceB = {
      find: vi.fn().mockResolvedValue(scopeB),
      get: vi.fn(),
      create: vi.fn().mockReturnValue(connectB.promise),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    const clientA = { service: vi.fn(() => serviceA) } as unknown as AgorClient;
    const clientB = { service: vi.fn(() => serviceB) } as unknown as AgorClient;
    const { rerender } = render(
      <AntApp>
        <OpenCodeProviderSettings client={clientA} copyText={copySuccessfully} />
      </AntApp>
    );

    fireEvent.change(await screen.findByLabelText('Provider A API key'), {
      target: { value: 'scope-a-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(serviceA.create).toHaveBeenCalledOnce());

    rerender(
      <AntApp>
        <OpenCodeProviderSettings client={clientB} copyText={copySuccessfully} />
      </AntApp>
    );
    fireEvent.change(await screen.findByLabelText('Provider B API key'), {
      target: { value: 'scope-b-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(serviceB.create).toHaveBeenCalledOnce());

    connectA.resolve(configuredA);
    await act(async () => {
      await connectA.promise;
    });

    expect(screen.getByLabelText('Provider B API key')).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider A API key')).not.toBeInTheDocument();

    connectB.resolve(configuredB);
    expect(await screen.findByText('Saved credential')).toBeInTheDocument();
    expect(screen.getAllByText('Provider B')).not.toHaveLength(0);
  });

  it('does not publish a deferred connect result after provider settings unmounts', async () => {
    const providerId = 'shared-provider';
    const before = singleProviderSettings(providerId, 'Provider before');
    before.providers[0].models = [{ id: 'model', name: 'Before model', status: 'active' }];
    const after: Settings = {
      ...before,
      providers: [
        {
          ...before.providers[0],
          name: 'Provider after',
          runtimeAvailable: true,
          credentialPresence: 'present',
          models: [{ id: 'model', name: 'After model', status: 'active' }],
        },
      ],
    };
    const connect = deferred<Settings>();
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(before),
      create: vi.fn().mockReturnValue(connect.promise),
    });
    const client = { service: vi.fn(() => service) } as unknown as AgorClient;
    const { unmount } = render(
      <AntApp>
        <OpenCodeProviderSettings client={client} copyText={copySuccessfully} />
      </AntApp>
    );

    fireEvent.change(await screen.findByLabelText('Provider before API key'), {
      target: { value: 'scope-a-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(service.create).toHaveBeenCalledOnce());
    unmount();

    connect.resolve(after);
    await act(async () => connect.promise);
    render(
      <AntApp>
        <OpenCodeProviderSettings client={client} copyText={copySuccessfully} />
      </AntApp>
    );

    expect((await screen.findAllByText('Provider before')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Provider after')).not.toBeInTheDocument();
  });

  it('does not store a deferred OAuth attempt from a previous authenticated client scope', async () => {
    const providerId = 'oauth-provider';
    const oauthMethods = [{ index: 0, type: 'oauth' as const, label: 'Browser flow' }];
    const scopeA = singleProviderSettings(providerId, 'OAuth Provider A', oauthMethods);
    const scopeB = singleProviderSettings(providerId, 'OAuth Provider B', oauthMethods);
    const attemptA = {
      attemptId: 'attempt-a',
      providerId,
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/a',
        method: 'auto' as const,
        instructions: 'Scope A authorization.',
      },
    };
    const attemptB = {
      ...attemptA,
      attemptId: 'attempt-b',
      authorization: {
        ...attemptA.authorization,
        url: 'http://127.0.0.1:9898/b',
        instructions: 'Scope B authorization.',
      },
    };
    const oauthA = deferred<typeof attemptA>();
    const serviceA = {
      find: vi.fn().mockResolvedValue(scopeA),
      get: vi.fn(),
      create: vi.fn().mockReturnValue(oauthA.promise),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    const serviceB = {
      find: vi.fn().mockResolvedValue(scopeB),
      get: vi.fn().mockResolvedValue(attemptB),
      create: vi.fn().mockResolvedValue(attemptB),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    const clientA = { service: vi.fn(() => serviceA) } as unknown as AgorClient;
    const clientB = { service: vi.fn(() => serviceB) } as unknown as AgorClient;
    const { rerender } = render(
      <AntApp>
        <OpenCodeProviderSettings client={clientA} copyText={copySuccessfully} />
      </AntApp>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Browser flow' }));
    await waitFor(() => expect(serviceA.create).toHaveBeenCalledOnce());

    rerender(
      <AntApp>
        <OpenCodeProviderSettings client={clientB} copyText={copySuccessfully} />
      </AntApp>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Browser flow' }));
    expect(await screen.findByText('Scope B authorization.')).toBeInTheDocument();

    oauthA.resolve(attemptA);
    await act(async () => {
      await oauthA.promise;
    });

    expect(screen.getByText('Scope B authorization.')).toBeInTheDocument();
    expect(screen.queryByText('Scope A authorization.')).not.toBeInTheDocument();
  });

  it('discards a deferred API connect after switching providers without clearing the newer busy state', async () => {
    const providers: Settings = {
      ...initial,
      providers: [
        {
          id: 'provider-a',
          name: 'Provider A',
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: [],
        },
        {
          id: 'provider-b',
          name: 'Provider B',
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: [],
        },
      ],
    };
    const configuredA: Settings = {
      ...providers,
      providers: providers.providers.map((provider) =>
        provider.id === 'provider-a'
          ? { ...provider, credentialPresence: 'present' as const }
          : provider
      ),
    };
    const configuredB: Settings = {
      ...providers,
      providers: providers.providers.map((provider) =>
        provider.id === 'provider-b'
          ? { ...provider, credentialPresence: 'present' as const }
          : provider
      ),
    };
    const connectA = deferred<Settings>();
    const connectB = deferred<Settings>();
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(providers),
      create: vi.fn((data: { providerId: string }) =>
        data.providerId === 'provider-a' ? connectA.promise : connectB.promise
      ),
    });
    renderSettings(service);

    fireEvent.mouseDown(await screen.findByLabelText('Provider to connect'));
    fireEvent.click(await screen.findByText('Provider A'));
    fireEvent.change(await screen.findByLabelText('Provider A API key'), {
      target: { value: 'provider-a-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.click(await screen.findByText('Provider B'));
    fireEvent.change(await screen.findByLabelText('Provider B API key'), {
      target: { value: 'provider-b-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(2));

    await act(async () => {
      connectA.resolve(configuredA);
      await connectA.promise;
    });

    expect(screen.queryByText('Saved credential')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Provider B API key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect$/ })).toHaveClass('ant-btn-loading');

    await act(async () => {
      connectB.resolve(configuredB);
      await connectB.promise;
    });
    expect(await screen.findByText('Saved credential')).toBeInTheDocument();
  });

  it('discards a deferred OAuth action after switching providers and never restores its attempt', async () => {
    const oauthMethods = [{ index: 0, type: 'oauth' as const, label: 'Browser flow' }];
    const providers: Settings = {
      ...initial,
      providers: [
        {
          id: 'oauth-a',
          name: 'OAuth A',
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: oauthMethods,
        },
        {
          id: 'oauth-b',
          name: 'OAuth B',
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: oauthMethods,
        },
      ],
    };
    const attemptA = {
      attemptId: 'attempt-a',
      providerId: 'oauth-a',
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/a',
        method: 'auto' as const,
        instructions: 'Authorize OAuth A.',
      },
    };
    const attemptB = {
      ...attemptA,
      attemptId: 'attempt-b',
      providerId: 'oauth-b',
      authorization: {
        ...attemptA.authorization,
        url: 'http://127.0.0.1:9898/b',
        instructions: 'Authorize OAuth B.',
      },
    };
    const oauthA = deferred<typeof attemptA>();
    const oauthB = deferred<typeof attemptB>();
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(providers),
      create: vi.fn((data: { providerId: string }) =>
        data.providerId === 'oauth-a' ? oauthA.promise : oauthB.promise
      ),
    });
    renderSettings(service);

    fireEvent.mouseDown(await screen.findByLabelText('Provider to connect'));
    fireEvent.click(await screen.findByText('OAuth A'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Browser flow' }));
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.click(await screen.findByText('OAuth B'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Browser flow' }));
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(2));

    await act(async () => {
      oauthA.resolve(attemptA);
      await oauthA.promise;
    });

    expect(screen.queryByText('Authorize OAuth A.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect with Browser flow$/ })).toHaveClass(
      'ant-btn-loading'
    );

    oauthB.resolve(attemptB);
    expect(await screen.findByText('Authorize OAuth B.')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText('Provider to connect'));
    fireEvent.click(await screen.findByText('OAuth A'));
    expect(screen.queryByText('Authorize OAuth A.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect with Browser flow' })).toBeInTheDocument();
  });

  it('renders a native API method with conditional prompts and connects it', async () => {
    const configured = {
      ...initial,
      providers: initial.providers.map((provider) =>
        provider.id === 'moonshotai'
          ? {
              ...provider,
              runtimeAvailable: true,
              credentialPresence: 'present' as const,
            }
          : provider
      ),
    };
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(initial),
      create: vi.fn().mockResolvedValue(configured),
    });
    renderSettings(service);

    expect(
      await screen.findByText(/logical namespaces in the daemon credential home/i)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Account ID')).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('Region'));
    fireEvent.click(await screen.findByText('US'));
    fireEvent.change(await screen.findByLabelText('Account ID'), {
      target: { value: 'synthetic-account' },
    });
    fireEvent.change(screen.getByLabelText('Kimi API key'), {
      target: { value: 'synthetic-kimi-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(service.create).toHaveBeenCalledWith({
        providerId: 'moonshotai',
        apiKey: 'synthetic-kimi-key',
        metadata: { region: 'us', accountId: 'synthetic-account' },
      })
    );
    expect(await screen.findAllByText('Saved credential')).toHaveLength(2);
    expect(screen.getAllByText(/provider access is not verified/i)).toHaveLength(2);
  });

  it('keeps the generic API-key fallback for a provider with no declared methods', async () => {
    const available = {
      ...initial,
      providers: [
        {
          id: 'zhipuai',
          name: 'GLM',
          runtimeAvailable: false,
          credentialPresence: 'absent' as const,
          models: [],
          authMethods: [],
        },
      ],
    };
    const configured = {
      ...available,
      providers: [
        {
          ...available.providers[0],
          runtimeAvailable: true,
          credentialPresence: 'present' as const,
        },
      ],
    };
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(available),
      create: vi.fn().mockResolvedValue(configured),
    });
    renderSettings(service);

    fireEvent.change(await screen.findByLabelText('GLM API key'), {
      target: { value: 'synthetic-glm-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(service.create).toHaveBeenCalledWith({
        providerId: 'zhipuai',
        apiKey: 'synthetic-glm-key',
      })
    );
  });

  it('keeps configured providers visible and disconnects through the existing service', async () => {
    const disconnected = {
      ...initial,
      providers: initial.providers.map((provider) =>
        provider.id === 'zhipuai'
          ? {
              ...provider,
              runtimeAvailable: false,
              credentialPresence: 'absent' as const,
            }
          : provider
      ),
    };
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(initial),
      remove: vi.fn().mockResolvedValue(disconnected),
    });
    renderSettings(service);

    expect(await screen.findByText('GLM')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() => expect(service.remove).toHaveBeenCalledWith('zhipuai'));
  });

  it('keeps Zen runtime availability distinct from its optional saved credential', async () => {
    const zen = {
      ...initial,
      providers: [
        {
          id: 'opencode',
          name: 'OpenCode Zen',
          runtimeAvailable: true,
          credentialPresence: 'absent' as const,
          models: [],
          authMethods: [],
        },
      ],
    };
    const service = createAuthService({ find: vi.fn().mockResolvedValue(zen) });
    renderSettings(service);

    expect(await screen.findByText(/available in the OpenCode runtime/i)).toBeInTheDocument();
    expect(await screen.findByLabelText('OpenCode Zen API key')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('does not offer destructive removal when saved credential presence is unknown', async () => {
    const unknown = {
      ...initial,
      providers: [
        {
          id: 'unknown-provider',
          name: 'Unknown Provider',
          runtimeAvailable: true,
          credentialPresence: 'unknown' as const,
          models: [],
          authMethods: [],
        },
      ],
    };
    const service = createAuthService({ find: vi.fn().mockResolvedValue(unknown) });
    renderSettings(service);

    expect(
      await screen.findByText(/saved credential presence could not be determined/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('starts and cancels a bounded native OAuth attempt with dynamic inputs', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          runtimeAvailable: false,
          credentialPresence: 'absent' as const,
          models: [],
          authMethods: [
            {
              index: 0,
              type: 'oauth' as const,
              label: 'ChatGPT browser',
            },
            {
              index: 1,
              type: 'oauth' as const,
              label: 'ChatGPT headless',
              prompts: [
                {
                  type: 'select' as const,
                  key: 'region',
                  message: 'OAuth region',
                  options: [{ label: 'US', value: 'us' }],
                },
                {
                  type: 'text' as const,
                  key: 'account',
                  message: 'OAuth account',
                  when: { key: 'region', op: 'eq' as const, value: 'us' },
                },
              ],
            },
          ],
        },
      ],
    };
    const attempt = {
      attemptId: 'attempt-1',
      providerId: 'oauth-provider',
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto' as const,
        instructions: 'Open the synthetic authorization page.',
      },
    };
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockResolvedValue(attempt),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockResolvedValue({ ...attempt, phase: 'cancelled' }),
    });
    renderSettings(service);

    fireEvent.mouseDown(await screen.findByLabelText('OAuth region'));
    fireEvent.click(await screen.findByText('US'));
    fireEvent.change(await screen.findByLabelText('OAuth account'), {
      target: { value: 'synthetic-account' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with ChatGPT headless' }));

    await waitFor(() =>
      expect(service.create).toHaveBeenCalledWith({
        operation: 'connect-oauth',
        providerId: 'oauth-provider',
        method: 1,
        inputs: { region: 'us', account: 'synthetic-account' },
      })
    );
    expect(await screen.findByText('Open the synthetic authorization page.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open authorization page' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:9898/authorize'
    );
    expect(screen.queryByLabelText('OAuth Provider API key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authorization' }));
    await waitFor(() => expect(service.patch).toHaveBeenCalledWith('attempt-1', { cancel: true }));
  });

  it('copies an OpenAI-style device code from the native authorization instructions', async () => {
    const oauthOnly = singleProviderSettings('openai', 'OpenAI', [
      { index: 0, type: 'oauth', label: 'ChatGPT' },
    ]);
    const attempt = deviceCodeAttempt('attempt-copy');
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockResolvedValue(attempt),
      create: vi.fn().mockResolvedValue(attempt),
    });
    const copyText = vi.fn(async () => true);
    renderSettings(service, copyText);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect with ChatGPT' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy authorization code' }));

    await screen.findByRole('button', { name: 'Authorization code copied' });
    expect(copyText).toHaveBeenCalledWith('ABCD-12345');
  });

  it('keeps the device code copy action available when clipboard access rejects', async () => {
    const oauthOnly = singleProviderSettings('openai', 'OpenAI', [
      { index: 0, type: 'oauth', label: 'ChatGPT' },
    ]);
    const attempt = deviceCodeAttempt('attempt-copy-failure');
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockResolvedValue(attempt),
      create: vi.fn().mockResolvedValue(attempt),
    });
    const copyText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'));
    renderSettings(service, copyText);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect with ChatGPT' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy authorization code' }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith('ABCD-12345'));
    expect(screen.getByRole('button', { name: 'Copy authorization code' })).toBeInTheDocument();
  });

  it('submits a code callback once and clears the secret from UI state', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          runtimeAvailable: false,
          credentialPresence: 'absent' as const,
          models: [],
          authMethods: [
            {
              index: 0,
              type: 'oauth' as const,
              label: 'Code flow',
              prompts: [{ type: 'text' as const, key: 'account', message: 'Code account' }],
            },
          ],
        },
      ],
    };
    const attempt = {
      attemptId: 'attempt-code',
      providerId: 'oauth-provider',
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'code' as const,
        instructions: 'Paste the one-time code.',
      },
    };
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockResolvedValue({ ...attempt, phase: 'completing' }),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockResolvedValue({ ...attempt, phase: 'completing' }),
    });
    renderSettings(service);

    fireEvent.change(await screen.findByLabelText('Code account'), {
      target: { value: 'synthetic-account' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Code flow' }));
    await waitFor(() =>
      expect(service.create).toHaveBeenCalledWith({
        operation: 'connect-oauth',
        providerId: 'oauth-provider',
        method: 0,
        inputs: { account: 'synthetic-account' },
      })
    );
    const input = await screen.findByLabelText('OAuth Provider authorization code');
    fireEvent.change(input, { target: { value: 'synthetic-secret-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit authorization code' }));

    await waitFor(() =>
      expect(service.patch).toHaveBeenCalledWith('attempt-code', {
        code: 'synthetic-secret-code',
      })
    );
    await waitFor(() => expect(input).toHaveValue(''));
    expect(document.body.textContent).not.toContain('synthetic-secret-code');
  });

  it('does not let a deferred poll regress a newer code submission or enable a duplicate', async () => {
    const providerId = 'oauth-provider';
    const oauthOnly = singleProviderSettings(providerId, 'OAuth Provider', [
      { index: 0, type: 'oauth' as const, label: 'Code flow' },
    ]);
    const attempt = {
      attemptId: 'attempt-code-race',
      providerId,
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'code' as const,
        instructions: 'Paste the one-time code.',
      },
    };
    const completing = { ...attempt, phase: 'completing' as const };
    const poll = deferred<typeof attempt>();
    const submission = deferred<typeof completing>();
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockReturnValue(poll.promise),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockReturnValue(submission.promise),
    });

    try {
      renderSettings(service);
      const connect = await screen.findByRole('button', { name: 'Connect with Code flow' });
      vi.useFakeTimers();
      fireEvent.click(connect);
      await act(async () => {
        await Promise.resolve();
      });

      const input = screen.getByLabelText('OAuth Provider authorization code');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(service.get).toHaveBeenCalledOnce();

      fireEvent.change(input, { target: { value: 'synthetic-secret-code' } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit authorization code' }));
      expect(service.patch).toHaveBeenCalledOnce();

      await act(async () => {
        submission.resolve(completing);
        poll.resolve(attempt);
        await Promise.all([submission.promise, poll.promise]);
      });

      expect(screen.queryByLabelText('OAuth Provider authorization code')).not.toBeInTheDocument();
      expect(service.patch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a deferred poll replace settings or attempt state from a newer disconnect', async () => {
    const providerId = 'oauth-provider';
    const configuredProviderId = 'configured-provider';
    const oauthSettings: Settings = {
      ...initial,
      providers: [
        {
          id: providerId,
          name: 'OAuth Provider',
          runtimeAvailable: false,
          credentialPresence: 'absent',
          models: [],
          authMethods: [{ index: 0, type: 'oauth' as const, label: 'Browser flow' }],
        },
        {
          id: configuredProviderId,
          name: 'Configured Provider',
          runtimeAvailable: true,
          credentialPresence: 'present',
          models: [],
          authMethods: [],
        },
      ],
    };
    const disconnectedSettings: Settings = {
      ...oauthSettings,
      providers: oauthSettings.providers.map((provider) =>
        provider.id === configuredProviderId
          ? {
              ...provider,
              runtimeAvailable: false,
              credentialPresence: 'absent' as const,
            }
          : provider
      ),
    };
    const staleSettings: Settings = {
      ...oauthSettings,
      providers: oauthSettings.providers.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              runtimeAvailable: true,
              credentialPresence: 'present' as const,
            }
          : provider
      ),
    };
    const attempt = {
      attemptId: 'attempt-disconnect-race',
      providerId,
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto' as const,
        instructions: 'Keep this newer attempt visible.',
      },
    };
    const stalePoll = {
      ...attempt,
      phase: 'configured' as const,
      settings: staleSettings,
    };
    const poll = deferred<typeof stalePoll>();
    const disconnect = deferred<Settings>();
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthSettings),
      get: vi.fn().mockReturnValueOnce(poll.promise).mockResolvedValue(attempt),
      create: vi.fn().mockResolvedValue(attempt),
      remove: vi.fn().mockReturnValue(disconnect.promise),
    });

    try {
      renderSettings(service);
      const connect = await screen.findByRole('button', { name: 'Connect with Browser flow' });
      vi.useFakeTimers();
      fireEvent.click(connect);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Keep this newer attempt visible.')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(service.get).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(service.remove).toHaveBeenCalledWith(configuredProviderId);

      await act(async () => {
        disconnect.resolve(disconnectedSettings);
        poll.resolve(stalePoll);
        await Promise.all([disconnect.promise, poll.promise]);
      });

      expect(screen.getByText('Keep this newer attempt visible.')).toBeInTheDocument();
      expect(screen.queryByText('Saved credential')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(service.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap polls or let a stale configured response reverse cancellation', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          runtimeAvailable: false,
          credentialPresence: 'absent' as const,
          models: [],
          authMethods: [{ index: 0, type: 'oauth' as const, label: 'Browser flow' }],
        },
      ],
    };
    const attempt = {
      attemptId: 'attempt-race',
      providerId: 'oauth-provider',
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto' as const,
        instructions: 'Authorize.',
      },
    };
    let resolvePoll!: (value: typeof attempt & { phase: 'configured'; settings: Settings }) => void;
    const service = createAuthService({
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          })
      ),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockResolvedValue({ ...attempt, phase: 'cancelled' as const }),
    });
    try {
      renderSettings(service);
      const connect = await screen.findByRole('button', { name: 'Connect with Browser flow' });
      vi.useFakeTimers();
      fireEvent.click(connect);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Authorize.')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(service.get).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel authorization' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Authorization cancelled.')).toBeInTheDocument();

      resolvePoll({ ...attempt, phase: 'configured', settings: oauthOnly });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Authorization cancelled.')).toBeInTheDocument();
      expect(screen.queryByText('Saved credential')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
