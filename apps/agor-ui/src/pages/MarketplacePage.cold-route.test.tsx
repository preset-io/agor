import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MarketplacePage } from './MarketplacePage';

const overview: MCPMarketplaceOverview = {
  servers: [
    {
      mcp_server_id: 'server-1',
      name: 'github',
      display_name: 'GitHub',
      source: 'catalog',
      transport: 'http',
      enabled: true,
      tools: [{ name: 'issues.list', description: 'List issues', permission: 'default' }],
      session_count: 0,
      created_at: '2026-08-21T12:34:56.000Z',
      updated_at: '2026-08-21T12:34:56.000Z',
    },
  ],
  attachments: [
    {
      session_id: 'session-1',
      mcp_server_id: 'server-1',
      enabled: true,
      added_at: '2026-08-21T12:34:56.000Z',
      session_title: 'Triage issues',
      session_status: 'idle',
      agentic_tool: 'claude-code',
      branch_id: 'branch-1',
      branch_name: 'main',
    },
  ],
  credentials: [
    {
      mcp_server_id: 'server-1',
      server_name: 'github',
      server_display_name: 'GitHub',
      method: 'oauth',
      status: 'active',
    },
  ],
  generated_at: '2026-08-21T12:34:56.000Z',
};

function makeClient(options: { holdRevalidation?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const events = {
    on: vi.fn((event: string, listener: () => void) => {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
    }),
    off: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener)),
    removeListener: vi.fn(),
  };
  const held = new Promise<MCPMarketplaceOverview>(() => undefined);
  let overviewReads = 0;
  const service = vi.fn((path: string) => {
    if (path === 'mcp-marketplace') {
      return {
        find: vi.fn(async () => {
          overviewReads += 1;
          if (options.holdRevalidation && overviewReads > 1) return held;
          return overview;
        }),
      };
    }
    if (path === 'mcp-member-policy') {
      return {
        ...events,
        find: vi.fn(async () => ({ policy: 'allow_crud', can_configure: true })),
      };
    }
    return { ...events, create: vi.fn(async () => ({ success: true })), remove: vi.fn() };
  });
  return { service, io: events } as unknown as AgorClient;
}

const Location = () => <output data-testid="route">{useLocation().pathname}</output>;

function renderPage(path: string, client = makeClient()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <MarketplacePage
        client={client}
        connected
        connecting={false}
        authGeneration={1}
        currentUser={{ user_id: 'alice', email: 'alice@example.test', role: 'member' } as never}
      />
    </MemoryRouter>
  );
}

describe('Marketplace cold direct routes and stale-while-refresh UI', () => {
  it('opens the Marketplace server drawer from a cold credentials bookmark', async () => {
    renderPage('/marketplace/credentials');

    const manage = await screen.findByRole('button', {
      name: 'Settings OAuth connection for GitHub',
    });
    fireEvent.click(manage);

    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/marketplace/servers')
    );
    const drawer = await screen.findByRole('dialog');
    expect(drawer).toHaveTextContent('Server settings');
    expect(drawer).toHaveTextContent('OAuth · Connected');
  });

  it('restores keyboard focus to the matching Servers settings action after handoff close', async () => {
    renderPage('/marketplace/credentials');
    const manage = await screen.findByRole('button', {
      name: 'Settings OAuth connection for GitHub',
    });
    manage.focus();
    fireEvent.keyDown(manage, { key: 'Enter', code: 'Enter' });
    fireEvent.click(manage);
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    const settings = await screen.findByRole('button', { name: 'Settings for GitHub' });
    await waitFor(() => expect(settings).toHaveFocus());
  });

  it('retains an open settings drawer and removal confirmation during focus revalidation', async () => {
    renderPage('/marketplace/servers', makeClient({ holdRevalidation: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Settings for GitHub' }));
    const remove = await screen.findByRole('button', { name: 'Remove GitHub server' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toHaveClass('ant-popover-open'));

    act(() => window.dispatchEvent(new Event('focus')));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 125)));

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(remove).toHaveClass('ant-popover-open');
  });

  it('retains a detach confirmation during visibility revalidation', async () => {
    renderPage('/marketplace/sessions', makeClient({ holdRevalidation: true }));
    const detach = await screen.findByRole('button', {
      name: 'Detach GitHub from session Triage issues',
    });
    fireEvent.click(detach);
    await waitFor(() => expect(detach).toHaveClass('ant-popover-open'));

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 125)));

    expect(detach).toHaveClass('ant-popover-open');
    expect(screen.getByText('Triage issues')).toBeVisible();
  });
});
