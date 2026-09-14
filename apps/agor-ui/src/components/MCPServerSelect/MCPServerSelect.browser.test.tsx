import type { Branch, MCPServer, Repo, User } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, Button, ConfigProvider, Drawer, Grid, Modal, Tabs, theme } from 'antd';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { GeneralTab } from '../BranchModal/tabs/GeneralTab';
import type { GeneralFormState } from '../BranchModal/useBranchModalForm';
import { NewSessionModal } from '../NewSessionModal/NewSessionModal';
import { UserSettingsModal } from '../SettingsModal/UserSettingsModal';

const enabledId = '01900000-0000-7000-8000-000000000001';
const disabledId = '01900000-0000-7000-8000-000000000002';
const unavailableId = '01900000-0000-7000-8000-000000000003';
const servers = [
  { mcp_server_id: enabledId, name: 'Enabled', enabled: true, transport: 'http' },
  { mcp_server_id: disabledId, name: 'Paused integration', enabled: false, transport: 'http' },
  ...Array.from({ length: 10 }, (_, index) => ({
    mcp_server_id: `extra-${index}`,
    name: `Extra ${index}`,
    enabled: true,
    transport: 'http',
  })),
] as MCPServer[];
const branch: Branch = {
  branch_id: '01900000-0000-7000-8000-000000000004' as Branch['branch_id'],
  repo_id: '01900000-0000-7000-8000-000000000005' as Branch['repo_id'],
  created_by: '01900000-0000-7000-8000-000000000006' as Branch['created_by'],
  branch_unique_id: 1,
  name: 'Picker validation' as Branch['name'],
  ref: 'main',
  path: '/fictional/teammate',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_used: '2026-01-01T00:00:00.000Z',
  new_branch: false,
  archived: false,
  needs_attention: false,
  mcp_server_ids: [enabledId, unavailableId, disabledId],
  custom_context: { teammate: { kind: 'teammate' } },
};

afterEach(() => {
  cleanup();
  agorStore.setState({ mcpServerById: new Map(), agenticToolSettingsHydrated: false });
  __resetAuthConfigForTests();
});

function GeneralSurface({ canEdit = true }: { canEdit?: boolean }) {
  const compact = !Grid.useBreakpoint().md;
  const [state, setState] = useState<GeneralFormState>({
    boardId: undefined,
    issueUrl: '',
    prUrl: '',
    notes: '',
    mcpServerIds: branch.mcp_server_ids ?? [],
  });
  // BranchModal's real responsive shell: bottom 94dvh drawer on phones,
  // header/tabs/footer plus a separately scrolling body on both presentations.
  const contents = (
    <Tabs
      items={[
        {
          key: 'general',
          label: 'General',
          children: (
            <GeneralTab
              branch={branch}
              repo={{ name: 'Fixture' } as Repo}
              sessions={[]}
              mcpServers={servers}
              canEdit={canEdit}
              state={state}
              setField={(key, value) => setState((prev) => ({ ...prev, [key]: value }))}
            />
          ),
        },
      ]}
    />
  );
  const footer = <Button>Save</Button>;
  return compact ? (
    <Drawer
      open
      title="Teammate / General"
      placement="bottom"
      size="94dvh"
      footer={footer}
      styles={{ body: { padding: '12px 16px', overflowY: 'auto' } }}
    >
      {contents}
    </Drawer>
  ) : (
    <Modal
      open
      title="Teammate / General"
      width={900}
      footer={footer}
      styles={{ body: { padding: 0, maxHeight: '80vh', overflowY: 'auto' } }}
    >
      {contents}
    </Modal>
  );
}

const user = {
  user_id: 'fixture-user',
  name: 'Fixture member',
  email: 'fixture@example.test',
  role: 'member',
  default_mcp_server_ids: branch.mcp_server_ids,
  default_agentic_config: {},
} as User;

function SettingsSurface() {
  return (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <UserSettingsModal
        open
        user={user}
        currentUser={user}
        client={null}
        initialTab="claude-code"
        onClose={vi.fn()}
      />
    </ConnectionProvider>
  );
}

function expectAnchoredAndUnclipped(input: HTMLElement) {
  const trigger = input.closest('.ant-select')!;
  const popup = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!;
  expect(popup).not.toBeNull();
  expect(popup.parentElement).toBe(document.body);
  const box = popup.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  // Never excuse overlap just because a viewport is short. Shrink the list.
  expect(box.bottom <= anchor.top + 1 || box.top >= anchor.bottom - 1).toBe(true);
  expect(
    Math.min(Math.abs(box.top - anchor.bottom), Math.abs(box.bottom - anchor.top)),
    JSON.stringify({
      anchor: anchor.toJSON(),
      box: box.toJSON(),
      style: popup.getAttribute('style'),
    })
  ).toBeLessThan(12);
  // Every remove control AND the input must still win hit testing while open.
  for (const control of [input, ...trigger.querySelectorAll('.ant-select-selection-item-remove')]) {
    const rect = control.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(control.contains(hit), control.outerHTML).toBe(true);
  }
  expect(box.left).toBeGreaterThanOrEqual(-1);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  // Geometry alone misses clipping by an independently scrolling ancestor.
  for (const y of [box.top + 8, box.bottom - 8]) {
    expect(
      popup.contains(document.elementFromPoint(box.left + box.width / 2, y)),
      JSON.stringify({
        box: box.toJSON(),
        hit: document.elementFromPoint(box.left + box.width / 2, y)?.outerHTML.slice(0, 200),
      })
    ).toBe(true);
  }
}

it.each(['New Session', 'Teammate / General', 'User Settings'] as const)(
  '%s keeps removal, focus, and popup anchoring through scrolling',
  async (surface) => {
    __setAuthConfigForTests({ requireAuth: false });
    agorStore.setState({
      agenticToolSettingsHydrated: true,
      mcpServerById: new Map(servers.map((server) => [server.mcp_server_id, server])),
    });
    render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
        <App>
          {surface === 'New Session' ? (
            <NewSessionModal
              open
              branchId={branch.branch_id}
              branch={branch}
              availableAgents={[]}
              client={null}
              onClose={vi.fn()}
              onCreate={vi.fn(async () => null)}
            />
          ) : surface === 'User Settings' ? (
            <SettingsSurface />
          ) : (
            <GeneralSurface />
          )}
        </App>
      </ConfigProvider>
    );
    if (surface === 'New Session') {
      await act(() => userEvent.click(screen.getByTestId('mcp-chip')));
    }
    if (surface === 'User Settings') {
      await act(() => userEvent.click(screen.getByRole('tab', { name: 'Session defaults' })));
    }
    const input =
      surface === 'New Session'
        ? screen.getByRole('combobox', { name: '' })
        : surface === 'User Settings'
          ? screen.getByRole('combobox', { name: 'MCP Servers' })
          : screen.getAllByRole('combobox').at(-1)!;
    if (surface !== 'New Session') input.scrollIntoView({ block: 'center' });
    if (window.innerWidth < 768 && surface !== 'New Session') {
      expect(input.closest('.ant-drawer-section')).not.toBeNull();
    }
    await act(() => userEvent.click(input));
    await waitFor(() => expectAnchoredAndUnclipped(input));
    const selectedDisabled = input
      .closest('.ant-select')!
      .querySelector('[title="Disabled · Paused integration (http)"]');
    expect(selectedDisabled).not.toBeNull();
    expect(selectedDisabled).toHaveTextContent('Disabled ·');
    const statusText = selectedDisabled!.querySelector('.ant-select-selection-item-content')!;
    const statusRange = document.createRange();
    statusRange.setStart(statusText.firstChild!, 0);
    statusRange.setEnd(statusText.firstChild!, 'Disabled'.length);
    // Status must remain visible before the label's native ellipsis.
    expect(statusRange.getBoundingClientRect().right).toBeLessThanOrEqual(
      statusText.getBoundingClientRect().right
    );

    await act(() => userEvent.type(input, 'Paused'));
    // Native option accessible names include the status, not just color/title.
    expect(
      screen.getByRole('option', { name: 'Disabled · Paused integration (http)' })
    ).toBeInTheDocument();
    await act(() => userEvent.clear(input));
    // Select guards against one held Backspace erasing search AND tags (250ms).
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await act(() => userEvent.keyboard('{Backspace}'));
    expect(screen.queryByText('Disabled · Paused integration (http)')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
    await waitFor(() => expectAnchoredAndUnclipped(input));
    const trigger = input.closest('.ant-select')!;
    const unavailable = Array.from(trigger.querySelectorAll('.ant-select-selection-item')).find(
      (tag) => tag.textContent?.includes('Unavailable')
    )!;
    await act(() =>
      userEvent.click(unavailable.querySelector('.ant-select-selection-item-remove')!)
    );
    expect(trigger.textContent).not.toContain('Unavailable');
    expect(input).toHaveFocus();
    await waitFor(() => expectAnchoredAndUnclipped(input));
    // Search and keyboard-select a new attachment; removed disabled/unavailable
    // entries are not offered anew. Escape retains the native input focus.
    await act(() => userEvent.type(input, 'Extra 9'));
    await act(() => userEvent.keyboard('{ArrowDown}{Enter}'));
    expect(trigger.textContent).toContain('Extra 9');
    expect(trigger.textContent).not.toContain('Paused integration');
    await act(() => userEvent.keyboard('{Escape}'));
    expect(input).toHaveFocus();
    await act(() => userEvent.keyboard('{ArrowDown}'));
    await waitFor(() => expectAnchoredAndUnclipped(input));
    // Exercise real wheel scrolling, not only search/virtual-list geometry.
    const dropdown = document.querySelector(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden)'
    )!;
    await act(() => userEvent.wheel(dropdown, { delta: { y: 1000 } }));
    const lastOption = Array.from(dropdown.querySelectorAll('.ant-select-item-option')).find(
      (option) => option.textContent?.includes('Extra 9')
    )!;
    await waitFor(() => {
      const rect = lastOption.getBoundingClientRect();
      expect(
        lastOption.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        )
      ).toBe(true);
    });
    await act(() => userEvent.click(lastOption));
    expect(trigger.textContent).not.toContain('Extra 9');
    expect(input).toHaveFocus();

    // New Session's picker is portaled into a popover, so its originating
    // chip's modal scroll owners must also move while the dropdown is open.
    const origins = [input];
    if (surface === 'New Session') origins.push(screen.getByTestId('mcp-chip'));
    const scrollOwners = new Set<HTMLElement>();
    for (const origin of origins) {
      for (let parent = origin.parentElement; parent; parent = parent.parentElement) {
        if (
          /(auto|scroll)/.test(getComputedStyle(parent).overflowY) &&
          parent.scrollHeight > parent.clientHeight
        )
          scrollOwners.add(parent);
      }
    }
    let scrolled = false;
    for (const parent of scrollOwners) {
      const before = parent.scrollTop;
      await act(async () => {
        parent.scrollTop = before > 24 ? before - 24 : before + 24;
        // Wait for the actual browser scroll event, not the synchronous assignment.
        await new Promise(requestAnimationFrame);
      });
      if (parent.scrollTop === before) continue;
      scrolled = true;
      await waitFor(() => expectAnchoredAndUnclipped(input));
    }
    if (window.innerHeight < 600) expect(scrolled).toBe(true);
    await act(() => userEvent.keyboard('{Escape}'));
    expect(input).toHaveFocus();
    await act(() => userEvent.keyboard('{ArrowDown}'));
    await waitFor(() => expectAnchoredAndUnclipped(input));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  }
);

it('Teammate / General respects read-only capability state', async () => {
  render(
    <App>
      <GeneralSurface canEdit={false} />
    </App>
  );
  const input = screen.getAllByRole('combobox').at(-1)!;
  expect(input).toBeDisabled();
  expect(
    input.closest('.ant-select')?.querySelector('.ant-select-selection-item-remove')
  ).toBeNull();
  expect(screen.getByText('Disabled · Paused integration (http)')).toBeInTheDocument();
  expect(screen.getByText(/Unavailable MCP server/)).toBeInTheDocument();
});
