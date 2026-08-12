/**
 * Generic Utility Types
 *
 * Reusable type utilities for common patterns across Agor.
 */

// ============================================================================
// Input Type Utilities
// ============================================================================

/**
 * Input type for creating an entity
 *
 * Omits auto-generated fields (timestamps) and optionally allows ID for bulk operations.
 *
 * @template T - Entity type
 * @template OmitKeys - Additional keys to omit (e.g., 'user_id' if auto-assigned)
 *
 * @example
 * ```ts
 * type CreateSessionInput = CreateInput<Session, 'session_id'>;
 * // Omits: session_id, created_at, last_updated
 * ```
 */
export type CreateInput<T, OmitKeys extends keyof T = never> = Omit<
  T,
  'created_at' | 'last_updated' | 'updated_at' | OmitKeys
> & {
  // Allow optional ID for bulk operations or explicit ID assignment
  [K in Extract<keyof T, `${string}_id`>]?: T[K];
};

/**
 * Input type for updating an entity
 *
 * All fields optional except auto-generated ones.
 *
 * @template T - Entity type
 * @template OmitKeys - Additional keys to omit (e.g., immutable fields)
 *
 * @example
 * ```ts
 * type UpdateSessionInput = UpdateInput<Session, 'session_id' | 'created_at'>;
 * // All fields optional except session_id and created_at
 * ```
 */
export type UpdateInput<T, OmitKeys extends keyof T = never> = Partial<
  Omit<T, 'created_at' | 'last_updated' | 'updated_at' | OmitKeys>
>;

// ============================================================================
// Response Type Utilities
// ============================================================================

/**
 * Paginated result wrapper
 *
 * Standard pagination format used by FeathersJS.
 *
 * @template T - Entity type
 *
 * @example
 * ```ts
 * const result: PaginatedResult<Session> = {
 *   total: 100,
 *   limit: 10,
 *   skip: 0,
 *   data: sessions
 * };
 * ```
 */
export interface PaginatedResult<T> {
  /** Total number of matching entities */
  total: number;
  /** Maximum results per page */
  limit: number;
  /** Number of results skipped */
  skip: number;
  /** Array of entities for this page */
  data: T[];
}

// ============================================================================
// Database Type Utilities
// ============================================================================

/**
 * Flatten nested object for database storage
 *
 * Converts nested objects to dot notation for indexed columns.
 *
 * @template T - Object type
 *
 * @example
 * ```ts
 * type GitState = { ref: string; base_sha: string; };
 * type Flat = FlattenObject<GitState>;
 * // Result: { 'git_state.ref': string; 'git_state.base_sha': string; }
 * ```
 */
export type FlattenObject<T extends Record<string, unknown>> = {
  [K in keyof T as T[K] extends Record<string, unknown>
    ? `${string & K}.${string & keyof T[K]}`
    : K]: T[K] extends Record<string, unknown> ? T[K][keyof T[K]] : T[K];
};

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if value is non-null and non-undefined
 *
 * Useful for filtering arrays and narrowing types.
 *
 * @param value - Value to check
 * @returns True if value is defined (not null or undefined)
 *
 * @example
 * ```ts
 * const ids = [id1, undefined, id2, null].filter(isDefined);
 * // Result: [id1, id2] with type string[]
 * ```
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Check if value is a non-empty string
 *
 * @param value - Value to check
 * @returns True if value is a non-empty string
 *
 * @example
 * ```ts
 * const names = ['', 'Alice', '  ', 'Bob'].filter(isNonEmptyString);
 * // Result: ['Alice', 'Bob']
 * ```
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ============================================================================
// Mapped Type Utilities
// ============================================================================

/**
 * Make specific keys required
 *
 * @template T - Object type
 * @template K - Keys to make required
 *
 * @example
 * ```ts
 * type SessionWithTitle = RequireKeys<Session, 'title'>;
 * // Session with title required instead of optional
 * ```
 */
export type RequireKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Make specific keys optional
 *
 * @template T - Object type
 * @template K - Keys to make optional
 *
 * @example
 * ```ts
 * type PartialSession = PartialKeys<Session, 'description' | 'title'>;
 * // Session with description and title optional
 * ```
 */
export type PartialKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Make all properties and nested properties readonly
 *
 * @template T - Object type
 *
 * @example
 * ```ts
 * type ImmutableSession = DeepReadonly<Session>;
 * // All fields and nested fields are readonly
 * ```
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
