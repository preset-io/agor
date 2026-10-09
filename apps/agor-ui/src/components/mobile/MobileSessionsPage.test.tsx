import type { AgorClient, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { getDisplayedBoardId } from '../../store/boardPartitions';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { selectSessionsByBranch } from '../../store/selectors';
import { userScopeCoverage } from '../../test/userScopeCoverage';
import { MobileSessionsPage } from './MobileSessionsPage';

const ownSession = {
  session_id: 'own1',
  title: 'My own task',
  status: 'idle',
  created_by: 'u1',
  branch_id: 'mine',
} as Session;

const assistantSession = {
  session_id: 'as1',
  title: 'Assistant task',
  status: 'idle',
  created_by: 'assistant-owner',
  branch_id: 'pb',
} as Session;

const primaryBranch = { branch_id: 'pb', name: 'Fable', repo_id: 'r1' } as Branch;

function renderPage(initialPath = '/m/sessions', withAssistant = true) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/m/sessions"
          element={
            <MobileSessionsPage
              sessionById={new Map([[ownSession.session_id, ownSession]])}
              branchById={new Map<string, Branch>()}
              userById={new Map<string, User>()}
              sessionsByBranch={new Map([['pb', [assistantSession]]])}
              currentUser={{ user_id: 'u1' } as User}
              client={null}
              primaryBranch={withAssistant ? primaryBranch : null}
              primaryTeammateName={withAssistant ? 'Fable' : undefined}
              onForkSession={vi.fn(async () => {})}
              onSpawnSession={vi.fn(async () => {})}
              onCreateSessionOnBranch={vi.fn()}
            />
          }
        />
        <Route path="/m/session/:id" element={<div>session view</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('MobileSessionsPage scope', () => {
  it('defaults to the caller (Yours) sessions', () => {
    renderPage();
    expect(screen.getByText('My own task')).toBeInTheDocument();
    expect(screen.queryByText('Assistant task')).not.toBeInTheDocument();
  });

  it('switches to the assistant scope and reveals the assistant sessions', () => {
    renderPage();
    fireEvent.click(screen.getByText('Fable'));
    expect(screen.getByText('Assistant task')).toBeInTheDocument();
    expect(screen.queryByText('My own task')).not.toBeInTheDocument();
  });

  it('honors the scope=assistant deep link from the Home hero', () => {
    renderPage('/m/sessions?scope=assistant');
    expect(screen.getByText('Assistant task')).toBeInTheDocument();
  });

  it('hides the scope control when there is no primary assistant', () => {
    renderPage('/m/sessions', false);
    expect(screen.getByText('My own task')).toBeInTheDocument();
    expect(screen.queryByText('Fable')).not.toBeInTheDocument();
  });
});

describe('MobileSessionsPage assistant scope with the store empty (Step 3)', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    discardRealtimeNow();
    setRealtimeAuthorityScope('u1:member:1');
    agorStore.getState().setLoading(false);
    agorStore
      .getState()
      .setMap('boardById', new Map([['board-1', { board_id: 'board-1', name: 'B' } as never]]));
  });
  afterEach(() => {
    setRealtimeAuthorityScope(null);
    agorStore.getState().reset();
  });

  it("loads the assistant's board in the background and lists its sessions", async () => {
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: (name: string) => ({
        findAll: vi.fn(async () => (name === 'sessions' ? [assistantSession] : [])),
        get: vi.fn(async () => ({ board_id: 'board-1', name: 'B', objects: {} })),
      }),
    } as unknown as AgorClient;
    function Page() {
      const sessionsByBranch = useAgorStore(selectSessionsByBranch);
      return (
        <MobileSessionsPage
          sessionById={new Map()}
          branchById={new Map()}
          userById={new Map()}
          sessionsByBranch={sessionsByBranch}
          currentUser={{ user_id: 'u1', role: 'member' } as User}
          client={client}
          primaryBranch={{ ...primaryBranch, board_id: 'board-1' } as Branch}
          primaryTeammateName="Fable"
          onForkSession={vi.fn(async () => {})}
          onSpawnSession={vi.fn(async () => {})}
          onCreateSessionOnBranch={vi.fn()}
        />
      );
    }
    render(
      <MemoryRouter initialEntries={['/m/sessions?scope=assistant']}>
        <Routes>
          <Route path="/m/sessions" element={<Page />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('Assistant task')).toBeInTheDocument();
    expect(getDisplayedBoardId()).toBeUndefined();
  });
});

describe('MobileSessionsPage Yours empty state', () => {
  afterEach(() => agorStore.getState().reset());

  it("waits for the caller's sessions to load before claiming there are none", () => {
    agorStore.getState().reset();
    render(
      <MemoryRouter initialEntries={['/m/sessions']}>
        <MobileSessionsPage
          sessionById={new Map()}
          branchById={new Map()}
          userById={new Map()}
          sessionsByBranch={new Map()}
          currentUser={{ user_id: 'u1' } as User}
          client={null}
          onForkSession={vi.fn(async () => {})}
          onSpawnSession={vi.fn(async () => {})}
          onCreateSessionOnBranch={vi.fn()}
        />
      </MemoryRouter>
    );
    // An empty map is not "none" until the user scope's sessions have loaded.
    expect(screen.queryByText(/No sessions yet/)).not.toBeInTheDocument();
    act(() => agorStore.setState({ coverage: userScopeCoverage({ sessions: true }) }));
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument();
  });
});
