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

/**
 * Short ID prefix (8-16 characters, no hyphens)
 *
 * Used for display in UI/CLI and user input.
 * Maps to full UUID via prefix matching.
 *
 * Collision behavior for UUIDv7-based IDs:
 * - The first 48 bits of every ID are a millisecond Unix timestamp, so any
 *   prefix of 12 hex chars or fewer carries zero random bits and collides
 *   deterministically for IDs created in the same time bucket (e.g. 8 chars
 *   collide within ~65.5 s, 10 chars within ~256 ms, 12 chars within 1 ms).
 * - 16 hex chars covers the full timestamp plus the 12 random bits of
 *   `rand_a`, giving ~4,096 random slots per millisecond — safe for URLs.
 *   See `URL_SHORT_ID_LENGTH`.
 * - Display contexts (compact pills, tables) tolerate collisions because
 *   hover/tooltips reveal the full UUID; URL contexts do not.
 *
 * @example
 * const display: ShortID = "01933e4a";                  // 8 chars (pills/tables)
 * const url: ShortID = "01933e4a7b897c35";              // 16 chars (URL routing)
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
 * Length of short IDs used in URLs (e.g. `/b/<board>/<session>/`).
 *
 * UUIDv7's first 48 bits are a millisecond timestamp, so an 8-char prefix
 * carries zero random bits and collides deterministically for any two IDs
 * created within the same ~65.5s window. 16 hex chars covers the full 48-bit
 * timestamp plus the 12 random bits of `rand_a`, giving ~4,096 random slots
 * per millisecond — safe against realistic spawn bursts. Display contexts
 * (pills, tables) keep the compact 8-char default via `toShortId`.
 */
export const URL_SHORT_ID_LENGTH = 16;

/**
 * Extract short ID prefix from a UUID-like string.
 *
 * Removes hyphens and truncates to the requested length (max 32).
 * Shared by core and client surfaces to keep short-ID behavior consistent.
 */
export function toShortId(id: AnyShortId, length: number = 8): ShortID {
  return id.replace(/-/g, '').slice(0, Math.min(length, 32));
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
 * Worktree identifier
 *
 * Uniquely identifies a git worktree (isolated work context).
 *
 * @example
 * const worktreeId: WorktreeID = "0193g1h2-3i4j-7k5l-a8f3-9d2e1c4b5a6f";
 */
export type WorktreeID = UUID;

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
 * Comments can be attached to boards, sessions, tasks, messages, or worktrees.
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
