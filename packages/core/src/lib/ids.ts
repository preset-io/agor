/**
 * ID Management Utilities
 *
 * Agor uses UUIDv4 (random) for all entity identifiers.
 * This module provides generation, validation, and resolution utilities.
 *
 * Why UUIDv4 instead of UUIDv7?
 * - UUIDv7 has timestamp prefix → first 8 chars identical for ~65 seconds
 * - UUIDv4 is fully random → 8-char short IDs work perfectly (like Git)
 * - Database performance difference is negligible at our scale
 *
 * Key concepts:
 * - Full UUIDs stored in database (36 chars)
 * - Short IDs displayed to users (8 chars, Git-style)
 * - Git-style collision resolution (expand prefix when ambiguous)
 *
 * @see context/concepts/id-management.md
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

/**
 * UUIDv4 identifier (36 characters including hyphens)
 *
 * Format: 550e8400-e29b-41d4-a716-446655440000
 * - Fully random (122 bits of randomness)
 * - Version 4 (random) in version field
 * - Excellent for 8-char short IDs (like Git commit hashes)
 */
export type UUID = string & { readonly __brand: 'UUID' };

/**
 * Short ID prefix (8-16 characters, no hyphens)
 *
 * Used for display and user input.
 * Example: "01933e4a" (8 chars) or "01933e4a7b89" (12 chars)
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
 * Generate a new UUIDv4 identifier.
 *
 * UUIDv4 provides:
 * - Global uniqueness (2^122 possible values)
 * - Fully random (no timestamp clustering)
 * - Perfect for Git-style 8-char short IDs
 *
 * @returns A new UUIDv4 string
 *
 * @example
 * const sessionId = generateId();
 * // => "550e8400-e29b-41d4-a716-446655440000"
 */
export function generateId(): UUID {
  return uuidv4() as UUID;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Check if a string is a valid UUID (v4 or v7).
 *
 * Accepts both versions for backward compatibility:
 * - UUIDv4 (new): Fully random
 * - UUIDv7 (legacy): Timestamp-based
 *
 * Validates:
 * - Length (36 chars)
 * - Format (8-4-4-4-12 with hyphens)
 * - Version (4 or 7 in the version field)
 * - Variant (RFC 4122 compliant)
 *
 * @param value - String to validate
 * @returns True if valid UUID
 *
 * @example
 * isValidUUID("550e8400-e29b-41d4-a716-446655440000") // => true (v4)
 * isValidUUID("01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f") // => true (v7, legacy)
 * isValidUUID("not-a-uuid") // => false
 * isValidUUID("01933e4a") // => false (too short)
 */
export function isValidUUID(value: string): value is UUID {
  // Accept both v4 and v7 for backward compatibility
  // UUIDv4: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
  // UUIDv7: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
 * Extract short ID prefix from a full UUID.
 *
 * Removes hyphens and truncates to specified length.
 * Default length is 8 characters (recommended for most use cases).
 *
 * @param uuid - Full UUID
 * @param length - Prefix length (8-32 chars, default: 8)
 * @returns Short ID without hyphens
 *
 * @example
 * const uuid = "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f";
 * shortId(uuid) // => "01933e4a"
 * shortId(uuid, 12) // => "01933e4a7b89"
 * shortId(uuid, 16) // => "01933e4a7b897c35"
 */
export function shortId(uuid: UUID, length: number = 8): ShortID {
  const cleanUuid = uuid.replace(/-/g, '');
  return cleanUuid.slice(0, Math.min(length, 32));
}

/**
 * Format short ID for display (alias for shortId for backward compatibility)
 *
 * @deprecated Use shortId() instead
 */
export function formatShortId(uuid: UUID, length: number = 8): ShortID {
  return shortId(uuid, length);
}

/**
 * Format a UUID for display in UI/CLI.
 *
 * Returns short ID by default, with option to show full UUID.
 *
 * @param uuid - Full UUID
 * @param options - Formatting options
 * @returns Formatted ID string
 *
 * @example
 * formatIdForDisplay(uuid) // => "01933e4a"
 * formatIdForDisplay(uuid, { verbose: true }) // => "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f"
 * formatIdForDisplay(uuid, { length: 12 }) // => "01933e4a7b89"
 */
export function formatIdForDisplay(
  uuid: UUID,
  options: { verbose?: boolean; length?: number } = {}
): string {
  if (options.verbose) {
    return uuid;
  }
  return shortId(uuid, options.length);
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
  // Normalize prefix (remove hyphens, lowercase)
  const cleanPrefix = prefix.replace(/-/g, '').toLowerCase();

  // Find all entities whose IDs start with this prefix
  const matches = entities.filter(e => {
    const cleanId = e.id.replace(/-/g, '').toLowerCase();
    return cleanId.startsWith(cleanPrefix);
  });

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

  // Multiple matches - show suggestions with longer prefixes
  const suggestions = matches
    .slice(0, 10) // Limit to first 10 matches
    .map(m => {
      const description = getEntityDescription(m);
      return `  - ${shortId(m.id, 12)}: ${description}`;
    })
    .join('\n');

  const ellipsis = matches.length > 10 ? `\n  ... and ${matches.length - 10} more` : '';

  throw new IdResolutionError(
    `Ambiguous ID prefix: ${prefix}\n\n${matches.length} matches found:\n${suggestions}${ellipsis}\n\nUse a longer prefix to disambiguate.`,
    'ambiguous',
    prefix,
    matches.map(m => ({ id: m.id }))
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
 * Find the minimum unique prefix length for a set of IDs.
 *
 * Useful for determining optimal display length in tables.
 *
 * @param ids - Array of UUIDs
 * @returns Minimum prefix length to ensure uniqueness (8-32)
 *
 * @example
 * const ids = [
 *   "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f",
 *   "01933e4b-1234-7c35-a8f3-9d2e1c4b5a6f",
 * ];
 * findMinimumPrefixLength(ids) // => 9 (to distinguish 01933e4a vs 01933e4b)
 */
export function findMinimumPrefixLength(ids: UUID[]): number {
  if (ids.length <= 1) return 8; // Default minimum

  // Start with 8 chars and increment until all IDs are unique
  for (let length = 8; length <= 32; length++) {
    const prefixes = new Set(ids.map(id => shortId(id, length)));
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
  formatShortId,
  formatIdForDisplay,
  expandPrefix,
  resolveShortId,
  findMinimumPrefixLength,
  isUniquePrefix,
};
