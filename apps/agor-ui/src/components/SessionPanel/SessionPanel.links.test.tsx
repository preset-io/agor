import type { AgorClient, Branch, Link, Session } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import SessionPanel from './SessionPanel';

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ state: { tasks: [] } }),
}));

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea aria-label="Prompt" />,
}));

vi.mock('../FileUpload', () => ({
  FileUpload: () => null,
}));

vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  ForkSpawnModal: () => null,
}));

vi.mock('../metadata', () => ({
  CreatedByTag: () => <span>Created by test user</span>,
}));

vi.mock('../Pill', () => ({
  ContextWindowPill: () => <span>Context window</span>,
  IssuePill: () => <span>Issue</span>,
  PullRequestPill: () => <span>PR</span>,
  TimerPill: () => <span>Timer</span>,
  TokenCountPill: () => <span>Tokens</span>,
}));

vi.mock('../SessionIds', () => ({
  SessionIdsButton: () => <span>Session IDs</span>,
  SessionIdsList: () => <span>Session IDs List</span>,
}));

vi.mock('../ToolIcon', () => ({
  ToolIcon: () => <span>Tool icon</span>,
}));

vi.mock('./SessionMcpFooterControl', () => ({
  SessionMcpFooterControl: () => null,
}));

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: () => <div>Session content</div>,
}));

vi.mock('./SessionRunSettingsPopover', () => ({
  SessionRunSettingsPopover: () => null,
}));

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  title: 'Links session',
  agentic_tool: 'codex',
  status: 'idle',
  archived: false,
  created_at: '2026-07-01T00:00:00.000Z',
  last_updated: '2026-07-01T00:00:00.000Z',
} as unknown as Session;

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'feature/links',
  path: '/tmp/feature-links',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    link_id: 'link-1',
    branch_id: null,
    session_id: 'session-1',
    source_message_id: null,
    kind: 'url',
    source: 'manual',
    url: 'https://example.com/session-runbook',
    ref_uri: null,
    file_path: null,
    target_key: 'url:https://example.com/session-runbook',
    is_pinned: true,
    title: 'Session Runbook',
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Link;
}

function makeClient(links: Link[]) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const linksById = new Map(links.map((link) => [link.link_id, link]));
  const client = {
    service(path: string) {
      return {
        async find(args?: unknown) {
          calls.push({ service: path, method: 'find', args: [args] });
          if (path.endsWith('/tasks/queue')) return { data: [] };
          return [];
        },
        async findAll(args?: unknown) {
          calls.push({ service: path, method: 'findAll', args: [args] });
          if (path === 'links') return links;
          return [];
        },
        async patch(id: string, body: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body] });
          const existing = linksById.get(id);
          return { ...existing, ...(body as object), link_id: id };
        },
        on: vi.fn(),
        off: vi.fn(),
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
}

describe('SessionPanel session links', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('hydrates full session links on open and renders from the centralized session selector', async () => {
    const link = makeLink();
    const { client, calls } = makeClient([link]);

    render(
      <ConnectionProvider value={connected}>
        <AppActionsProvider value={{}}>
          <AntApp>
            <SessionPanel
              client={client}
              session={session}
              branch={branch}
              open
              onClose={vi.fn()}
            />
          </AntApp>
        </AppActionsProvider>
      </ConnectionProvider>
    );

    await screen.findByText('Session Runbook');
    await waitFor(() => {
      expect(calls.some((call) => call.service === 'links' && call.method === 'findAll')).toBe(
        true
      );
    });
    const linkFind = calls.find((call) => call.service === 'links' && call.method === 'findAll');
    expect(linkFind?.args[0]).toMatchObject({
      query: {
        owner_scope: 'session',
        session_id: 'session-1',
      },
    });
    expect(agorStore.getState().linksBySession.get('session-1')).toEqual([link]);
  });
});
