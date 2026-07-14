import {
  canPromoteLink,
  isLinkPlacementFromPromotionRoot,
  LINK_CONTEXT_KIND,
  LINK_PROMOTION_TARGET,
  type LinkContextKind,
  type LinkPromotionRequest,
} from '@agor/core/types';
import type { AgorClient, BranchID, Link } from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';
import { ensurePersistedLink } from './linkPinning';
import {
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_KIND,
  LINK_PLACEMENT_OPERATION,
  LINK_PROMOTION_DESTINATION,
  LINK_ROUTE,
  type LinkPlacementOperation,
  type LinkPromotionDestination,
} from './linkUiConstants';

interface LinkPlacementsClientService {
  find(): Promise<Link[]>;
  create(data: LinkPromotionRequest): Promise<Link>;
  remove(id: null, params: { query: LinkPromotionRequest }): Promise<Link | null>;
}

function placementsService(client: AgorClient, linkId: string): LinkPlacementsClientService {
  return client.service(
    LINK_ROUTE.placements(linkId) as never
  ) as unknown as LinkPlacementsClientService;
}

export interface LinkPromotionSelection {
  destination: LinkPromotionDestination;
  branchId: string;
}

export interface LinkPromotionAction extends LinkPromotionSelection {
  key: string;
  label: string;
  disabled: boolean;
  operation: LinkPlacementOperation;
}

interface LinkPromotionContext {
  branchId?: string | null;
  teammateBranchId?: string | null;
  placements?: readonly Link[];
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

const LINK_REMOVAL_LABEL = {
  [LINK_PROMOTION_DESTINATION.branch]: LINK_ACTION_LABEL.removeFromBranch,
  [LINK_PROMOTION_DESTINATION.teammate]: LINK_ACTION_LABEL.removeFromTeammate,
} as const satisfies Record<LinkPromotionDestination, string>;

const LINK_REMOVAL_ACTION_KEY = {
  [LINK_PROMOTION_DESTINATION.branch]: LINK_ACTION_KEY.removeFromBranch,
  [LINK_PROMOTION_DESTINATION.teammate]: LINK_ACTION_KEY.removeFromTeammate,
} as const satisfies Record<LinkPromotionDestination, string>;

function promotionSourceContext(
  item: LinkDisplayItem,
  context: LinkPromotionContext
): LinkContextKind {
  if (item.ownerScope === LINK_CONTEXT_KIND.session) return LINK_CONTEXT_KIND.session;
  const ownerBranchId = item.ownerBranchId ?? context.branchId ?? null;
  return ownerBranchId && ownerBranchId === context.teammateBranchId
    ? LINK_CONTEXT_KIND.teammate
    : LINK_CONTEXT_KIND.branch;
}

function promotionCandidates(
  item: LinkDisplayItem,
  context: LinkPromotionContext
): LinkPromotionSelection[] {
  const ownerBranchId = item.ownerBranchId ?? context.branchId ?? null;
  const sourceContext = promotionSourceContext(item, context);
  const candidates: LinkPromotionSelection[] = [];

  if (item.ownerScope === LINK_CONTEXT_KIND.session && context.branchId) {
    candidates.push({
      destination:
        context.branchId === context.teammateBranchId
          ? LINK_PROMOTION_DESTINATION.teammate
          : LINK_PROMOTION_DESTINATION.branch,
      branchId: context.branchId,
    });
  }
  if (context.teammateBranchId && context.teammateBranchId !== ownerBranchId) {
    candidates.push({
      destination: LINK_PROMOTION_DESTINATION.teammate,
      branchId: context.teammateBranchId,
    });
  }

  return candidates.filter((candidate) => canPromoteLink(sourceContext, candidate.destination));
}

function placementMatchesSelection(link: Link, selection: LinkPromotionSelection): boolean {
  return link.branch_id === selection.branchId && !link.session_id;
}

function getLinkPlacementAction(
  item: LinkDisplayItem,
  selection: LinkPromotionSelection,
  placements: readonly Link[] = [],
  available = true
): LinkPromotionAction | null {
  const existing = placements.find((link) => placementMatchesSelection(link, selection));
  if (
    existing &&
    (!item.promotionRootLinkId ||
      !isLinkPlacementFromPromotionRoot(existing, item.promotionRootLinkId))
  ) {
    return null;
  }
  const operation = existing ? LINK_PLACEMENT_OPERATION.remove : LINK_PLACEMENT_OPERATION.promote;
  return {
    ...selection,
    operation,
    key:
      operation === LINK_PLACEMENT_OPERATION.remove
        ? LINK_REMOVAL_ACTION_KEY[selection.destination]
        : LINK_PROMOTION_ACTION_KEY[selection.destination],
    label:
      operation === LINK_PLACEMENT_OPERATION.remove
        ? LINK_REMOVAL_LABEL[selection.destination]
        : LINK_PROMOTION_LABEL[selection.destination],
    disabled: !available,
  };
}

export function getLinkPromotionActions(
  item: LinkDisplayItem,
  context: LinkPromotionContext
): LinkPromotionAction[] {
  if (item.kind === LINK_KIND.internal) return [];
  return promotionCandidates(item, context).flatMap((selection) => {
    const action = getLinkPlacementAction(
      item,
      selection,
      context.placements,
      context.available ?? true
    );
    return action ? [action] : [];
  });
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
  return placementsService(args.client, linkId).create(promotionRequest(args.selection));
}

export async function loadLinkPlacements(args: {
  client: AgorClient;
  item: LinkDisplayItem;
}): Promise<Link[]> {
  if (!args.item.linkId) return [];
  return placementsService(args.client, args.item.linkId).find();
}

export async function removeLinkPlacement(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  selection: LinkPromotionSelection;
}): Promise<Link | null> {
  if (!args.item.linkId) return null;
  return placementsService(args.client, args.item.linkId).remove(null, {
    query: promotionRequest(args.selection),
  });
}
