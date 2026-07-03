import type { Board, Branch, Session } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { HomeBoardsSection } from './HomeBoardsSection';
import { HomeSessionsSection } from './HomeSessionsSection';

// Both leaf components (HomeSessionRow / BoardHomeCard) are memo'd module
// internals, so their render counts are observed through utils each calls
// exactly once per render body: getSessionDisplayTitle(session) for a session
// row, formatRelativeTime(latestSessionAt) for a board card. Wrapping the real
// implementations keeps rendering behavior identical while exposing call
// counts keyed by argument identity.
vi.mock('../../utils/sessionTitle', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../utils/sessionTitle')>();
  return { ...mod, getSessionDisplayTitle: vi.fn(mod.getSessionDisplayTitle) };
});
vi.mock('../../utils/time', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../utils/time')>();
  return { ...mod, formatRelativeTime: vi.fn(mod.formatRelativeTime) };
});

const noop = () => {};

const makeSession = (id: string, lastUpdated: string, extra?: object) =>
  ({
    session_id: id,
    title: `Session ${id}`,
    status: 'completed',
    archived: false,
    genealogy: {},
    agentic_tool: 'claude',
    last_updated: lastUpdated,
    ...extra,
  }) as unknown as Session;

const titleRendersFor = (session: Session) =>
  vi.mocked(getSessionDisplayTitle).mock.calls.filter(([arg]) => arg === session).length;

const timeRendersWith = (timestamp: string) =>
  vi.mocked(formatRelativeTime).mock.calls.filter(([arg]) => arg === timestamp).length;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  agorStore.setState({ ...EMPTY_MAPS });
});

describe('HomeSessionsSection row re-render isolation', () => {
  it('patching one session leaves the other rows un-rendered', async () => {
    const s1 = makeSession('s-1', '2026-07-01T10:00:00.000Z');
    const s2 = makeSession('s-2', '2026-07-01T09:00:00.000Z');
    agorStore.setState({
      sessionById: new Map([
        [s1.session_id, s1],
        [s2.session_id, s2],
      ]),
    });

    render(<HomeSessionsSection onSessionClick={noop} />);

    await waitFor(() => {
      expect(titleRendersFor(s2)).toBeGreaterThanOrEqual(1);
    });
    const s2Baseline = titleRendersFor(s2);

    // Streaming-style patch to s1: new object identity, s2 untouched. The
    // section re-renders (it displays session data), but only s1's row may
    // re-render — s2's row keeps every prop reference and bails out.
    const s1Patched = { ...s1, status: 'running' } as Session;
    act(() => {
      agorStore.setState({
        sessionById: new Map([
          [s1.session_id, s1Patched],
          [s2.session_id, s2],
        ]),
      });
    });

    await waitFor(() => {
      expect(titleRendersFor(s1Patched)).toBeGreaterThanOrEqual(1);
    });
    expect(titleRendersFor(s2)).toBe(s2Baseline);
  });
});

describe('HomeBoardsSection card re-render isolation', () => {
  it('a session patch on one board leaves the other boards’ cards un-rendered', async () => {
    const timeA = '2026-07-01T10:00:00.000Z';
    const timeAPatched = '2026-07-01T10:05:00.000Z';
    const timeB = '2026-06-30T08:00:00.000Z';

    const boardA = {
      board_id: 'b-A',
      name: 'Alpha',
      archived: false,
      last_updated: '2026-06-01T00:00:00.000Z',
    } as unknown as Board;
    const boardB = {
      board_id: 'b-B',
      name: 'Beta',
      archived: false,
      last_updated: '2026-06-01T00:00:00.000Z',
    } as unknown as Board;
    const branchA = {
      branch_id: 'br-A',
      board_id: 'b-A',
      archived: false,
      name: 'br-a',
      created_at: '2026-06-01T00:00:00.000Z',
    } as unknown as Branch;
    const branchB = {
      branch_id: 'br-B',
      board_id: 'b-B',
      archived: false,
      name: 'br-b',
      created_at: '2026-06-01T00:00:00.000Z',
    } as unknown as Branch;
    const sessionA = makeSession('s-A', timeA, { branch_id: 'br-A' });
    const sessionB = makeSession('s-B', timeB, { branch_id: 'br-B' });
    // Shared across both setState calls: the store's realtime writer preserves
    // untouched branch buckets by reference, and this test mirrors that.
    const branchBSessions = [sessionB];

    agorStore.setState({
      boardById: new Map([
        [boardA.board_id, boardA],
        [boardB.board_id, boardB],
      ]),
      branchById: new Map([
        [branchA.branch_id, branchA],
        [branchB.branch_id, branchB],
      ]),
      sessionsByBranch: new Map([
        ['br-A', [sessionA]],
        ['br-B', branchBSessions],
      ]),
    });

    render(<HomeBoardsSection onBoardClick={noop} onOpenCreateDialog={noop} />);

    await waitFor(() => {
      expect(timeRendersWith(timeB)).toBeGreaterThanOrEqual(1);
    });
    const boardBBaseline = timeRendersWith(timeB);

    // Patch board A's streaming session. Board B's derived card props are all
    // unchanged (same board object, same session bucket), so its card bails.
    act(() => {
      agorStore.setState({
        sessionsByBranch: new Map([
          ['br-A', [{ ...sessionA, last_updated: timeAPatched } as Session]],
          ['br-B', branchBSessions],
        ]),
      });
    });

    await waitFor(() => {
      expect(timeRendersWith(timeAPatched)).toBeGreaterThanOrEqual(1);
    });
    expect(timeRendersWith(timeB)).toBe(boardBBaseline);
  });
});
