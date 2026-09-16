import type { Board, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileHomePage } from './MobileHomePage';

function renderHome(props: Partial<React.ComponentProps<typeof MobileHomePage>> = {}) {
  return render(
    <MemoryRouter initialEntries={['/m']}>
      <Routes>
        <Route
          path="/m"
          element={
            <MobileHomePage
              sessionById={props.sessionById ?? new Map()}
              branchById={new Map()}
              boardById={props.boardById ?? new Map()}
              currentUser={{ user_id: 'u1', name: 'Ada Lovelace' } as never}
              onAsk={props.onAsk ?? vi.fn()}
              primaryTeammateName={props.primaryTeammateName}
              assistantSessionCount={props.assistantSessionCount}
              onOpenAssistantSessions={props.onOpenAssistantSessions}
            />
          }
        />
        <Route path="/m/sessions" element={<div>all sessions</div>} />
        <Route path="/m/board/:id" element={<div>board view</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('MobileHomePage', () => {
  it('greets the user and triggers Ask primary', () => {
    const onAsk = vi.fn();
    renderHome({ onAsk, primaryTeammateName: 'Fable' });
    expect(screen.getByText('Welcome back, Ada')).toBeInTheDocument();
    expect(screen.getByText('Ask Fable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onAsk).toHaveBeenCalled();
  });

  it('lists recent sessions with an All sessions link, and navigates to boards', () => {
    const sessionById = new Map<string, Session>([
      [
        's1',
        { session_id: 's1', title: 'Recent work', status: 'idle', created_by: 'u1' } as Session,
      ],
    ]);
    const boardById = new Map<string, Board>([
      ['b1', { board_id: 'b1', name: 'Delivery' } as Board],
    ]);
    renderHome({ sessionById, boardById });

    expect(screen.getByText('Recent work')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delivery'));
    expect(screen.getByText('board view')).toBeInTheDocument();
  });

  it('opens the assistant session list from the hero body while Ask stays compose', () => {
    const onAsk = vi.fn();
    const onOpenAssistantSessions = vi.fn();
    renderHome({
      onAsk,
      primaryTeammateName: 'Fable',
      assistantSessionCount: 3,
      onOpenAssistantSessions,
    });

    // Count is surfaced on the hero.
    expect(screen.getByText(/3 sessions/)).toBeInTheDocument();

    // The body region opens the assistant's sessions, not compose.
    fireEvent.click(screen.getByRole('button', { name: "View Fable's sessions" }));
    expect(onOpenAssistantSessions).toHaveBeenCalled();
    expect(onAsk).not.toHaveBeenCalled();

    // The Ask button still composes.
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onAsk).toHaveBeenCalled();
  });
});
