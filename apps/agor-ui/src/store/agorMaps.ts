/**
 * Normalized data-map shape + the pure index/merge helpers that maintain it.
 *
 * Lives here (rather than in `useAgorData`) so BOTH the zustand store
 * (`agorStore` / `agorRealtimeActions`) and the hook's `fetchData` share the
 * exact same reducers — and so the store can import `EMPTY_MAPS` at module load
 * without an import cycle back through the hook (the hook imports the store).
 * Nothing here touches React or the store; these are reference-preserving
 * immutable updaters (incl. `buildSessionMaps`).
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
  Link,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { shallowEqualEntity } from '../utils/shallowEqual';

/**
 * All server-backed data maps held in a single state object.
 *
 * Adding a new map here + to `EMPTY_MAPS` is all that's required — resetting
 * the store covers every field automatically.
 */
export type DataMaps = {
  sessionById: Map<string, Session>;
  sessionsByBranch: Map<string, Session[]>;
  boardById: Map<string, Board>;
  boardObjectById: Map<string, BoardEntityObject>;
  boardObjectsByBoardId: Map<string, BoardEntityObject[]>;
  // Global placement lookup. Branch placements are unique because a branch can
  // only have one board-object row at a time.
  boardObjectByBranchId: Map<string, BoardEntityObject>;
  // Global placement lookup. Cards follow the same one-row-per-card service
  // contract as branches; callers needing board-scoped iteration should use
  // boardObjectsByBoardId instead.
  boardObjectByCardId: Map<string, BoardEntityObject>;
  commentById: Map<string, BoardComment>;
  cardById: Map<string, CardWithType>;
  cardTypeById: Map<string, CardType>;
  repoById: Map<string, Repo>;
  branchById: Map<string, Branch>;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  gatewayChannelById: Map<string, GatewayChannel>;
  artifactById: Map<string, Artifact>;
  linkById: Map<string, Link>;
  linksByBranch: Map<string, Link[]>;
  linksBySession: Map<string, Link[]>;
  sessionMcpServerIds: Map<string, string[]>;
  userAuthenticatedMcpServerIds: Set<string>;
};

export const EMPTY_MAPS: DataMaps = {
  sessionById: new Map(),
  sessionsByBranch: new Map(),
  boardById: new Map(),
  boardObjectById: new Map(),
  boardObjectsByBoardId: new Map(),
  boardObjectByBranchId: new Map(),
  boardObjectByCardId: new Map(),
  commentById: new Map(),
  cardById: new Map(),
  cardTypeById: new Map(),
  repoById: new Map(),
  branchById: new Map(),
  userById: new Map(),
  mcpServerById: new Map(),
  gatewayChannelById: new Map(),
  artifactById: new Map(),
  linkById: new Map(),
  linksByBranch: new Map(),
  linksBySession: new Map(),
  sessionMcpServerIds: new Map(),
  userAuthenticatedMcpServerIds: new Set(),
};

// The data-map keys, derived once from EMPTY_MAPS. Used by `pickMaps` and the
// store's `applyMaps` to iterate slices generically (and stays in lockstep
// with DataMaps automatically when a new map is added).
export const MAP_KEYS = Object.keys(EMPTY_MAPS) as (keyof DataMaps)[];

/**
 * Project the data-map slices out of a wider state object (the store holds the
 * maps as top-level fields alongside meta + actions). Returns a fresh DataMaps
 * object whose slice references are the store's current ones — so callers can
 * run the existing whole-DataMaps reducers and diff the result per-slice.
 */
export function pickMaps(state: DataMaps): DataMaps {
  const maps = {} as DataMaps;
  for (const key of MAP_KEYS) {
    maps[key] = state[key] as never;
  }
  return maps;
}

// Generic byId-map replacer used by the per-entity `*Patched` handlers below.
// Returns `prev` unchanged when the incoming entity is shallow-equal to what
// we already hold — combined with the wrapper-level no-op short-circuit in
// `setMapSlice`, idempotent server-side patches become true no-ops. The
// per-entity handlers stay responsible for archive / branch-migration /
// cross-map cleanup; this helper only covers the plain "replace one entry"
// case.
export function replaceIfChanged<T extends object>(
  prev: Map<string, T>,
  id: string,
  entity: T
): Map<string, T> {
  const existing = prev.get(id);
  if (existing && shallowEqualEntity(existing, entity)) return prev;
  const next = new Map(prev);
  next.set(id, entity);
  return next;
}

// Reconcile a freshly-built id-map against the previous one: reuse the prior
// entity reference for every row that is value-equal, and return the PRIOR Map
// object itself when nothing changed at all. Without this, a wholesale rebuild
// (the background "load whole store" hydration, first-paint apply, reconnect
// resync) mints brand-new references for every row even when the data is
// identical — which invalidates the top-level store subscriptions and every
// per-entity memo/selector, re-rendering the whole board for no reason. This
// makes a wholesale apply of already-loaded data a true no-op for subscribers.
export function reconcileByIdMap<T extends object>(
  prev: Map<string, T> | undefined,
  next: Map<string, T>
): Map<string, T> {
  if (!prev || prev.size === 0) return next;
  let changed = prev.size !== next.size;
  for (const [id, value] of next) {
    const prior = prev.get(id);
    if (prior !== undefined && (prior === value || shallowEqualEntity(prior, value))) {
      // Reuse the prior reference so downstream `===`/memo checks stay quiet.
      if (prior !== value) next.set(id, prior);
    } else {
      changed = true;
    }
  }
  return changed ? next : prev;
}

// Build a plain `byId` Map from a fetched list. Used by the background
// (non-gated) fetches whose results land via their own setter rather than the
// single atomic map-apply the essential gate performs. Pass `prev` to preserve
// references for unchanged rows (see `reconcileByIdMap`).
export function buildById<T extends object>(
  list: readonly T[],
  key: keyof T,
  prev?: Map<string, T>
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) {
    map.set(item[key] as unknown as string, item);
  }
  return reconcileByIdMap(prev, map);
}

// Group session-MCP relationship rows by session_id.
export function buildSessionMcpMap(
  list: readonly { session_id: string; mcp_server_id: string }[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const relationship of list) {
    const ids = map.get(relationship.session_id);
    if (ids) ids.push(relationship.mcp_server_id);
    else map.set(relationship.session_id, [relationship.mcp_server_id]);
  }
  return map;
}

function removeLinkFromBucket(
  buckets: Map<string, Link[]>,
  ownerId: string | null | undefined,
  linkId: string
): Map<string, Link[]> {
  if (!ownerId) return buckets;
  const bucket = buckets.get(ownerId);
  if (!bucket?.some((item) => item.link_id === linkId)) return buckets;

  const next = new Map(buckets);
  const filtered = bucket.filter((item) => item.link_id !== linkId);
  if (filtered.length > 0) next.set(ownerId, filtered);
  else next.delete(ownerId);
  return next;
}

function upsertLinkInBucket(
  buckets: Map<string, Link[]>,
  ownerId: string | null | undefined,
  link: Link
): Map<string, Link[]> {
  if (!ownerId) return buckets;
  const bucket = buckets.get(ownerId) ?? [];
  const index = bucket.findIndex((item) => item.link_id === link.link_id);
  if (index >= 0 && shallowEqualEntity(bucket[index], link)) return buckets;

  const next = new Map(buckets);
  if (index === -1) {
    next.set(ownerId, [...bucket, link]);
  } else {
    const updated = [...bucket];
    updated[index] = link;
    next.set(ownerId, updated);
  }
  return next;
}

export function upsertLinkInMaps(prev: DataMaps, link: Link): DataMaps {
  const existing = prev.linkById.get(link.link_id);
  if (existing && shallowEqualEntity(existing, link)) return prev;

  const linkById = new Map(prev.linkById);
  linkById.set(link.link_id, link);

  let linksByBranch = prev.linksByBranch;
  let linksBySession = prev.linksBySession;

  if (existing?.branch_id && existing.branch_id !== link.branch_id) {
    linksByBranch = removeLinkFromBucket(linksByBranch, existing.branch_id, existing.link_id);
  }
  if (existing?.session_id && existing.session_id !== link.session_id) {
    linksBySession = removeLinkFromBucket(linksBySession, existing.session_id, existing.link_id);
  }

  if (link.branch_id && !link.session_id) {
    linksByBranch = upsertLinkInBucket(linksByBranch, link.branch_id, link);
    if (existing?.session_id) {
      linksBySession = removeLinkFromBucket(linksBySession, existing.session_id, existing.link_id);
    }
  } else if (link.session_id && !link.branch_id) {
    linksBySession = upsertLinkInBucket(linksBySession, link.session_id, link);
    if (existing?.branch_id) {
      linksByBranch = removeLinkFromBucket(linksByBranch, existing.branch_id, existing.link_id);
    }
  }

  return { ...prev, linkById, linksByBranch, linksBySession };
}

export function mergeLinksIntoMaps(prev: DataMaps, links: readonly Link[]): DataMaps {
  let next = prev;
  for (const link of links) next = upsertLinkInMaps(next, link);
  return next;
}

type PinnedBranchLinkHydrationDomain = {
  /**
   * Optional owner branch scope for a partial pinned-branch snapshot (for
   * example, the displayed board's branch ids). Omit for the global
   * owner_scope=branch,is_pinned=true domain.
   */
  branchIds?: ReadonlySet<string> | readonly string[];
  /**
   * Branch owners with a newer full-owner link bucket that this pinned-only
   * snapshot must not prune. Pinned snapshots may still upsert fetched links for
   * these owners; they just are not authoritative for deleting absent ones.
   */
  preserveBranchIds?: ReadonlySet<string> | readonly string[];
};

function normalizeDomainBranchIds(
  branchIds: PinnedBranchLinkHydrationDomain['branchIds']
): ReadonlySet<string> | null {
  if (!branchIds) return null;
  return branchIds instanceof Set ? branchIds : new Set(branchIds);
}

function isPinnedBranchLinkInDomain(
  link: Link,
  domainBranchIds: ReadonlySet<string> | null
): boolean {
  if (!link.branch_id || link.session_id || !link.is_pinned) return false;
  return !domainBranchIds || domainBranchIds.has(link.branch_id);
}

function isPinnedBranchLinkPrunable(
  link: Link,
  domainBranchIds: ReadonlySet<string> | null,
  preserveBranchIds: ReadonlySet<string> | null
): boolean {
  return (
    isPinnedBranchLinkInDomain(link, domainBranchIds) &&
    (!link.branch_id || !preserveBranchIds?.has(link.branch_id))
  );
}

/**
 * Reconcile a fetched `owner_scope=branch,is_pinned=true` snapshot into the
 * link maps. Unlike `mergeLinksIntoMaps`, this is domain-complete: cached
 * pinned branch links that are inside the fetched domain but absent from the
 * server snapshot are removed. Links outside that exact domain (session-owned,
 * unpinned branch links, or branch owners outside `branchIds`) are preserved.
 */
export function reconcilePinnedBranchLinksIntoMaps(
  prev: DataMaps,
  links: readonly Link[],
  domain: PinnedBranchLinkHydrationDomain = {}
): DataMaps {
  const domainBranchIds = normalizeDomainBranchIds(domain.branchIds);
  const preserveBranchIds = normalizeDomainBranchIds(domain.preserveBranchIds);
  const fetchedIds = new Set<string>();
  for (const link of links) {
    if (isPinnedBranchLinkInDomain(link, domainBranchIds)) {
      fetchedIds.add(link.link_id);
    }
  }

  let next = prev;
  for (const link of prev.linkById.values()) {
    if (
      isPinnedBranchLinkPrunable(link, domainBranchIds, preserveBranchIds) &&
      !fetchedIds.has(link.link_id)
    ) {
      next = removeLinkFromMaps(next, link.link_id);
    }
  }

  return mergeLinksIntoMaps(next, links);
}

function sameLinkArray(left: readonly Link[] | undefined, right: readonly Link[]): boolean {
  if (!left) return right.length === 0;
  if (left.length !== right.length) return false;
  return left.every((link, index) => shallowEqualEntity(link, right[index]));
}

function replaceLinkBucket(
  buckets: Map<string, Link[]>,
  ownerId: string,
  links: readonly Link[]
): Map<string, Link[]> {
  const existing = buckets.get(ownerId);
  if (sameLinkArray(existing, links)) return buckets;

  const next = new Map(buckets);
  if (links.length > 0) next.set(ownerId, [...links]);
  else next.delete(ownerId);
  return next;
}

function replaceFullOwnerLinksInMaps(
  prev: DataMaps,
  scope: 'branch' | 'session',
  ownerId: string,
  links: readonly Link[]
): DataMaps {
  const branchOwned = scope === 'branch';
  const ownerLinks = links.filter((link) =>
    branchOwned
      ? link.branch_id === ownerId && !link.session_id
      : link.session_id === ownerId && !link.branch_id
  );
  const fetchedIds = new Set(ownerLinks.map((link) => link.link_id));
  const bucketKey = branchOwned ? 'linksByBranch' : 'linksBySession';

  let next = prev;
  for (const link of prev[bucketKey].get(ownerId) ?? []) {
    if (!fetchedIds.has(link.link_id)) {
      next = removeLinkFromMaps(next, link.link_id);
    }
  }
  next = mergeLinksIntoMaps(next, ownerLinks);

  const nextBuckets = replaceLinkBucket(next[bucketKey], ownerId, ownerLinks);
  return nextBuckets === next[bucketKey] ? next : { ...next, [bucketKey]: nextBuckets };
}

export function replaceFullBranchLinksInMaps(
  prev: DataMaps,
  branchId: string,
  links: readonly Link[]
): DataMaps {
  return replaceFullOwnerLinksInMaps(prev, 'branch', branchId, links);
}

export function replaceFullSessionLinksInMaps(
  prev: DataMaps,
  sessionId: string,
  links: readonly Link[]
): DataMaps {
  return replaceFullOwnerLinksInMaps(prev, 'session', sessionId, links);
}

export function removeLinkFromMaps(prev: DataMaps, linkOrId: Link | string): DataMaps {
  const linkId = typeof linkOrId === 'string' ? linkOrId : linkOrId.link_id;
  const existing = prev.linkById.get(linkId);
  if (!existing) return prev;

  const linkById = new Map(prev.linkById);
  linkById.delete(linkId);

  return {
    ...prev,
    linkById,
    linksByBranch: removeLinkFromBucket(prev.linksByBranch, existing.branch_id, linkId),
    linksBySession: removeLinkFromBucket(prev.linksBySession, existing.session_id, linkId),
  };
}

// Derived board-object index set, built once from a fetched list. Shared by
// the essential (board-scoped, first-paint) index build and the background
// full-hydration pass — single source of truth so the two can't diverge.
export function buildBoardObjectMaps(list: readonly BoardEntityObject[]): {
  boardObjectById: Map<string, BoardEntityObject>;
  boardObjectsByBoardId: Map<string, BoardEntityObject[]>;
  boardObjectByBranchId: Map<string, BoardEntityObject>;
  boardObjectByCardId: Map<string, BoardEntityObject>;
} {
  const boardObjectById = new Map<string, BoardEntityObject>();
  const boardObjectsByBoardId = new Map<string, BoardEntityObject[]>();
  const boardObjectByBranchId = new Map<string, BoardEntityObject>();
  const boardObjectByCardId = new Map<string, BoardEntityObject>();
  for (const boardObject of list) {
    boardObjectById.set(boardObject.object_id, boardObject);

    const bucket = boardObjectsByBoardId.get(boardObject.board_id);
    if (bucket) bucket.push(boardObject);
    else boardObjectsByBoardId.set(boardObject.board_id, [boardObject]);

    if (boardObject.branch_id) {
      boardObjectByBranchId.set(boardObject.branch_id, boardObject);
    }
    if (boardObject.card_id) {
      boardObjectByCardId.set(boardObject.card_id, boardObject);
    }
  }
  return { boardObjectById, boardObjectsByBoardId, boardObjectByBranchId, boardObjectByCardId };
}

// Build the session lookups (`sessionById` + branch-bucketed `sessionsByBranch`)
// from a flat session list. Shared by the bounded first-paint build and the
// background full-hydration pass so the two can't diverge. Mirrors the realtime
// handlers: archived sessions stay in `sessionById` (so a direct archived-link
// can open the drawer) but are kept OUT of the branch buckets (so they never
// reappear as branch/board cards). Cross-branch remote-created sessions are
// projected as muted surrogate children under the creating session's branch.
export function buildSessionMaps(
  sessionsList: readonly Session[],
  prev?: { sessionById: Map<string, Session>; sessionsByBranch: Map<string, Session[]> }
): {
  sessionById: Map<string, Session>;
  sessionsByBranch: Map<string, Session[]>;
} {
  const sessionsById = new Map<string, Session>();
  const sessionsByBranchId = new Map<string, Session[]>();

  for (const session of sessionsList) {
    sessionsById.set(session.session_id, session);
    if (session.archived) continue;
    const branchId = session.branch_id;
    if (!sessionsByBranchId.has(branchId)) sessionsByBranchId.set(branchId, []);
    sessionsByBranchId.get(branchId)!.push(session);
  }

  for (const sourceSession of sessionsList) {
    if (sourceSession.archived) continue;
    for (const relationship of sourceSession.remote_relationships?.as_source ?? []) {
      if (relationship.relationship_type !== 'remote_create') continue;

      const targetSession = sessionsById.get(relationship.target_session_id);
      if (!targetSession) continue;

      const sourceBranchSessions = sessionsByBranchId.get(sourceSession.branch_id) ?? [];
      if (sourceBranchSessions.some((session) => session.session_id === targetSession.session_id)) {
        continue;
      }

      const remoteSurrogate = createRemoteSurrogateSession(
        sourceSession,
        targetSession,
        relationship
      );
      if (!remoteSurrogate) continue;

      sessionsByBranchId.set(sourceSession.branch_id, [...sourceBranchSessions, remoteSurrogate]);
    }
  }

  if (!prev || (prev.sessionById.size === 0 && prev.sessionsByBranch.size === 0)) {
    return { sessionById: sessionsById, sessionsByBranch: sessionsByBranchId };
  }

  // Reuse prior references for unchanged sessions and unchanged per-branch
  // buckets so a wholesale rebuild of already-loaded data doesn't re-render the
  // whole board. Sessions are reconciled first; buckets then remap to the
  // reconciled refs before comparing element-wise against the prior bucket.
  const sessionById = reconcileByIdMap(prev.sessionById, sessionsById);
  let bucketsChanged = prev.sessionsByBranch.size !== sessionsByBranchId.size;
  for (const [branchId, bucket] of sessionsByBranchId) {
    let remapped = bucket;
    for (let i = 0; i < bucket.length; i++) {
      // Remote surrogate rows intentionally reuse the target session id while
      // overriding branch_id / genealogy / remote_surrogate so they render under
      // the source branch. Do not canonicalize them back to `sessionById`, or a
      // full-session hydration rebuild will erase the surrogate projection.
      if (bucket[i].remote_surrogate) continue;

      const canonical = sessionById.get(bucket[i].session_id);
      if (canonical && canonical !== bucket[i]) {
        if (remapped === bucket) remapped = bucket.slice();
        remapped[i] = canonical;
      }
    }
    const prior = prev.sessionsByBranch.get(branchId);
    if (
      prior &&
      prior.length === remapped.length &&
      prior.every((session, i) => session === remapped[i])
    ) {
      sessionsByBranchId.set(branchId, prior); // reuse prior array ref
    } else {
      sessionsByBranchId.set(branchId, remapped);
      bucketsChanged = true;
    }
  }
  const sessionsByBranch = bucketsChanged ? sessionsByBranchId : prev.sessionsByBranch;

  return { sessionById, sessionsByBranch };
}

// Apply a single `session:patched` (incl. archive) to the branch-bucket map,
// returning `prevBuckets` unchanged when nothing moved. Split out of
// `applySessionPatchToMaps` only for readability; it carries the branch-
// migration cleanup, the muted remote-surrogate projection, and the content-
// equal bail that keeps a no-op patch from minting a fresh bucket array (so a
// `makeSessionsForBranchSelector` consumer doesn't re-render on an idempotent
// patch). Inserts on a missing id by design — the caller's tombstone/keyed
// queue, not this reducer, is what prevents a stale patch from resurrecting a
// removed session.
function applySessionPatchToBranchBuckets(
  prevBuckets: Map<string, Session[]>,
  session: Session,
  oldBranchId: string | null,
  isArchived: boolean
): Map<string, Session[]> {
  let changed = false;
  const next = new Map(prevBuckets);
  const newBranchId = session.branch_id;

  const removeFromBranch = (branchId: string) => {
    const bucket = next.get(branchId) || [];
    const filtered = bucket.filter((s) => s.session_id !== session.session_id);
    if (filtered.length !== bucket.length) {
      changed = true;
      if (filtered.length > 0) next.set(branchId, filtered);
      else next.delete(branchId);
    }
  };

  if (isArchived) {
    for (const [branchId, bucket] of next) {
      if (bucket.some((item) => item.session_id === session.session_id)) {
        removeFromBranch(branchId);
      }
    }
    return changed ? next : prevBuckets;
  }

  // Session moved between branches — drop it from the old bucket first.
  const branchMigrated = oldBranchId && oldBranchId !== newBranchId;
  if (branchMigrated) removeFromBranch(oldBranchId!);

  const branchSessions = next.get(newBranchId) || [];
  const index = branchSessions.findIndex((s) => s.session_id === session.session_id);
  let sourceSessionForRemoteProjection = session;

  if (index === -1) {
    next.set(newBranchId, [...branchSessions, session]);
    changed = true;
  } else {
    const mergedSession = preserveSessionRelationshipFields(session, branchSessions[index]);
    sourceSessionForRemoteProjection = mergedSession;

    // Content-equal to what we hold — leave the bucket ref untouched.
    if (
      branchSessions[index] === mergedSession ||
      shallowEqualEntity(branchSessions[index], mergedSession)
    ) {
      return changed ? next : prevBuckets;
    }

    const updatedSessions = [...branchSessions];
    updatedSessions[index] = mergedSession;
    next.set(newBranchId, updatedSessions);
    changed = true;

    // Refresh any remote/surrogate projections of this session that live in
    // other branch buckets, preserving their local tree placement.
    for (const [branchId, bucket] of next) {
      if (branchId === newBranchId) continue;

      let bucketChanged = false;
      const refreshedBucket = bucket.map((item) => {
        if (item.session_id !== session.session_id) return item;
        bucketChanged = true;
        return {
          ...preserveSessionRelationshipFields(session, item),
          branch_id: item.branch_id,
          genealogy: item.genealogy,
          remote_surrogate: item.remote_surrogate,
        };
      });

      if (bucketChanged) {
        next.set(branchId, refreshedBucket);
        changed = true;
      }
    }
  }

  // Project a `remote_create` source row into muted remote-surrogate children
  // now, rather than doing relationship work during render.
  for (const relationship of sourceSessionForRemoteProjection.remote_relationships?.as_source ??
    []) {
    if (relationship.relationship_type !== 'remote_create') continue;

    const targetSession = findSessionInBranchBuckets(next, relationship.target_session_id);
    if (!targetSession) continue;

    const sourceBranchSessions = next.get(sourceSessionForRemoteProjection.branch_id) ?? [];
    if (
      sourceBranchSessions.some((candidate) => candidate.session_id === targetSession.session_id)
    ) {
      continue;
    }

    const remoteSurrogate = createRemoteSurrogateSession(
      sourceSessionForRemoteProjection,
      targetSession,
      relationship
    );
    if (!remoteSurrogate) continue;

    next.set(sourceSessionForRemoteProjection.branch_id, [
      ...sourceBranchSessions,
      remoteSurrogate,
    ]);
    changed = true;
  }

  return changed ? next : prevBuckets;
}

// Pure `session:patched` reducer over the whole data-map object: updates
// `sessionById` + `sessionsByBranch` in one pass and returns `prev` untouched on
// a no-op (so `applyMaps`' whole-object short-circuit preserves references).
// Archive removes the session from the active maps but leaves the branch-bucket
// pruning to the buckets helper. This is the shared reducer for BOTH the direct
// `sessionPatched` action and the frame-coalesced flush, which composes many of
// these into a single store write.
export function applySessionPatchToMaps(prev: DataMaps, session: Session): DataMaps {
  const isArchived = session.archived === true;
  const existing = prev.sessionById.get(session.session_id);
  const oldBranchId = existing?.branch_id ?? null;

  let sessionById = prev.sessionById;
  if (isArchived) {
    if (existing) {
      sessionById = new Map(prev.sessionById);
      sessionById.delete(session.session_id);
    }
  } else {
    const mergedSession = preserveSessionRelationshipFields(session, existing);
    // Content-equal idempotent patch — keep the prior ref (safe false negative
    // on nested fields the daemon reserializes; see `replaceIfChanged`).
    if (!existing || !shallowEqualEntity(existing, mergedSession)) {
      sessionById = new Map(prev.sessionById);
      sessionById.set(session.session_id, mergedSession);
    }
  }

  const sessionsByBranch = applySessionPatchToBranchBuckets(
    prev.sessionsByBranch,
    session,
    oldBranchId,
    isArchived
  );

  if (sessionById === prev.sessionById && sessionsByBranch === prev.sessionsByBranch) {
    return prev;
  }
  return { ...prev, sessionById, sessionsByBranch };
}

export function removeBoardObjectFromBoardBucket(
  buckets: Map<string, BoardEntityObject[]>,
  boardObject: BoardEntityObject
): Map<string, BoardEntityObject[]> {
  const bucket = buckets.get(boardObject.board_id);
  if (!bucket?.some((item) => item.object_id === boardObject.object_id)) return buckets;

  const next = new Map(buckets);
  const filtered = bucket.filter((item) => item.object_id !== boardObject.object_id);
  if (filtered.length > 0) next.set(boardObject.board_id, filtered);
  else next.delete(boardObject.board_id);
  return next;
}

export function upsertBoardObjectInMaps(
  prev: DataMaps,
  boardObject: BoardEntityObject,
  mode: 'create' | 'patch'
): DataMaps {
  const existing = prev.boardObjectById.get(boardObject.object_id);
  if (mode === 'create' && existing) return prev;
  if (mode === 'patch' && existing && shallowEqualEntity(existing, boardObject)) return prev;

  const boardObjectById = new Map(prev.boardObjectById);
  boardObjectById.set(boardObject.object_id, boardObject);

  let boardObjectsByBoardId = prev.boardObjectsByBoardId;
  if (existing && existing.board_id !== boardObject.board_id) {
    boardObjectsByBoardId = removeBoardObjectFromBoardBucket(boardObjectsByBoardId, existing);
  }

  const bucket = boardObjectsByBoardId.get(boardObject.board_id) ?? [];
  const bucketIndex = bucket.findIndex((item) => item.object_id === boardObject.object_id);
  if (
    bucketIndex === -1 ||
    bucket[bucketIndex] !== boardObject ||
    !shallowEqualEntity(bucket[bucketIndex], boardObject)
  ) {
    const nextBuckets = new Map(boardObjectsByBoardId);
    if (bucketIndex === -1) {
      nextBuckets.set(boardObject.board_id, [...bucket, boardObject]);
    } else {
      const updatedBucket = [...bucket];
      updatedBucket[bucketIndex] = boardObject;
      nextBuckets.set(boardObject.board_id, updatedBucket);
    }
    boardObjectsByBoardId = nextBuckets;
  }

  let boardObjectByBranchId = prev.boardObjectByBranchId;
  if (existing?.branch_id && existing.branch_id !== boardObject.branch_id) {
    boardObjectByBranchId = new Map(boardObjectByBranchId);
    boardObjectByBranchId.delete(existing.branch_id);
  }
  if (boardObject.branch_id) {
    const existingByBranch = boardObjectByBranchId.get(boardObject.branch_id);
    if (!existingByBranch || !shallowEqualEntity(existingByBranch, boardObject)) {
      boardObjectByBranchId =
        boardObjectByBranchId === prev.boardObjectByBranchId
          ? new Map(boardObjectByBranchId)
          : boardObjectByBranchId;
      boardObjectByBranchId.set(boardObject.branch_id, boardObject);
    }
  }

  let boardObjectByCardId = prev.boardObjectByCardId;
  if (existing?.card_id && existing.card_id !== boardObject.card_id) {
    boardObjectByCardId = new Map(boardObjectByCardId);
    boardObjectByCardId.delete(existing.card_id);
  }
  if (boardObject.card_id) {
    const existingByCard = boardObjectByCardId.get(boardObject.card_id);
    if (!existingByCard || !shallowEqualEntity(existingByCard, boardObject)) {
      boardObjectByCardId =
        boardObjectByCardId === prev.boardObjectByCardId
          ? new Map(boardObjectByCardId)
          : boardObjectByCardId;
      boardObjectByCardId.set(boardObject.card_id, boardObject);
    }
  }

  return {
    ...prev,
    boardObjectById,
    boardObjectsByBoardId,
    boardObjectByBranchId,
    boardObjectByCardId,
  };
}

export function removeBoardObjectFromMaps(
  prev: DataMaps,
  boardObject: BoardEntityObject
): DataMaps {
  const existing = prev.boardObjectById.get(boardObject.object_id);
  if (!existing) return prev;

  const boardObjectById = new Map(prev.boardObjectById);
  boardObjectById.delete(existing.object_id);

  let boardObjectByBranchId = prev.boardObjectByBranchId;
  if (
    existing.branch_id &&
    boardObjectByBranchId.get(existing.branch_id)?.object_id === existing.object_id
  ) {
    boardObjectByBranchId = new Map(boardObjectByBranchId);
    boardObjectByBranchId.delete(existing.branch_id);
  }

  let boardObjectByCardId = prev.boardObjectByCardId;
  if (
    existing.card_id &&
    boardObjectByCardId.get(existing.card_id)?.object_id === existing.object_id
  ) {
    boardObjectByCardId = new Map(boardObjectByCardId);
    boardObjectByCardId.delete(existing.card_id);
  }

  return {
    ...prev,
    boardObjectById,
    boardObjectsByBoardId: removeBoardObjectFromBoardBucket(prev.boardObjectsByBoardId, existing),
    boardObjectByBranchId,
    boardObjectByCardId,
  };
}

export function preserveSessionRelationshipFields(session: Session, existing?: Session): Session {
  if (!existing) return session;

  const remoteRelationships = session.remote_relationships ?? existing.remote_relationships;
  const remoteSurrogate = session.remote_surrogate ?? existing.remote_surrogate;

  if (
    remoteRelationships === session.remote_relationships &&
    remoteSurrogate === session.remote_surrogate
  ) {
    return session;
  }

  return {
    ...session,
    ...(remoteRelationships !== undefined && { remote_relationships: remoteRelationships }),
    ...(remoteSurrogate !== undefined && { remote_surrogate: remoteSurrogate }),
  };
}

export function createRemoteSurrogateSession(
  sourceSession: Session,
  targetSession: Session,
  relationship: NonNullable<NonNullable<Session['remote_relationships']>['as_source']>[number]
): Session | null {
  if (relationship.relationship_type !== 'remote_create') return null;
  if (targetSession.archived) return null;
  if (targetSession.branch_id === sourceSession.branch_id) return null;

  return {
    ...targetSession,
    branch_id: sourceSession.branch_id,
    genealogy: {
      ...(targetSession.genealogy ?? {}),
      parent_session_id: sourceSession.session_id,
    },
    remote_surrogate: {
      relationship,
      source_session_id: sourceSession.session_id,
      source_branch_id: sourceSession.branch_id,
      target_branch_id: targetSession.branch_id,
    },
  };
}

export function findSessionInBranchBuckets(
  sessionsByBranchId: Map<string, Session[]>,
  sessionId: string
): Session | undefined {
  for (const bucket of sessionsByBranchId.values()) {
    const session = bucket.find((candidate) => candidate.session_id === sessionId);
    if (session && !session.remote_surrogate) return session;
  }
  return undefined;
}
