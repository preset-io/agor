/**
 * Searchable-fields registry — single source of truth for which fields each
 * entity type exposes to global search.
 *
 * V1 consumes these client-side via `useGlobalSearch` (substring AND-of-ORs
 * over the entity's full field set, see `matchSearchTokens` below). V2's
 * server-side fan-out (per design doc §5.7) will read the same registry to
 * build dialect-specific SQL — for SQLite via `like`, for Postgres via
 * `ilike` / `tsvector`. Either way, adding/removing a searchable field is a
 * one-place change here.
 *
 * Why functions, not column-name lists: V1 needs to extract live values from
 * in-memory entity objects (some fields live in JSON columns like
 * `data.custom_context.teammate.displayName`, which can't be expressed as a
 * column name alone). V2 can layer a parallel column-name list onto the same
 * shape when it lands.
 *
 * The `branch` entry covers both pure branches and teammates — they share
 * the underlying table row, so the field set is unified. Render-time type
 * discrimination (branch vs. teammate) happens at the caller via
 * `isTeammate()`.
 */

import type { Artifact } from '../types/artifact.js';
import type { Board } from '../types/board.js';
import { type Branch, getTeammateConfig } from '../types/branch.js';
import type { MCPServer } from '../types/mcp.js';
import type { Session } from '../types/session.js';

/** Extracts the searchable string values from an entity. */
export type SearchFieldExtractor<T> = (item: T) => Array<string | undefined | null>;

export const SEARCHABLE_FIELDS = {
  session: ((s) => [s.title, s.description, s.agentic_tool]) as SearchFieldExtractor<Session>,
  branch: ((b) => [
    b.name,
    b.ref,
    b.notes,
    b.issue_url,
    b.pull_request_url,
    getTeammateConfig(b)?.displayName,
  ]) as SearchFieldExtractor<Branch>,
  artifact: ((a) => [a.name, a.description]) as SearchFieldExtractor<Artifact>,
  board: ((b) => [b.name, b.description]) as SearchFieldExtractor<Board>,
  mcp: ((m) => [m.name, m.display_name, m.description]) as SearchFieldExtractor<MCPServer>,
} as const;

/**
 * AND-of-ORs substring match per design doc §3.3 — every token must appear in
 * at least one of the supplied field values (case-insensitive). `null` and
 * `undefined` field values are skipped, as are empty/whitespace-only tokens.
 *
 * Tokens are lowercased internally, so callers don't have to pre-normalize.
 * The default UI client already runs them through `tokenizeSearchQuery()`
 * (which lowercases too), but external callers — e.g. a future server-side
 * fan-out — can pass arbitrary case without surprises.
 *
 *     matchSearchTokens(tokens, SEARCHABLE_FIELDS.session(session))
 */
export function matchSearchTokens(
  tokens: string[],
  fields: Array<string | undefined | null>
): boolean {
  const normalized = tokens.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return false;
  const haystack = fields
    .filter((f): f is string => Boolean(f))
    .join(' \n ')
    .toLowerCase();
  return normalized.every((t) => haystack.includes(t));
}

/**
 * Tokenize a raw query into lowercase whitespace-separated tokens, dropping
 * empties. Centralized here so client and (future) server fan-out agree on
 * the same split rules.
 */
export function tokenizeSearchQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
