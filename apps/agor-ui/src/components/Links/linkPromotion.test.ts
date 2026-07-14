import type { Link } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import { getLinkPlacementMenuItems } from './linkPromotion';
import {
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_PLACEMENT_OPERATION,
  LINK_PROMOTION_DESTINATION,
} from './linkUiConstants';

const BRANCH_ID = 'branch-1';
const TEAMMATE_BRANCH_ID = 'teammate-1';

function linkItem(overrides: Partial<LinkDisplayItem> = {}): LinkDisplayItem {
  return {
    key: 'link:source',
    linkId: 'source',
    promotionRootLinkId: 'source',
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

describe('getLinkPlacementMenuItems', () => {
  it('offers branch and teammate destinations for a session-owned link', () => {
    expect(
      getLinkPlacementMenuItems(linkItem(), {
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
        operation: LINK_PLACEMENT_OPERATION.promote,
      },
      {
        destination: LINK_PROMOTION_DESTINATION.teammate,
        branchId: TEAMMATE_BRANCH_ID,
        key: LINK_ACTION_KEY.promoteToTeammate,
        label: LINK_ACTION_LABEL.promoteToTeammate,
        disabled: false,
        operation: LINK_PLACEMENT_OPERATION.promote,
      },
    ]);
  });

  it('offers only the teammate destination for a branch-owned link', () => {
    expect(
      getLinkPlacementMenuItems(linkItem({ ownerScope: 'branch', ownerBranchId: BRANCH_ID }), {
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
        operation: LINK_PLACEMENT_OPERATION.promote,
      },
    ]);
  });

  it('promotes a session inside a teammate only to that teammate', () => {
    expect(
      getLinkPlacementMenuItems(linkItem(), {
        branchId: TEAMMATE_BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
      })
    ).toEqual([
      expect.objectContaining({
        destination: LINK_PROMOTION_DESTINATION.teammate,
        branchId: TEAMMATE_BRANCH_ID,
      }),
    ]);
  });

  it('offers removal when the target already has a teammate placement', () => {
    const teammatePlacement = {
      link_id: 'teammate-link',
      branch_id: TEAMMATE_BRANCH_ID,
      session_id: null,
      target_key: 'url:https://example.com/runbook',
      metadata: { promoted_from_owner: { link_id: 'source' } },
    } as Link;

    expect(
      getLinkPlacementMenuItems(linkItem(), {
        branchId: BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
        placements: [teammatePlacement],
      })
    ).toContainEqual({
      destination: LINK_PROMOTION_DESTINATION.teammate,
      branchId: TEAMMATE_BRANCH_ID,
      key: LINK_ACTION_KEY.removeFromTeammate,
      label: LINK_ACTION_LABEL.removeFromTeammate,
      disabled: false,
      operation: LINK_PLACEMENT_OPERATION.remove,
    });
  });

  it('offers removal for a legacy promotion-managed teammate placement', () => {
    const legacyPlacement = {
      link_id: 'legacy-teammate-link',
      branch_id: TEAMMATE_BRANCH_ID,
      session_id: null,
      target_key: 'url:https://example.com/runbook',
      metadata: { teammate_promotion: true },
    } as Link;

    expect(
      getLinkPlacementMenuItems(linkItem(), {
        branchId: TEAMMATE_BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
        placements: [legacyPlacement],
      })
    ).toEqual([
      expect.objectContaining({
        key: LINK_ACTION_KEY.removeFromTeammate,
        label: LINK_ACTION_LABEL.removeFromTeammate,
        operation: LINK_PLACEMENT_OPERATION.remove,
      }),
    ]);
  });

  it('does not offer removal for an independently curated matching teammate link', () => {
    const curatedPlacement = {
      link_id: 'curated-link',
      branch_id: TEAMMATE_BRANCH_ID,
      session_id: null,
      target_key: 'url:https://example.com/runbook',
      metadata: { teammate_owned: true },
    } as Link;

    expect(
      getLinkPlacementMenuItems(linkItem(), {
        branchId: BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
        placements: [curatedPlacement],
      })
    ).toEqual([
      expect.objectContaining({ destination: LINK_PROMOTION_DESTINATION.branch }),
      {
        key: LINK_ACTION_KEY.alreadyInTeammate,
        label: LINK_ACTION_LABEL.alreadyInTeammate,
        disabled: true,
      },
    ]);
  });

  it('does not offer removal for a matching placement promoted from another source', () => {
    const unrelatedPlacement = {
      link_id: 'other-promotion',
      branch_id: TEAMMATE_BRANCH_ID,
      session_id: null,
      target_key: 'url:https://example.com/runbook',
      metadata: { promoted_from_owner: { link_id: 'different-source' } },
    } as Link;

    expect(
      getLinkPlacementMenuItems(linkItem(), {
        branchId: BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
        placements: [unrelatedPlacement],
      })
    ).toEqual([
      expect.objectContaining({ destination: LINK_PROMOTION_DESTINATION.branch }),
      {
        key: LINK_ACTION_KEY.alreadyInTeammate,
        label: LINK_ACTION_LABEL.alreadyInTeammate,
        disabled: true,
      },
    ]);
  });

  it('shows a stable status while destination placements are loading', () => {
    expect(
      getLinkPlacementMenuItems(linkItem(), {
        branchId: BRANCH_ID,
        teammateBranchId: TEAMMATE_BRANCH_ID,
        placementsLoaded: false,
      })
    ).toEqual([
      {
        key: LINK_ACTION_KEY.checkingDestinations,
        label: LINK_ACTION_LABEL.checkingDestinations,
        disabled: true,
      },
    ]);
  });

  it('does not offer downward promotion actions for teammate-owned links', () => {
    expect(
      getLinkPlacementMenuItems(
        linkItem({ ownerScope: 'branch', ownerBranchId: TEAMMATE_BRANCH_ID }),
        {
          branchId: TEAMMATE_BRANCH_ID,
          teammateBranchId: TEAMMATE_BRANCH_ID,
        }
      )
    ).toEqual([]);
  });

  it('keeps uploaded files promotable and internal references owner-local', () => {
    expect(
      getLinkPlacementMenuItems(
        linkItem({ kind: 'document', source: 'upload', filePath: '/tmp/report.pdf' }),
        { branchId: BRANCH_ID }
      )
    ).toHaveLength(1);
    expect(
      getLinkPlacementMenuItems(linkItem({ kind: 'internal' }), { branchId: BRANCH_ID })
    ).toEqual([]);
  });
});
