/**
 * A relayed `?mcp_connect=<widget id>` link through the real desktop routing.
 *
 * `useUrlState` canonicalizes the address (dropping the query) before the
 * session's transcript, and so the card, has mounted. The intent is captured at
 * boot (`main.tsx`), so the card still opens its drawer once — and a reload,
 * which no longer carries the query, does not reopen it.
 */

import { MCP_CONNECT_WIDGET_QUERY_PARAM } from '@agor/core/types';
import type { AgorClient, Session, WidgetMessageMetadata } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasNavigationProvider, useRegisterRecenter } from '@/contexts/CanvasNavigationContext';
import {
  type MCPCatalogEntryHandoff,
  MCPCatalogModalProvider,
  useMCPCatalogModal,
} from '@/contexts/MCPCatalogModalContext';
import { useUrlState } from '@/hooks/useUrlState';
import { captureMcpConnectIntent } from '@/utils/mcpConnectIntent';
import { OAuthConnectWidget } from './OAuthConnectWidget';

const SESSION_ID = '019e9999-0000-7000-8000-000000000001';
const SESSION_SHORT = '019e99990000700080000000';
const BOARD_ID = '019e7777-0000-7000-8000-000000000001';

const WIDGET = {
  widget_id: 'widget-1',
  widget_type: 'oauth',
  schema_version: 1,
  status: 'pending',
  requested_at: '2026-10-14T00:00:00.000Z',
  params: {
    serverName: 'GitHub',
    oauthMode: 'per_user',
    reason: 'Read the issues.',
    catalogEntryName: 'io.github.github/github-mcp-server',
  },
} as unknown as WidgetMessageMetadata;

const client = { service: () => ({ create: vi.fn() }) } as unknown as AgorClient;

/** Records every drawer the card asks the app-owned catalog host to open. */
function HandoffProbe({ seen }: { seen: MCPCatalogEntryHandoff[] }) {
  const handoff = useMCPCatalogModal()?.entryHandoff;
  useEffect(() => {
    if (handoff) seen.push(handoff);
  }, [handoff, seen]);
  return null;
}

/** The session route: URL state plus a transcript that loads a beat later. */
function SessionRoute() {
  useRegisterRecenter(() => true);
  useUrlState({
    currentBoardId: BOARD_ID,
    currentSessionId: SESSION_ID,
    boardById: new Map([[BOARD_ID, { board_id: BOARD_ID, slug: 'board' }]]) as never,
    sessionById: new Map([[SESSION_ID, { session_id: SESSION_ID } as Session]]) as never,
    branchById: new Map(),
    artifactById: new Map(),
    onBoardChange: vi.fn(),
    onSessionChange: vi.fn(),
  });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 20);
    return () => clearTimeout(timer);
  }, []);
  return loaded ? (
    <OAuthConnectWidget message={{} as never} widget={WIDGET} client={client} />
  ) : null;
}

function renderApp(seen: MCPCatalogEntryHandoff[]) {
  return render(
    <AntApp>
      <BrowserRouter>
        <CanvasNavigationProvider>
          <MCPCatalogModalProvider>
            <HandoffProbe seen={seen} />
            <Routes>
              <Route path="/s/:sessionShortId/" element={<SessionRoute />} />
              <Route path="/*" element={null} />
            </Routes>
          </MCPCatalogModalProvider>
        </CanvasNavigationProvider>
      </BrowserRouter>
    </AntApp>
  );
}

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('mcp_connect deep link through routing', () => {
  it('opens the drawer once on a cold load, and not again on reload', async () => {
    window.history.replaceState(
      null,
      '',
      `/s/${SESSION_SHORT}/?${MCP_CONNECT_WIDGET_QUERY_PARAM}=widget-1`
    );
    captureMcpConnectIntent();
    expect(window.location.search).toBe('');

    const seen: MCPCatalogEntryHandoff[] = [];
    const first = renderApp(seen);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].entryName).toBe('io.github.github/github-mcp-server');
    expect(window.location.pathname).toBe(`/s/${SESSION_SHORT}/`);
    first.unmount();

    // Reload: same address, nothing captured.
    captureMcpConnectIntent();
    const again: MCPCatalogEntryHandoff[] = [];
    renderApp(again);
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(again).toHaveLength(0);
  });

  it('ignores a link naming a different widget', async () => {
    window.history.replaceState(
      null,
      '',
      `/s/${SESSION_SHORT}/?${MCP_CONNECT_WIDGET_QUERY_PARAM}=widget-2`
    );
    captureMcpConnectIntent();
    const seen: MCPCatalogEntryHandoff[] = [];
    renderApp(seen);
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(seen).toHaveLength(0);
  });
});
