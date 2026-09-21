import type { Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
