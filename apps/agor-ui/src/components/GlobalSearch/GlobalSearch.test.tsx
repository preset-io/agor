import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './GlobalSearch';

const { goToBoard, recentsState } = vi.hoisted(() => ({
  goToBoard: vi.fn(),
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
    goToSession: vi.fn(),
    goToArtifact: vi.fn(),
  }),
}));

vi.mock('./useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    results: {
      session: [],
      branch: [],
      teammate: [],
      artifact: [],
      board: [],
      mcp: [],
    },
    counts: { session: 0, branch: 0, teammate: 0, artifact: 0, board: 0, mcp: 0 },
    hasAnyResults: false,
    debouncedQuery: '',
    flush: vi.fn(),
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
    recentsState.board = [];
    // jsdom doesn't implement scrollIntoView; the keyboard-cursor effect calls
    // it whenever visibleRows is non-empty.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
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

  it('renders the search icon button', () => {
    renderSearch();

    const button = screen.getByRole('button', { name: 'Open search' });
    expect(button).toBeInTheDocument();
  });

  it('clicking the icon opens the popover and shows the combobox input', async () => {
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await vi.advanceTimersByTimeAsync(16);

    expect(screen.getByRole('combobox', { name: 'Global search' })).toBeInTheDocument();
  });

  it('clicking the icon again closes the popover', async () => {
    renderSearch();

    const button = screen.getByRole('button', { name: 'Open search' });

    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.getByRole('combobox', { name: 'Global search' })).toBeInTheDocument();

    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.queryByRole('combobox', { name: 'Global search' })).not.toBeInTheDocument();
  });

  it('Cmd+K opens the popover from closed state', async () => {
    renderSearch();

    expect(screen.queryByRole('combobox', { name: 'Global search' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await vi.advanceTimersByTimeAsync(16);

    expect(screen.getByRole('combobox', { name: 'Global search' })).toBeInTheDocument();
  });

  it('Close button closes the popover', async () => {
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.getByRole('combobox', { name: 'Global search' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    await vi.advanceTimersByTimeAsync(16);
    expect(screen.queryByRole('combobox', { name: 'Global search' })).not.toBeInTheDocument();
  });

  it('combobox input is not visible when the popover is closed', () => {
    renderSearch();

    expect(screen.queryByRole('combobox', { name: 'Global search' })).not.toBeInTheDocument();
  });
});
