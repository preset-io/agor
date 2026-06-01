/**
 * Base Repository Interface
 *
 * Generic CRUD interface for type-safe repository pattern.
 * All repositories extend this base interface.
 */

import { isValidUUID } from '../../lib/ids';
import { prefixToLikePattern } from '../../types/id';

/**
 * Base repository interface with generic CRUD operations
 */
export interface BaseRepository<T, TInsert = T> {
  /**
   * Create a new entity
   */
  create(data: TInsert): Promise<T>;

  /**
   * Find entity by ID (supports short ID resolution)
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find all entities
   */
  findAll(): Promise<T[]>;

  /**
   * Update entity by ID
   */
  update(id: string, updates: Partial<TInsert>): Promise<T>;

  /**
   * Delete entity by ID
   */
  delete(id: string): Promise<void>;
}

/**
 * Base repository error
 */
export class RepositoryError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/**
 * Entity not found error
 */
export class EntityNotFoundError extends RepositoryError {
  constructor(
    public readonly entityType: string,
    public readonly id: string
  ) {
    super(`${entityType} with ID '${id}' not found`);
    this.name = 'EntityNotFoundError';
  }
}

/**
 * Ambiguous ID error
 */
export class AmbiguousIdError extends RepositoryError {
  constructor(
    public readonly entityType: string,
    public readonly prefix: string,
    public readonly matches: string[]
  ) {
    super(
      `Ambiguous ID prefix '${prefix}' for ${entityType} (${matches.length} matches: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '...' : ''})`
    );
    this.name = 'AmbiguousIdError';
  }
}

/**
 * Centralized short-ID prefix resolver for repositories.
 *
 * Given a user-supplied `id` (full UUID, or any-length hex prefix), returns
 * the matching full UUID. Throws `AmbiguousIdError` on >1 match,
 * `EntityNotFoundError` on 0 matches.
 *
 * The repository supplies `fetchMatches(pattern)` — a thin callback that
 * runs `SELECT <id_col> FROM <table> WHERE <id_col> LIKE pattern LIMIT 11`
 * and returns the full ID strings. Limit 11 = "we only need to know 0/1/2+,
 * plus a few extra for a useful error message; never load every match."
 *
 * Why centralized: this exact LIMIT-then-throw pattern was duplicated across
 * `cards.ts`, `users.ts`, `mcp-servers.ts`, `board-comments.ts`, and
 * `card-types.ts`. Centralizing means a single place to tune the limit, the
 * full-UUID short-circuit, and the error contract.
 */
export async function resolveByShortIdPrefix(
  id: string,
  entityType: string,
  fetchMatches: (pattern: string) => Promise<string[]>
): Promise<string> {
  // Full UUID → bypass the matcher. `isValidUUID` is strict (length, version,
  // variant) so we don't accidentally pattern-match a malformed 36-char input.
  if (isValidUUID(id)) {
    return id;
  }

  const pattern = prefixToLikePattern(id);
  const matches = await fetchMatches(pattern);

  if (matches.length === 0) {
    throw new EntityNotFoundError(entityType, id);
  }
  if (matches.length > 1) {
    throw new AmbiguousIdError(entityType, id, matches);
  }
  return matches[0];
}

/**
 * Recommended row limit for the `fetchMatches` callback in
 * `resolveByShortIdPrefix`. We only need to distinguish 0 / 1 / 2+; the extra
 * rows feed a richer `AmbiguousIdError.matches` list without unbounded growth.
 */
export const RESOLVE_SHORT_ID_FETCH_LIMIT = 11;
