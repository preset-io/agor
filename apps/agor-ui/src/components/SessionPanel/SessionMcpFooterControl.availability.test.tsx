import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true, role: 'admin', hasRole: () => true }),
}));
vi.mock('@/contexts/ConnectionContext', () => ({
  useConnectionState: () => ({ connected: true, connecting: false, authGeneration: 1 }),
}));
const update = vi.hoisted(() => vi.fn());
vi.mock('@/utils/sessionMcpServers', () => ({ updateSessionMcpServers: update }));
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));
const server = (id: string, name: string) =>
  ({
    mcp_server_id: id,
    name,
    display_name: name,
    transport: 'http',
    scope: 'session',
    enabled: true,
    auth: { type: 'none' },
  }) as MCPServer;
const attached = server('01900000-0000-7000-8000-000000000020', 'Owner private');
const shared = server('01900000-0000-7000-8000-000000000021', 'Shared tools');
const foreign = server('01900000-0000-7000-8000-000000000022', 'Foreign private');
function deferred() {
  let resolve!: (servers: MCPServer[]) => void;
  const promise = new Promise<MCPServer[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const find = vi.fn().mockResolvedValue([shared]);
  const props = {
    client: { service: () => ({ find }) } as unknown as AgorClient,
    currentUserId: 'admin',
    sessionId: 'session-a',
    sessionMcpServerIds: [attached.mcp_server_id],
    mcpServerById: new Map([attached, shared, foreign].map((s) => [s.mcp_server_id, s])),
    userAuthenticatedMcpServerIds: new Set<string>(),
  };
  const view = render(<SessionMcpFooterControl {...props} />, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
  });
  const trigger = screen.getByRole('button', { name: /^MCP servers\./ });
  fireEvent.click(trigger);
  return { props, find, view, trigger };
}
function selectedLabel() {
  return document.querySelector('.ant-select-selection-item-content');
}

describe('session picker readable labels and refresh interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agorStore.getState().reset();
    for (const id of ['session-a', 'session-b']) agorStore.getState().markSessionMcpLoaded(id);
  });

  it('keeps readable attached names during fetch, denial and reopen without offering other private rows', async () => {
    const { find, props, view, trigger } = fixture();
    expect(selectedLabel()).toHaveTextContent('Owner private');
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.queryByText(/Foreign private \(http\)/)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    find.mockRejectedValue({ code: 403 });
    fireEvent.click(trigger);
    await screen.findByText(/Only the session owner/);
    expect(selectedLabel()).toHaveTextContent('Owner private');
    // Deleted/unreadable metadata is not retained in a display cache.
    view.rerender(<SessionMcpFooterControl {...props} mcpServerById={new Map()} />);
    expect(selectedLabel()).toHaveTextContent('Unavailable MCP server');
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves focus, search and Escape during refresh; obsolete eligibility cannot authorize selection', async () => {
    const { find, props, view, trigger } = fixture();
    await act(async () => {});
    const combo = screen.getByRole('combobox');
    combo.focus();
    fireEvent.mouseDown(combo);
    fireEvent.change(combo, { target: { value: 'Shared' } });
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    const obsolete = deferred();
    find.mockReturnValueOnce(obsolete.promise);
    view.rerender(
      <SessionMcpFooterControl {...props} mcpServerById={new Map(props.mcpServerById)} />
    );
    expect(combo).toHaveFocus();
    expect(combo).not.toBeDisabled();
    expect(combo).toHaveValue('Shared');
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(combo, { key: 'Enter' });
    expect(update).not.toHaveBeenCalled();
    const current = deferred();
    find.mockReturnValueOnce(current.promise);
    view.rerender(
      <SessionMcpFooterControl {...props} mcpServerById={new Map(props.mcpServerById)} />
    );
    await act(async () => {
      obsolete.resolve([foreign]);
    });
    expect(combo).toHaveFocus();
    fireEvent.change(combo, { target: { value: '' } });
    expect(screen.queryByText(/Foreign private \(http\)/)).not.toBeInTheDocument();
    await act(async () => {
      current.resolve([shared]);
    });
    expect(combo).toHaveFocus();
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(combo, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Session MCP servers' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(['session', 'user'] as const)(
    'discards overlays and pending choices on %s changes',
    async (change) => {
      const { find, props, view } = fixture();
      const obsolete = deferred();
      find.mockReturnValueOnce(obsolete.promise);
      view.rerender(
        <SessionMcpFooterControl {...props} mcpServerById={new Map(props.mcpServerById)} />
      );
      const nextProps = {
        ...props,
        ...(change === 'session' ? { sessionId: 'session-b' } : { currentUserId: 'other-user' }),
        sessionMcpServerIds: [],
        mcpServerById: new Map<string, MCPServer>(),
      };
      find.mockResolvedValue([]);
      view.rerender(<SessionMcpFooterControl {...nextProps} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^MCP servers\./ }));
      await act(async () => {
        obsolete.resolve([foreign]);
      });
      fireEvent.mouseDown(screen.getByRole('combobox'));
      expect(
        within(screen.getByRole('dialog')).queryByText('Owner private')
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Foreign private \(http\)/)).not.toBeInTheDocument();
      expect(update).not.toHaveBeenCalled();
    }
  );
});
