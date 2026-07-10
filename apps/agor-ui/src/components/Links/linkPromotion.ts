import type { AgorClient, Link } from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';

export type AssistantPromotionState =
  | {
      canPromote: false;
      isPromoted: false;
      assistantLink: null;
      reason:
        | 'no-assistant'
        | 'same-owner'
        | 'missing-source-link'
        | 'missing-target'
        | 'file-lifetime'
        | 'internal-target-access';
    }
  | {
      canPromote: true;
      isPromoted: false;
      assistantLink: null;
      reason: null;
    }
  | {
      canPromote: true;
      isPromoted: true;
      assistantLink: Link;
      reason: null;
    };

export function findAssistantLinkForTarget(
  source: Pick<LinkDisplayItem, 'targetKey'>,
  assistantLinks: readonly Link[]
): Link | null {
  return assistantLinks.find((link) => link.target_key === source.targetKey) ?? null;
}

export function getAssistantPromotionState(args: {
  item: LinkDisplayItem;
  assistantBranchId?: string | null;
  sourceBranchId?: string | null;
  assistantLinks: readonly Link[];
}): AssistantPromotionState {
  if (!args.assistantBranchId) {
    return { canPromote: false, isPromoted: false, assistantLink: null, reason: 'no-assistant' };
  }
  if (args.sourceBranchId && args.sourceBranchId === args.assistantBranchId) {
    return { canPromote: false, isPromoted: false, assistantLink: null, reason: 'same-owner' };
  }
  if (!args.item.linkId) {
    return {
      canPromote: false,
      isPromoted: false,
      assistantLink: null,
      reason: 'missing-source-link',
    };
  }
  if (!args.item.targetKey) {
    return { canPromote: false, isPromoted: false, assistantLink: null, reason: 'missing-target' };
  }

  const assistantLink = findAssistantLinkForTarget(args.item, args.assistantLinks);
  if (assistantLink) return { canPromote: true, isPromoted: true, assistantLink, reason: null };
  if (args.item.filePath || args.item.source === 'upload') {
    return {
      canPromote: false,
      isPromoted: false,
      assistantLink: null,
      reason: 'file-lifetime',
    };
  }
  if (args.item.kind === 'internal') {
    return {
      canPromote: false,
      isPromoted: false,
      assistantLink: null,
      reason: 'internal-target-access',
    };
  }
  return { canPromote: true, isPromoted: false, assistantLink: null, reason: null };
}

export async function promoteLinkToAssistant(args: {
  client: AgorClient;
  sourceLinkId: string;
  assistantBranchId: string;
}): Promise<Link> {
  return args.client.service(`links/${args.sourceLinkId}/promote`).create({
    target: 'assistant',
    assistant_branch_id: args.assistantBranchId,
  });
}
