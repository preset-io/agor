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

  it('keeps loading distinct from empty and exposes error recovery', () => {
    const refresh = vi.fn(async () => undefined);
    const props = {
      client: null,
      authorityKey: null,
      overview: { ...overview, attachments: [] },
      refresh,
    };
    const view = render(
      <MemoryRouter>
        <SessionsTab {...props} loading error={null} />
      </MemoryRouter>
    );
    expect(screen.queryByText('No sessions use your MCP servers')).not.toBeInTheDocument();
    expect(document.querySelector('.ant-spin-spinning')).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <SessionsTab {...props} loading={false} error="Overview read failed" />
      </MemoryRouter>
    );
    expect(screen.getByText('Could not load Catalog sessions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('groups multiple attached servers into one cross-server session card', () => {
    const secondServer = {
      ...overview.servers[0],
      mcp_server_id: 'server-2',
      name: 'linear',
      display_name: 'Linear',
    };
    const secondAttachment = {
      ...overview.attachments[0],
      mcp_server_id: 'server-2',
      enabled: false,
    };
    const anotherSession = {
      ...overview.attachments[0],
      session_id: 'session-2',
      session_title: 'Plan release',
    };
    render(
      <MemoryRouter>
        <SessionsTab
          client={null}
          authorityKey={null}
          overview={{
            ...overview,
            servers: [...overview.servers, secondServer],
            attachments: [...overview.attachments, secondAttachment, anotherSession],
          }}
          loading={false}
          error={null}
          refresh={vi.fn(async () => undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getAllByText('GitHub')).toHaveLength(2);
    expect(screen.getByText('Linear · Disabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open session Triage bugs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open session Plan release' })).toBeInTheDocument();
    const cards = document.querySelectorAll('.ant-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.parentElement).toHaveClass('ant-col-xs-24');
      expect(card.parentElement).toHaveClass('ant-col-lg-12');
    }
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
