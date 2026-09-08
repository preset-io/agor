import type { Branch, MCPServer, Repo } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { App, ConfigProvider, Modal, theme } from 'antd';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { agorStore } from '../../store/agorStore';
import { GeneralTab } from '../BranchModal/tabs/GeneralTab';
import type { GeneralFormState } from '../BranchModal/useBranchModalForm';
import { NewSessionModal } from '../NewSessionModal/NewSessionModal';

const enabledId = '01900000-0000-7000-8000-000000000001';
const disabledId = '01900000-0000-7000-8000-000000000002';
const unavailableId = '01900000-0000-7000-8000-000000000003';
const servers = [
  { mcp_server_id: enabledId, name: 'Enabled', enabled: true, transport: 'http' },
  { mcp_server_id: disabledId, name: 'Disabled', enabled: false, transport: 'http' },
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
  agorStore.setState({ mcpServerById: new Map() });
});

function GeneralSurface({ canEdit = true }: { canEdit?: boolean }) {
  const [state, setState] = useState<GeneralFormState>({
    boardId: undefined,
    issueUrl: '',
    prUrl: '',
    notes: '',
    mcpServerIds: branch.mcp_server_ids ?? [],
  });
  return (
    <Modal
      open
      title="Teammate / General"
      footer={null}
      styles={{ body: { maxHeight: '80vh', overflowY: 'auto' } }}
    >
      <GeneralTab
        branch={branch}
        repo={{ name: 'Fixture' } as Repo}
        sessions={[]}
        mcpServers={servers}
        canEdit={canEdit}
        state={state}
        setField={(key, value) => setState((prev) => ({ ...prev, [key]: value }))}
      />
    </Modal>
  );
}

function expectAnchoredAndUnclipped(input: HTMLElement) {
  const trigger = input.closest('.ant-select')!;
  const popup = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!;
  expect(popup).not.toBeNull();
  expect(
    (
      trigger.closest('.ant-popover, .ant-modal-container, .ant-drawer-content') ??
      trigger.parentElement
    )?.contains(popup)
  ).toBe(true);
  const box = popup.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  if (Math.max(anchor.top, window.innerHeight - anchor.bottom) >= box.height + 4) {
    expect(
      Math.min(Math.abs(box.top - anchor.bottom), Math.abs(box.bottom - anchor.top))
    ).toBeLessThan(12);
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

it.each(['New Session', 'Teammate / General'] as const)(
  '%s keeps removal, focus, and popup anchoring through scrolling',
  async (surface) => {
    agorStore.setState({
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
          ) : (
            <GeneralSurface />
          )}
        </App>
      </ConfigProvider>
    );
    if (surface === 'New Session') {
      await act(() => userEvent.click(screen.getByTestId('mcp-chip')));
    }
    const input =
      surface === 'New Session'
        ? screen.getByRole('combobox', { name: '' })
        : screen.getAllByRole('combobox').at(-1)!;
    if (surface === 'Teammate / General') input.scrollIntoView({ block: 'center' });
    await act(() => userEvent.click(input));
    await vi.waitFor(() => expectAnchoredAndUnclipped(input));
    // Backspace must remove the final disabled attachment, not skip over it.
    await act(() => userEvent.keyboard('{Backspace}'));
    expect(screen.queryByText('Disabled (http)')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
    // On short viewports a tall list may shift across the field. Dismiss it
    // before using the chip's mouse affordance; Escape must retain focus.
    await act(() => userEvent.keyboard('{Escape}'));
    expect(input).toHaveFocus();
    const trigger = input.closest('.ant-select')!;
    const unavailable = Array.from(trigger.querySelectorAll('.ant-select-selection-item')).find(
      (tag) => tag.textContent?.includes('Unavailable')
    )!;
    await act(() =>
      userEvent.click(unavailable.querySelector('.ant-select-selection-item-remove')!)
    );
    expect(trigger.textContent).not.toContain('Unavailable');
    expect(input).toHaveFocus();
    await act(() => userEvent.keyboard('{ArrowDown}'));

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
      });
      if (parent.scrollTop === before) continue;
      scrolled = true;
      await vi.waitFor(() => expectAnchoredAndUnclipped(input));
    }
    if (window.innerHeight < 600) expect(scrolled).toBe(true);
    await act(() => userEvent.keyboard('{Escape}'));
    expect(input).toHaveFocus();
    await act(() => userEvent.keyboard('{ArrowDown}'));
    await vi.waitFor(() => expectAnchoredAndUnclipped(input));
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
  expect(screen.getByText('Disabled (http)')).toBeInTheDocument();
  expect(screen.getByText(/Unavailable MCP server/)).toBeInTheDocument();
});
