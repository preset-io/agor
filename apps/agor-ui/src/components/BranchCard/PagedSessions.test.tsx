import type { Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PagedSessions } from './PagedSessions';

it('bounds each page and recovers when realtime removals empty a later page', () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => ({
    session_id: `session-${index}`,
  })) as Session[];
  const row = (session: Session) => <div key={session.session_id}>{session.session_id}</div>;
  const { rerender } = render(<PagedSessions sessions={sessions}>{row}</PagedSessions>);
  expect(screen.getAllByText(/^session-/)).toHaveLength(20);
  fireEvent.click(screen.getByTitle('Next Page'));
  expect(screen.getByText('session-20')).toBeInTheDocument();
  expect(screen.queryByText('session-0')).not.toBeInTheDocument();

  rerender(<PagedSessions sessions={sessions.slice(0, 1)}>{row}</PagedSessions>);
  expect(screen.getByText('session-0')).toBeInTheDocument();
  expect(screen.queryByTitle('Next Page')).not.toBeInTheDocument();
  rerender(<PagedSessions sessions={sessions}>{row}</PagedSessions>);
  expect(screen.getByText('session-0')).toBeInTheDocument();
  expect(screen.queryByText('session-20')).not.toBeInTheDocument();
  rerender(<PagedSessions sessions={[]}>{row}</PagedSessions>);
  expect(screen.queryByText(/^session-/)).not.toBeInTheDocument();
});
