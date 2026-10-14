/**
 * Per-collection realtime entity actions for the Agor store.
 *
 * Each function is one socket handler — `replaceIfChanged` / cascade /
 * index-rebuild logic, `Object.is` bail-outs, per-collection `bumpRevision`
 * calls — writing through the store primitives (`setMap` / `applyMaps` and the
 * named branch lifecycle cascades). `useAgorData`'s subscribe effect wires socket
 * events straight to these.
 *
 * Load fences: each handler bumps the matching per-collection revision and
 * stamps the written id (`bumpRevision`, from `agorHydration`), so a load in
 * flight — first paint, a reconnect resync, a board partition or the user
 * scope — keeps this live write rather than replacing it with its older
 * snapshot. That INCLUDES the branch-eviction cascade, which mutates sessions
 * and, for a hard delete, every normalized FK-cascade/SET NULL slice, and so
 * bumps the matching revisions.
 *
 * IMMER breadth/depth rule applied here:
 *  - HOT single-map `*:patched` writes → RAW reducer via `setMap`
 *    (`new Map(prev); next.set(id, e)` through `replaceIfChanged`). No immer
 *    proxy on the hot path.
 *  - multi-map maintenance (session `sessionById` + `sessionsByBranch`,
 *    board-object index) → the pure reducers (`applySessionPatchToMaps` /
 *    `upsertBoardObjectInMaps` / `removeBoardObjectFromMaps`) via `applyMaps`,
 *    which commits every changed slice in ONE store notify — reference-stable so
 *    the contract the tests pin holds exactly.
 *  - the branch-eviction CASCADE → the store's immer action
 *    (`evictArchivedBranch` / `applyBranchHardDeleteCascade`).
 *
 * Branch, session, board-object and card writes go through `applyLive`: a
 * row they would insert that nothing holds stays out (`admitHeld`; the
 * touched fence is still recorded), and load-scope membership stays live
 * (`liveMembership`): the written row joins every current loaded scope that
 * claims it and leaves the ones that no longer do, in the same store update
 * as the row.
 */
import type {
  Artifact,
  Board,
  BoardComment,
  BoardEntityObject,
  BoardLayoutAppliedEvent,
  Branch,
  CardType,
  CardWithType,
  GatewayChannel,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { removeCollapsedBranchNode } from '../utils/collapsedBranchNodes';
import { bumpRevision } from './agorHydration';
import {
  applySessionPatchToMaps,
  type DataMaps,
  removeBoardObjectFromMaps,
  replaceIfChanged,
  upsertBoardObjectInMaps,
} from './agorMaps';
import { type AgorState, agorStore } from './agorStore';
import { isLoadLifetimeCurrent } from './loadLifetime';
import { admitHeld, forgetAbsentSessions } from './retention';
import {
  boardScopeKey,
  type Coverage,
  type CoverageUpdate,
  liveMembership,
  type WrittenIds,
  withBranchSessions,
  withCoverage,
} from './scopeMerge';
import { pruneSessionMcpLinks } from './sessionMcpLinks';

// Thin bindings to the store primitives. The vanilla store and its actions are
// stable module singletons, so these resolve the live action each call. The
// signatures are pulled straight off `AgorState` so the generic `setMap` key→
// value inference (and the `applyMaps` reducer / branch cascade
// shapes) carry through to every callback below.
const setMap: AgorState['setMap'] = (key, value) => agorStore.getState().setMap(key, value);
const applyMaps: AgorState['applyMaps'] = (updater, coverage) =>
  agorStore.getState().applyMaps(updater, coverage);
const evictArchivedBranch: AgorState['evictArchivedBranch'] = (branchId, coverage) =>
  agorStore.getState().evictArchivedBranch(branchId, coverage);
const applyBranchHardDeleteCascade: AgorState['applyBranchHardDeleteCascade'] = (
  branchId,
  coverage
) => agorStore.getState().applyBranchHardDeleteCascade(branchId, coverage);

/**
 * The membership update for a live write of `written` (current scopes only);
 * `branchSessions` re-checks the sessions on its branches (a create or move).
 */
export const liveCoverage =
  (written: WrittenIds, branchSessions = false): CoverageUpdate =>
  (maps, coverage) =>
    liveMembership(
      coverage,
      maps,
      branchSessions ? withBranchSessions(written, maps) : written,
      isLoadLifetimeCurrent
    );

/** `boardId`'s partition entry, if it is current. */
function currentPartition(coverage: Coverage, boardId: string | null | undefined) {
  const entry = boardId ? coverage.get(boardScopeKey(boardId)) : undefined;
  return entry && isLoadLifetimeCurrent(entry) ? entry : undefined;
}

/**
 * A branch that moves onto a loading or loaded board from a board whose
 * partition isn't loaded and complete, or that the store didn't hold, may
 * arrive without sessions nothing held while it was away (a loading or
 * incomplete source's read may lack them), and a move emits no session
 * events. Its board's partition stops claiming to be complete: the mounted
 * `useBoardPartition` reloads it (a complete replace), and a load in flight
 * settles incomplete (`settleBoardPartition`), so the board is read again.
 */
const markArrivalIncomplete =
  (from: string | null | undefined, to: string | null | undefined): CoverageUpdate =>
  (_maps, coverage) => {
    const destination = currentPartition(coverage, to);
    const source = currentPartition(coverage, from);
    const sourceComplete = source?.status === 'loaded' && source.complete === true;
    if (!to || from === to || !destination || destination.status === 'error' || sourceComplete) {
      return coverage;
    }
    return destination.complete !== false
      ? withCoverage(coverage, boardScopeKey(to), { ...destination, complete: false })
      : coverage;
  };

/**
 * Apply a live write of `written`: the rows it inserts or moves out of every
 * scope that nothing holds leave (`admitHeld`; a moved branch's sessions are
 * judged too), with their sessions' MCP state, and membership follows
 * (`liveCoverage`), with `coverage` after it.
 */
function applyLive(
  update: (prev: DataMaps) => DataMaps,
  written: WrittenIds,
  branchSessions = false,
  coverage?: CoverageUpdate
): void {
  let judged = written;
  applyMaps(
    (prev) => {
      const next = update(prev);
      judged = branchSessions ? withBranchSessions(written, next) : written;
      return admitHeld(prev, next, judged);
    },
    (maps, current) => {
      const live = liveCoverage(written, branchSessions)(maps, current);
      return coverage ? coverage(maps, live) : live;
    }
  );
  forgetAbsentSessions(judged.sessions ?? []);
}

/** The ids a branch eviction cascade removes with it. */
function evictedWith(branchId: string, withBoardObjects: boolean): WrittenIds {
  const state = agorStore.getState();
  const onBranch = <T extends { branch_id?: string | null }>(rows: Iterable<T>) =>
    [...rows].filter((row) => row.branch_id === branchId);
  return {
    branches: [branchId],
    sessions: onBranch(state.sessionById.values()).map((session) => session.session_id),
    ...(withBoardObjects
      ? { boardObjects: onBranch(state.boardObjectById.values()).map((o) => o.object_id) }
      : {}),
  };
}

// ── Sessions ────────────────────────────────────────────────────────────────
export function sessionCreated(session: Session) {
  // Bump and stamp so a load in flight keeps this write (see the header).
  bumpRevision('sessions', session.session_id);
  if (session.archived) return;

  applyLive(
    (prev) => {
      // Only create new Maps for a session that doesn't exist yet (duplicate event).
      let { sessionById, sessionsByBranch } = prev;
      if (!sessionById.has(session.session_id)) {
        sessionById = new Map(sessionById).set(session.session_id, session);
      }
      const branchSessions = sessionsByBranch.get(session.branch_id) || [];
      if (!branchSessions.some((s) => s.session_id === session.session_id)) {
        sessionsByBranch = new Map(sessionsByBranch).set(session.branch_id, [
          ...branchSessions,
          session,
        ]);
      }
      if (sessionById === prev.sessionById && sessionsByBranch === prev.sessionsByBranch) {
        return prev;
      }
      return { ...prev, sessionById, sessionsByBranch };
    },
    { sessions: [session.session_id] }
  );
}

export function sessionPatched(session: Session) {
  // Patch (incl. archive, which removes the session from the active maps) counts
  // as a live write — bump so a load in flight can't clobber it or resurrect an
  // archive with a pre-archive snapshot. One `applyMaps` commits
  // both `sessionById` and `sessionsByBranch` in a single store notify; the
  // reducer returns `prev` untouched on a no-op patch so references stay stable.
  bumpRevision('sessions', session.session_id);
  applyLive((prev) => applySessionPatchToMaps(prev, session), { sessions: [session.session_id] });
}

export function sessionRemoved(session: Session) {
  bumpRevision('sessions', session.session_id);
  bumpRevision('sessionMcp');
  pruneSessionMcpLinks([session.session_id]);
  applyLive(
    (prev) => {
      // Bail out per map when the id isn't tracked, so an untracked removal
      // leaves every reference (and the store) untouched.
      let { sessionById, sessionsByBranch } = prev;
      if (sessionById.has(session.session_id)) {
        sessionById = new Map(sessionById);
        sessionById.delete(session.session_id);
      }
      const branchSessions = sessionsByBranch.get(session.branch_id);
      if (branchSessions?.some((s) => s.session_id === session.session_id)) {
        sessionsByBranch = new Map(sessionsByBranch);
        const filtered = branchSessions.filter((s) => s.session_id !== session.session_id);
        // Clean up empty arrays
        if (filtered.length > 0) sessionsByBranch.set(session.branch_id, filtered);
        else sessionsByBranch.delete(session.branch_id);
      }
      if (sessionById === prev.sessionById && sessionsByBranch === prev.sessionsByBranch) {
        return prev;
      }
      return { ...prev, sessionById, sessionsByBranch };
    },
    { sessions: [session.session_id] }
  );
}

// ── Boards ──────────────────────────────────────────────────────────────────
// A board partition load replaces its board WITH the full `objects`/`custom_css`
// (the gated list fetch is lean), so every board write bumps and stamps the
// `boards` revision — otherwise a load whose (full) snapshot predates a zone
// create/move/delete could clobber the live change with the pre-edit board.
export function boardCreated(board: Board) {
  bumpRevision('boards', board.board_id);
  setMap('boardById', (prev) => {
    if (prev.has(board.board_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(board.board_id, board);
    return next;
  });
}
export function boardPatched(board: Board) {
  bumpRevision('boards', board.board_id);
  setMap('boardById', (prev) => replaceIfChanged(prev, board.board_id, board));
}
/**
 * One layout commit: the board row and its moved placements land in one store
 * notification, through the same fences as `boardPatched` and
 * `boardObjectPatched` — each written id is stamped so a load in flight keeps
 * it, and the placements go through `applyLive` so a row of a board nothing
 * holds stays out and scope membership follows.
 */
export function boardLayoutApplied(event: BoardLayoutAppliedEvent) {
  bumpRevision('boards', event.board.board_id);
  const placementIds = event.placements.map((placement) => placement.object_id);
  for (const objectId of placementIds) bumpRevision('boardObjects', objectId);
  applyLive(
    (previous) => {
      const boardById = replaceIfChanged(previous.boardById, event.board.board_id, event.board);
      let next = boardById === previous.boardById ? previous : { ...previous, boardById };
      for (const placement of event.placements) {
        next = upsertBoardObjectInMaps(next, placement, 'patch');
      }
      return next;
    },
    { boardObjects: placementIds }
  );
}
export function boardRemoved(board: Board) {
  bumpRevision('boards', board.board_id);
  setMap('boardById', (prev) => {
    if (!prev.has(board.board_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(board.board_id);
    return next;
  });
}

// ── Board objects ─────────────────────────────────────────────────────────--
export function boardObjectCreated(boardObject: BoardEntityObject) {
  bumpRevision('boardObjects', boardObject.object_id);
  applyLive((prev) => upsertBoardObjectInMaps(prev, boardObject, 'create'), {
    boardObjects: [boardObject.object_id],
  });
}
export function boardObjectPatched(boardObject: BoardEntityObject) {
  bumpRevision('boardObjects', boardObject.object_id);
  applyLive((prev) => upsertBoardObjectInMaps(prev, boardObject, 'patch'), {
    boardObjects: [boardObject.object_id],
  });
}
export function boardObjectRemoved(boardObject: BoardEntityObject) {
  bumpRevision('boardObjects', boardObject.object_id);
  applyLive((prev) => removeBoardObjectFromMaps(prev, boardObject), {
    boardObjects: [boardObject.object_id],
  });
}

// ── Repos ─────────────────────────────────────────────────────────────────--
export function repoCreated(repo: Repo) {
  setMap('repoById', (prev) => {
    if (prev.has(repo.repo_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(repo.repo_id, repo);
    return next;
  });
}
export function repoPatched(repo: Repo) {
  setMap('repoById', (prev) => {
    // Attempts advance atomically on the server. A delayed old failure must not
    // undo an in-place retry; a new generation may legitimately leave failed.
    const current = prev.get(repo.repo_id);
    const generation = repo.clone_generation ?? 0;
    const previousGeneration = current?.clone_generation ?? 0;
    if (generation < previousGeneration) return prev;
    if (
      generation === previousGeneration &&
      (current?.clone_status === 'ready' || current?.clone_status === 'failed') &&
      repo.clone_status === 'cloning'
    )
      return prev;
    return replaceIfChanged(prev, repo.repo_id, repo);
  });
}
export function repoRemoved(repo: Repo) {
  setMap('repoById', (prev) => {
    if (!prev.has(repo.repo_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(repo.repo_id);
    return next;
  });
}

// ── Branches ──────────────────────────────────────────────────────────────--
export function branchCreated(branch: Branch) {
  // Bump the branches revision so an in-flight branches hydration can't clobber
  // this write (mirrors the session handlers).
  bumpRevision('branches', branch.branch_id);
  if (branch.archived) return;

  applyLive(
    (prev) => {
      if (prev.branchById.has(branch.branch_id)) return prev; // Already exists, shouldn't happen
      return { ...prev, branchById: new Map(prev.branchById).set(branch.branch_id, branch) };
    },
    { branches: [branch.branch_id] },
    true
  );
}
export function branchPatched(branch: Branch) {
  // The branch id stamp also fences the eviction cascade below: a partition
  // load skips every session/object/comment on a touched-and-absent branch.
  bumpRevision('branches', branch.branch_id);
  if (branch.archived) {
    // Archive preserves the board-object placement for a future unarchive.
    bumpRevision('sessions');
    evictArchivedBranch(branch.branch_id, liveCoverage(evictedWith(branch.branch_id, false)));
    return;
  }

  const from = agorStore.getState().branchById.get(branch.branch_id);
  const moved = from?.board_id !== branch.board_id;
  applyLive(
    (prev) => {
      const branchById = replaceIfChanged(prev.branchById, branch.branch_id, branch);
      return branchById === prev.branchById ? prev : { ...prev, branchById };
    },
    { branches: [branch.branch_id] },
    moved,
    moved ? markArrivalIncomplete(from?.board_id, branch.board_id) : undefined
  );
}
export function branchRemoved(branch: Branch) {
  // The branch id stamp fences the whole FK cascade below for partition loads.
  bumpRevision('branches', branch.branch_id);
  // Mirror the archive path: a hard delete should also evict any sessions we
  // still track on that branch and its FK-cascaded board placement.
  bumpRevision('sessions');
  bumpRevision('boardObjects');
  bumpRevision('boards');
  // The cascade clears these boards' teammate pointer; a partition's full
  // board record fetched before the delete must not restore it.
  for (const board of agorStore.getState().boardById.values()) {
    if (board.primary_teammate_id === branch.branch_id) bumpRevision('boards', board.board_id);
  }
  bumpRevision('comments');
  bumpRevision('sessionMcp');
  bumpRevision('gatewayChannels');
  bumpRevision('artifacts');
  const evicted = evictedWith(branch.branch_id, true);
  applyBranchHardDeleteCascade(branch.branch_id, liveCoverage(evicted));
  pruneSessionMcpLinks([...(evicted.sessions ?? [])]);
  // Collapse exceptions survive archive/move but not a hard delete.
  removeCollapsedBranchNode(branch.branch_id);
}

// ── Users ─────────────────────────────────────────────────────────────────--
export function userCreated(user: User) {
  setMap('userById', (prev) => {
    if (prev.has(user.user_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(user.user_id, user);
    return next;
  });
}
export function userPatched(user: User) {
  setMap('userById', (prev) => replaceIfChanged(prev, user.user_id, user));
}
export function userRemoved(user: User) {
  setMap('userById', (prev) => {
    if (!prev.has(user.user_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(user.user_id);
    return next;
  });
}

// ── MCP servers ───────────────────────────────────────────────────────────--
export function mcpServerCreated(server: MCPServer) {
  if (agorStore.getState().deletedMcpServerIds.has(server.mcp_server_id)) return;
  bumpRevision('mcpServers');
  setMap('mcpServerById', (prev) => {
    if (prev.has(server.mcp_server_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(server.mcp_server_id, server);
    return next;
  });
}
export function mcpServerPatched(server: MCPServer) {
  if (agorStore.getState().deletedMcpServerIds.has(server.mcp_server_id)) return;
  bumpRevision('mcpServers');
  setMap('mcpServerById', (prev) => replaceIfChanged(prev, server.mcp_server_id, server));
}
export function mcpServerRemoved(server: Pick<MCPServer, 'mcp_server_id'>) {
  bumpRevision('mcpServers');
  bumpRevision('sessionMcp');
  agorStore.setState((prev) => {
    const mcpServerById = new Map(prev.mcpServerById);
    mcpServerById.delete(server.mcp_server_id);
    const sessionMcpServerIds = new Map(prev.sessionMcpServerIds);
    for (const [sessionId, ids] of sessionMcpServerIds) {
      if (!ids.includes(server.mcp_server_id)) continue;
      const remaining = ids.filter((id) => id !== server.mcp_server_id);
      if (remaining.length) sessionMcpServerIds.set(sessionId, remaining);
      else sessionMcpServerIds.delete(sessionId);
    }
    const userAuthenticatedMcpServerIds = new Set(prev.userAuthenticatedMcpServerIds);
    userAuthenticatedMcpServerIds.delete(server.mcp_server_id);
    return {
      mcpServerById,
      sessionMcpServerIds,
      userAuthenticatedMcpServerIds,
      deletedMcpServerIds: new Set(prev.deletedMcpServerIds).add(server.mcp_server_id),
    };
  });
}

// ── Gateway channels ──────────────────────────────────────────────────────--
export function gatewayChannelCreated(channel: GatewayChannel) {
  bumpRevision('gatewayChannels');
  setMap('gatewayChannelById', (prev) => {
    if (prev.has(channel.id)) return prev;
    const next = new Map(prev);
    next.set(channel.id, channel);
    return next;
  });
}
export function gatewayChannelPatched(channel: GatewayChannel) {
  bumpRevision('gatewayChannels');
  setMap('gatewayChannelById', (prev) => replaceIfChanged(prev, channel.id, channel));
}
export function gatewayChannelRemoved(channel: GatewayChannel) {
  bumpRevision('gatewayChannels');
  setMap('gatewayChannelById', (prev) => {
    if (!prev.has(channel.id)) return prev;
    const next = new Map(prev);
    next.delete(channel.id);
    return next;
  });
}

// ── Cards ─────────────────────────────────────────────────────────────────--
/** Write the card map through `applyLive`, so card membership stays live. */
function writeCard(
  card: CardWithType,
  update: (prev: Map<string, CardWithType>) => Map<string, CardWithType>
) {
  applyLive(
    (prev) => {
      const cardById = update(prev.cardById);
      return cardById === prev.cardById ? prev : { ...prev, cardById };
    },
    { cards: [card.card_id] }
  );
}
export function cardCreated(card: CardWithType) {
  bumpRevision('cards', card.card_id);
  writeCard(card, (prev) => {
    if (prev.has(card.card_id)) return prev; // Duplicate event — bail.
    return new Map(prev).set(card.card_id, card);
  });
}
export function cardPatched(card: CardWithType) {
  bumpRevision('cards', card.card_id);
  writeCard(card, (prev) => replaceIfChanged(prev, card.card_id, card));
}
export function cardRemoved(card: CardWithType) {
  bumpRevision('cards', card.card_id);
  writeCard(card, (prev) => {
    if (!prev.has(card.card_id)) return prev;
    const next = new Map(prev);
    next.delete(card.card_id);
    return next;
  });
}

// ── Card types ────────────────────────────────────────────────────────────--
export function cardTypeCreated(cardType: CardType) {
  setMap('cardTypeById', (prev) => {
    if (prev.has(cardType.card_type_id)) return prev; // Duplicate event — bail.
    const next = new Map(prev);
    next.set(cardType.card_type_id, cardType);
    return next;
  });
}
export function cardTypePatched(cardType: CardType) {
  setMap('cardTypeById', (prev) => replaceIfChanged(prev, cardType.card_type_id, cardType));
}
export function cardTypeRemoved(cardType: CardType) {
  setMap('cardTypeById', (prev) => {
    if (!prev.has(cardType.card_type_id)) return prev;
    const next = new Map(prev);
    next.delete(cardType.card_type_id);
    return next;
  });
}

// ── Artifacts ─────────────────────────────────────────────────────────────--
export function artifactCreated(artifact: Artifact) {
  bumpRevision('artifacts');
  setMap('artifactById', (prev) => {
    if (prev.has(artifact.artifact_id)) return prev;
    const next = new Map(prev);
    next.set(artifact.artifact_id, artifact);
    return next;
  });
}
export function artifactPatched(artifact: Artifact) {
  bumpRevision('artifacts');
  setMap('artifactById', (prev) => replaceIfChanged(prev, artifact.artifact_id, artifact));
  // Notify ArtifactNode components that payload may have changed. The
  // consumer (apps/agor-ui/src/components/SessionCanvas/canvas/ArtifactNode.tsx)
  // already filters by `contentHash !== lastHashRef.current`, so an
  // idempotent dispatch is a cheap no-op there — no need to mirror the
  // shallow-equal bailout from a state-updater side effect (which would
  // not be pure under StrictMode anyway).
  window.dispatchEvent(
    new CustomEvent('agor:artifact-patched', {
      detail: { artifactId: artifact.artifact_id, contentHash: artifact.content_hash },
    })
  );
}
export function artifactRemoved(artifact: Artifact) {
  bumpRevision('artifacts');
  setMap('artifactById', (prev) => {
    if (!prev.has(artifact.artifact_id)) return prev;
    const next = new Map(prev);
    next.delete(artifact.artifact_id);
    return next;
  });
}

// Re-export transport-neutral relationship actions so existing websocket
// subscription wiring can keep using the realtime action namespace.
export { sessionMcpCreated, sessionMcpPatched, sessionMcpRemoved } from './sessionMcpActions';

// ── Board comments ────────────────────────────────────────────────────────--
export function commentCreated(comment: BoardComment) {
  bumpRevision('comments', comment.comment_id);
  setMap('commentById', (prev) => {
    if (prev.has(comment.comment_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(comment.comment_id, comment);
    return next;
  });
}
export function commentPatched(comment: BoardComment) {
  bumpRevision('comments', comment.comment_id);
  setMap('commentById', (prev) => replaceIfChanged(prev, comment.comment_id, comment));
}
export function commentRemoved(comment: BoardComment) {
  bumpRevision('comments', comment.comment_id);
  setMap('commentById', (prev) => {
    if (!prev.has(comment.comment_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(comment.comment_id);
    return next;
  });
}
