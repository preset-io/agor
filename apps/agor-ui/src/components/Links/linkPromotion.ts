import type { AgorClient, Link } from '@agor-live/client';
import {
  isTeammatePromotionLink,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';
import {
  LINK_ACTION_LABEL,
  LINK_KIND,
  LINK_OWNER_SCOPE,
  LINK_PROMOTION_REASON,
  LINK_PROMOTION_TARGET,
  LINK_ROUTE,
  LINK_SOURCE,
  LINK_TARGET,
  LINK_UNAVAILABLE_REASON,
  type LinkPromotionReason,
} from './linkUiConstants';

export type TeammatePromotionState =
  | {
      canPromote: false;
      isPromoted: false;
      teammateLink: null;
      reason: LinkPromotionReason;
    }
  | {
      canPromote: true;
      isPromoted: false;
      teammateLink: null;
      reason: null;
    }
  | {
      canPromote: true;
      isPromoted: true;
      teammateLink: Link;
      reason: null;
    };

export function getTeammatePromotionUnavailableReason(
  state: TeammatePromotionState
): string | null {
  if (state.canPromote) return null;
  switch (state.reason) {
    case LINK_PROMOTION_REASON.noTeammate:
      return LINK_UNAVAILABLE_REASON.noTeammate;
    case LINK_PROMOTION_REASON.sameOwner:
      return LINK_UNAVAILABLE_REASON.sameOwner;
    case LINK_PROMOTION_REASON.existingTarget:
      return LINK_UNAVAILABLE_REASON.existingTarget;
    case LINK_PROMOTION_REASON.missingTarget:
      return LINK_UNAVAILABLE_REASON.missingTarget;
    case LINK_PROMOTION_REASON.fileLifetime:
      return LINK_UNAVAILABLE_REASON.fileLifetime;
    case LINK_PROMOTION_REASON.internalAccess:
      return LINK_UNAVAILABLE_REASON.internalAccess;
  }
}

export function getTeammatePromotionActionLabel(state: TeammatePromotionState): string {
  if (state.canPromote) {
    return state.isPromoted
      ? LINK_ACTION_LABEL.removeFromTeammate
      : LINK_ACTION_LABEL.saveToTeammate;
  }
  return getTeammatePromotionUnavailableReason(state) ?? LINK_ACTION_LABEL.promotionUnavailable;
}

export function findTeammateLinkForTarget(
  source: Pick<LinkDisplayItem, 'targetKey'>,
  teammateLinks: readonly Link[]
): Link | null {
  const sourceTargetKey = normalizePromotionTargetKey(source.targetKey);
  return (
    teammateLinks.find(
      (link) => normalizePromotionTargetKey(link.target_key) === sourceTargetKey
    ) ?? null
  );
}

function normalizePromotionTargetKey(targetKey: string): string {
  if (targetKey.startsWith(LINK_TARGET.fileKeyPrefix)) return targetKey;
  if (targetKey.toLowerCase().startsWith(LINK_TARGET.urlKeyPrefix)) {
    return normalizeUrlTargetKey(targetKey.slice(LINK_TARGET.urlKeyPrefix.length));
  }
  if (targetKey.toLowerCase().startsWith(LINK_TARGET.refKeyPrefix)) {
    return normalizeRefTargetKey(targetKey.slice(LINK_TARGET.refKeyPrefix.length));
  }
  return targetKey.toLowerCase();
}

export function getTeammatePromotionState(args: {
  item: LinkDisplayItem;
  teammateBranchId?: string | null;
  sourceBranchId?: string | null;
  teammateLinks: readonly Link[];
}): TeammatePromotionState {
  if (!args.teammateBranchId) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: LINK_PROMOTION_REASON.noTeammate,
    };
  }
  if (
    args.item.ownerScope === LINK_OWNER_SCOPE.branch &&
    args.sourceBranchId &&
    args.sourceBranchId === args.teammateBranchId
  ) {
    const ownedLink = args.item.linkId
      ? (args.teammateLinks.find((link) => link.link_id === args.item.linkId) ?? null)
      : null;
    if (ownedLink && isTeammatePromotionLink(ownedLink)) {
      return { canPromote: true, isPromoted: true, teammateLink: ownedLink, reason: null };
    }
    if (ownedLink) {
      return {
        canPromote: false,
        isPromoted: false,
        teammateLink: null,
        reason: LINK_PROMOTION_REASON.existingTarget,
      };
    }
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: LINK_PROMOTION_REASON.sameOwner,
    };
  }
  if (!args.item.targetKey) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: LINK_PROMOTION_REASON.missingTarget,
    };
  }

  const teammateLink = findTeammateLinkForTarget(args.item, args.teammateLinks);
  if (teammateLink && isTeammatePromotionLink(teammateLink)) {
    return { canPromote: true, isPromoted: true, teammateLink, reason: null };
  }
  if (teammateLink) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: LINK_PROMOTION_REASON.existingTarget,
    };
  }
  if (
    args.item.filePath ||
    args.item.source === LINK_SOURCE.upload ||
    args.item.targetKey.startsWith(LINK_TARGET.fileKeyPrefix)
  ) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: LINK_PROMOTION_REASON.fileLifetime,
    };
  }
  if (args.item.kind === LINK_KIND.internal) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: LINK_PROMOTION_REASON.internalAccess,
    };
  }
  // Display-only branch issue/PR metadata is safe to materialize as a manual
  // source link when the user chooses Save to teammate. The mutation helper
  // performs that step before calling the promotion service.
  return { canPromote: true, isPromoted: false, teammateLink: null, reason: null };
}

export async function promoteLinkToTeammate(args: {
  client: AgorClient;
  sourceLinkId: string;
  teammateBranchId: string;
}): Promise<Link> {
  return args.client.service(LINK_ROUTE.promote(args.sourceLinkId)).create({
    target: LINK_PROMOTION_TARGET.teammate,
    teammate_branch_id: args.teammateBranchId,
  });
}
