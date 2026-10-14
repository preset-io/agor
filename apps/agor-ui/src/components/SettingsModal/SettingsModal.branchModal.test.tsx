/**
 * Opening a branch from Settings reads that branch's active sessions for the
 * BranchModal, so its count and list are right with the store's session map
 * empty (Step 3).
 */
import type { AgorClient, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Grid } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import { withTestAuthority } from '../../test/harness';
import { SettingsModal } from './SettingsModal';

const branch = { branch_id: 'branch-1', repo_id: 'repo-1', name: 'feature' } as Branch;
const session = { session_id: 's1', branch_id: 'branch-1', title: 'Fix it' } as Session;

vi.mock('./BranchesTable', () => ({
  BranchesTable: ({ onRowClick }: { onRowClick: (b: Branch) => void }) => (
    <button type="button" onClick={() => onRowClick(branch)}>
      open branch
    </button>
  ),
}));
vi.mock('../BranchModal', () => ({
  BranchModal: ({
    open,
    sessions,
    onClose,
  }: {
    open: boolean;
    sessions: Session[];
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="branch-modal">
        {sessions.map((s) => s.title).join(',')}
        <button type="button" onClick={onClose}>
          close branch
        </button>
      </div>
    ) : null,
}));

withTestAuthority('u1:admin:1', { dataAuthority: false });
beforeEach(() => vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true }));

const listeners = { on: () => {}, off: () => {} };

function renderSettings(client: AgorClient) {
  render(
    <SettingsModal
      open
      onClose={vi.fn()}
      client={client}
      currentUser={{ user_id: 'u1', role: 'admin' } as User}
      activeTab="branches"
    />
  );
}

it("reads the opened branch's active sessions once", async () => {
  const findAll = vi.fn(async () => [session]);
  const client = { service: () => ({ findAll, ...listeners }) } as unknown as AgorClient;
  renderSettings(client);
  fireEvent.click(screen.getByRole('button', { name: 'open branch' }));
  expect(await screen.findByText('Fix it')).toBeInTheDocument();
  expect(findAll).toHaveBeenCalledTimes(1);
  expect(findAll).toHaveBeenCalledWith({
    query: { branch_id: 'branch-1', archived: false, $sort: { created_at: -1 } },
  });
});

it('never lets a read from an earlier opening of the same branch land', async () => {
  const replies: Array<(sessions: Session[]) => void> = [];
  const findAll = vi.fn(() => new Promise<Session[]>((resolve) => replies.push(resolve)));
  const client = { service: () => ({ findAll, ...listeners }) } as unknown as AgorClient;
  renderSettings(client);
  fireEvent.click(screen.getByRole('button', { name: 'open branch' }));
  fireEvent.click(await screen.findByRole('button', { name: 'close branch' }));
  fireEvent.click(screen.getByRole('button', { name: 'open branch' }));
  expect(findAll).toHaveBeenCalledTimes(2);
  await act(async () => replies[1]([{ ...session, title: 'Fresh' }]));
  await act(async () => replies[0]([{ ...session, title: 'Stale' }]));
  expect(screen.getByTestId('branch-modal')).toHaveTextContent('Fresh');
  expect(screen.getByTestId('branch-modal')).not.toHaveTextContent('Stale');
});
