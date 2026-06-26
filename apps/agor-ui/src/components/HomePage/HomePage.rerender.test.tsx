import type { Board } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomePage } from './HomePage';

// HomePage renders its sections unconditionally. HomeBoardsSection is mocked to a
// bare render counter so its invocation count is a faithful proxy for how many
// times HomePage itself rendered.
let homeRenders = 0;

vi.mock('./HomeBoardsSection', () => ({
  HomeBoardsSection: () => {
    homeRenders += 1;
    return null;
  },
}));
vi.mock('./HomeSessionsSection', () => ({
  HomeSessionsSection: () => null,
}));
vi.mock('./HomeActivitySection', () => ({
  HomeActivitySection: () => null,
}));
vi.mock('./HomeKnowledgeSection', () => ({
  HomeKnowledgeSection: () => null,
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as unknown as Board;

function renderHome() {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <HomePage
        client={null}
        onBoardClick={() => {}}
        onBranchClick={() => {}}
        onSessionClick={() => {}}
      />
    </MemoryRouter>
  );
}

describe('HomePage store-selector re-render isolation', () => {
  beforeEach(() => {
    homeRenders = 0;
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('a patch to a slice HomePage does not select leaves it un-rendered', async () => {
    renderHome();

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // Patch a slice HomePage never selects (comments). zustand notifies every
    // subscriber, but each of HomePage's selected slices keeps its reference, so
    // its subscriptions stay quiet and it does not re-render.
    act(() => {
      agorStore.setState({ commentById: new Map([['c-1', { board_id: 'board-1' } as never]]) });
    });

    expect(homeRenders).toBe(baseline);
  });

  it('a patch to a selected slice (boards) re-renders HomePage', async () => {
    renderHome();

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = homeRenders;

    // Contrast: HomePage subscribes to boardById (it derives the boards section
    // from it), so a boards patch MUST wake it — proving the subscription is
    // live and the isolation above is meaningful.
    act(() => {
      agorStore.setState({ boardById: new Map([[board.board_id, board]]) });
    });

    await waitFor(() => {
      expect(homeRenders).toBeGreaterThan(baseline);
    });
  });
});
