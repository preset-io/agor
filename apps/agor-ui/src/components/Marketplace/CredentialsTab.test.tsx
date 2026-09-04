import type { MCPMarketplaceOverview } from '@agor/core/types';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CredentialsTab } from './CredentialsTab';

const TIMESTAMP = '2026-08-21T12:34:56.000Z';

function overview(credentials: MCPMarketplaceOverview['credentials']): MCPMarketplaceOverview {
  return {
    servers: credentials.map((credential) => ({
      mcp_server_id: credential.mcp_server_id,
      name: credential.server_name,
      source: 'user',
      transport: 'http',
      enabled: true,
      tools: [],
      session_count: 0,
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    })),
    attachments: [],
    credentials,
    generated_at: TIMESTAMP,
  };
}

describe('Marketplace credential metadata', () => {
  it('shows redacted auth method, semantic status, timestamps, and real recovery actions', () => {
    const openSettings = vi.fn();
    render(
      <CredentialsTab
        overview={overview([
          {
            mcp_server_id: 'server-active',
            server_name: 'active-server',
            server_display_name: 'Active server',
            method: 'oauth',
            status: 'active',
            expires_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          },
        ])}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
        canManageCredentials
        onOpenServerSettings={openSettings}
      />
    );

    const active = screen.getByText('Active server').closest('tr');
    expect(active).not.toBeNull();
    expect(within(active!).getByText('OAuth')).toBeInTheDocument();
    expect(within(active!).getByText('Connected')).toBeInTheDocument();
    expect(within(active!).getAllByText(new Date(TIMESTAMP).toLocaleString())).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Settings OAuth connection for Active server',
      })
    );
    expect(openSettings).toHaveBeenCalledWith('server-active');
  });

  it('renders every credential status with production copy and semantic color', () => {
    const statuses = [
      ['active', 'Connected', 'success', 'Settings'],
      ['configured', 'Credential stored', 'default', 'Settings'],
      ['refreshable', 'Connected', 'success', 'Settings'],
      ['refreshing', 'Refreshing', 'processing', 'Settings'],
      ['reauthentication_required', 'Reconnect required', 'error', 'Reconnect'],
      ['not_connected', 'Sign-in required', 'warning', 'Connect'],
    ] as const;
    render(
      <CredentialsTab
        overview={overview(
          statuses.map(([detailStatus], index) => ({
            mcp_server_id: `server-${detailStatus}`,
            server_name: `Server ${index + 1}`,
            method: detailStatus === 'configured' ? 'bearer' : 'oauth',
            status:
              detailStatus === 'refreshing' || detailStatus === 'reauthentication_required'
                ? 'attention'
                : detailStatus === 'refreshable'
                  ? 'expired'
                  : detailStatus,
            detail_status: detailStatus,
          }))
        )}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
        canManageCredentials
        onOpenServerSettings={vi.fn()}
      />
    );

    for (const [status, label, color, action] of statuses) {
      const row = screen
        .getByText(`Server ${statuses.findIndex(([value]) => value === status) + 1}`)
        .closest('tr');
      expect(row).not.toBeNull();
      const badge = within(row!).getByText(label).closest('.ant-badge-status');
      expect(badge?.querySelector(`.ant-badge-status-${color}`)).not.toBeNull();
      expect(row).not.toHaveTextContent('not_connected');
      expect(within(row!).getByRole('button', { name: new RegExp(`^${action} `) })).toBeEnabled();
    }
  });

  it('shows disabled separately and never invents a reconnect action from stale projection data', () => {
    const value = overview([
      {
        mcp_server_id: 'server-disabled',
        server_name: 'Disabled server',
        method: 'oauth',
        status: 'active',
      },
    ]);
    value.servers[0].enabled = false;
    render(
      <CredentialsTab
        overview={value}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
        canManageCredentials
        onOpenServerSettings={vi.fn()}
      />
    );

    const row = screen.getByText('Disabled server').closest('tr')!;
    expect(within(row).getByText('Disabled')).toBeVisible();
    expect(within(row).queryByText('Connected')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Reconnect/ })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Settings / })).toBeEnabled();
  });

  it('projects explicit metadata only and never renders secret-shaped extras', () => {
    const secretValues = [
      'access-secret-value',
      'refresh-secret-value',
      'client-secret-value',
      'bearer-secret-value',
      'client-identifier-value',
      'https://issuer.secret.test',
      'https://resource.secret.test',
      '••••secret-suffix',
    ];
    const credential = {
      mcp_server_id: 'server-1',
      server_name: 'safe-name',
      method: 'oauth',
      status: 'active',
      oauth_access_token: secretValues[0],
      oauth_refresh_token: secretValues[1],
      oauth_client_secret: secretValues[2],
      token: secretValues[3],
      client_id: secretValues[4],
      issuer: secretValues[5],
      resource_uri: secretValues[6],
      masked_token: secretValues[7],
    } as unknown as MCPMarketplaceOverview['credentials'][number];

    const { container } = render(
      <CredentialsTab
        overview={overview([credential])}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText('safe-name')).toBeVisible();
    for (const secret of secretValues) expect(container).not.toHaveTextContent(secret);
    expect(screen.queryByRole('button', { name: /copy|reveal/i })).not.toBeInTheDocument();
  });

  it('separates loading, empty, and error states', () => {
    const refresh = vi.fn(async () => undefined);
    const props = { overview: overview([]), error: null, refresh };
    const view = render(<CredentialsTab {...props} loading />);
    expect(screen.queryByText('No saved Catalog credentials')).not.toBeInTheDocument();

    view.rerender(<CredentialsTab {...props} loading={false} />);
    expect(screen.getByText('No saved Catalog credentials')).toBeVisible();

    view.rerender(<CredentialsTab {...props} loading={false} error="Overview read failed" />);
    expect(screen.getByText('Could not load credential metadata')).toBeVisible();
    expect(screen.queryByText('No saved Catalog credentials')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('fails closed for users without credential-management authority', () => {
    render(
      <CredentialsTab
        overview={overview([
          {
            mcp_server_id: 'server-1',
            server_name: 'server',
            method: 'oauth',
            status: 'not_connected',
          },
        ])}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
        canManageCredentials={false}
        onOpenServerSettings={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Connect OAuth connection for server' })
    ).toBeDisabled();
  });

  it('keeps the complete credential metadata columns on the desktop table', () => {
    render(
      <CredentialsTab
        overview={overview([
          {
            mcp_server_id: 'server-1',
            server_name: 'server',
            method: 'oauth',
            status: 'active',
          },
        ])}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByRole('columnheader', { name: 'Server' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Expires' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Last changed' })).toBeVisible();
  });
});
