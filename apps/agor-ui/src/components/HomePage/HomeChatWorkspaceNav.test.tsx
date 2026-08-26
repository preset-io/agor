import type { Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomeChatWorkspaceNav } from './HomeChatWorkspaceNav';

const branch = {
  branch_id: 'branch-1',
  name: 'support-worktree',
  archived: false,
} as unknown as Branch;

const session = {
  session_id: 'session-1',
  branch_id: branch.branch_id,
  title: 'Support triage',
  status: 'running',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T12:00:00.000Z',
} as unknown as Session;

const alternateSession = {
  ...session,
  session_id: 'session-2',
  title: 'Release planning',
  status: 'idle',
} as unknown as Session;

const availableSession = {
  ...session,
  session_id: 'session-3',
  title: 'Unpinned incident review',
  status: 'idle',
  last_updated: '2026-08-25T13:00:00.000Z',
} as unknown as Session;

const user = {
  user_id: 'user-1',
  preferences: {
    chat_collections: {
      collections: [
        {
          collection_id: 'support',
          name: 'Support crew',
          session_ids: [session.session_id, alternateSession.session_id],
        },
      ],
    },
  },
} as unknown as User;

describe('HomeChatWorkspaceNav', () => {
  beforeEach(() => {
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([[user.user_id, user]]),
      branchById: new Map([[branch.branch_id, branch]]),
      sessionById: new Map([
        [session.session_id, session],
        [alternateSession.session_id, alternateSession],
        [availableSession.session_id, availableSession],
      ]),
    });
  });

  it('shows grouped sessions and switches the canonical conversation', () => {
    const onSessionClick = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={onSessionClick}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
      />
    );

    expect(screen.getByText('Support crew')).toBeInTheDocument();
    expect(screen.getByText('Support triage').closest('button')).toHaveAttribute(
      'aria-current',
      'page'
    );

    fireEvent.click(screen.getByText('Release planning'));

    expect(onSessionClick).toHaveBeenCalledWith(alternateSession.session_id);

    const collectionNode = screen.getByText('Support crew').closest('button');
    expect(collectionNode).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collectionNode!);
    expect(collectionNode).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the active chat back on its board', () => {
    const onShowOnBoard = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={onShowOnBoard}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show active session on board' }));
    expect(onShowOnBoard).toHaveBeenCalledWith(session.session_id);
  });

  it('shows recent unpinned sessions under a worktree and opens add/remove management', () => {
    const onManage = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={onManage}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
      />
    );

    expect(screen.getByText('Unpinned incident review')).toBeVisible();
    expect(screen.getByText('2/3')).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: 'Add Unpinned incident review to collection' })
    );
    expect(onManage).toHaveBeenCalledWith(availableSession.session_id);

    fireEvent.click(screen.getByRole('button', { name: 'Manage Support triage in collection' }));
    expect(onManage).toHaveBeenCalledWith(session.session_id);
  });
});
