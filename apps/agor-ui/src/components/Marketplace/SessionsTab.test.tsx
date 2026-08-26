import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionsTab } from './SessionsTab';

const overview: MCPMarketplaceOverview = {
  servers: [
    {
      mcp_server_id: 'server-1',
      name: 'github',
      display_name: 'GitHub',
      source: 'user',
      transport: 'http',
      enabled: true,
      tools: [],
      session_count: 1,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  ],
  attachments: [
    {
      mcp_server_id: 'server-1',
      session_id: 'session-1',
      enabled: true,
      added_at: new Date(0).toISOString(),
      session_title: 'Triage bugs',
      session_status: 'idle',
      branch_id: 'branch-1',
      branch_name: 'fixes',
      agentic_tool: 'claude-code',
    },
  ],
  credentials: [],
  generated_at: new Date(0).toISOString(),
};

describe('Marketplace session attachments', () => {
  it('renders a dedicated empty state when no visible session uses a server', () => {
    render(
      <MemoryRouter>
        <SessionsTab
          client={null}
          authorityKey={null}
          overview={{ ...overview, attachments: [] }}
          loading={false}
          error={null}
          refresh={vi.fn(async () => undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('No sessions use your MCP servers')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps attachment columns in a horizontally scrollable table', () => {
    const { container } = render(
      <MemoryRouter>
        <SessionsTab
          client={null}
          authorityKey={null}
          overview={overview}
          loading={false}
          error={null}
          refresh={vi.fn(async () => undefined)}
        />
      </MemoryRouter>
    );

    expect(container.querySelector('table')).toHaveStyle({ width: 'max-content' });
    expect(container.querySelector('.ant-table-content')).toHaveStyle({ overflowX: 'auto' });
  });

  it('uses a contextual label and requires confirmation before detach', async () => {
    const remove = vi.fn(async () => ({ mcp_server_id: 'server-1' }));
    const client = { service: vi.fn(() => ({ remove })) } as unknown as AgorClient;
    const refresh = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <SessionsTab
          client={client}
          authorityKey={['alice', 'member', 1, client]}
          overview={overview}
          loading={false}
          error={null}
          refresh={refresh}
        />
      </MemoryRouter>
    );

    const trigger = screen.getByRole('button', {
      name: 'Detach GitHub from session Triage bugs',
    });
    fireEvent.click(trigger);
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveClass('ant-popover-open'));
    expect(screen.getByText(/Work already in flight/)).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Detach', hidden: true });
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('server-1'));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('closes confirmation and fails closed when session-write authority is lost', async () => {
    const client = {
      service: vi.fn(() => ({ remove: vi.fn() })),
    } as unknown as AgorClient;
    const props = {
      client,
      overview,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const view = render(
      <MemoryRouter>
        <SessionsTab {...props} authorityKey={['alice', 'member', 1, client]} />
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', {
      name: 'Detach GitHub from session Triage bugs',
    });
    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveClass('ant-popover-open'));

    view.rerender(
      <MemoryRouter>
        <SessionsTab {...props} authorityKey={null} />
      </MemoryRouter>
    );

    const revoked = screen.getByRole('button', {
      name: 'Detach GitHub from session Triage bugs',
    });
    expect(revoked).toBeDisabled();
    await waitFor(() => expect(revoked).not.toHaveClass('ant-popover-open'));
  });
});
