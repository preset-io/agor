/**
 * Per-collection realtime entity actions for the Agor store.
 *
 * Each function is one socket handler — `replaceIfChanged` / cascade /
 * index-rebuild logic, `Object.is` bail-outs, per-collection `bumpRevision`
 * calls — writing through the store primitives (`setMap` / `applyMaps` /
 * `evictBranchAndSessions`). `useAgorData`'s subscribe effect wires socket
 * events straight to these.
 *
 * Background hydration: each handler bumps the matching per-collection revision
 * counter (`bumpRevision`, from `agorHydration`) so an in-flight background
 * hydration discards its snapshot rather than clobbering this live write —
 * INCLUDING the branch-eviction cascade, which mutates the sessions maps and so
 * bumps `sessions` too.
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
 *    (`evictBranchAndSessions`).
 */
import type {
  Artifact,
  Board,
  BoardComment,
  BoardEntityObject,
  Branch,
  CardType,
  CardWithType,
  GatewayChannel,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { bumpRevision } from './agorHydration';
import {
  applySessionPatchToMaps,
  removeBoardObjectFromMaps,
  replaceIfChanged,
  upsertBoardObjectInMaps,
} from './agorMaps';
import { type AgorState, agorStore } from './agorStore';

// Thin bindings to the store primitives. The vanilla store and its actions are
// stable module singletons, so these resolve the live action each call. The
// signatures are pulled straight off `AgorState` so the generic `setMap` key→
// value inference (and the `applyMaps` reducer / `evictBranchAndSessions`
// shapes) carry through to every callback below.
const setMap: AgorState['setMap'] = (key, value) => agorStore.getState().setMap(key, value);
const applyMaps: AgorState['applyMaps'] = (updater) => agorStore.getState().applyMaps(updater);
const evictBranchAndSessions: AgorState['evictBranchAndSessions'] = (branchId) =>
  agorStore.getState().evictBranchAndSessions(branchId);

// ── Sessions ────────────────────────────────────────────────────────────────
export function sessionCreated(session: Session) {
  // Bump the sessions revision so an in-flight sessions hydration discards its
  // snapshot and refetches instead of clobbering this write.
  bumpRevision('sessions');
  if (session.archived) return;

  // Update sessionById - only create new Map if session doesn't exist
  setMap('sessionById', (prev) => {
    if (prev.has(session.session_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(session.session_id, session);
    return next;
  });

  // Update sessionsByBranch - only create new Map when adding new session
  setMap('sessionsByBranch', (prev) => {
    const branchSessions = prev.get(session.branch_id) || [];
    // Check if session already exists in this branch (duplicate event)
    if (branchSessions.some((s) => s.session_id === session.session_id)) return prev;

    const next = new Map(prev);
    next.set(session.branch_id, [...branchSessions, session]);
    return next;
  });
}

export function sessionPatched(session: Session) {
  // Patch (incl. archive, which removes the session from the active maps) counts
  // as a live write — bump so an in-flight sessions hydration can't clobber it or
  // resurrect an archive with a pre-archive snapshot. One `applyMaps` commits
  // both `sessionById` and `sessionsByBranch` in a single store notify; the
  // reducer returns `prev` untouched on a no-op patch so references stay stable.
  bumpRevision('sessions');
  applyMaps((prev) => applySessionPatchToMaps(prev, session));
}

export function sessionRemoved(session: Session) {
  bumpRevision('sessions');
  // Update sessionById — bail out when the id isn't tracked so the
  // wrapper short-circuit prevents the spurious `maps` update.
  setMap('sessionById', (prev) => {
    if (!prev.has(session.session_id)) return prev;
    const next = new Map(prev);
    next.delete(session.session_id);
    return next;
  });

  // Update sessionsByBranch — same bail when the session isn't in the
  // branch's bucket.
  setMap('sessionsByBranch', (prev) => {
    const branchSessions = prev.get(session.branch_id);
    if (!branchSessions?.some((s) => s.session_id === session.session_id)) {
      return prev;
    }
    const next = new Map(prev);
    const filtered = branchSessions.filter((s) => s.session_id !== session.session_id);
    if (filtered.length > 0) {
      next.set(session.branch_id, filtered);
    } else {
      // Clean up empty arrays
      next.delete(session.branch_id);
    }
    return next;
  });
}

// ── Boards ──────────────────────────────────────────────────────────────────
// Boards are background-hydrated WITH their full `objects`/`custom_css` (the
// gated list fetch is lean), so every board write bumps the `boards` revision —
// otherwise an in-flight boards hydration whose (full) snapshot predates a zone
// create/move/delete could clobber the live change with the pre-edit board.
export function boardCreated(board: Board) {
  bumpRevision('boards');
  setMap('boardById', (prev) => {
    if (prev.has(board.board_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(board.board_id, board);
    return next;
  });
}
export function boardPatched(board: Board) {
  bumpRevision('boards');
  setMap('boardById', (prev) => replaceIfChanged(prev, board.board_id, board));
}
export function boardRemoved(board: Board) {
  bumpRevision('boards');
  setMap('boardById', (prev) => {
    if (!prev.has(board.board_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(board.board_id);
    return next;
  });
}

// ── Board objects ─────────────────────────────────────────────────────────--
export function boardObjectCreated(boardObject: BoardEntityObject) {
  bumpRevision('boardObjects');
  applyMaps((prev) => upsertBoardObjectInMaps(prev, boardObject, 'create'));
}
export function boardObjectPatched(boardObject: BoardEntityObject) {
  bumpRevision('boardObjects');
  applyMaps((prev) => upsertBoardObjectInMaps(prev, boardObject, 'patch'));
}
export function boardObjectRemoved(boardObject: BoardEntityObject) {
  bumpRevision('boardObjects');
  applyMaps((prev) => removeBoardObjectFromMaps(prev, boardObject));
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
  setMap('repoById', (prev) => replaceIfChanged(prev, repo.repo_id, repo));
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
  bumpRevision('branches');
  if (branch.archived) return;

  setMap('branchById', (prev) => {
    if (prev.has(branch.branch_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(branch.branch_id, branch);
    return next;
  });
}
export function branchPatched(branch: Branch) {
  bumpRevision('branches');
  if (branch.archived) {
    // The eviction cascade mutates BOTH the branches map (bumped above) and the
    // sessions maps, so bump the sessions revision too — otherwise a sessions
    // hydration in flight could resurrect the evicted sessions with a
    // pre-eviction snapshot.
    bumpRevision('sessions');
    evictBranchAndSessions(branch.branch_id);
    return;
  }

  setMap('branchById', (prev) => replaceIfChanged(prev, branch.branch_id, branch));
}
export function branchRemoved(branch: Branch) {
  bumpRevision('branches');
  // Mirror the archive path: a hard delete should also evict any sessions we
  // still track on that branch (and bump `sessions` for the cascade).
  bumpRevision('sessions');
  evictBranchAndSessions(branch.branch_id);
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
  bumpRevision('mcpServers');
  setMap('mcpServerById', (prev) => {
    if (prev.has(server.mcp_server_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(server.mcp_server_id, server);
    return next;
  });
}
export function mcpServerPatched(server: MCPServer) {
  bumpRevision('mcpServers');
  setMap('mcpServerById', (prev) => replaceIfChanged(prev, server.mcp_server_id, server));
}
export function mcpServerRemoved(server: MCPServer) {
  bumpRevision('mcpServers');
  setMap('mcpServerById', (prev) => {
    if (!prev.has(server.mcp_server_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(server.mcp_server_id);
    return next;
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
export function cardCreated(card: CardWithType) {
  bumpRevision('cards');
  setMap('cardById', (prev) => {
    if (prev.has(card.card_id)) return prev; // Duplicate event — bail.
    const next = new Map(prev);
    next.set(card.card_id, card);
    return next;
  });
}
export function cardPatched(card: CardWithType) {
  bumpRevision('cards');
  setMap('cardById', (prev) => replaceIfChanged(prev, card.card_id, card));
}
export function cardRemoved(card: CardWithType) {
  bumpRevision('cards');
  setMap('cardById', (prev) => {
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
export { sessionMcpCreated, sessionMcpRemoved } from './sessionMcpActions';

// ── Board comments ────────────────────────────────────────────────────────--
export function commentCreated(comment: BoardComment) {
  bumpRevision('comments');
  setMap('commentById', (prev) => {
    if (prev.has(comment.comment_id)) return prev; // Already exists, shouldn't happen
    const next = new Map(prev);
    next.set(comment.comment_id, comment);
    return next;
  });
}
export function commentPatched(comment: BoardComment) {
  bumpRevision('comments');
  setMap('commentById', (prev) => replaceIfChanged(prev, comment.comment_id, comment));
}
export function commentRemoved(comment: BoardComment) {
  bumpRevision('comments');
  setMap('commentById', (prev) => {
    if (!prev.has(comment.comment_id)) return prev; // Doesn't exist, nothing to remove
    const next = new Map(prev);
    next.delete(comment.comment_id);
    return next;
  });
}
