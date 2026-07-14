import type { AgorClient, BranchID, Link, LinkPromotionRequest } from '@agor-live/client';
import { LINK_PROMOTION_TARGET } from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';
import { ensurePersistedLink } from './linkPinning';
import {
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_KIND,
  LINK_PROMOTION_DESTINATION,
  LINK_ROUTE,
  type LinkPromotionDestination,
} from './linkUiConstants';

export interface LinkPromotionSelection {
  destination: LinkPromotionDestination;
  branchId: string;
}

export interface LinkPromotionAction extends LinkPromotionSelection {
  key: string;
  label: string;
  disabled: boolean;
}

interface LinkPromotionContext {
  branchId?: string | null;
  teammateBranchId?: string | null;
  available?: boolean;
}

const LINK_PROMOTION_LABEL = {
  [LINK_PROMOTION_DESTINATION.branch]: LINK_ACTION_LABEL.promoteToBranch,
  [LINK_PROMOTION_DESTINATION.teammate]: LINK_ACTION_LABEL.promoteToTeammate,
} as const satisfies Record<LinkPromotionDestination, string>;

const LINK_PROMOTION_ACTION_KEY = {
  [LINK_PROMOTION_DESTINATION.branch]: LINK_ACTION_KEY.promoteToBranch,
  [LINK_PROMOTION_DESTINATION.teammate]: LINK_ACTION_KEY.promoteToTeammate,
} as const satisfies Record<LinkPromotionDestination, string>;

function promotionCandidates(
  item: LinkDisplayItem,
  context: LinkPromotionContext
): LinkPromotionSelection[] {
  const ownerBranchId = item.ownerBranchId ?? context.branchId ?? null;
  if (item.ownerScope === 'branch') {
    return context.teammateBranchId && context.teammateBranchId !== ownerBranchId
      ? [
          {
            destination: LINK_PROMOTION_DESTINATION.teammate,
            branchId: context.teammateBranchId,
          },
        ]
      : [];
  }

  if (context.teammateBranchId && context.teammateBranchId === context.branchId) {
    return [
      {
        destination: LINK_PROMOTION_DESTINATION.teammate,
        branchId: context.teammateBranchId,
      },
    ];
  }

  return [
    ...(context.branchId
      ? [{ destination: LINK_PROMOTION_DESTINATION.branch, branchId: context.branchId } as const]
      : []),
    ...(context.teammateBranchId
      ? [
          {
            destination: LINK_PROMOTION_DESTINATION.teammate,
            branchId: context.teammateBranchId,
          } as const,
        ]
      : []),
  ];
}

export function getLinkPromotionActions(
  item: LinkDisplayItem,
  context: LinkPromotionContext
): LinkPromotionAction[] {
  if (item.kind === LINK_KIND.internal) return [];
  return promotionCandidates(item, context).map((selection) => ({
    ...selection,
    key: LINK_PROMOTION_ACTION_KEY[selection.destination],
    label: LINK_PROMOTION_LABEL[selection.destination],
    disabled: !(context.available ?? true),
  }));
}

function promotionRequest(selection: LinkPromotionSelection): LinkPromotionRequest {
  return selection.destination === LINK_PROMOTION_DESTINATION.teammate
    ? {
        target: LINK_PROMOTION_TARGET.teammate,
        teammate_branch_id: selection.branchId as BranchID,
      }
    : {
        target: LINK_PROMOTION_TARGET.branch,
        branch_id: selection.branchId as BranchID,
      };
}

export async function promoteLinkDisplayItem(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  selection: LinkPromotionSelection;
  branchId?: string | null;
  sessionId?: string | null;
}): Promise<Link> {
  const persisted = args.item.linkId
    ? null
    : await ensurePersistedLink({
        client: args.client,
        item: args.item,
        branchId: args.item.ownerBranchId ?? args.branchId,
        sessionId: args.item.sessionId ?? args.sessionId,
        isPinned: args.item.isPinned,
      });
  const linkId = args.item.linkId ?? String(persisted?.link_id);
  return args.client.service(LINK_ROUTE.promote(linkId)).create(promotionRequest(args.selection));
}
