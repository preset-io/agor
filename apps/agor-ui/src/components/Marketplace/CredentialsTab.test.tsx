import type { MCPMarketplaceOverview } from '@agor/core/types';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CredentialsTab } from './CredentialsTab';

const TIMESTAMP = '2026-08-21T12:34:56.000Z';

function overview(credentials: MCPMarketplaceOverview['credentials']): MCPMarketplaceOverview {
  return {
    servers: [],
    attachments: [],
    credentials,
    generated_at: TIMESTAMP,
  };
}

describe('Marketplace credential metadata', () => {
  it('renders every status with its semantic color and trustworthy timestamps', () => {
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
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          },
          {
            mcp_server_id: 'server-configured',
            server_name: 'configured-server',
            method: 'bearer',
            status: 'configured',
          },
          {
            mcp_server_id: 'server-attention',
            server_name: 'attention-server',
            method: 'jwt',
            status: 'attention',
          },
          {
            mcp_server_id: 'server-expired',
            server_name: 'expired-server',
            method: 'oauth',
            status: 'expired',
          },
          {
            mcp_server_id: 'server-disconnected',
            server_name: 'disconnected-server',
            method: 'oauth',
            status: 'not_connected',
          },
        ] as unknown as MCPMarketplaceOverview['credentials'])}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    const activeRow = screen.getByText('Active server').closest('tr');
    expect(activeRow).not.toBeNull();
    expect(within(activeRow!).getByText('OAUTH')).toBeInTheDocument();
    expect(within(activeRow!).getByText('active').closest('.ant-tag')).toHaveClass('ant-tag-green');
    expect(within(activeRow!).getAllByText(new Date(TIMESTAMP).toLocaleString())).toHaveLength(3);

    expect(screen.getByText('configured').closest('.ant-tag')).toHaveClass('ant-tag-green');
    expect(screen.getByText('attention').closest('.ant-tag')).toHaveClass('ant-tag-orange');
    expect(screen.getByText('expired').closest('.ant-tag')).not.toHaveClass('ant-tag-green');
    expect(screen.getByText('not connected').closest('.ant-tag')).not.toHaveClass('ant-tag-orange');

    const configuredRow = screen.getByText('configured-server').closest('tr');
    expect(configuredRow).not.toBeNull();
    expect(within(configuredRow!).getByText('BEARER')).toBeInTheDocument();
    expect(within(configuredRow!).getAllByText('—')).toHaveLength(3);
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

  it('renders a dedicated empty state only after loading finishes', () => {
    const props = {
      overview: overview([]),
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const view = render(<CredentialsTab {...props} loading />);
    expect(screen.queryByText('No credential metadata')).not.toBeInTheDocument();

    view.rerender(<CredentialsTab {...props} loading={false} />);
    expect(screen.getByText('No credential metadata')).toBeVisible();
  });

  it('shows a visible error and retries without presenting it as empty', () => {
    const refresh = vi.fn(async () => undefined);
    render(
      <CredentialsTab
        overview={overview([])}
        loading={false}
        error="Overview read failed"
        refresh={refresh}
      />
    );

    expect(screen.getByText('Could not load credential metadata')).toBeVisible();
    expect(screen.getByText('Overview read failed')).toBeVisible();
    expect(screen.queryByText('No credential metadata')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps the credential table horizontally scrollable', () => {
    const { container } = render(
      <CredentialsTab
        overview={overview([
          {
            mcp_server_id: 'server-1',
            server_name: 'server',
            method: 'oauth',
            status: 'active',
          },
        ] as unknown as MCPMarketplaceOverview['credentials'])}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    expect(container.querySelector('table')).toHaveStyle({ width: 'max-content' });
    expect(container.querySelector('.ant-table-content')).toHaveStyle({ overflowX: 'auto' });
  });
});
