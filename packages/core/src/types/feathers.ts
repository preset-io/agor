/**
 * FeathersJS Type Abstractions
 *
 * Centralized type definitions for FeathersJS patterns used across Agor.
 * These types provide a consistent interface for both client and server.
 *
 * Re-exports FeathersJS types so daemon doesn't need direct dependencies.
 */

import type {
  HookContext as FeathersHookContext,
  Id,
  NullableId,
  Paginated,
  Params,
  Service,
  ServiceMethods,
} from '@feathersjs/feathers';

// ============================================================================
// Re-exported FeathersJS Types (for daemon usage without direct import)
// ============================================================================

/**
 * Re-export FeathersJS core types
 *
 * Daemon should import these from @agor/core/types instead of @feathersjs/feathers
 * This provides:
 * - Single dependency layer (core)
 * - Version control (core manages Feathers version)
 * - Easier mocking/testing
 */
export type { Id, NullableId, Paginated, Params, Service, ServiceMethods };

// ============================================================================
// Authentication Types
// ============================================================================

/**
 * Authenticated user from JWT/Local strategy
 *
 * Extracted from JWT token or local authentication.
 * Available in hook context and service params after authentication.
 */
export interface AuthenticatedUser {
  /** User ID (UUIDv7) */
  user_id: string;
  /** User email address */
  email: string;
  /** User role (for authorization) - always defined, defaults to 'member' */
  role: string;
}

/**
 * Extended params with authentication context
 *
 * All authenticated requests include user information in params.
 */
export interface AuthenticatedParams extends Params {
  /** Authenticated user (undefined for anonymous requests) */
  user?: AuthenticatedUser;
}

/**
 * Extended params with RBAC cache properties
 *
 * Used by worktree-authorization hooks to cache loaded entities and permissions
 * to avoid redundant database queries within a hook chain.
 *
 * @example
 * ```ts
 * // In loadWorktree hook
 * function loadWorktree(worktreeRepo: WorktreeRepository) {
 *   return async (context: HookContext) => {
 *     const worktree = await worktreeRepo.findById(worktreeId);
 *     const isOwner = await worktreeRepo.isOwner(worktree.worktree_id, userId);
 *
 *     // Cache for downstream hooks (type-safe!)
 *     const rbacParams = context.params as RBACParams;
 *     rbacParams.worktree = worktree;
 *     rbacParams.isWorktreeOwner = isOwner;
 *   };
 * }
 * ```
 */
export interface RBACParams extends AuthenticatedParams {
  /** Cached worktree from loadWorktree/loadSessionWorktree hooks */
  worktree?: import('./worktree').Worktree;
  /** Cached ownership status for current user */
  isWorktreeOwner?: boolean;
  /** Cached session from loadSession/loadSessionWorktree hooks */
  session?: import('./session').Session;
  /** Cached session ID from resolveSessionContext hook */
  sessionId?: string;
}

// ============================================================================
// Query Parameter Types
// ============================================================================

/**
 * Generic service query parameters with Feathers $ modifiers
 *
 * Supports pagination, sorting, field selection, and entity-specific filters.
 *
 * @template T - Entity type for type-safe filtering
 *
 * @example
 * ```ts
 * interface SessionQuery extends QueryParams<Session> {
 *   query?: {
 *     status?: Session['status'];
 *     agentic_tool?: Session['agentic_tool'];
 *     $limit?: number;
 *     $skip?: number;
 *   };
 * }
 * ```
 */
export interface QueryParams<T = unknown> extends Params {
  query?: {
    /** Maximum number of results to return */
    $limit?: number;
    /** Number of results to skip (for pagination) */
    $skip?: number;
    /** Sort order (1 = ascending, -1 = descending) */
    $sort?: Record<string, 1 | -1>;
    /** Fields to include in results */
    $select?: string[];
  } & Partial<T>;
}

// ============================================================================
// Hook Context Types
// ============================================================================

/**
 * Hook context for create operations
 *
 * Supports both single objects and arrays for bulk operations.
 * Data can be the full entity or partial (for creates).
 *
 * @template T - Entity type
 *
 * @example
 * ```ts
 * async function validateMessage(context: CreateHookContext<Message>) {
 *   // context.data is Message | Message[]
 *   const messages = Array.isArray(context.data) ? context.data : [context.data];
 *   for (const msg of messages) {
 *     if (!msg.content) throw new Error('Message content required');
 *   }
 * }
 * ```
 */
export interface CreateHookContext<T = unknown> extends FeathersHookContext {
  params: RBACParams;
  data: T | T[];
}

/**
 * Hook context for update/patch operations
 *
 * Data is optional (may be undefined for get/find/remove operations).
 * Supports partial updates via Partial<T>.
 *
 * @template T - Entity type
 */
export interface HookContext<T = unknown> extends FeathersHookContext {
  params: RBACParams;
  data?: Partial<T> | Partial<T>[];
}

// ============================================================================
// Service Interface Types
// ============================================================================

/**
 * Base Feathers service interface with standard CRUD methods
 *
 * All Agor services implement this interface for consistency.
 * Custom methods can be added via interface extension.
 *
 * @template T - Entity type (e.g., Session, Task, Message)
 * @template D - Data type for create/update (defaults to Partial<T>)
 * @template P - Params type (defaults to Params)
 *
 * @example
 * ```ts
 * interface SessionsService extends BaseService<Session, Partial<Session>, SessionParams> {
 *   // Add custom methods
 *   fork(id: string, data: { prompt: string }, params?: SessionParams): Promise<Session>;
 * }
 * ```
 */
export interface BaseService<T, D = Partial<T>, P extends Params = Params> {
  /**
   * Find entities matching query criteria
   *
   * Returns paginated results if pagination is enabled, otherwise array.
   */
  find(params?: P): Promise<Paginated<T> | T[]>;

  /**
   * Get a single entity by ID
   *
   * @param id - Entity ID (usually UUIDv7)
   * @param params - Query parameters
   * @throws EntityNotFoundError if not found
   */
  get(id: string, params?: P): Promise<T>;

  /**
   * Create a new entity
   *
   * @param data - Entity data (full or partial)
   * @param params - Request parameters
   * @returns Created entity with generated fields (ID, timestamps)
   */
  create(data: D, params?: P): Promise<T>;

  /**
   * Replace an entity entirely (PUT semantics)
   *
   * @param id - Entity ID
   * @param data - Complete entity data
   * @param params - Request parameters
   * @returns Updated entity
   */
  update(id: string, data: T, params?: P): Promise<T>;

  /**
   * Partially update an entity (PATCH semantics)
   *
   * Supports both single and multi-patch operations.
   *
   * @param id - Entity ID (or null for multi-patch)
   * @param data - Partial entity data
   * @param params - Request parameters
   * @returns Updated entity
   */
  patch(id: string | null, data: D, params?: P): Promise<T>;

  /**
   * Remove an entity
   *
   * @param id - Entity ID
   * @param params - Request parameters
   * @returns Removed entity
   */
  remove(id: string, params?: P): Promise<T>;
}

/**
 * Service with event emitter capabilities
 *
 * Feathers services emit events for real-time updates via Socket.IO.
 * Clients can listen to these events for live data synchronization.
 *
 * @template T - Entity type
 */
export interface ServiceWithEvents<T> extends BaseService<T> {
  /**
   * Subscribe to service events
   *
   * Standard events: created, updated, patched, removed
   *
   * @param event - Event name
   * @param handler - Event handler function
   *
   * @example
   * ```ts
   * service.on('created', (session: Session) => {
   *   console.log('New session:', session.session_id);
   * });
   * ```
   */
  on(event: string, handler: (data: T) => void): void;

  /**
   * Unsubscribe from service events
   *
   * @param event - Event name
   * @param handler - Event handler to remove
   */
  removeListener(event: string, handler: (data: T) => void): void;
}

// ============================================================================
// Authentication Result Types
// ============================================================================

/**
 * Authentication result from Feathers authentication
 *
 * Returned by authenticate() method after successful login.
 * Contains JWT token and user information.
 */
export interface AuthenticationResult {
  /** JWT access token */
  accessToken: string;
  /** Authentication metadata */
  authentication: {
    /** Strategy used (e.g., 'local', 'jwt', 'anonymous') */
    strategy: string;
    /** Token (may be undefined for anonymous) */
    accessToken?: string;
    /** Decoded JWT payload */
    payload?: Record<string, unknown>;
  };
  /** Authenticated user (if available) */
  user?: AuthenticatedUser;
  /** Additional fields from strategy */
  [key: string]: unknown;
}
