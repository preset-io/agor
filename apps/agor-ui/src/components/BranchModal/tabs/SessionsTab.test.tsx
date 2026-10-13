import type { Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { makeBranch, wrapper } from '../testUtils';
import { SessionsTab } from './SessionsTab';

function makeSession(overrides: Partial<Session>): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    agentic_tool: 'claude-code',
    status: 'idle',
    title: 'Fix the bug',
    archived: false,
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

it.each([
  { status: 'awaiting_permission', label: 'Waiting for approval' },
  { status: 'awaiting_input', label: 'Waiting for your reply' },
  { status: 'timed_out', label: 'Approval timed out' },
  { status: 'failed', label: 'Last run failed' },
  { status: 'stopping', label: 'Stopping' },
  { status: 'completed', label: 'Done' },
] as const)('labels a $status session "$label"', ({ status, label }) => {
  render(<SessionsTab branch={makeBranch()} sessions={[makeSession({ status })]} client={null} />, {
    wrapper,
  });
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.queryByText(status)).not.toBeInTheDocument();
});

it('labels a scheduled run that never started', () => {
  render(
    <SessionsTab
      branch={makeBranch()}
      sessions={[
        makeSession({
          status: 'failed',
          scheduler_init_failure_code: 'no_credentials',
        } as Partial<Session>),
      ]}
      client={null}
    />,
    { wrapper }
  );
  expect(screen.getByText("Scheduled run didn't start")).toBeInTheDocument();
});

it('offers status filters in sentence case', () => {
  render(<SessionsTab branch={makeBranch()} sessions={[makeSession({})]} client={null} />, {
    wrapper,
  });
  fireEvent.click(screen.getByRole('button', { name: /filter/i }));
  for (const label of [
    'Ready',
    'Idle',
    'Running',
    'Done',
    'Last run failed',
    'Waiting for approval',
    'Waiting for your reply',
    'Approval timed out',
    'Stopping',
  ]) {
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  }
});

it.each([
  { filter: 'Ready', shown: 'Ready session', hidden: 'Idle session' },
  { filter: 'Idle', shown: 'Idle session', hidden: 'Ready session' },
])('the $filter filter matches only rows labelled $filter', ({ filter, shown, hidden }) => {
  render(
    <SessionsTab
      branch={makeBranch()}
      sessions={[
        makeSession({ session_id: 'idle-1', title: 'Idle session' }),
        makeSession({ session_id: 'ready-1', title: 'Ready session', ready_for_prompt: true }),
      ]}
      client={null}
    />,
    { wrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: /filter/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: filter }));
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.getByText(shown)).toBeInTheDocument();
  expect(screen.queryByText(hidden)).not.toBeInTheDocument();
});
