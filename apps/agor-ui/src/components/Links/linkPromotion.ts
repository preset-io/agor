import type { AgorClient, Link } from '@agor-live/client';
import { normalizeRefTargetKey, normalizeUrlTargetKey } from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';

export type TeammatePromotionState =
  | {
      canPromote: false;
      isPromoted: false;
      teammateLink: null;
      reason:
        | 'no-teammate'
        | 'same-owner'
        | 'missing-source-link'
        | 'missing-target'
        | 'file-lifetime'
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
  if (args.sourceBranchId && args.sourceBranchId === args.teammateBranchId) {
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
  if (teammateLink) return { canPromote: true, isPromoted: true, teammateLink, reason: null };
  if (args.item.filePath || args.item.source === 'upload') {
    return {
      canPromote: false,
      isPromoted: false,
      teammateLink: null,
      reason: 'file-lifetime',
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
