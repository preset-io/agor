/**
 * Session ↔ MCP links, loaded per session on first need (design r3 §6).
 *
 * There is no global `session-mcp-servers` read. A surface that shows or edits
 * one session's links calls `loadSessionMcpServerIds` (via
 * `useSessionMcpServerIds`), which reads `session-mcp-servers.find({ session_id })`
 * and records the session in `sessionMcpLoaded`. Realtime link events keep
 * applying for every session, so `sessionMcpServerIds` may hold a PARTIAL set
 * for a session that is not loaded: "not loaded" is never "none attached".
 * Every edit diff therefore requires the session to be loaded
 * (`updateSessionMcpServers`), or it could detach links it never saw.
 *
 * Links are a set of (session, server) pairs maintained by delta events, so
 * the touched fence is per pair: a `created`/`removed` event during the read
 * stamps its pair, and that pair keeps its live presence; every other pair
 * comes from the snapshot. A `patched` event publishes the session's complete
 * selection and stamps the session itself: the live selection then wins whole.
 */
import type { AgorClient } from '@agor-live/client';
import {
  beginPartitionLoad,
  endPartitionLoad,
  type HydratedCollection,
  markTouched,
  touchedSince,
} from './agorHydration';
import { agorStore } from './agorStore';
import { captureLoadLifetime, isLoadLifetimeCurrent } from './loadLifetime';

/** Touched-fence id of one (session, server) link. */
export function sessionMcpPairKey(sessionId: string, mcpServerId: string): string {
  return `${sessionId}\u0000${mcpServerId}`;
}

/**
 * Merge one session's link snapshot under the per-pair fence. Returns `prev`
 * when nothing changes.
 */
export function mergeSessionMcpSnapshot(
  prev: Map<string, string[]>,
  sessionId: string,
  snapshotIds: readonly string[],
  options: {
    deletedMcpServerIds: ReadonlySet<string>;
    touched: (id: string) => boolean;
  }
): Map<string, string[]> {
  const { deletedMcpServerIds, touched } = options;
  // A complete selection landed live during the read: it is newer.
  if (touched(sessionId)) return prev;
  const live = prev.get(sessionId) ?? [];
  const pairTouched = (id: string) => touched(sessionMcpPairKey(sessionId, id));
  const next: string[] = [];
  for (const id of snapshotIds) {
    if (deletedMcpServerIds.has(id) || next.includes(id)) continue;
    if (pairTouched(id) && !live.includes(id)) continue; // removed live
    next.push(id);
  }
  for (const id of live) {
    if (!next.includes(id) && pairTouched(id)) next.push(id); // created live
  }
  if (next.length === live.length && next.every((id, i) => id === live[i])) return prev;
  const map = new Map(prev);
  if (next.length > 0) map.set(sessionId, next);
  else map.delete(sessionId);
  return map;
}

const inflight = new Map<string, Promise<void>>();
// A read that started before a reset (`sessionMcpEpoch`) never marks its
// session loaded afterwards; the epoch is reactive, so readers re-run.
const epoch = () => agorStore.getState().sessionMcpEpoch;

/**
 * Forget which sessions are loaded (a reconnect may have missed link events;
 * an authority change may change which links are visible). Rows stay on
 * screen; mounted readers reload and their edit controls wait meanwhile.
 */
/** Touched-fence id recording that a session was deleted. */
const deletedKey = (sessionId: string) => `deleted\u0000${sessionId}`;

/**
 * Forget deleted sessions' links and loaded marks (realtime `removed`, or a
 * hard-deleted branch's cascade). The deletion is stamped on the touched
 * fence, so a read in flight for the session applies nothing. The caller
 * has already bumped the `sessionMcp` revision for this removal.
 */
export function pruneSessionMcpLinks(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  for (const id of sessionIds) markTouched('sessionMcp', deletedKey(id));
  agorStore.getState().forgetSessionMcp(sessionIds);
}

export function resetSessionMcpLinks(): void {
  agorStore.getState().resetSessionMcpLoaded();
}

/**
 * Load one session's MCP links and record it in `sessionMcpLoaded`.
 * Deduplicated per (lifetime, generation, session). A failed read leaves the
 * session unloaded; it is retried after the next reset or remount.
 */
export function loadSessionMcpServerIds(client: AgorClient, sessionId: string): Promise<void> {
  // Captured before the first await, like every load (see `loadLifetime`).
  const lifetime = captureLoadLifetime();
  if (!lifetime) return Promise.resolve();
  const loadGeneration = epoch();
  const key = `${lifetime.authorityScope}\u0000${lifetime.loadEpoch}\u0000${loadGeneration}\u0000${sessionId}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const isCurrent = () => isLoadLifetimeCurrent(lifetime) && loadGeneration === epoch();
  const run = async () => {
    const fence = beginPartitionLoad();
    try {
      const result = (await client
        .service('session-mcp-servers')
        .find({ query: { session_id: sessionId } })) as
        | Array<{ session_id: string; mcp_server_id: string }>
        | { data: Array<{ session_id: string; mcp_server_id: string }> };
      if (!isCurrent()) return;
      const collection: HydratedCollection = 'sessionMcp';
      const start = fence.startRevisions[collection];
      if (touchedSince(collection, deletedKey(sessionId), start)) return;
      const rows = Array.isArray(result) ? result : result.data;
      const snapshotIds = rows
        .filter((row) => row.session_id === sessionId)
        .map((row) => row.mcp_server_id);
      const store = agorStore.getState();
      store.applyMaps((prev) => {
        const sessionMcpServerIds = mergeSessionMcpSnapshot(
          prev.sessionMcpServerIds,
          sessionId,
          snapshotIds,
          {
            deletedMcpServerIds: agorStore.getState().deletedMcpServerIds,
            touched: (id) => touchedSince(collection, id, start),
          }
        );
        return sessionMcpServerIds === prev.sessionMcpServerIds
          ? prev
          : { ...prev, sessionMcpServerIds };
      });
      // `applyMaps` notifies synchronously; a subscriber may have ended this load.
      if (!isCurrent()) return;
      store.markSessionMcpLoaded(sessionId);
    } catch (err) {
      if (isCurrent()) console.warn(`[sessionMcpLinks] load failed for session ${sessionId}:`, err);
    } finally {
      endPartitionLoad();
    }
  };
  const promise = run().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
