import type {
  AgorClient,
  BranchID,
  LinkMoveRequest,
  LinkMoveResult,
  SessionID,
} from '@agor-live/client';
import { LINK_MOVE_TARGET } from '@agor-live/client';
import type { LinkDisplayItem } from './linkDisplay';
import { ensurePersistedLink } from './linkPinning';
import {
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_KIND,
  LINK_MOVE_DESTINATION,
  LINK_MOVE_UNAVAILABLE_REASON,
  LINK_ROUTE,
  LINK_SOURCE,
  type LinkMoveDestination,
} from './linkUiConstants';

export interface LinkMoveSelection {
  destination: LinkMoveDestination;
  ownerId: string;
}

export interface LinkMoveAction extends LinkMoveSelection {
  key: string;
  label: string;
  disabled: boolean;
  reason: string | null;
}

interface LinkMoveContext {
  branchId?: string | null;
  sessionId?: string | null;
  teammateBranchId?: string | null;
  available?: boolean;
}

const LINK_MOVE_LABEL = {
  [LINK_MOVE_DESTINATION.branch]: LINK_ACTION_LABEL.moveToBranch,
  [LINK_MOVE_DESTINATION.session]: LINK_ACTION_LABEL.moveToSession,
  [LINK_MOVE_DESTINATION.teammate]: LINK_ACTION_LABEL.moveToTeammate,
} as const satisfies Record<LinkMoveDestination, string>;

const LINK_MOVE_ACTION_KEY = {
  [LINK_MOVE_DESTINATION.branch]: LINK_ACTION_KEY.moveToBranch,
  [LINK_MOVE_DESTINATION.session]: LINK_ACTION_KEY.moveToSession,
  [LINK_MOVE_DESTINATION.teammate]: LINK_ACTION_KEY.moveToTeammate,
} as const satisfies Record<LinkMoveDestination, string>;

const LINK_MOVE_ORDER: Record<LinkMoveDestination, readonly LinkMoveDestination[]> = {
  [LINK_MOVE_DESTINATION.session]: [LINK_MOVE_DESTINATION.branch, LINK_MOVE_DESTINATION.teammate],
  [LINK_MOVE_DESTINATION.branch]: [LINK_MOVE_DESTINATION.session, LINK_MOVE_DESTINATION.teammate],
  [LINK_MOVE_DESTINATION.teammate]: [LINK_MOVE_DESTINATION.session, LINK_MOVE_DESTINATION.branch],
};

function currentDestination(item: LinkDisplayItem, context: LinkMoveContext): LinkMoveDestination {
  if (item.ownerScope === LINK_MOVE_DESTINATION.session) {
    return LINK_MOVE_DESTINATION.session;
  }
  const ownerBranchId = item.ownerBranchId ?? context.branchId;
  return ownerBranchId && ownerBranchId === context.teammateBranchId
    ? LINK_MOVE_DESTINATION.teammate
    : LINK_MOVE_DESTINATION.branch;
}

function destinationOwnerId(
  destination: LinkMoveDestination,
  context: LinkMoveContext
): string | null {
  if (destination === LINK_MOVE_DESTINATION.session) return context.sessionId ?? null;
  if (destination === LINK_MOVE_DESTINATION.teammate) return context.teammateBranchId ?? null;
  if (context.branchId && context.branchId === context.teammateBranchId) return null;
  return context.branchId ?? null;
}

function unavailableReason(item: LinkDisplayItem, available: boolean): string | null {
  if (!available) return LINK_MOVE_UNAVAILABLE_REASON.disconnected;
  if (item.filePath || item.source === LINK_SOURCE.upload) {
    return LINK_MOVE_UNAVAILABLE_REASON.fileLifetime;
  }
  if (item.kind === LINK_KIND.internal) return LINK_MOVE_UNAVAILABLE_REASON.internalAccess;
  if (!item.url && !(item.refUri && item.kind === LINK_KIND.knowledge)) {
    return LINK_MOVE_UNAVAILABLE_REASON.missingTarget;
  }
  return null;
}

export function getLinkMoveActions(
  item: LinkDisplayItem,
  context: LinkMoveContext
): LinkMoveAction[] {
  const current = currentDestination(item, context);
  const reason = unavailableReason(item, context.available ?? true);
  const seenOwnerIds = new Set<string>();

  return LINK_MOVE_ORDER[current].flatMap((destination) => {
    const ownerId = destinationOwnerId(destination, context);
    if (!ownerId || seenOwnerIds.has(ownerId)) return [];
    seenOwnerIds.add(ownerId);
    return [
      {
        destination,
        ownerId,
        key: LINK_MOVE_ACTION_KEY[destination],
        label: LINK_MOVE_LABEL[destination],
        disabled: Boolean(reason),
        reason,
      },
    ];
  });
}

function moveRequest(selection: LinkMoveSelection): LinkMoveRequest {
  return selection.destination === LINK_MOVE_DESTINATION.session
    ? {
        target: LINK_MOVE_TARGET.session,
        session_id: selection.ownerId as SessionID,
      }
    : {
        target: LINK_MOVE_TARGET.branch,
        branch_id: selection.ownerId as BranchID,
      };
}

export async function moveLinkDisplayItem(args: {
  client: AgorClient;
  item: LinkDisplayItem;
  selection: LinkMoveSelection;
  branchId?: string | null;
  sessionId?: string | null;
}): Promise<LinkMoveResult> {
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
  return args.client.service(LINK_ROUTE.move(linkId)).create(moveRequest(args.selection));
}
