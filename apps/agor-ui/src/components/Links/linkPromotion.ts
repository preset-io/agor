import type { AgorClient, Link } from '@agor-live/client';
import { type LinkDisplayItem, targetKeyForLink } from './linkDisplay';

export interface AssistantPromotionState {
  assistantLink: Link | null;
  isPromoted: boolean;
  isAssistantOwned: boolean;
  canUseAssistantPromotion: boolean;
  unavailableReason: string | null;
  actionLabel: 'Promote to assistant' | 'Remove from assistant';
}

export function findAssistantLinkForTarget(
  item: Pick<LinkDisplayItem, 'targetKey'>,
  assistantLinks: Link[]
): Link | null {
  const targetKey = item.targetKey.toLowerCase();
  return (
    assistantLinks.find((link) => {
      const linkTargetKey = targetKeyForLink(link);
      return linkTargetKey?.toLowerCase() === targetKey;
    }) ?? null
  );
}

export function getAssistantPromotionState(args: {
  item: Pick<LinkDisplayItem, 'targetKey' | 'linkId'>;
  assistantBranchId?: string | null;
  assistantLinks: Link[];
  sourceBranchId?: string | null;
}): AssistantPromotionState {
  const assistantLink = args.assistantBranchId
    ? findAssistantLinkForTarget(args.item, args.assistantLinks)
    : null;
  const isAssistantOwned = Boolean(
    args.assistantBranchId && args.sourceBranchId && args.sourceBranchId === args.assistantBranchId
  );
  const isPromoted = Boolean(assistantLink || isAssistantOwned);
  const actionLabel = isPromoted ? 'Remove from assistant' : 'Promote to assistant';

  if (!args.assistantBranchId) {
    return {
      assistantLink,
      isPromoted,
      isAssistantOwned,
      canUseAssistantPromotion: false,
      unavailableReason: 'No primary assistant is assigned to this board.',
      actionLabel,
    };
  }

  if (!args.item.linkId && !assistantLink) {
    return {
      assistantLink,
      isPromoted,
      isAssistantOwned,
      canUseAssistantPromotion: false,
      unavailableReason: 'Only saved links can be promoted to the assistant.',
      actionLabel,
    };
  }

  return {
    assistantLink,
    isPromoted,
    isAssistantOwned,
    canUseAssistantPromotion: true,
    unavailableReason: null,
    actionLabel,
  };
}

export async function promoteLinkToAssistant(args: {
  client: AgorClient;
  sourceLinkId: string;
  assistantBranchId: string;
}): Promise<Link> {
  return (await args.client.service(`links/${args.sourceLinkId}/promote`).create({
    target: 'assistant',
    assistant_branch_id: args.assistantBranchId,
  })) as Link;
}
