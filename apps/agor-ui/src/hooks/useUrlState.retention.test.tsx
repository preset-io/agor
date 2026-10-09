/**
 * The store's session and branch Maps are replaced on every partition load
 * and eviction. A memoized callback that survives renders keeps the closure
 * context of the render that created it; if that context also holds the Maps
 * (a sibling closure captured them), each surviving callback retains an old
 * Map, and chains of them grow the heap for the life of the tab.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { CanvasNavigationProvider } from '../contexts/CanvasNavigationContext';
import { type UseUrlStateOptions, useUrlState } from './useUrlState';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const BOARD_ID = '019e7777-0000-7000-8000-000000000001';

function HookHost({ options }: { options: UseUrlStateOptions }) {
  useUrlState(options);
  return null;
}

it('does not retain replaced session and branch maps', async () => {
  const onBoardChange = vi.fn();
  const onSessionChange = vi.fn();
  const boards = () => new Map([[BOARD_ID, { board_id: BOARD_ID, slug: 'board' }]]);
  let boardById = boards();
  const tree = (options: UseUrlStateOptions) => (
    <MemoryRouter initialEntries={['/b/board/']}>
      <CanvasNavigationProvider>
        <Routes>
          <Route path="/b/:boardParam/" element={<HookHost options={options} />} />
        </Routes>
      </CanvasNavigationProvider>
    </MemoryRouter>
  );
  // A new Map per replacement, with a payload worth retaining.
  const sessions = (round: number) =>
    new Map(
      Array.from({ length: 50 }, (_, i) => [
        `s-${round}-${i}`,
        { session_id: `s-${round}-${i}`, branch_board_id: BOARD_ID },
      ])
    );
  const branches = (round: number) =>
    new Map([[`b-${round}`, { branch_id: `b-${round}`, board_id: BOARD_ID }]]);
  // As in the app, the Maps are replaced on different renders (a partition
  // load replaces sessions on one, branches or the board record on another),
  // so memoized callbacks are recreated at different cadences.
  let sessionById = sessions(0);
  let branchById = branches(0);
  const options = (): UseUrlStateOptions => ({
    currentBoardId: BOARD_ID,
    currentSessionId: null,
    boardById,
    sessionById,
    branchById,
    artifactById: new Map(),
    onBoardChange,
    onSessionChange,
  });

  const { rerender, unmount } = render(tree(options()));
  const sessionMaps = [new WeakRef(sessionById)];
  const branchMaps = [new WeakRef(branchById)];
  for (let round = 1; round <= 60; round++) {
    if (round % 2 === 1) {
      sessionById = sessions(round);
      sessionMaps.push(new WeakRef(sessionById));
    } else {
      branchById = branches(round);
      branchMaps.push(new WeakRef(branchById));
    }
    if (round % 3 === 0) boardById = boards();
    rerender(tree(options()));
  }
  // Let WeakRef targets from this turn become collectable, then collect.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  const alive = (refs: WeakRef<object>[]) => refs.filter((ref) => ref.deref()).length;
  // The mounted render (and React's alternate fiber) may hold the latest few;
  // the count must not grow with the 30 replacements of each.
  expect(alive(sessionMaps)).toBeLessThanOrEqual(5);
  expect(alive(branchMaps)).toBeLessThanOrEqual(5);
  unmount();
});
