import type { AgorClient, Link, LinkMoveResult } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { getLinkMoveActions, moveLinkDisplayItem } from './linkMove';
import { LINK_MOVE_DESTINATION } from './linkUiConstants';
import { makeTestLink } from './testUtils';

const context = {
  branchId: 'branch-1',
  sessionId: 'session-1',
  teammateBranchId: 'teammate-1',
  available: true,
};

function item(owner: 'session' | 'branch' | 'teammate') {
  const link = makeTestLink({
    branch_id: owner === 'session' ? null : owner === 'branch' ? 'branch-1' : 'teammate-1',
    session_id: owner === 'session' ? 'session-1' : null,
  });
  return {
    key: `link:${link.link_id}`,
    linkId: link.link_id,
    name: 'Runbook',
    targetKey: link.target_key,
    category: 'url' as const,
    kind: link.kind,
    source: link.source,
    ownerScope: owner === 'session' ? ('session' as const) : ('branch' as const),
    ownerBranchId: link.branch_id ?? undefined,
    sessionId: link.session_id ?? undefined,
    isPinned: link.is_pinned,
    url: link.url ?? undefined,
  };
}

describe('link moves', () => {
  it.each([
    ['session', ['Move to branch', 'Move to teammate']],
    ['branch', ['Move to this session', 'Move to teammate']],
    ['teammate', ['Move to this session', 'Move to branch']],
  ] as const)('omits the current %s owner and offers the other destinations', (owner, labels) => {
    expect(getLinkMoveActions(item(owner), context).map((action) => action.label)).toEqual(labels);
  });

  it('keeps genuine transfer-policy failures visible without showing a current-owner row', () => {
    const upload = {
      ...item('session'),
      source: 'upload' as const,
      filePath: 'report.pdf',
      url: undefined,
    };

    const actions = getLinkMoveActions(upload, context);

    expect(actions.map((action) => action.destination)).toEqual([
      LINK_MOVE_DESTINATION.branch,
      LINK_MOVE_DESTINATION.teammate,
    ]);
    expect(actions.every((action) => action.disabled)).toBe(true);
    expect(actions[0].reason).toContain('retention');
  });

  it('calls the owner-move route with the concrete destination', async () => {
    const source = makeTestLink({ session_id: 'session-1', branch_id: null });
    const moved = {
      ...source,
      session_id: null,
      branch_id: 'branch-1',
      revision: (source.revision ?? 1) + 1,
    } as Link;
    const result = { link: moved, previous_link: source, merged: false } satisfies LinkMoveResult;
    const create = vi.fn(async () => result);
    const service = vi.fn(() => ({ create }));
    const client = { service } as unknown as AgorClient;

    await moveLinkDisplayItem({
      client,
      item: item('session'),
      selection: { destination: LINK_MOVE_DESTINATION.branch, ownerId: 'branch-1' },
      branchId: 'branch-1',
      sessionId: 'session-1',
    });

    expect(service).toHaveBeenCalledWith('links/link-1/move');
    expect(create).toHaveBeenCalledWith({ target: 'branch', branch_id: 'branch-1' });
  });
});
