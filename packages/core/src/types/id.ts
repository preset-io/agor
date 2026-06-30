/**
 * ID Type Definitions
 *
 * Centralized type definitions for UUIDv7 identifiers used across all Agor entities.
 *
 * @see context/concepts/id-management.md
 * @see src/lib/ids.ts
 */

/**
 * UUIDv7 identifier (36 characters including hyphens)
 *
 * Format: 01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f
 *
 * Structure:
 * - First 48 bits: Unix timestamp in milliseconds
 * - Next 12 bits: Random sequence for monotonic ordering
 * - Last 62 bits: Random data for uniqueness
 *
 * Properties:
 * - Globally unique (2^122 possible values)
 * - Time-ordered (sortable by creation time)
 * - Excellent database index performance
 * - Standard compliant (RFC 9562)
 *
 * @example
 * const sessionId: UUID = "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f";
 */
export type UUID = string & { readonly __brand: 'UUID' };

export type GroupID = UUID & { readonly __entity: 'Group' };

/**
 * Short ID prefix (hex, no hyphens, length `SHORT_ID_LENGTH`).
 *
 * Used everywhere a user sees an ID — URLs, notifications, pills, logs, CLI.
 * Maps back to full UUID via prefix matching (`findByShortIdPrefix`).
 *
 * Collision behavior for our UUIDv7-based IDs (same-millisecond, e.g. during
 * parent fan-out spawning):
 * - Chars 0–11 are the Unix-ms timestamp (deterministic per ms).
 * - Char 12 is the version nibble "7" (deterministic).
 * - Chars 13–31 are derived from per-call random bytes — `generateId()`
 *   passes fresh `randomBytes(16)` to `uuid.v7()`, bypassing the library's
 *   monotonic-counter `seq` state. Only the 2 variant bits at char 16 are
 *   fixed; everything else is truly random per call.
 *
 * Canonical display length is **24 chars**: 11 hex chars of per-call random
 * entropy = ~42 random bits per ms ≈ 4.4T slots → 50% birthday collision
 * at ~2.5M same-ms IDs. Past any realistic Agor workload. See `SHORT_ID_LENGTH`.
 *
 * @example
 * const display: ShortID = "01933e4a7b897c35a8f39d2e"; // 24 chars (canonical)
 */
export type ShortID = string;

/**
 * Any length ID prefix for matching
 *
 * Used internally for flexible ID resolution.
 * Can be any partial prefix of a UUID (with or without hyphens).
 */
export type IDPrefix = string;

/**
 * Unresolved ID input — either a full UUID or a short ID prefix.
 *
 * Used at API entry points (MCP tools, REST routes) where callers may pass
 * either form. Must be resolved to a full UUID before use as a foreign key
 * or in database queries.
 *
 * @example
 * const input: IdInput = "01933e4a";                                // short prefix
 * const input: IdInput = "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f";  // full UUID
 */
export type IdInput = string;

/**
 * Any ID-like input accepted by short-id helpers.
 *
 * Useful at API boundaries where callers may provide:
 * - full UUIDs
 * - short prefixes
 * - plain string IDs not yet branded
 */
export type AnyShortId = UUID | ShortID | string;

/**
 * Canonical length of short IDs displayed to users (URLs, notifications,
 * pills, logs, CLI). One number, used consistently.
 *
 * Why 24:
 * - UUIDv7's first 48 bits are a millisecond timestamp (chars 0–11), and
 *   char 12 is the fixed version nibble "7" — both deterministic for IDs
 *   born in the same ms.
 * - Our `generateId()` passes fresh `randomBytes(16)` to `uuid.v7()`,
 *   bypassing the library's per-ms `seq` counter (RFC 9562 method 3).
 *   That makes chars 13–31 per-call random (minus 2 fixed variant bits
 *   at char 16) — 74 random bits per call total.
 * - At 24 chars we get 11 random hex chars after the deterministic prefix,
 *   ≈ 42 random bits per ms (≈ 4.4T slots) — 50% birthday collision at
 *   ~2.5M same-ms IDs, 1% at ~290K. Past any realistic Agor workload by
 *   orders of magnitude.
 *
 * Inputs from users can be shorter — the centralized resolver
 * (`resolveByShortIdPrefix`) handles "too short to be unique" by throwing
 * `AmbiguousIdError` rather than guessing.
 */
export const SHORT_ID_LENGTH = 24;

/**
 * @deprecated Use `SHORT_ID_LENGTH` — kept temporarily for any external
 * imports during the migration. Will be removed.
 */
export const URL_SHORT_ID_LENGTH = SHORT_ID_LENGTH;

/**
 * Extract a short-ID prefix of `length` hex chars from a UUID-like string.
 *
 * **Lower-level primitive.** Most code should call `shortId(id)` (canonical
 * `SHORT_ID_LENGTH`-char display form). Use this only when you have a
 * documented reason to pick a non-canonical length — e.g.
 * `findMinimumPrefixLength` searching for the shortest disambiguating prefix
 * in a fixed set, or the Unix-name carve-out in `unix/group-manager.ts`.
 *
 * Removes hyphens and truncates to the requested length (max 32).
 */
export function toShortId(id: AnyShortId, length: number = SHORT_ID_LENGTH): ShortID {
  return id.replace(/-/g, '').slice(0, Math.min(length, 32));
}

/**
 * Render a UUID as the canonical short ID for display.
 *
 * Always returns `SHORT_ID_LENGTH` hex chars (24). Use this everywhere a
 * user sees an ID — URLs, notifications, pills, logs, CLI — so every site
 * agrees on one collision-safe shape. No length parameter, by design: if
 * every site picks its own length, we get back the "Child session
 * 019e372a has completed" same-millisecond-collision bug this helper was
 * created to prevent. See `SHORT_ID_LENGTH` for collision math.
 *
 * Lives here (rather than `lib/ids.ts`) so it's available from the
 * browser-safe `@agor/core/client` surface for the React UI.
 *
 * @example
 * shortId("01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f") // => "01933e4a7b897c35a8f3"
 */
export function shortId(id: AnyShortId): ShortID {
  return toShortId(id, SHORT_ID_LENGTH);
}

/**
 * Convert a (possibly-hyphenated) short-ID prefix into a SQL `LIKE`-friendly
 * pattern that matches the canonical hyphenated UUID storage format.
 *
 * Repositories store IDs as full hyphenated UUIDs (e.g. `019e0eca-0d2d-7…`).
 * Users pass prefixes in mixed forms — bare hex (`019e0eca0d2d`), partial
 * hyphenated (`019e0eca-0d2d`), or copy-pasted from `AmbiguousIdError`
 * (which prints the full hyphenated UUID, so a prefix-truncation often
 * lands on a hyphen boundary). Without normalization, `LIKE '019e0eca0d2d%'`
 * can never match a row whose ID is `019e0eca-0d2d-7XXX-…` because of the
 * hyphen at position 8.
 *
 * This strips any hyphens from the input and re-inserts them at the
 * canonical UUID positions (8, 12, 16, 20 hex chars) so the resulting
 * pattern matches the stored format. Non-hex / empty inputs pass through
 * to a pattern that will naturally not match any UUID column.
 *
 * @example
 *   prefixToLikePattern('019e0eca')        === '019e0eca%'
 *   prefixToLikePattern('019e0eca0d2d')    === '019e0eca-0d2d%'
 *   prefixToLikePattern('019e0eca-0d2d')   === '019e0eca-0d2d%'
 *   prefixToLikePattern('019E0ECA')        === '019e0eca%' // lowercased
 */
export function prefixToLikePattern(prefix: string): string {
  const clean = prefix.replace(/-/g, '').toLowerCase();
  // Hyphens land at hex positions 8, 12, 16, 20 in a canonical UUID.
  const breaks = [8, 12, 16, 20];
  let out = '';
  let cursor = 0;
  for (const b of breaks) {
    if (b >= clean.length) {
      return `${out}${clean.slice(cursor)}%`;
    }
    out += `${clean.slice(cursor, b)}-`;
    cursor = b;
  }
  return `${out}${clean.slice(cursor)}%`;
}

/**
 * Find all entities whose ID starts with the given short-ID prefix.
 *
 * This is the shared short-ID matching primitive used by both core
 * resolution helpers (e.g. `resolveShortId`) and UI URL routers.
 * Semantics:
 * - Hyphens are stripped from both the prefix and entity IDs before matching.
 * - Case-insensitive.
 * - Forward prefix match only (`entity.id.startsWith(prefix)`) — this is the
 *   only direction that makes semantic sense for "URL carries a truncated ID".
 * - Empty or non-hex prefixes return `[]` (safe for direct use on
 *   unvalidated user/router input, with no throw).
 *
 * Callers that want stricter behavior (throw on empty, throw on ambiguity)
 * should wrap this with their own checks — see `resolveShortId` in `lib/ids`.
 */
export function findByShortIdPrefix<T extends { id: AnyShortId }>(
  prefix: IDPrefix,
  entities: Iterable<T>
): T[] {
  const cleanPrefix = prefix.replace(/-/g, '').toLowerCase();
  if (cleanPrefix.length === 0 || !/^[0-9a-f]+$/.test(cleanPrefix)) {
    return [];
  }
  const matches: T[] = [];
  for (const entity of entities) {
    const cleanId = entity.id.replace(/-/g, '').toLowerCase();
    if (cleanId.startsWith(cleanPrefix)) {
      matches.push(entity);
    }
  }
  return matches;
}

// ============================================================================
// Entity-Specific ID Types
// ============================================================================

/**
 * Session identifier
 *
 * Uniquely identifies a session across all boards and agents.
 *
 * @example
 * const sessionId: SessionID = "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f";
 */
export type SessionID = UUID;
export type SessionRelationshipID = UUID;

/**
 * Task identifier
 *
 * Uniquely identifies a task within the global task space.
 * Tasks are scoped to sessions via the `session_id` foreign key.
 *
 * @example
 * const taskId: TaskID = "0193a1b2-3c4d-7e5f-a8f3-9d2e1c4b5a6f";
 */
export type TaskID = UUID;

/**
 * Board identifier
 *
 * Uniquely identifies a board (collection of sessions).
 *
 * @example
 * const boardId: BoardID = "01935abc-def1-7234-a8f3-9d2e1c4b5a6f";
 */
export type BoardID = UUID;

/**
 * Agentic tool identifier
 *
 * Uniquely identifies an agentic coding tool configuration.
 *
 * @example
 * const agenticToolId: AgenticToolID = "01938abc-def1-7234-a8f3-9d2e1c4b5a6f";
 */
export type AgenticToolID = UUID;

/**
 * Message identifier
 *
 * Uniquely identifies a message in a conversation.
 * Messages are scoped to sessions via the `session_id` foreign key.
 *
 * @example
 * const messageId: MessageID = "0193d1e2-3f4a-7b5c-a8f3-9d2e1c4b5a6f";
 */
export type MessageID = UUID;

/**
 * User identifier
 *
 * Uniquely identifies a user in the system.
 *
 * @example
 * const userId: UserID = "0193f1a2-3b4c-7d5e-a8f3-9d2e1c4b5a6f";
 */
export type UserID = UUID;

/**
 * Branch identifier
 *
 * Uniquely identifies a git branch (isolated work context).
 *
 * @example
 * const branchId: BranchID = "0193g1h2-3i4j-7k5l-a8f3-9d2e1c4b5a6f";
 */
export type BranchID = UUID;

/**
 * Repository identifier
 *
 * Uniquely identifies a git repository registered with Agor.
 *
 * @example
 * const repoId: RepoID = "0193m1n2-3o4p-7q5r-a8f3-9d2e1c4b5a6f";
 */
export type RepoID = UUID;

/**
 * Comment identifier
 *
 * Uniquely identifies a board comment (human-to-human conversation).
 * Comments can be attached to boards, sessions, tasks, messages, or branches.
 *
 * @example
 * const commentId: CommentID = "0193h1i2-3j4k-7l5m-a8f3-9d2e1c4b5a6f";
 */
export type CommentID = UUID;

/**
 * Artifact identifier
 *
 * Uniquely identifies a Sandpack artifact (live web app on a board).
 *
 * @example
 * const artifactId: ArtifactID = "0194a1b2-3c4d-7e5f-a8f3-9d2e1c4b5a6f";
 */
export type ArtifactID = UUID;

/**
 * Note: Concepts and Reports use file paths as identifiers, not UUIDs.
 *
 * - Concepts: ConceptPath (e.g., "core.md", "explorations/cli.md")
 * - Reports: ReportPath (e.g., "<session-id>/<task-id>.md")
 *
 * See: src/types/concept.ts and src/types/report.ts
 */
