import type { AgorClient, OpenCodeProviderSettings as Settings } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  create: ReturnType<typeof vi.fn>;
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
      create: vi.fn().mockResolvedValue(configured),
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
      create: vi.fn().mockResolvedValue(configured),
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

  it('does not offer API-key connection for an OAuth-only provider', async () => {
    const oauthOnly = {
      ...initial,
      providers: [
        {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          configured: false,
          status: 'disconnected' as const,
          authMethods: [{ type: 'oauth' as const, label: 'Sign in with OAuth' }],
        },
      ],
    };
    const service = {
      find: vi.fn().mockResolvedValue(oauthOnly),
      create: vi.fn(),
      remove: vi.fn(),
    };
    renderSettings(service);

    expect(await screen.findByText(/OAuth connection is not available here/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('OAuth Provider API key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(service.create).not.toHaveBeenCalled();
  });
});
