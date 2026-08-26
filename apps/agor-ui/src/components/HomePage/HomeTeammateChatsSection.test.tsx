import type { Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomeTeammateChatsSection } from './HomeTeammateChatsSection';

const teammate = {
  branch_id: 'branch-1',
  name: 'operator',
  archived: false,
  custom_context: {
    teammate: { kind: 'teammate', displayName: 'Operator', emoji: '🧭' },
  },
} as unknown as Branch;

const session = {
  session_id: 'session-1',
  branch_id: teammate.branch_id,
  title: 'Daily planning',
  status: 'idle',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T12:00:00.000Z',
} as unknown as Session;

const regularBranch = {
  branch_id: 'branch-2',
  name: 'release-worktree',
  archived: false,
} as unknown as Branch;

const regularSession = {
  ...session,
  session_id: 'session-2',
  branch_id: regularBranch.branch_id,
  title: 'Release planning',
} as unknown as Session;

const user = {
  user_id: 'user-1',
  preferences: {
    chat_collections: {
      collections: [
        {
          collection_id: 'daily',
          name: 'Daily crew',
          session_ids: [session.session_id, regularSession.session_id],
        },
      ],
    },
  },
} as unknown as User;

describe('HomeTeammateChatsSection', () => {
  beforeEach(() => {
    localStorage.clear();
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([[user.user_id, user]]),
      branchById: new Map([
        [teammate.branch_id, teammate],
        [regularBranch.branch_id, regularBranch],
      ]),
      sessionById: new Map([
        [session.session_id, session],
        [regularSession.session_id, regularSession],
      ]),
    });
  });

  it('resolves the latest title from the canonical session id after a rename', () => {
    render(
      <HomeTeammateChatsSection
        currentUserId={user.user_id}
        onSessionClick={vi.fn()}
        onManageTeammateChats={vi.fn()}
      />
    );

    act(() => {
      agorStore.setState((state) => ({
        sessionById: new Map(state.sessionById).set(session.session_id, {
          ...session,
          title: 'Renamed daily planning',
        }),
      }));
    });

    expect(screen.getByText('Renamed daily planning')).toBeInTheDocument();
    expect(screen.queryByText('Daily planning')).not.toBeInTheDocument();
  });

  it('opens saved teammate and regular worktree sessions', () => {
    const onSessionClick = vi.fn();
    render(
      <HomeTeammateChatsSection
        currentUserId={user.user_id}
        onSessionClick={onSessionClick}
        onManageTeammateChats={vi.fn()}
      />
    );

    const row = screen.getByText('Daily planning').closest('button');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(onSessionClick).toHaveBeenCalledWith(session.session_id);
    expect(screen.getByText('Release planning')).toBeInTheDocument();
  });
});
