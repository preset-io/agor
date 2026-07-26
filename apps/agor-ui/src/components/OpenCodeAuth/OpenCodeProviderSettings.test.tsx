import type { AgorClient, OpenCodeProviderSettings as Settings } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeProviderSettings } from './OpenCodeProviderSettings';

const initial: Settings = {
  runtime: 'available',
  runtimeVersion: '1.14.33',
  isolation: { mode: 'simple', boundary: 'logical' },
  providers: [
    {
      id: 'moonshotai',
      name: 'Kimi',
      configured: false,
      status: 'disconnected',
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
      configured: true,
      status: 'configured',
      authMethods: [],
    },
  ],
};

function renderSettings(service: {
  find: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}) {
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  render(
    <AntApp>
      <OpenCodeProviderSettings client={client} />
    </AntApp>
  );
}

describe('OpenCodeProviderSettings', () => {
  it('renders a native API method with conditional prompts and connects it', async () => {
    const configured = {
      ...initial,
      providers: initial.providers.map((provider) =>
        provider.id === 'moonshotai'
          ? { ...provider, configured: true, status: 'configured' as const }
          : provider
      ),
    };
    const service = {
      find: vi.fn().mockResolvedValue(initial),
      get: vi.fn(),
      create: vi.fn().mockResolvedValue(configured),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    renderSettings(service);

    expect(await screen.findByText(/separate logical namespaces/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search OpenCode providers'), {
      target: { value: 'Kimi' },
    });
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
    expect(await screen.findByText('Configured in OpenCode')).toBeInTheDocument();
    expect(screen.getByText(/provider access is not verified/i)).toBeInTheDocument();
  });

  it('keeps the generic API-key fallback for a provider with no declared methods', async () => {
    const available = {
      ...initial,
      providers: [
        {
          id: 'zhipuai',
          name: 'GLM',
          configured: false,
          status: 'disconnected' as const,
          authMethods: [],
        },
      ],
    };
    const configured = {
      ...available,
      providers: [{ ...available.providers[0], configured: true, status: 'configured' as const }],
    };
    const service = {
      find: vi.fn().mockResolvedValue(available),
      get: vi.fn(),
      create: vi.fn().mockResolvedValue(configured),
      patch: vi.fn(),
      remove: vi.fn(),
    };
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

  it('starts and cancels a bounded native OAuth attempt with dynamic inputs', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          configured: false,
          status: 'disconnected' as const,
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
    const service = {
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockResolvedValue(attempt),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockResolvedValue({ ...attempt, phase: 'cancelled' }),
      remove: vi.fn(),
    };
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

  it('submits a code callback once and clears the secret from UI state', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          configured: false,
          status: 'disconnected' as const,
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
    const service = {
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn().mockResolvedValue({ ...attempt, phase: 'completing' }),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockResolvedValue({ ...attempt, phase: 'completing' }),
      remove: vi.fn(),
    };
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

  it('does not overlap polls or let a stale configured response reverse cancellation', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          configured: false,
          status: 'disconnected' as const,
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
    const service = {
      find: vi.fn().mockResolvedValue(oauthOnly),
      get: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          })
      ),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn().mockResolvedValue({ ...attempt, phase: 'cancelled' as const }),
      remove: vi.fn(),
    };
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
      expect(screen.queryByText('Configured in OpenCode')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
