import type { Board, Branch, Session } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { SessionPage } from './SessionPage';

vi.mock('../SessionPanel', () => ({
  SessionPanel: ({ session, onClose }: { session: Session; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close {session.session_id}
    </button>
  ),
}));
vi.mock('../SessionSettingsModal', () => ({ SessionSettingsModal: () => null }));

const boards = new Map([
  ['a', { board_id: 'a', name: 'A' } as Board],
  ['b', { board_id: 'b', name: 'B' } as Board],
]);
const branches = new Map([
  ['branch-a', { branch_id: 'branch-a', board_id: 'a' } as Branch],
  ['branch-b', { branch_id: 'branch-b', board_id: 'b' } as Branch],
]);
const sessions = new Map([
  ['parent', { session_id: 'parent', branch_id: 'branch-a' } as Session],
  ['child', { session_id: 'child', branch_id: 'branch-b', parent_session_id: 'parent' } as Session],
]);

function setup(
  entries: string[],
  overrides: Partial<React.ComponentProps<typeof SessionPage>> = {}
) {
  const props = {
    client: null,
    sessionById: sessions,
    branchById: branches,
    boardById: boards,
    onForkSession: vi.fn(async () => {}),
    onBtwForkSession: vi.fn(async () => {}),
    onSpawnSession: vi.fn(async () => {}),
    onUpdateSession: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter(
    [
      { path: '/m/session/:sessionId', element: <SessionPage {...props} /> },
      { path: '/m/board/:boardId', element: <div>Board</div> },
      { path: '/m', element: <div>Home</div> },
    ],
    { initialEntries: entries }
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('mobile session exit versus history', () => {
  it('closes a nested session to its own board, not its parent or previously viewed board', async () => {
    const router = setup(['/m/board/a', '/m/session/parent', '/m/session/child']);
    fireEvent.click(screen.getByRole('button', { name: 'Close child' }));
    expect(router.state.location.pathname).toBe('/m/board/b');
    expect(router.state.historyAction).toBe('REPLACE');
    // Browser Back remains intentional history navigation; it is NOT X.
    await act(() => router.navigate(-1));
    expect(screen.getByRole('button', { name: 'Close parent' })).toBeInTheDocument();
    await act(() => router.navigate(1));
    expect(router.state.location.pathname).toBe('/m/board/b');
  });

  it('closes an initial direct short URL using the joined board before branch hydration', () => {
    const id = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
    const router = setup(['/m/session/01a012d84f507c329daa6e3f'], {
      branchById: new Map(),
      sessionById: new Map([[id, { session_id: id, branch_board_id: 'b' } as Session]]),
    });
    fireEvent.click(screen.getByRole('button', { name: `Close ${id}` }));
    expect(router.state.location.pathname).toBe('/m/board/b');
  });

  it.each([undefined, null, 'removed'])(
    'uses home when the current board is %s, not a stale joined board',
    (boardId) => {
      const router = setup(['/m/board/a', '/m/session/child'], {
        branchById: new Map([['branch-b', { branch_id: 'branch-b', board_id: boardId } as Branch]]),
        sessionById: new Map([
          ['child', { ...sessions.get('child'), branch_board_id: 'a' } as Session],
        ]),
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close child' }));
      expect(router.state.location.pathname).toBe('/m');
    }
  );

  it('does not use an inaccessible board, even when its ID is known', () => {
    const router = setup(['/m/session/child'], { boardById: new Map() });
    fireEvent.click(screen.getByRole('button', { name: 'Close child' }));
    expect(router.state.location.pathname).toBe('/m');
  });

  it('offers an exit for a removed/inaccessible session instead of spinning forever', () => {
    agorStore.getState().setLoading(false);
    const router = setup(['/m/session/missing']);
    expect(screen.getByText('Session not loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(router.state.location.pathname).toBe('/m');
  });

  it('late session data cannot reopen a session after the user exits loading', async () => {
    agorStore.getState().setLoading(true);
    const delayed = new Map<string, Session>();
    const router = setup(['/m/session/child'], { sessionById: delayed });
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    await act(async () => {
      delayed.set('child', sessions.get('child')!);
      agorStore.getState().setLoading(false);
    });
    expect(router.state.location.pathname).toBe('/m');
  });
});
