import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileApp } from './MobileApp';

vi.mock('./MobileBoardPage', () => ({
  MobileBoardPage: ({
    onOpenBranch,
  }: {
    onOpenBranch: (branchId: string, tab: string) => void;
  }) => (
    <button type="button" onClick={() => onOpenBranch('branch-1', 'schedule')}>
      Open schedule
    </button>
  ),
}));

vi.mock('../BranchModal', () => ({
  BranchModal: ({ open, defaultTab }: { open: boolean; defaultTab?: string }) =>
    open ? <div data-testid="branch-sheet">{defaultTab}</div> : null,
}));

vi.mock('./MobileNavTree', () => ({ MobileNavTree: () => null }));

describe('MobileApp branch actions', () => {
  it('wires board branch actions to the requested bottom sheet tab', () => {
    render(
      <MemoryRouter initialEntries={['/board/board-1']}>
        <MobileApp
          client={null}
          onSendComment={vi.fn()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenUserSettings={vi.fn()}
          promptDrafts={new Map()}
          onUpdateDraft={vi.fn()}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));
    expect(screen.getByTestId('branch-sheet')).toHaveTextContent('schedule');
  });
});
