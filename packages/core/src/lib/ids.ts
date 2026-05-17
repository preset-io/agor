/**
 * ID Management Utilities
 *
 * Agor uses UUIDv7 (time-ordered) for all entity identifiers, per
 * context/concepts/id-management.md.
 *
 * Key concepts:
 * - Full UUIDs stored in database (36 chars)
 * - Short IDs displayed to users — always 20 hex chars via `shortId(id)`.
 *   See `SHORT_ID_LENGTH` in `../types/id` for the collision math.
 * - Git-style collision resolution on user input (expand prefix when
 *   ambiguous) — handled centrally by `resolveByShortIdPrefix` in
 *   `db/repositories/base.ts`.
 *
 * @see context/concepts/id-management.md
 */

import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  findByShortIdPrefix,
  SHORT_ID_LENGTH,
  shortId,
  toShortId,
  URL_SHORT_ID_LENGTH,
} from '../types/id';

export { findByShortIdPrefix, SHORT_ID_LENGTH, shortId, toShortId, URL_SHORT_ID_LENGTH };

// ============================================================================
// Types
// ============================================================================

/**
 * UUIDv7 identifier (36 characters including hyphens)
 *
 * Format: 01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f
 * - First 48 bits = Unix timestamp (ms precision)
 * - Time-ordered (sortable by creation time)
 * - Version 7 (time-ordered random) in version field
 */
export type UUID = string & { readonly __brand: 'UUID' };

/**
 * Short ID prefix — hex, no hyphens, `SHORT_ID_LENGTH` chars when emitted by
 * `shortId(id)`. May be shorter on inputs from users (CLI args, URL params),
 * which are resolved through the centralized ambiguity-throwing resolver.
 */
export type ShortID = string;

/**
 * Any length ID prefix for matching
 */
export type IDPrefix = string;

// ============================================================================
// Generation
// ============================================================================

/**
 * Generate a new UUIDv7 identifier with full per-call entropy.
 *
 * Why this isn't a bare `uuid.v7()` call:
 *
 * The `uuid@14` package's default `v7()` implements RFC 9562 **method 1** —
 * a per-millisecond-initialized monotonic counter (`seq`) that's encoded
 * into bytes 6–10. Without our intervention, *only bytes 11–15 (the last
 * 10 hex chars) are truly random per call* within a single millisecond.
 * A 24-char display prefix would carry ~10 bits of per-call entropy —
 * 50% birthday collision at ~32 same-ms IDs — the bug this whole effort
 * exists to prevent (see "Child session 019e372a has completed").
 *
 * Passing `{ random: randomBytes(16) }` bypasses the library's `_state`
 * machine entirely: bytes 6–15 are derived from the fresh random bytes we
 * supply, giving us RFC 9562 **method 3** behavior (74 bits of per-call
 * entropy). A 24-char prefix now carries ~42 random bits per ms (~2.5M
 * same-ms IDs before 50% birthday collision) — past any realistic Agor
 * workload by orders of magnitude.
 *
 * Trade-off: we give up the library's strict sub-millisecond `seq`
 * ordering. Ms-resolution time-ordering on the timestamp prefix
 * (bytes 0–5) is preserved, so DB index locality and "ORDER BY id ASC ≈
 * insertion order at second resolution" still work. The one caller that
 * relied on sub-ms ordering (`TaskRepository.createMany`) now imposes
 * insertion order explicitly. Existing IDs in the DB are unaffected.
 *
 * @returns A UUIDv7-shaped, RFC 9562 method-3 identifier.
 *
 * @example
 * const sessionId = generateId();
 * // => "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f"
 */
export function generateId(): UUID {
  return uuidv7({ random: randomBytes(16) }) as UUID;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Check if a string is a valid UUIDv7.
 *
 * Validates:
 * - Length (36 chars)
 * - Format (8-4-4-4-12 with hyphens)
 * - Version (7 in the version field)
 * - Variant (RFC 4122 compliant)
 *
 * @param value - String to validate
 * @returns True if valid UUIDv7
 *
 * @example
 * isValidUUID("01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f") // => true
 * isValidUUID("550e8400-e29b-41d4-a716-446655440000") // => false (v4)
 * isValidUUID("not-a-uuid") // => false
 * isValidUUID("01933e4a") // => false (too short)
 */
export function isValidUUID(value: string): value is UUID {
  // UUIDv7: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidPattern.test(value);
}

/**
 * Check if a string is a valid short ID prefix.
 *
 * Valid short IDs:
 * - 8-32 hexadecimal characters
 * - No hyphens (stripped for convenience)
 * - Must be valid prefix of a UUID
 *
 * @param value - String to validate
 * @returns True if valid short ID
 *
 * @example
 * isValidShortID("01933e4a") // => true
 * isValidShortID("01933e4a7b89") // => true
 * isValidShortID("xyz") // => false (not hex)
 * isValidShortID("123") // => false (too short)
 */
export function isValidShortID(value: string): value is ShortID {
  return /^[0-9a-f]{8,32}$/i.test(value);
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a UUID for display in UI/CLI.
 *
 * Returns canonical short ID by default; pass `{ verbose: true }` to get the
 * full UUID instead.
 *
 * @example
 * formatIdForDisplay(uuid) // => "01933e4a7b897c35a8f3"
 * formatIdForDisplay(uuid, { verbose: true }) // => full UUID
 */
export function formatIdForDisplay(uuid: UUID, options: { verbose?: boolean } = {}): string {
  return options.verbose ? uuid : shortId(uuid);
}

/**
 * Expand a short ID prefix to a SQL LIKE pattern.
 *
 * Handles partial UUIDs with or without hyphens.
 * Returns a pattern suitable for database queries.
 *
 * @param prefix - Short ID or partial UUID
 * @returns SQL LIKE pattern with wildcard
 *
 * @example
 * expandPrefix("01933e4a") // => "01933e4a%"
 * expandPrefix("01933e4a-7b89") // => "01933e4a-7b89%"
 * expandPrefix("01933e4a7b897c35a8f3") // => "01933e4a-7b89-7c35-a8f3%"
 */
export function expandPrefix(prefix: IDPrefix): string {
  // Remove all hyphens for consistent processing
  const clean = prefix.replace(/-/g, '').toLowerCase();

  if (clean.length === 0) {
    throw new Error('ID prefix cannot be empty');
  }

  if (!isValidShortID(clean)) {
    throw new Error(`Invalid ID prefix: ${prefix} (must be hexadecimal)`);
  }

  // If we have a full UUID without hyphens, reformat it
  if (clean.length === 32) {
    return formatUUIDWithHyphens(clean);
  }

  // For partial prefixes, add hyphens at standard positions
  let formatted = '';
  let pos = 0;

  // Format: 8-4-4-4-12
  const sections = [8, 4, 4, 4, 12];
  let offset = 0;

  for (const sectionLength of sections) {
    if (pos >= clean.length) break;

    const section = clean.slice(pos, pos + sectionLength);
    formatted += (offset > 0 ? '-' : '') + section;
    pos += section.length;

    if (section.length < sectionLength) {
      // Partial section, stop here and add wildcard
      return `${formatted}%`;
    }

    offset++;
  }

  return `${formatted}%`;
}

/**
 * Format a 32-character hex string as a standard UUID.
 *
 * @param hex - 32 hex characters (no hyphens)
 * @returns UUID with hyphens
 * @internal
 */
function formatUUIDWithHyphens(hex: string): UUID {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as UUID;
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Error thrown when short ID resolution fails
 */
export class IdResolutionError extends Error {
  constructor(
    message: string,
    public readonly type: 'not_found' | 'ambiguous',
    public readonly prefix?: string,
    public readonly candidates?: Array<{ id: string; label?: string }>
  ) {
    super(message);
    this.name = 'IdResolutionError';
  }
}

/**
 * Resolve a short ID prefix to a full entity.
 *
 * This implements git-style ID resolution:
 * - If exactly one match: return it
 * - If no matches: throw error
 * - If multiple matches: throw error with suggestions
 *
 * @param prefix - Short ID or partial UUID
 * @param entities - Array of entities to search
 * @returns Matching entity
 * @throws IdResolutionError if not found or ambiguous
 *
 * @example
 * const sessions = [
 *   { id: "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f", description: "Auth" },
 *   { id: "01934c2d-1234-7c35-a8f3-9d2e1c4b5a6f", description: "CORS" },
 * ];
 *
 * resolveShortId("01933e4a", sessions)
 * // => { id: "01933e4a-...", description: "Auth" }
 *
 * resolveShortId("0193", sessions)
 * // => Error: Ambiguous ID prefix
 */
export function resolveShortId<T extends { id: UUID }>(prefix: IDPrefix, entities: T[]): T {
  const matches = findByShortIdPrefix(prefix, entities);

  if (matches.length === 0) {
    throw new IdResolutionError(
      `No entity found with ID prefix: ${prefix}\n\nUse 'agor <entity> list' to see available IDs.`,
      'not_found',
      prefix
    );
  }

  if (matches.length === 1) {
    return matches[0];
  }

  // Multiple matches - show suggestions at canonical display length
  const suggestions = matches
    .slice(0, 10) // Limit to first 10 matches
    .map((m) => {
      const description = getEntityDescription(m);
      return `  - ${shortId(m.id)}: ${description}`;
    })
    .join('\n');

  const ellipsis = matches.length > 10 ? `\n  ... and ${matches.length - 10} more` : '';

  throw new IdResolutionError(
    `Ambiguous ID prefix: ${prefix}\n\n${matches.length} matches found:\n${suggestions}${ellipsis}\n\nUse a longer prefix to disambiguate.`,
    'ambiguous',
    prefix,
    matches.map((m) => ({ id: m.id }))
  );
}

/**
 * Get a human-readable description of an entity.
 *
 * Tries common description fields in order.
 *
 * @param entity - Entity to describe
 * @returns Description string
 * @internal
 */
// biome-ignore lint/suspicious/noExplicitAny: Accepts any entity type with description field
function getEntityDescription(entity: any): string {
  // Try common description fields
  if (entity.description) return entity.description;
  if (entity.full_prompt) return truncate(entity.full_prompt, 60);
  if (entity.name) return entity.name;
  if (entity.agent) return `(${entity.agent} session)`;

  return '(no description)';
}

/**
 * Truncate a string to a maximum length with ellipsis.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 * @internal
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 3)}...`;
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Find the minimum unique prefix length for a fixed set of IDs.
 *
 * Used by table-rendering code that wants the tightest non-collision display
 * for a known list (e.g. an `agor session list` table). This is the rare
 * case that legitimately needs a non-canonical length, so it reaches for the
 * lower-level `toShortId(id, length)` primitive directly.
 *
 * For general display (logs, notifications, URLs, single IDs in any
 * unbounded set), use `shortId(id)` — it's `SHORT_ID_LENGTH` (24) chars,
 * which is collision-safe for any realistic workload.
 *
 * @param ids - Array of UUIDs
 * @returns Minimum prefix length to ensure uniqueness within this set (8–32)
 */
export function findMinimumPrefixLength(ids: UUID[]): number {
  if (ids.length <= 1) return 8; // Default minimum for empty/singleton sets

  for (let length = 8; length <= 32; length++) {
    const prefixes = new Set(ids.map((id) => toShortId(id, length)));
    if (prefixes.size === ids.length) {
      return length;
    }
  }

  return 32; // Fallback to full UUID (should never happen)
}

/**
 * Check if an ID prefix is unique within a set of entities.
 *
 * @param prefix - Short ID prefix
 * @param entities - Entities to check against
 * @returns True if prefix matches exactly one entity
 *
 * @example
 * isUniquePrefix("01933e4a", sessions) // => true or false
 */
export function isUniquePrefix<T extends { id: UUID }>(prefix: IDPrefix, entities: T[]): boolean {
  try {
    resolveShortId(prefix, entities);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Exports
// ============================================================================

export default {
  generateId,
  isValidUUID,
  isValidShortID,
  shortId,
  toShortId,
  formatIdForDisplay,
  expandPrefix,
  resolveShortId,
  findByShortIdPrefix,
  findMinimumPrefixLength,
  isUniquePrefix,
  SHORT_ID_LENGTH,
  URL_SHORT_ID_LENGTH,
};
