import type { AgorClient, Link } from '@agor-live/client';
import { normalizeRefTargetKey, normalizeUrlTargetKey } from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';

export type AssistantPromotionState =
  | {
      canPromote: false;
      isPromoted: false;
      assistantLink: null;
      reason: 'no-assistant' | 'same-owner' | 'missing-source-link' | 'missing-target';
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
  const sourceTargetKey = normalizePromotionTargetKey(source.targetKey);
  return (
    assistantLinks.find(
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
