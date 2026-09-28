import type { Session } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './GlobalSearch';

const { goToBoard, goToSession, recentsState } = vi.hoisted(() => ({
  goToBoard: vi.fn(),
  goToSession: vi.fn(),
  recentsState: {
    session: [] as unknown[],
    branch: [] as unknown[],
    teammate: [] as unknown[],
    artifact: [] as unknown[],
    board: [] as unknown[],
    mcp: [] as unknown[],
  },
}));

vi.mock('../../hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({
    goToBoard,
    goToBranch: vi.fn(),
    goToSession,
    goToArtifact: vi.fn(),
  }),
}));

vi.mock('./useRecents', () => ({
  useRecents: () => recentsState,
}));

const emptyMaps = {
  sessionById: new Map(),
  branchById: new Map(),
  artifactById: new Map(),
  boardById: new Map(),
  mcpServerById: new Map(),
};

function renderSearch() {
  return render(
    <MemoryRouter>
      <GlobalSearch {...emptyMaps} />
    </MemoryRouter>
  );
}

describe('GlobalSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    goToBoard.mockClear();
    goToSession.mockClear();
    recentsState.board = [];
    // jsdom doesn't implement scrollIntoView; the keyboard-cursor effect calls
    // it whenever visibleRows is non-empty.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('submitting an empty query does not navigate to a recent item', async () => {
    recentsState.board = [{ type: 'board', item: { board_id: 'board-1', name: 'Recent Board' } }];
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await vi.advanceTimersByTimeAsync(16);

    const input = screen.getByRole('combobox', { name: 'Global search' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(goToBoard).not.toHaveBeenCalled();
  });

  it('does not render legacy board emojis in board result rows', async () => {
    recentsState.board = [
      { type: 'board', item: { board_id: 'board-1', name: 'Recent Board', icon: '🦊' } },
    ];
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await vi.advanceTimersByTimeAsync(16);

    expect(screen.getByRole('option', { name: 'Recent Board' })).not.toBeNull();
    expect(screen.queryByText('🦊')).toBeNull();
  });

  it('renders the search icon button', () => {
    renderSearch();

    const button = screen.getByRole('button', { name: 'Open search' });
    expect(button).not.toBeNull();
  });

  it('clicking the icon opens the popover and shows the combobox input', async () => {
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await vi.advanceTimersByTimeAsync(16);

    expect(screen.getByRole('combobox', { name: 'Global search' })).not.toBeNull();
  });

  it('clicking the icon again closes the popover', async () => {
    renderSearch();

    const button = screen.getByRole('button', { name: 'Open search' });

    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.getByRole('combobox', { name: 'Global search' })).not.toBeNull();

    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.queryByRole('combobox', { name: 'Global search' })).toBeNull();
  });

  it('Cmd+K opens the popover from closed state', async () => {
    renderSearch();

    expect(screen.queryByRole('combobox', { name: 'Global search' })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await vi.advanceTimersByTimeAsync(16);

    expect(screen.getByRole('combobox', { name: 'Global search' })).not.toBeNull();
  });

  it('uses current results for keyboard selection and removes its shortcut on unmount', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const sessions = ['first', 'second'].map(
      (id) =>
        ({
          session_id: id,
          title: `deploy ${id}`,
          archived: false,
          created_by: 'me',
          last_updated: '2026-09-28T00:00:00.000Z',
        }) as Session
    );
    const props = {
      ...emptyMaps,
      currentUserId: 'me',
      sessionById: new Map(sessions.map((session) => [session.session_id, session])),
    };
    const view = render(
      <MemoryRouter>
        <GlobalSearch {...props} />
      </MemoryRouter>
    );
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    await act(() => vi.advanceTimersByTimeAsync(16));
    const input = screen.getByRole('combobox', { name: 'Global search' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'deploy' } });
    // First Enter flushes the pending query without navigating stale rows.
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(goToSession).not.toHaveBeenCalled();
    fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Remove the selected row. Selection must clamp to the remaining current row.
    view.rerender(
      <MemoryRouter>
        <GlobalSearch {...props} sessionById={new Map([['first', sessions[0]]])} />
      </MemoryRouter>
    );
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(goToSession).toHaveBeenCalledExactlyOnceWith('first');
    expect(screen.queryByRole('combobox')).toBeNull();
    view.unmount();
    expect(remove.mock.calls.some(([event]) => event === 'keydown')).toBe(true);
    remove.mockRestore();
  });

  it('Close button closes the popover', async () => {
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.getByRole('combobox', { name: 'Global search' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.queryByRole('combobox', { name: 'Global search' })).toBeNull();
  });

  it('combobox input is not visible when the popover is closed', () => {
    renderSearch();

    expect(screen.queryByRole('combobox', { name: 'Global search' })).toBeNull();
  });
});
