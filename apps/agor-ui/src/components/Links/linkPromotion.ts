import type { AgorClient, Link } from '@agor-live/client';
import {
  isTeammatePromotionLink,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';

type TeammatePromotionState =
  | {
      canPromote: false;
      isPromoted: false;
      teammateLink: null;
      reason:
        | 'no-teammate'
        | 'same-owner'
        | 'existing-target'
        | 'missing-source-link'
        | 'missing-target'
        | 'file-target-lifetime'
        | 'internal-target-access';
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
    case 'no-teammate':
      return 'No teammate configured';
    case 'same-owner':
      return 'Already on teammate branch';
    case 'existing-target':
      return 'Teammate already owns this link';
    case 'missing-source-link':
      return 'Cannot promote generated branch metadata';
    case 'missing-target':
      return 'Cannot promote a link without a target';
    case 'file-target-lifetime':
      return 'File promotion awaits retention and cleanup rules';
    case 'internal-target-access':
      return 'Internal promotion awaits target access checks';
  }
}

export function getTeammatePromotionActionLabel(state: TeammatePromotionState): string {
  if (state.canPromote) return state.isPromoted ? 'Remove from teammate' : 'Promote to teammate';
  return getTeammatePromotionUnavailableReason(state) ?? 'Cannot promote this link';
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
  if (targetKey.startsWith('file:')) return targetKey;
  if (targetKey.toLowerCase().startsWith('url:')) {
    return normalizeUrlTargetKey(targetKey.slice(4));
  }
  if (targetKey.toLowerCase().startsWith('ref:')) {
    return normalizeRefTargetKey(targetKey.slice(4));
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
    return { canPromote: false, isPromoted: false, teammateLink: null, reason: 'no-teammate' };
  }
  if (
    args.item.ownerScope === 'branch' &&
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
        reason: 'existing-target',
      };
    }
    return { canPromote: false, isPromoted: false, teammateLink: null, reason: 'same-owner' };
  }
  if (!args.item.linkId) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: 'missing-source-link',
    };
  }
  if (!args.item.targetKey) {
    return { canPromote: false, isPromoted: false, teammateLink: null, reason: 'missing-target' };
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
      reason: 'existing-target',
    };
  }
  if (
    args.item.filePath ||
    args.item.source === 'upload' ||
    args.item.targetKey.startsWith('file:')
  ) {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: 'file-target-lifetime',
    };
  }
  if (args.item.kind === 'internal') {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: 'internal-target-access',
    };
  }
  return { canPromote: true, isPromoted: false, teammateLink: null, reason: null };
}

export async function promoteLinkToTeammate(args: {
  client: AgorClient;
  sourceLinkId: string;
  teammateBranchId: string;
}): Promise<Link> {
  return args.client.service(`links/${args.sourceLinkId}/promote`).create({
    target: 'teammate',
    teammate_branch_id: args.teammateBranchId,
  });
}
