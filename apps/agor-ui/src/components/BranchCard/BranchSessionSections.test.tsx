import type { Branch, Session, User } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { BranchSessionSections } from './BranchSessionSections';

const branch = {
  branch_id: 'branch-1',
  name: 'feature/cleanup',
  filesystem_status: 'ready',
} as Branch;

const scheduledSession = {
  session_id: 'session-scheduled-1',
  branch_id: 'branch-1',
  title: 'Clean up board',
  agentic_tool: 'codex',
  status: 'idle',
  archived: false,
  scheduled_from_branch: true,
  scheduled_run_at: 1_780_527_200_000,
  created_at: '2026-06-03T00:00:00.000Z',
  last_updated: '2026-06-03T00:00:00.000Z',
} as unknown as Session;

function renderSections(props: Partial<React.ComponentProps<typeof BranchSessionSections>> = {}) {
  return render(
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <AntApp>
        <BranchSessionSections
          branch={branch}
          sessions={[scheduledSession]}
          userById={new Map<string, User>()}
          onSessionClick={vi.fn()}
          onCreateSession={vi.fn()}
          client={null}
          {...props}
        />
      </AntApp>
    </ConnectionProvider>
  );
}

describe('BranchSessionSections', () => {
  it('keeps the new-session affordance visible when only scheduled runs remain', () => {
    renderSections();

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Scheduled Runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new session/i })).toBeInTheDocument();
  });
});
