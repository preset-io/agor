/**
 * Versioned full-set reads for the workspace store (protocol:
 * `@agor/core/types` list-sync).
 *
 * The store's unbounded reads (a board partition, the board list, comments)
 * go through `findAllVersioned`, so reading the same set again — a reconnect
 * resync re-reads the displayed board, the board list and comments — sends
 * only what changed. It returns exactly the rows a plain `findAll` would. It
 * tells the daemon which row versions this client already holds, and the
 * daemon sends a slot index instead of each such row.
 *
 * Versions are held per read scope: the collection plus its query (minus
 * paging), e.g. one board's sessions. A re-read of that scope offers them.
 *
 * A version is "held" only while the store's live row is still the object it
 * was recorded with (or shallow-equal to it, which implies identical content).
 * Anything a realtime event changed since then is simply re-sent in full.
 * Rows the scoped read no longer returns (deleted, archived, no longer
 * visible) drop out, exactly as in a full read.
 */

import { PAGINATION } from '@agor/core/config/browser';
import {
  isListSyncPage,
  LIST_SYNC_HASH_LENGTH,
  LIST_SYNC_ID_FIELDS,
  LIST_SYNC_MAX_KNOWN,
  LIST_SYNC_QUERY_KEY,
  type ListSyncPath,
} from '@agor/core/types';
import { shallowEqualEntity } from '../utils/shallowEqual';
import { agorStore } from './agorStore';

type Row = object;

interface HeldVersion {
  version: string;
  row: Row;
}

interface FindService {
  find(params: { query: Record<string, unknown> }): Promise<unknown>;
  findAll(params: { query: Record<string, unknown> }): Promise<Row[]>;
}

export interface ListSyncClient {
  service(path: string): unknown;
}

export type LiveRowLookup = (path: ListSyncPath, id: string) => Row | undefined;

/** Held versions per read scope (see `scopeKey`). */
const heldVersions = new Map<string, Map<string, HeldVersion>>();
let daemonLacksListSync = false;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The read scope a query selects: its collection and filters, not its paging. */
function scopeKey(path: ListSyncPath, query: Record<string, unknown>): string {
  const { $limit: _limit, $skip: _skip, ...scope } = query;
  return `${path}\u0000${stableStringify(scope)}`;
}

/** The store's current row for a versioned collection. */
export const liveStoreRow: LiveRowLookup = (path, id) => {
  const state = agorStore.getState();
  switch (path) {
    case 'sessions':
      return state.sessionById.get(id);
    case 'branches':
      return state.branchById.get(id);
    case 'board-objects':
      return state.boardObjectById.get(id);
    case 'board-comments':
      return state.commentById.get(id);
    case 'cards':
      return state.cardById.get(id);
    case 'boards':
      return state.boardById.get(id);
  }
};

/** Forget every held version (logout, authority change, store reset). */
export function resetListSyncVersions(): void {
  heldVersions.clear();
  daemonLacksListSync = false;
}

function isBadRequest(error: unknown): boolean {
  const e = error as { name?: unknown; code?: unknown } | null;
  return e?.name === 'BadRequest' || e?.code === 400;
}

/**
 * Read every row a query selects, transferring only rows this client doesn't
 * already hold from its previous read of the same scope (same `path` and
 * query, ignoring paging).
 */
export async function findAllVersioned<T extends Row>(
  client: ListSyncClient,
  path: ListSyncPath,
  query: Record<string, unknown>,
  liveRow: LiveRowLookup = liveStoreRow
): Promise<T[]> {
  const service = client.service(path) as FindService;
  const scope = scopeKey(path, query);
  if (daemonLacksListSync) {
    heldVersions.delete(scope);
    return (await service.findAll({ query })) as T[];
  }

  const idField = LIST_SYNC_ID_FIELDS[path];
  const knownIds: string[] = [];
  const knownVersions: string[] = [];
  for (const [id, held] of heldVersions.get(scope) ?? []) {
    if (knownIds.length >= LIST_SYNC_MAX_KNOWN) break;
    const live = liveRow(path, id);
    if (live && (live === held.row || shallowEqualEntity(live, held.row))) {
      knownIds.push(id);
      knownVersions.push(held.version);
    }
  }
  const known = knownVersions.join('');

  const limit = typeof query.$limit === 'number' ? query.$limit : PAGINATION.DEFAULT_LIMIT;
  const rows: T[] = [];
  const nextHeld = new Map<string, HeldVersion>();
  let skip = 0;
  let total: number | null = null;
  for (;;) {
    let page: unknown;
    try {
      page = await service.find({
        query: { ...query, $skip: skip, $limit: limit, [LIST_SYNC_QUERY_KEY]: { known } },
      });
    } catch (error) {
      if (!isBadRequest(error)) throw error;
      // A daemon that predates versioned reads rejects the unknown key.
      daemonLacksListSync = true;
      heldVersions.delete(scope);
      return (await service.findAll({ query })) as T[];
    }
    if (!isListSyncPage<T>(page)) {
      // A daemon that predates versioned reads ignored the key: plain rows.
      daemonLacksListSync = true;
      heldVersions.delete(scope);
      if (Array.isArray(page)) return page as T[];
      return (await service.findAll({ query })) as T[];
    }
    if (total !== null && page.total !== total) {
      throw new Error(`Versioned read of ${path} changed while pages were being read`);
    }
    total = page.total;

    let versionIndex = 0;
    for (const entry of page.data) {
      if (typeof entry === 'number') {
        // Unchanged since this client recorded it. Use the live row: it is
        // that version, or newer if a realtime event landed during the read.
        const id = knownIds[entry];
        const live = id === undefined ? undefined : liveRow(path, id);
        if (!live) continue; // removed locally while the read was in flight
        rows.push(live as T);
        const held = heldVersions.get(scope)?.get(id);
        if (held && (live === held.row || shallowEqualEntity(live, held.row))) {
          nextHeld.set(id, { version: knownVersions[entry], row: live });
        }
      } else {
        const version = page.$sync.versions.slice(
          versionIndex * LIST_SYNC_HASH_LENGTH,
          (versionIndex + 1) * LIST_SYNC_HASH_LENGTH
        );
        versionIndex += 1;
        rows.push(entry);
        const id = (entry as Record<string, unknown>)[idField];
        if (typeof id === 'string' && version.length === LIST_SYNC_HASH_LENGTH) {
          nextHeld.set(id, { version, row: entry });
        }
      }
    }

    skip += page.data.length;
    if (page.data.length === 0 || skip >= page.total) break;
  }

  heldVersions.set(scope, nextHeld);
  return rows;
}
