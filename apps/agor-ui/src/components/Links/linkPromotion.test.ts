import { describe, expect, it } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import { getLinkPromotionActions } from './linkPromotion';
import { LINK_ACTION_KEY, LINK_ACTION_LABEL, LINK_PROMOTION_DESTINATION } from './linkUiConstants';

const BRANCH_ID = 'branch-1';
const TEAMMATE_BRANCH_ID = 'teammate-1';

function linkItem(overrides: Partial<LinkDisplayItem> = {}): LinkDisplayItem {
  return {
    key: 'link:source',
    linkId: 'source',
    name: 'Runbook',
    targetKey: 'url:https://example.com/runbook',
    category: 'url',
    kind: 'url',
    source: 'manual',
    ownerScope: 'session',
    isPinned: false,
    url: 'https://example.com/runbook',
    ...overrides,
  };
}

describe('getLinkPromotionActions', () => {
  it('offers branch and teammate destinations for a session-owned link', () => {
    expect(
      getLinkPromotionActions(linkItem(), {
        branchId: BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
      })
    ).toEqual([
      {
        destination: LINK_PROMOTION_DESTINATION.branch,
        branchId: BRANCH_ID,
        key: LINK_ACTION_KEY.promoteToBranch,
        label: LINK_ACTION_LABEL.promoteToBranch,
        disabled: false,
      },
      {
        destination: LINK_PROMOTION_DESTINATION.teammate,
        branchId: TEAMMATE_BRANCH_ID,
        key: LINK_ACTION_KEY.promoteToTeammate,
        label: LINK_ACTION_LABEL.promoteToTeammate,
        disabled: false,
      },
    ]);
  });

  it('offers only the teammate destination for a branch-owned link', () => {
    expect(
      getLinkPromotionActions(linkItem({ ownerScope: 'branch', ownerBranchId: BRANCH_ID }), {
        branchId: BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
      })
    ).toEqual([
      {
        destination: LINK_PROMOTION_DESTINATION.teammate,
        branchId: TEAMMATE_BRANCH_ID,
        key: LINK_ACTION_KEY.promoteToTeammate,
        label: LINK_ACTION_LABEL.promoteToTeammate,
        disabled: false,
      },
    ]);
  });

  it('keeps uploaded files promotable and internal references owner-local', () => {
    expect(
      getLinkPromotionActions(
        linkItem({ kind: 'document', source: 'upload', filePath: '/tmp/report.pdf' }),
        { branchId: BRANCH_ID }
      )
    ).toHaveLength(1);
    expect(
      getLinkPromotionActions(linkItem({ kind: 'internal' }), { branchId: BRANCH_ID })
    ).toEqual([]);
  });
});
