import type { Board, Branch, Session } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { agorStore } from '../../store/agorStore';
import { MobileApp } from './MobileApp';

// Keep the real mobile shell/router/page/close callback. The heavy conversation
// renderer is a boundary stub; its close prop is already wired by SessionPage.
vi.mock('../SessionPanel', () => ({
  SessionPanel: ({ session, onClose }: { session: Session; onClose: () => void }) => {
    const navigate = useNavigate();
    return (
      <div>
        <h1>{session.session_id}</h1>
        <button type="button" onClick={onClose}>
          Close session
        </button>
        <button type="button" onClick={() => navigate('/m/session/child')}>
          Open child session
        </button>
      </div>
    );
  },
}));
vi.mock('../SessionSettingsModal', () => ({ SessionSettingsModal: () => null }));
vi.mock('./MobileHomePage', () => ({ MobileHomePage: () => <h1>Home</h1> }));
vi.mock('./MobileCommentsPage', () => ({ MobileCommentsPage: () => null }));
vi.mock('./MobileSearchPage', () => ({ MobileSearchPage: () => null }));
vi.mock('./MobileSessionsPage', () => ({ MobileSessionsPage: () => null }));
vi.mock('./MobileMarketplacePage', () => ({ MobileMarketplacePage: () => null }));
vi.mock('./MobileMoreSheet', () => ({ MobileMoreSheet: () => null }));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../SettingsModal/PrimaryTeammatePicker', () => ({ PrimaryTeammatePicker: () => null }));
vi.mock('../MarkdownRenderer/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('../AgentSelectionGrid', () => ({ AgentSelectionGrid: () => null, AVAILABLE_AGENTS: [] }));

const originalUrl = window.location.href;
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', originalUrl);
  agorStore.getState().reset();
});
const boards = new Map([
  ['a', { board_id: 'a', name: 'Alpha', slug: 'alpha', primary_teammate_id: 'assistant' } as Board],
  ['b', { board_id: 'b', name: 'Beta', slug: 'beta' } as Board],
]);
const branches = new Map([
  ['assistant', { branch_id: 'assistant', board_id: 'a', name: 'Ada' } as Branch],
  ['other', { branch_id: 'other', board_id: 'b' } as Branch],
]);
function mount(path = '/m/board/alpha') {
  agorStore.setState({
    boardById: boards,
    branchById: branches,
    sessionById: new Map([
      ['parent', { session_id: 'parent', title: 'Parent', branch_id: 'assistant' } as Session],
      [
        'child',
        { session_id: 'child', branch_id: 'other', parent_session_id: 'parent' } as Session,
      ],
    ]),
    sessionsByBranch: new Map([
      ['assistant', [{ session_id: 'parent', title: 'Parent', status: 'idle' } as Session]],
    ]),
    loading: false,
  });
  window.history.replaceState(null, '', path);
  render(
    <BrowserRouter>
      <Routes>
        <Route
          path="/m/*"
          element={
            <MobileApp
              client={null}
              authGeneration={0}
              onCreateSession={vi.fn(async () => null)}
              onForkSession={vi.fn(async () => {})}
              onBtwForkSession={vi.fn(async () => {})}
              onSpawnSession={vi.fn(async () => {})}
              onUpdateSession={vi.fn()}
              onDeleteSession={vi.fn()}
              onSendComment={vi.fn()}
              onOpenWorkspaceSettings={vi.fn()}
              onOpenUserSettings={vi.fn()}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

it('uses real browser history for session switches, Back/Forward, X and board switches', async () => {
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Open Parent' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Open child session' }));
  expect(window.location.pathname).toBe('/m/session/child');
  await act(async () => window.history.back());
  await screen.findByRole('heading', { name: 'parent' });
  await act(async () => window.history.forward());
  await screen.findByRole('heading', { name: 'child' });
  await userEvent.click(screen.getByRole('button', { name: 'Close session' }));
  expect(window.location.pathname).toBe('/m/board/b');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Close session' })).not.toBeInTheDocument()
  );
  await userEvent.click(await screen.findByRole('button', { name: /Switch board/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Switch to Alpha' }));
  expect(window.location.pathname).toBe('/m/board/a');
  await userEvent.click(screen.getByRole('button', { name: 'Home', exact: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Board', exact: true }));
  expect(window.location.pathname).toBe('/m/board/a');
});

it('remembers the canonical slug board rather than defaulting to another board', async () => {
  mount('/m/board/beta');
  await userEvent.click(screen.getByRole('button', { name: 'Home', exact: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Board', exact: true }));
  expect(window.location.pathname).toBe('/m/board/b');
});

it('uses home when a direct session loses board access, without reopening on late data', async () => {
  mount('/m/session/child');
  await act(async () => agorStore.setState({ boardById: new Map([['a', boards.get('a')!]]) }));
  await userEvent.click(screen.getByRole('button', { name: 'Close session' }));
  expect(window.location.pathname).toBe('/m');
  await act(async () => agorStore.setState({ boardById: boards }));
  await waitFor(() => expect(window.location.pathname).toBe('/m'));
});

it('tracks a live branch move rather than a stale session board projection', async () => {
  mount('/m/session/child');
  await act(async () =>
    agorStore.setState({
      branchById: new Map([
        ...branches,
        ['other', { ...branches.get('other'), board_id: 'a' } as Branch],
      ]),
      sessionById: new Map([
        ['child', { session_id: 'child', branch_id: 'other', branch_board_id: 'b' } as Session],
      ]),
    })
  );
  await userEvent.click(screen.getByRole('button', { name: 'Close session' }));
  expect(window.location.pathname).toBe('/m/board/a');
});

it('lets the user exit when an open session is removed or becomes inaccessible', async () => {
  mount('/m/session/child');
  await act(async () => agorStore.setState({ sessionById: new Map() }));
  expect(await screen.findByText('Session not loaded')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Back to home' }));
  expect(window.location.pathname).toBe('/m');
});

it('keeps uncached session wording neutral after bootstrap and renders a late targeted result', async () => {
  mount('/m/session/archived');
  expect(screen.getByText('Session not loaded')).toBeInTheDocument();
  expect(
    screen.getByText('It may still be loading or may no longer be available.')
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Back to home' })).toBeInTheDocument();
  await act(async () =>
    agorStore.setState({
      sessionById: new Map([
        ['archived', { session_id: 'archived', branch_id: 'other', archived: true } as Session],
      ]),
    })
  );
  expect(await screen.findByRole('heading', { name: 'archived' })).toBeInTheDocument();
  expect(screen.queryByText('Session not loaded')).not.toBeInTheDocument();
  expect(window.location.pathname).toBe('/m/session/archived');
  await userEvent.click(screen.getByRole('button', { name: 'Close session' }));
  expect(window.location.pathname).toBe('/m/board/b');
});
