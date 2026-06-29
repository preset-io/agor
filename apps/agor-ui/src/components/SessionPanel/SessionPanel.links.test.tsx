import type { Branch, Link, Session } from '@agor-live/client';
import { normalizeRefTargetKey } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import SessionPanel from './SessionPanel';

const dropdownCapture = vi.hoisted(() => ({ calls: [] as Array<Array<{ name: string }>> }));

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ state: { tasks: [] } }),
}));

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea aria-label="Prompt" />,
}));

vi.mock('../FileUpload', () => ({
  FileUpload: () => null,
  FileUploadButton: () => null,
}));

vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  ForkSpawnModal: () => null,
}));

vi.mock('../metadata', () => ({
  CreatedByTag: () => <span>Created by test user</span>,
}));

vi.mock('../Pill', () => ({
  ContextWindowPill: () => <span>Context window</span>,
  TimerPill: () => <span>Timer</span>,
  TokenCountPill: () => <span>Tokens</span>,
}));

vi.mock('../SessionIds', () => ({
  SessionIdsButton: () => <span>Session IDs</span>,
}));

vi.mock('../ToolIcon', () => ({
  ToolIcon: () => <span>Tool icon</span>,
}));

vi.mock('./SessionAttachmentsDropdown', () => ({
  SessionAttachmentsDropdown: ({ items }: { items: Array<{ name: string }> }) => {
    dropdownCapture.calls.push(items);
    return (
      <div data-testid="session-links">
        {items.map((item) => (
          <span key={item.name}>{item.name}</span>
        ))}
      </div>
    );
  },
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
  agentic_tool: 'claude-code-cli',
  status: 'idle',
  archived: false,
  created_at: '2026-06-29T00:00:00.000Z',
  last_updated: '2026-06-29T00:00:00.000Z',
} as unknown as Session;

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'feature/links',
  path: '/tmp/feature-links',
  filesystem_status: 'ready',
  issue_url: 'https://github.com/acme/widgets/issues/92',
  archived: false,
} as unknown as Branch;

const kbLink = {
  link_id: 'link-kb',
  branch_id: null,
  session_id: 'session-1',
  source_message_id: null,
  kind: 'kb_ref',
  source: 'parsed',
  url: null,
  ref_uri: 'agor://kb/team/runbooks/links.md',
  file_path: null,
  target_key: normalizeRefTargetKey('agor://kb/team/runbooks/links.md'),
  title: null,
  mime_type: null,
  metadata: null,
  created_by: null,
  created_at: '2026-06-29T00:00:00.000Z',
  updated_at: '2026-06-29T00:00:00.000Z',
} as Link;

describe('SessionPanel session links', () => {
  it('queries links for the active session and passes merged rows to the links widget', async () => {
    dropdownCapture.calls = [];
    const linksFindAll = vi.fn().mockResolvedValue([kbLink]);
    const noopService = { on: vi.fn(), off: vi.fn() };
    const client = {
      service: vi.fn((path: string) => {
        if (path === 'links') return { findAll: linksFindAll, on: vi.fn(), off: vi.fn() };
        if (path === `/sessions/${session.session_id}/tasks/queue`) {
          return { find: vi.fn().mockResolvedValue({ data: [] }) };
        }
        return noopService;
      }),
    };

    render(
      <ConnectionProvider value={connected}>
        <AppActionsProvider value={{ onOpenTerminal: vi.fn() }}>
          <AntApp>
            <SessionPanel
              client={client as never}
              session={session}
              branch={branch}
              open
              onClose={vi.fn()}
            />
          </AntApp>
        </AppActionsProvider>
      </ConnectionProvider>
    );

    await waitFor(() =>
      expect(linksFindAll).toHaveBeenCalledWith({ query: { session_id: 'session-1' } })
    );
    expect(await screen.findByText('Issue: acme/widgets#92')).toBeInTheDocument();
    expect(screen.getByText('KB: team/runbooks/links.md')).toBeInTheDocument();
  });
});
