/**
 * Versioned list reads for reconnecting clients (see `@agor/core/types`
 * `list-sync` for the protocol).
 *
 * Both hooks are installed at the app level so they wrap every service hook:
 *
 * - `stripListSyncQuery` (app `before`) takes `$sync` off the query before any
 *   service validation or filter sees it, so it can never become a column
 *   filter and never changes which rows the read selects.
 * - `projectListSyncResult` (app `after`) runs after every service `after`
 *   hook — tenant assertion, redaction, `lean` projection — on exactly the
 *   payload the transport will send (`dispatch ?? result`). It only replaces
 *   rows the caller already holds, byte for byte, with a slot index. It adds no
 *   row, field or id the plain read would not have returned.
 *
 * Nothing is stored between requests: the client sends the versions it holds.
 */

import { createHash } from 'node:crypto';
import { BadRequest } from '@agor/core/feathers';
import {
  type HookContext,
  isListSyncPath,
  LIST_SYNC_HASH_LENGTH,
  LIST_SYNC_ID_FIELDS,
  LIST_SYNC_QUERY_KEY,
  type ListSyncPage,
  splitListSyncVersions,
} from '@agor/core/types';

interface ListSyncParams {
  /** Parsed `$sync.known`: version -> slot index (first occurrence). */
  listSyncKnown?: Map<string, number>;
}

/** Version of one row as it is serialized to the caller. */
export function listSyncRowVersion(row: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(row) ?? '')
    .digest('base64url')
    .slice(0, LIST_SYNC_HASH_LENGTH);
}

export function stripListSyncQuery(context: HookContext): HookContext {
  if (context.method !== 'find') return context;
  const query = context.params.query as Record<string, unknown> | undefined;
  if (!query || !Object.hasOwn(query, LIST_SYNC_QUERY_KEY)) return context;

  const { [LIST_SYNC_QUERY_KEY]: sync, ...rest } = query;
  context.params.query = rest;
  // Only external callers on a versioned collection get the projection; for
  // anything else the key is simply dropped and the read is a plain find.
  if (!context.params.provider || !isListSyncPath(context.path)) return context;

  const knownValue =
    sync && typeof sync === 'object' ? (sync as { known?: unknown }).known : undefined;
  const versions = splitListSyncVersions(knownValue ?? '');
  if (!versions) throw new BadRequest('Invalid $sync.known');
  const known = new Map<string, number>();
  versions.forEach((version, index) => {
    if (!known.has(version)) known.set(version, index);
  });
  (context.params as ListSyncParams).listSyncKnown = known;
  return context;
}

export function projectListSyncResult(context: HookContext): HookContext {
  const known = (context.params as ListSyncParams).listSyncKnown;
  const path: string = context.path;
  if (context.method !== 'find' || !known || !isListSyncPath(path)) return context;

  const useDispatch = context.dispatch !== undefined;
  const payload: unknown = useDispatch ? context.dispatch : context.result;
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!rows) return context;

  const idField = LIST_SYNC_ID_FIELDS[path];
  const data: unknown[] = new Array(rows.length);
  let versions = '';
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const version = listSyncRowVersion(row);
    const slot = known.get(version);
    // A known version identifies one row the caller holds; a row carrying an
    // id can only match its own previous serialization.
    if (slot !== undefined && row && typeof row === 'object' && idField in row) {
      data[index] = slot;
    } else {
      data[index] = row;
      versions += version;
    }
  }

  const paginated = Array.isArray(payload)
    ? { total: rows.length, limit: rows.length, skip: 0 }
    : (payload as { total?: number; limit?: number; skip?: number });
  const page: ListSyncPage<unknown> = {
    total: paginated.total ?? rows.length,
    limit: paginated.limit ?? rows.length,
    skip: paginated.skip ?? 0,
    data,
    $sync: { versions },
  };
  if (useDispatch) context.dispatch = page;
  else context.result = page;
  return context;
}
