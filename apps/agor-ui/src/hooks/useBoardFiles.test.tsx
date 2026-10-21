import type { AgorClient, BoardFileItem, Branch, Session, UserID } from '@agor-live/client';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { type BoardFilesFilters, useBoardFiles } from './useBoardFiles';

const filters: BoardFilesFilters = { q: '', kind: 'all', sort: 'name' };
const item = (n: number): BoardFileItem => ({
  kind: 'artifact',
  id: `artifact-${String(n).padStart(3, '0')}`,
  name: `Item ${String(n).padStart(3, '0')}`,
  made_at: '2026-10-21T10:00:00.000Z',
  created_at: '2026-10-21T10:00:00.000Z',
  made_by: { user_id: 'user-1' as UserID },
  source: 'board',
});
const all = Array.from({ length: 80 }, (_, n) => item(n));

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const find = vi.fn(async ({ query }: { query: { $skip: number; $limit: number } }) => ({
  total: all.length,
  limit: query.$limit,
  skip: query.$skip,
  data: all.slice(query.$skip, query.$skip + query.$limit),
}));
const client = {
  service: (path: string) => ({
    find,
    on: (event: string, handler: Handler) => {
      const key = `${path}:${event}`;
      handlers.set(key, (handlers.get(key) ?? new Set()).add(handler));
    },
    removeListener: (event: string, handler: Handler) => {
      handlers.get(`${path}:${event}`)?.delete(handler);
    },
  }),
} as unknown as AgorClient;

function emit(path: string, event: string, data: unknown) {
  for (const handler of handlers.get(`${path}:${event}`) ?? []) handler(data);
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  find.mockClear();
  agorStore.setState({
    ...EMPTY_MAPS,
    branchById: new Map([
      ['branch-here', { branch_id: 'branch-here', board_id: 'board-1' } as Branch],
      ['branch-away', { branch_id: 'branch-away', board_id: 'board-2' } as Branch],
    ]),
    sessionById: new Map([
      ['session-here', { session_id: 'session-here', branch_id: 'branch-here' } as Session],
      ['session-away', { session_id: 'session-away', branch_id: 'branch-away' } as Session],
    ]),
  } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderOnPageTwo() {
  const hook = renderHook(
    ({ active }: { active: boolean }) =>
      useBoardFiles({ client, boardId: 'board-1', filters, active }),
    { initialProps: { active: true } }
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => hook.result.current.loadMore());
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(hook.result.current.items).toHaveLength(80);
  expect(hook.result.current.nextSkip).toBe(80);
  find.mockClear();
  return hook;
}

const lastSkip = () => find.mock.calls.at(-1)?.[0].query.$skip;

describe('useBoardFiles live refresh', () => {
  it('restarts from page one when an unlisted document is written by a board conversation', async () => {
    const hook = await renderOnPageTwo();
    // Not listed: it may now sort before the next offset.
    emit('kb/documents', 'patched', {
      document_id: 'doc-new',
      updated_by_session_id: 'session-here',
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(find).toHaveBeenCalledTimes(1);
    expect(lastSkip()).toBe(0);
    expect(hook.result.current.items).toHaveLength(50);
    expect(hook.result.current.nextSkip).toBe(50);
  });

  it('restarts from page one on a prompt in a board conversation (how an upload arrives)', async () => {
    await renderOnPageTwo();
    emit('tasks', 'created', { task_id: 'task-1', session_id: 'session-here' });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(find).toHaveBeenCalledTimes(1);
    expect(lastSkip()).toBe(0);
  });

  it('ignores unlisted documents and prompts from other boards', async () => {
    const hook = await renderOnPageTwo();
    emit('kb/documents', 'created', {
      document_id: 'doc-x',
      updated_by_session_id: 'session-away',
    });
    emit('kb/documents', 'patched', { document_id: 'doc-y', updated_by_session_id: null });
    emit('tasks', 'created', { task_id: 'task-2', session_id: 'session-away' });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(find).not.toHaveBeenCalled();
    expect(hook.result.current.items).toHaveLength(80);
  });

  it('stops listening when the tab is hidden', async () => {
    const hook = await renderOnPageTwo();
    hook.rerender({ active: false });
    emit('tasks', 'created', { task_id: 'task-3', session_id: 'session-here' });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(find).not.toHaveBeenCalled();
  });
});
