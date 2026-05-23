/**
 * Pure URL-param → entity-ID resolvers.
 *
 * Used by `useUrlState` to translate the URL params declared in the
 * route table into full UUIDs. Lives outside the hook file because
 * these are pure functions with no hook dependencies — keeping them
 * here makes them unit-testable and reusable from other UI code (e.g.
 * future deep-link components).
 *
 * Ambiguity policy is uniform: a short-ID prefix that matches more
 * than one entity is treated as not-found (`null`) rather than
 * mis-routed. With `SHORT_ID_LENGTH` now 24 (~290K same-ms IDs before
 * 1% collision), realistic URLs are unambiguous and silent
 * mis-routing would be the worse failure mode. The optional
 * `onAmbiguous` callback lets callers surface a dev warning.
 */

import { findByShortIdPrefix } from '@agor-live/client';

export function resolveByShortIdPure<T>(
  prefix: string,
  entries: Iterable<T>,
  getId: (entry: T) => string,
  onAmbiguous?: (prefix: string, matchCount: number) => void
): string | null {
  const matches = findByShortIdPrefix(
    prefix,
    Array.from(entries, (e) => ({ id: getId(e) }))
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  onAmbiguous?.(prefix, matches.length);
  return null;
}

/** Resolve a board param (slug or short-ID prefix) → board ID. Slug
 *  match wins (exact); short-ID match falls back to
 *  `resolveByShortIdPure`. */
export function resolveBoardFromUrlPure(
  boardParam: string,
  boardById: Map<string, { board_id: string; slug?: string }>,
  onAmbiguous?: (param: string, matchCount: number) => void
): string | null {
  for (const board of boardById.values()) {
    if (board.slug === boardParam) {
      return board.board_id;
    }
  }
  return resolveByShortIdPure(boardParam, boardById.values(), (b) => b.board_id, onAmbiguous);
}

export function resolveSessionFromShortIdPure(
  sessionShortId: string,
  sessionById: Map<string, { session_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  return resolveByShortIdPure(
    sessionShortId,
    sessionById.values(),
    (s) => s.session_id,
    onAmbiguous
  );
}

export function resolveWorktreeFromShortIdPure(
  worktreeShortId: string,
  worktreeById: Map<string, { worktree_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  return resolveByShortIdPure(
    worktreeShortId,
    worktreeById.values(),
    (w) => w.worktree_id,
    onAmbiguous
  );
}

export function resolveArtifactFromShortIdPure(
  artifactShortId: string,
  artifactById: Map<string, { artifact_id: string }>,
  onAmbiguous?: (shortId: string, matchCount: number) => void
): string | null {
  return resolveByShortIdPure(
    artifactShortId,
    artifactById.values(),
    (a) => a.artifact_id,
    onAmbiguous
  );
}
