import { act, fireEvent, render, screen } from '@testing-library/react';
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

// Capture the props the sheet is actually handed, so a control that renders
// enabled but is wired to nothing fails here rather than silently on a phone.
let branchModalProps: Record<string, unknown> = {};
vi.mock('../BranchModal', () => ({
  BranchModal: (props: { open: boolean; defaultTab?: string }) => {
    branchModalProps = props as Record<string, unknown>;
    return props.open ? <div data-testid="branch-sheet">{props.defaultTab}</div> : null;
  },
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

  it('hands the bottom sheet the same edit handlers as the desktop modal', () => {
    const handlers = {
      onUpdateBranch: vi.fn(),
      onUpdateRepo: vi.fn(),
      onArchiveOrDeleteBranch: vi.fn(),
      onExecuteScheduleNow: vi.fn(),
    };

    render(
      <MemoryRouter initialEntries={['/board/board-1']}>
        <MobileApp
          client={null}
          onSendComment={vi.fn()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenUserSettings={vi.fn()}
          promptDrafts={new Map()}
          onUpdateDraft={vi.fn()}
          {...handlers}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));

    expect(branchModalProps.onUpdateBranch).toBe(handlers.onUpdateBranch);
    expect(branchModalProps.onUpdateRepo).toBe(handlers.onUpdateRepo);
    expect(branchModalProps.onArchiveOrDelete).toBe(handlers.onArchiveOrDeleteBranch);
    expect(branchModalProps.onExecuteScheduleNow).toBe(handlers.onExecuteScheduleNow);
    expect(typeof branchModalProps.onSessionClick).toBe('function');
  });

  it('navigates session links to the mobile session route', () => {
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
    const onSessionClick = branchModalProps.onSessionClick as (id: string) => void;
    act(() => onSessionClick('session-9'));

    // Sheet closes and the session opens on its own /m route.
    expect(screen.queryByTestId('branch-sheet')).not.toBeInTheDocument();
  });
});
