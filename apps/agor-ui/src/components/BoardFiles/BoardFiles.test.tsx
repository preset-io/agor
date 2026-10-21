import type {
  AgorClient,
  Board,
  BoardFileItem,
  BoardFilesPage,
  Branch,
  UserID,
} from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardViewContext, type BoardViewContextValue } from '../../contexts/BoardViewContext';
import { agorStore } from '../../store/agorStore';
import { BoardFiles } from './BoardFiles';

const teammate = {
  branch_id: 'teammate-1',
  name: 'kelly',
  custom_context: { teammate: { kind: 'teammate', displayName: 'Kelly', emoji: '🧭' } },
} as unknown as Branch;
const board = { board_id: 'board-1', primary_teammate_id: 'teammate-1' } as unknown as Board;

const file = (id: string, overrides: Partial<BoardFileItem> = {}): BoardFileItem => ({
  kind: 'document',
  id,
  name: `Doc ${id}`,
  made_at: '2026-10-21T10:00:00.000Z',
  created_at: '2026-10-21T10:00:00.000Z',
  made_by: { user_id: 'user-1' as UserID },
  source: 'board',
  ...overrides,
});

function filesClient(respond: (query: Record<string, unknown>) => BoardFilesPage) {
  const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => respond(query));
  const service = vi.fn(() => ({ find, on: vi.fn(), removeListener: vi.fn() }));
  return { client: { service } as unknown as AgorClient, find, service };
}

const page = (data: BoardFileItem[], total = data.length): BoardFilesPage => ({
  total,
  limit: 50,
  skip: 0,
  data,
});

function boardView(): BoardViewContextValue {
  return {
    view: 'files',
    showOnBoard: vi.fn(),
    previewTarget: null,
    openPreview: vi.fn(),
    closePreview: vi.fn(),
    openConversation: vi.fn(),
  };
}

function renderFiles(client: AgorClient, context = boardView(), mobile = false) {
  render(
    <BoardViewContext.Provider value={context}>
      <BoardFiles client={client} boardId="board-1" active mobile={mobile} />
    </BoardViewContext.Provider>
  );
  return context;
}

let observers: { callback: IntersectionObserverCallback }[] = [];
beforeEach(() => {
  agorStore.setState({
    boardById: new Map([[board.board_id, board]]),
    branchById: new Map([[teammate.branch_id, teammate]]),
    userById: new Map(),
  } as never);
  observers = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BoardFiles', () => {
  it('says nothing is here yet, naming the board’s teammate', async () => {
    const { client, service } = filesClient(() => page([]));
    renderFiles(client);
    expect(
      await screen.findByText(
        'Nothing here yet. Things Kelly makes and files you share show up here.'
      )
    ).toBeInTheDocument();
    expect(service).toHaveBeenCalledWith('boards/board-1/files');
  });

  it('says no files match a search or a type, and sends both to the server', async () => {
    const { client, find } = filesClient((query) =>
      query.q || query.kind ? page([]) : page([file('a')])
    );
    renderFiles(client);
    await screen.findByText('Doc a');
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'renewal' } });
    expect(
      await screen.findByText('No files match. Try another word or type.')
    ).toBeInTheDocument();
    expect(find).toHaveBeenLastCalledWith({
      query: expect.objectContaining({ q: 'renewal', sort: 'recent', $limit: 50, $skip: 0 }),
    });
  });

  it('shows where each item came from: a conversation link, private, or shared on the board', async () => {
    const { client } = filesClient(() =>
      page([
        file('a', { source: { session_id: 'session-1', title: 'QBR prep' } as never }),
        file('b', { source: 'private', made_by: { name: 'Kelly', emoji: '🧭' } }),
        file('c', { kind: 'upload', name: 'order-form.pdf', source: 'board' }),
      ])
    );
    const context = renderFiles(client);
    const link = await screen.findByRole('button', { name: /QBR prep/ });
    expect(screen.getByText('Private conversation')).toBeInTheDocument();
    expect(screen.getByText('Shared on the board')).toBeInTheDocument();
    expect(screen.getByText('Kelly')).toBeInTheDocument();
    fireEvent.click(link);
    expect(context.openConversation).toHaveBeenCalledWith('session-1');
    expect(context.openPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'order-form.pdf, Upload' }));
    expect(context.openPreview).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'upload', ref: 'c' })
    );
  });

  it('loads the next 50 when the end of the list comes into view', async () => {
    const { client, find } = filesClient((query) =>
      query.$skip ? page([file('page-2')], 3) : page([file('a'), file('b')], 3)
    );
    renderFiles(client);
    await screen.findByText('Doc a');
    expect(screen.getByRole('status')).toHaveTextContent('Loading more…');
    expect(observers.length).toBeGreaterThan(0);
    await act(async () => {
      for (const { callback } of observers) {
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        );
      }
    });
    expect(await screen.findByText('Doc page-2')).toBeInTheDocument();
    expect(find).toHaveBeenLastCalledWith({ query: expect.objectContaining({ $skip: 2 }) });
  });

  const reachEnd = () =>
    act(async () => {
      for (const { callback } of observers) {
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        );
      }
    });

  it('keeps one row per item when pages overlap, and stops at the server’s total', async () => {
    // A new item pushed "b" onto the second page as well.
    const { client, find } = filesClient((query) =>
      query.$skip ? page([file('b'), file('c')], 4) : page([file('a'), file('b')], 4)
    );
    renderFiles(client);
    await screen.findByText('Doc a');
    await reachEnd();
    expect(await screen.findByText('Doc c')).toBeInTheDocument();
    expect(screen.getAllByText('Doc b')).toHaveLength(1);
    // Four of four read, though three rows show: nothing more to load.
    expect(screen.queryByText('Loading more…')).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('says a later page failed and retries that page', async () => {
    let failNext = true;
    const { client, find } = filesClient((query) => {
      if (!query.$skip) return page([file('a'), file('b')], 3);
      if (failNext) {
        failNext = false;
        throw new Error('offline');
      }
      return page([file('page-2')], 3);
    });
    renderFiles(client);
    await screen.findByText('Doc a');
    await reachEnd();
    expect(await screen.findByText('Couldn’t load more.')).toBeInTheDocument();
    expect(screen.queryByText('Loading more…')).toBeNull();
    expect(screen.getByText('Doc a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Doc page-2')).toBeInTheDocument();
    expect(find).toHaveBeenLastCalledWith({ query: expect.objectContaining({ $skip: 2 }) });
  });

  it('reloads from page one when a listed branch is deleted or moves to another board', async () => {
    const handlers = new Map<string, (record: unknown) => void>();
    let rows = [file('branch-1', { kind: 'app' }), file('a')];
    const find = vi.fn(async () => page(rows));
    const client = {
      service: (path: string) => ({
        find,
        on: (event: string, handler: (record: unknown) => void) =>
          handlers.set(`${path}:${event}`, handler),
        removeListener: vi.fn(),
      }),
    } as unknown as AgorClient;
    agorStore.setState({
      branchById: new Map([
        [teammate.branch_id, teammate],
        ['branch-1', { branch_id: 'branch-1', board_id: 'board-1' } as unknown as Branch],
      ]),
    } as never);
    renderFiles(client);
    await screen.findByText('Doc branch-1');

    // The patch names only the new board; this board still refreshes.
    rows = [file('a')];
    act(() => handlers.get('branches:patched')?.({ branch_id: 'branch-1', board_id: 'board-2' }));
    await waitFor(() => expect(screen.queryByText('Doc branch-1')).toBeNull(), { timeout: 2000 });
    expect(find).toHaveBeenLastCalledWith({ query: expect.objectContaining({ $skip: 0 }) });

    // Unrelated branches elsewhere do not.
    const calls = find.mock.calls.length;
    act(() => handlers.get('branches:removed')?.({ branch_id: 'other', board_id: 'board-2' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(find).toHaveBeenCalledTimes(calls);
  });

  it('moves Type, Sort and View into Filters when narrow, counting the ones changed', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(520);
    const { client } = filesClient(() => page([file('a')]));
    renderFiles(client);
    await screen.findByText('Doc a');
    const filters = screen.getByRole('button', { name: /Filters/ });
    expect(screen.queryByLabelText('Sort')).toBeNull();
    fireEvent.click(filters);
    const popover = await screen.findByRole('tooltip');
    fireEvent.mouseDown(within(popover).getByLabelText('View'));
    fireEvent.click(await screen.findByTitle('Grid'));
    await waitFor(() => expect(filters.closest('.ant-badge')).toHaveTextContent('1'));
    width.mockRestore();
  });

  it('shows only Search and Type on phones', async () => {
    const { client } = filesClient(() => page([file('a')]));
    renderFiles(client, boardView(), true);
    await screen.findByText('Doc a');
    expect(screen.getByLabelText('Search files')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sort')).toBeNull();
    expect(screen.queryByLabelText('View')).toBeNull();
    expect(screen.queryByRole('button', { name: /Filters/ })).toBeNull();
  });
});
