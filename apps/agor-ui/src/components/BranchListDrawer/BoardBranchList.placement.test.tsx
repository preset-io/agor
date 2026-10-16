import type { AgorClient, Board, BoardID, Branch, BranchID, RepoID } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasNavigationProvider,
  useRegisterRecenter,
} from '../../contexts/CanvasNavigationContext';
import { makeBranch } from '../BranchModal/testUtils';
import { BoardBranchList } from './BoardBranchList';

vi.mock('../BranchModal/BranchPlacementModal', () => ({
  BranchPlacementModal: ({
    branch,
    open,
    onClose,
    afterClose,
  }: {
    branch: Branch;
    open: boolean;
    onClose: () => void;
    afterClose: () => void;
  }) => (
    <div data-testid="placement" data-open={open}>
      {branch.branch_id}
      <button type="button" onClick={onClose}>
        Close placement
      </button>
      <button type="button" onClick={afterClose}>
        Finish closing
      </button>
    </div>
  ),
}));
const board: Board = {
  board_id: 'board-1' as BoardID,
  name: 'Board',
  created_by: 'user-1',
  created_at: '',
  last_updated: '',
  archived: false,
  url: '',
};
const branch = makeBranch({
  branch_id: 'branch-1' as BranchID,
  board_id: board.board_id,
  repo_id: 'repo-1' as RepoID,
  name: 'feature/placement',
  last_used: '2026-10-14T00:00:00.000Z',
});
function setup({ canMove = true, rows = [branch] }: { canMove?: boolean; rows?: Branch[] } = {}) {
  const service = {
    findAll: vi.fn().mockResolvedValue(rows),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const client = { service: vi.fn().mockReturnValue(service) } as unknown as AgorClient;
  const recenter = vi.fn(() => true);
  const afterClick = vi.fn();
  function Harness({ allowed }: { allowed: boolean }) {
    useRegisterRecenter(recenter);
    return (
      <BoardBranchList
        board={board}
        repoById={new Map()}
        client={client}
        canMoveBranches={allowed}
        onAfterBranchClick={afterClick}
      />
    );
  }
  const ui = (allowed: boolean) => (
    <CanvasNavigationProvider>
      <Harness allowed={allowed} />
    </CanvasNavigationProvider>
  );
  const view = render(ui(canMove));
  return { recenter, afterClick, rerender: (allowed: boolean) => view.rerender(ui(allowed)) };
}
describe('Teammate branches placement action', () => {
  it('opens the shared dialog for the selected branch without panning or dismissing the panel', async () => {
    const { recenter, afterClick } = setup();
    fireEvent.click(await screen.findByLabelText('Move feature/placement on board'));
    expect(screen.getByTestId('placement').textContent).toContain(branch.branch_id);
    expect(screen.getByTestId('placement').getAttribute('data-open')).toBe('true');
    expect(recenter).not.toHaveBeenCalled();
    expect(afterClick).not.toHaveBeenCalled();
  });
  it('keeps the dialog mounted until its closing animation finishes', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Move feature/placement on board'));
    fireEvent.click(screen.getByText('Close placement'));
    expect(screen.getByTestId('placement').getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByText('Finish closing'));
    expect(screen.queryByTestId('placement')).toBeNull();
  });
  it('does not expose movement without board-edit capability', async () => {
    setup({ canMove: false });
    await screen.findByText(branch.name);
    expect(screen.queryByLabelText('Move feature/placement on board')).toBeNull();
  });
  it('disables moving archived and deleting branches', async () => {
    setup({
      rows: [
        { ...branch, archived: true },
        {
          ...branch,
          branch_id: 'branch-2' as BranchID,
          name: 'deleting',
          deletion_status: 'deleting',
        },
      ],
    });
    expect(
      (await screen.findByLabelText<HTMLButtonElement>('Move feature/placement on board')).disabled
    ).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>('Move deleting on board').disabled).toBe(true);
  });
  it('drops the selected branch when board-edit capability is lost', async () => {
    const { rerender } = setup();
    fireEvent.click(await screen.findByLabelText('Move feature/placement on board'));
    rerender(false);
    await waitFor(() => expect(screen.queryByTestId('placement')).toBeNull());
    rerender(true);
    expect(screen.queryByTestId('placement')).toBeNull();
  });
});
