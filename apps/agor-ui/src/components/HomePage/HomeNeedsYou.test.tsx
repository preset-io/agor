/**
 * A comment row for you names its session's branch with the store's session
 * and branch maps empty (Step 3): Needs you reads the shown comment rows'
 * target sessions, and their branches, by id.
 */
import type { BoardComment, Branch, Session } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { HomeCommentNeed } from '../../store/selectors';
import { fakeFeathersClient, withTestAuthority } from '../../test/harness';
import { HomeNeedsYou } from './HomeNeedsYou';

const comment = {
  comment_id: 'c1',
  board_id: 'board-1',
  session_id: 's1',
  created_by: 'user-2',
  content: 'Look at this',
  created_at: new Date(0).toISOString(),
} as BoardComment;
const need: HomeCommentNeed = {
  key: 'comment:c1',
  reason: 'comment',
  at: 0,
  boardId: 'board-1',
  thread: comment,
  comment,
  threadSize: 1,
};

withTestAuthority();

it("reads a shown comment's session and its branch for the row's branch chip", async () => {
  const { client } = fakeFeathersClient({
    sessions: { find: () => [{ session_id: 's1', branch_id: 'b1', archived: false } as Session] },
    branches: { find: () => [{ branch_id: 'b1', name: 'feature-b1', archived: false } as Branch] },
  });
  render(
    <HomeNeedsYou
      client={client}
      needs={[need]}
      needsCount={1}
      needsByReason={{ permission: 0, failed: 0, finished: 0 }}
      commentCount={1}
      filter="all"
      onFilterChange={vi.fn()}
      expanded={false}
      onExpandedChange={vi.fn()}
      hydrated
      onOpenSession={vi.fn()}
      onOpenFailure={vi.fn()}
      onOpenComment={vi.fn()}
      onMarkRead={vi.fn()}
    />
  );
  expect(await screen.findByText('feature-b1')).toBeInTheDocument();
  expect(client.service('sessions').find).toHaveBeenCalledTimes(1);
  expect(client.service('branches').find).toHaveBeenCalledTimes(1);
});
