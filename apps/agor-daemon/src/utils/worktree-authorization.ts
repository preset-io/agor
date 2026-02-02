/**
 * Worktree-centric RBAC authorization utilities
 *
 * Enforces app-layer permissions for worktrees and their nested resources (sessions/tasks/messages).
 *
 * Uses RBACParams to provide type-safe access to cached RBAC entities (worktree, session, ownership).
 * This avoids redundant database queries within hook chains.
 *
 * @see context/explorations/rbac.md
 * @see context/explorations/unix-user-modes.md
 */

import type { SessionRepository, WorktreeRepository } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  HookContext,
  Session,
  UUID,
  Worktree,
  WorktreePermissionLevel,
} from '@agor/core/types';

/**
 * Permission level hierarchy (for comparisons)
 */
export const PERMISSION_RANK: Record<WorktreePermissionLevel, number> = {
  none: -1, // No access at all
  view: 0,
  prompt: 1,
  all: 2,
};

/**
 * Check if user has minimum required permission level on a worktree
 *
 * Logic:
 * - Owners always have 'all' permission
 * - Non-owners inherit from worktree.others_can
 * - Compare effective permission against required level
 *
 * @param worktree - Worktree to check
 * @param userId - User ID to check
 * @param isOwner - Whether user is an owner
 * @param requiredLevel - Minimum permission level required
 * @returns true if user has sufficient permission
 */
export function hasWorktreePermission(
  worktree: Worktree,
  userId: UUID,
  isOwner: boolean,
  requiredLevel: WorktreePermissionLevel
): boolean {
  // Owners always have 'all' permission
  if (isOwner) {
    return true;
  }

  // Non-owners inherit from worktree.others_can (defaults to 'view')
  const effectiveLevel = worktree.others_can ?? 'view';
  const effectiveRank = PERMISSION_RANK[effectiveLevel];
  const requiredRank = PERMISSION_RANK[requiredLevel];

  return effectiveRank >= requiredRank;
}

/**
 * Resolve worktree permission for a user
 *
 * Returns the effective permission level the user has on the worktree.
 *
 * @param worktree - Worktree to check
 * @param userId - User ID to check
 * @param isOwner - Whether user is an owner
 * @returns Effective permission level ('view', 'prompt', or 'all')
 */
export function resolveWorktreePermission(
  worktree: Worktree,
  userId: UUID,
  isOwner: boolean
): WorktreePermissionLevel {
  if (isOwner) {
    return 'all';
  }
  return worktree.others_can ?? 'view';
}

/**
 * Load worktree and cache it on context.params
 *
 * Fetches the worktree once and caches it on context.params.worktree.
 * Also resolves ownership and caches it on context.params.isWorktreeOwner.
 *
 * This hook should run BEFORE ensureWorktreePermission.
 *
 * @param worktreeRepo - WorktreeRepository instance
 * @param worktreeIdField - Field name containing worktree_id (default: 'worktree_id')
 * @returns Feathers hook
 */
export function loadWorktree(worktreeRepo: WorktreeRepository, worktreeIdField = 'worktree_id') {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Extract worktree_id from data or query
    let worktreeId: string | undefined;

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const data = context.data as any;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const query = context.params.query as any;

    if (context.method === 'create' && data?.[worktreeIdField]) {
      worktreeId = data[worktreeIdField];
    } else if (context.id) {
      // For get/patch/remove, worktree_id might be the ID itself (for worktrees service)
      // or we need to load the parent resource (for sessions/tasks/messages)
      if (context.path === 'worktrees') {
        worktreeId = context.id as string;
      } else {
        // For nested resources, worktree_id should be in data/query
        worktreeId = data?.[worktreeIdField] || query?.[worktreeIdField];
      }
    } else if (query?.[worktreeIdField]) {
      worktreeId = query[worktreeIdField];
    }

    if (!worktreeId) {
      throw new Error(`Cannot load worktree: ${worktreeIdField} not found`);
    }

    // Load worktree
    const worktree = await worktreeRepo.findById(worktreeId);
    if (!worktree) {
      throw new Forbidden(`Worktree not found: ${worktreeId}`);
    }

    // Check ownership
    const userId = context.params.user?.user_id as UUID | undefined;
    const isOwner = userId ? await worktreeRepo.isOwner(worktree.worktree_id, userId) : false;

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.worktree = worktree;
    context.params.isWorktreeOwner = isOwner;

    return context;
  };
}

/**
 * Ensure user has minimum required permission on the worktree
 *
 * Throws Forbidden if user lacks permission.
 * Internal calls (no params.provider) bypass this check.
 *
 * IMPORTANT: Must run AFTER loadWorktree hook (which caches worktree and ownership).
 *
 * @param requiredLevel - Minimum permission level required
 * @param action - Human-readable action description (for error messages)
 * @returns Feathers hook
 */
export function ensureWorktreePermission(
  requiredLevel: WorktreePermissionLevel,
  action: string = 'perform this action'
) {
  return (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    if (!context.params.user) {
      throw new NotAuthenticated('Authentication required');
    }

    // Worktree and ownership should have been cached by loadWorktree hook
    const worktree = context.params.worktree;
    const isOwner = context.params.isWorktreeOwner ?? false;

    if (!worktree) {
      throw new Error('loadWorktree hook must run before ensureWorktreePermission');
    }

    const userId = context.params.user.user_id as UUID;

    if (!hasWorktreePermission(worktree, userId, isOwner, requiredLevel)) {
      const effectiveLevel = resolveWorktreePermission(worktree, userId, isOwner);
      throw new Forbidden(
        `You need '${requiredLevel}' permission to ${action}. You have '${effectiveLevel}' permission.`
      );
    }

    return context;
  };
}

/**
 * Scope worktree query to only return authorized worktrees (OPTIMIZED SQL VERSION)
 *
 * Replaces the default find() query with an optimized SQL query that uses JOIN
 * to filter worktrees by access in a single database query instead of N+1 queries.
 *
 * This is a BEFORE hook that modifies the query to use the repository's
 * findAccessibleWorktrees method which does a LEFT JOIN with worktree_owners.
 *
 * @param worktreeRepo - WorktreeRepository instance
 * @returns Feathers hook
 */
export function scopeWorktreeQuery(worktreeRepo: WorktreeRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    const userId = context.params.user?.user_id as UUID | undefined;
    if (!userId) {
      // Not authenticated - return empty results
      context.result = {
        total: 0,
        limit: 0,
        skip: 0,
        data: [],
      };
      return context;
    }

    // Use optimized repository method (single SQL query with JOIN)
    const accessibleWorktrees = await worktreeRepo.findAccessibleWorktrees(userId);

    // Set result directly to bypass default query
    // This prevents the N+1 problem from the old filterWorktreesByPermission approach
    context.result = {
      total: accessibleWorktrees.length,
      limit: context.params.query?.$limit ?? accessibleWorktrees.length,
      skip: context.params.query?.$skip ?? 0,
      data: accessibleWorktrees,
    };

    return context;
  };
}

/**
 * Helper to compare two session fields for sorting
 *
 * Handles string, number, and date comparisons with type safety.
 */
function compareSessionFields(a: Session, b: Session, field: keyof Session, order: 1 | -1): number {
  const aVal = a[field];
  const bVal = b[field];

  // Handle null/undefined
  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return 1;
  if (bVal == null) return -1;

  // Type-safe comparison
  if (aVal < bVal) return order === -1 ? 1 : -1;
  if (aVal > bVal) return order === -1 ? -1 : 1;
  return 0;
}

/**
 * Scope session query to only return sessions from authorized worktrees (OPTIMIZED SQL VERSION)
 *
 * Uses an optimized SQL query with JOINs to filter sessions by worktree access
 * in a single database query instead of N+1 queries.
 *
 * This is a BEFORE hook that replaces the default find() query.
 *
 * @param sessionRepo - SessionRepository instance
 * @returns Feathers hook
 */
export function scopeSessionQuery(sessionRepo: SessionRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Only apply to find() method
    if (context.method !== 'find') {
      return context;
    }

    const userId = context.params.user?.user_id as UUID | undefined;
    if (!userId) {
      // Not authenticated - return empty results
      context.result = {
        total: 0,
        limit: 0,
        skip: 0,
        data: [],
      };
      return context;
    }

    // Use optimized repository method (single SQL query with JOINs)
    const accessibleSessions = await sessionRepo.findAccessibleSessions(userId);

    // Apply sorting if specified in query
    let sortedSessions = accessibleSessions;
    const sort = context.params.query?.$sort;
    if (sort) {
      const sortField = Object.keys(sort)[0] as keyof Session;
      const sortOrder = sort[sortField] as 1 | -1;
      sortedSessions = [...accessibleSessions].sort((a, b) =>
        compareSessionFields(a, b, sortField, sortOrder)
      );
    }

    // Apply pagination if specified
    const limit = context.params.query?.$limit ?? sortedSessions.length;
    const skip = context.params.query?.$skip ?? 0;
    const paginatedSessions = sortedSessions.slice(skip, skip + limit);

    // Set result directly to bypass default query
    context.result = {
      total: sortedSessions.length,
      limit,
      skip,
      data: paginatedSessions,
    };

    return context;
  };
}

/**
 * Filter worktrees by permission in find() results (DEPRECATED - use scopeWorktreeQuery instead)
 *
 * This is a post-query hook that filters out worktrees the user cannot access.
 * Should run AFTER the database query.
 *
 * WARNING: This has an N+1 query problem. Use scopeWorktreeQuery instead.
 *
 * @param worktreeRepo - WorktreeRepository instance
 * @returns Feathers hook
 * @deprecated Use scopeWorktreeQuery for optimized SQL-based filtering
 */
export function filterWorktreesByPermission(worktreeRepo: WorktreeRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Only apply to find() method
    if (context.method !== 'find') {
      return context;
    }

    const userId = context.params.user?.user_id as UUID | undefined;
    if (!userId) {
      // Not authenticated - return empty results
      context.result = {
        total: 0,
        limit: context.result?.limit ?? 0,
        skip: context.result?.skip ?? 0,
        data: [],
      };
      return context;
    }

    // Get all worktrees from result
    const worktrees: Worktree[] = context.result?.data ?? context.result ?? [];

    // Filter worktrees by permission
    const authorizedWorktrees = [];
    for (const worktree of worktrees) {
      const isOwner = await worktreeRepo.isOwner(worktree.worktree_id, userId);
      // User can access if they're an owner OR others_can allows at least 'view' permission
      // Check against permission rank: 'none' (-1) blocks access, 'view' (0) and above allows
      const effectivePermission = worktree.others_can ?? 'view';
      const hasAccess = isOwner || PERMISSION_RANK[effectivePermission] >= PERMISSION_RANK.view;

      if (hasAccess) {
        authorizedWorktrees.push(worktree);
      }
    }

    // Update result
    if (context.result?.data) {
      context.result.data = authorizedWorktrees;
      context.result.total = authorizedWorktrees.length;
    } else {
      context.result = authorizedWorktrees;
    }

    return context;
  };
}

/**
 * Load session's worktree and cache it on context.params
 *
 * For session/task/message operations, we need to resolve the worktree first.
 * This hook loads the session, then loads its worktree.
 *
 * @param sessionService - FeathersJS sessions service
 * @param worktreeRepo - WorktreeRepository instance
 * @returns Feathers hook
 */
export function loadSessionWorktree(
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  sessionService: any, // Type as FeathersService if available
  worktreeRepo: WorktreeRepository
) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    console.log(
      `[loadSessionWorktree] method=${context.method}, path=${context.path}, id=${context.id || 'none'}`
    );

    // Extract session_id from data, query, or id
    let sessionId: string | undefined;

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const data = context.data as any;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const query = context.params.query as any;

    if (context.method === 'create' && data?.session_id) {
      sessionId = data.session_id;
    } else if (context.id) {
      // For get/patch/remove on sessions
      if (context.path === 'sessions') {
        sessionId = context.id as string;
      } else {
        // For tasks/messages, session_id should be in data/query
        sessionId = data?.session_id || query?.session_id;

        // If session_id not provided in patch/remove, load existing record
        if (!sessionId && (context.method === 'patch' || context.method === 'remove')) {
          console.log(
            `[loadSessionWorktree] Loading existing ${context.path} record to get session_id. ID: ${context.id}`
          );
          try {
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
            const existingRecord = await (context.service as any).get(context.id, {
              provider: undefined, // Bypass provider to avoid recursion
            });
            sessionId = existingRecord?.session_id;
            console.log(
              `[loadSessionWorktree] Loaded session_id from existing record: ${sessionId?.substring(0, 8) || 'NOT FOUND'}`
            );
          } catch (error) {
            console.error(
              `[loadSessionWorktree] Failed to load existing ${context.path} record for session_id:`,
              error
            );
          }
        }
      }
    } else if (query?.session_id) {
      sessionId = query.session_id;
    }

    if (!sessionId) {
      throw new Error('Cannot load session worktree: session_id not found');
    }

    // Load session (bypass provider to avoid recursion)
    const session = await sessionService.get(sessionId, { provider: undefined });
    if (!session) {
      throw new Forbidden(`Session not found: ${sessionId}`);
    }

    // Load worktree
    const worktree = await worktreeRepo.findById(session.worktree_id);
    if (!worktree) {
      throw new Forbidden(`Worktree not found: ${session.worktree_id}`);
    }

    // Check ownership
    const userId = context.params.user?.user_id as UUID | undefined;
    const isOwner = userId ? await worktreeRepo.isOwner(worktree.worktree_id, userId) : false;

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.session = session;
    context.params.worktree = worktree;
    context.params.isWorktreeOwner = isOwner;

    return context;
  };
}

/**
 * Resolve session context for worktree-nested resources
 *
 * Extracts session_id from various sources based on the operation:
 * - Sessions: context.id (for get/patch/remove) or data.session_id (for create)
 * - Tasks/Messages: data.session_id (for create) or load from existing record (for patch/remove)
 *
 * Caches session_id on context.params.sessionId for downstream hooks.
 *
 * This is Step 1 of the RBAC hook chain.
 */
export function resolveSessionContext() {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    let sessionId: string | undefined;

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const data = context.data as any;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const query = context.params.query as any;

    // Sessions service - session_id IS the record ID
    if (context.path === 'sessions') {
      if (context.method === 'create') {
        sessionId = data?.session_id;
      } else if (context.id) {
        sessionId = context.id as string;
      }
    }
    // Tasks/Messages services - session_id is a foreign key
    else if (context.path === 'tasks' || context.path === 'messages') {
      if (context.method === 'create') {
        sessionId = data?.session_id;
      } else if (context.method === 'patch' || context.method === 'remove') {
        // Try data/query first
        sessionId = data?.session_id || query?.session_id;

        // If not found, load existing record
        if (!sessionId && context.id) {
          try {
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type
            const existing = await (context.service as any).get(context.id, {
              provider: undefined,
            });
            sessionId = existing?.session_id;
          } catch (error) {
            console.error(`[resolveSessionContext] Failed to load existing record:`, error);
          }
        }
      } else if (context.method === 'get') {
        // Try query first (if session_id provided in params)
        sessionId = query?.session_id;

        // If not found and we have an ID, load existing record
        if (!sessionId && context.id) {
          try {
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type
            const existing = await (context.service as any).get(context.id, {
              provider: undefined,
            });
            sessionId = existing?.session_id;
          } catch (error) {
            console.error(`[resolveSessionContext] Failed to load existing record:`, error);
          }
        }
      } else if (context.method === 'find') {
        sessionId = query?.session_id;
      }
    }

    if (!sessionId) {
      throw new Error(
        `Cannot resolve session context: session_id not found for ${context.path}.${context.method}`
      );
    }

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.sessionId = sessionId;

    return context;
  };
}

/**
 * Load session record and cache on context.params
 *
 * Loads the session using the sessionId cached by resolveSessionContext().
 * Caches session on context.params.session for downstream hooks.
 *
 * This is Step 2 of the RBAC hook chain.
 *
 * @param sessionService - FeathersJS sessions service
 */
export function loadSession(
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type
  sessionService: any
) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    const sessionId = context.params.sessionId;

    if (!sessionId) {
      throw new Error('resolveSessionContext hook must run before loadSession');
    }

    // Load session (bypass provider to avoid recursion)
    const session = await sessionService.get(sessionId, { provider: undefined });

    if (!session) {
      throw new Forbidden(`Session not found: ${sessionId}`);
    }

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.session = session;

    return context;
  };
}

/**
 * Load worktree from session and check ownership
 *
 * Loads the worktree referenced by the session (session.worktree_id).
 * Checks ownership and caches both worktree and ownership on context.params.
 *
 * This is Step 3 of the RBAC hook chain.
 *
 * @param worktreeRepo - WorktreeRepository instance
 */
export function loadWorktreeFromSession(worktreeRepo: WorktreeRepository) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    const session = context.params.session;

    if (!session) {
      throw new Error('loadSession hook must run before loadWorktreeFromSession');
    }

    // Load worktree
    const worktree = await worktreeRepo.findById(session.worktree_id);

    if (!worktree) {
      throw new Forbidden(`Worktree not found: ${session.worktree_id}`);
    }

    // Check ownership
    const userId = context.params.user?.user_id as UUID | undefined;
    const isOwner = userId ? await worktreeRepo.isOwner(worktree.worktree_id, userId) : false;

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.worktree = worktree;
    context.params.isWorktreeOwner = isOwner;

    return context;
  };
}

/**
 * Ensure session is immutable to its creator
 *
 * Validates that critical session fields (created_by, unix_username) cannot be changed.
 * This is CRITICAL for Unix isolation - session execution context is determined
 * by session.created_by (which maps to Unix user) and session.unix_username.
 *
 * @see context/explorations/rbac.md - Session Ownership (CRITICAL)
 * @see context/explorations/unix-user-modes.md - Session Execution Model
 */
export function ensureSessionImmutability() {
  return (context: HookContext) => {
    // Only enforce on patch/update
    if (context.method !== 'patch' && context.method !== 'update') {
      return context;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const data = context.data as any;

    // Check if created_by is being changed
    if (data?.created_by !== undefined) {
      throw new Forbidden(
        'session.created_by is immutable - it determines execution context (Unix user, credentials, SDK state)'
      );
    }

    // Check if unix_username is being changed
    if (data?.unix_username !== undefined) {
      throw new Forbidden(
        'session.unix_username is immutable - it determines SDK session storage location and execution user'
      );
    }

    return context;
  };
}

/**
 * Set session unix_username from creator's current unix_username
 *
 * When a session is created, stamp it with the creator's current unix_username.
 * This unix_username is IMMUTABLE and determines:
 * - SDK session storage location (~/.claude/, ~/.codex/, etc.)
 * - Unix user for all session operations (sudo -u)
 *
 * IMPORTANT: Run this hook BEFORE any permission checks that might need the unix_username.
 *
 * @param userRepo - UserRepository instance
 */
export function setSessionUnixUsername(
  // biome-ignore lint/suspicious/noExplicitAny: UserRepository type
  userRepo: any
) {
  return async (context: HookContext) => {
    console.log('[setSessionUnixUsername] Hook entry', {
      method: context.method,
      path: context.path,
      hasProvider: !!context.params.provider,
    });

    // Only for session creation
    if (context.method !== 'create' || context.path !== 'sessions') {
      console.log('[setSessionUnixUsername] Skipping - not session creation');
      return context;
    }

    // Skip for internal calls
    if (!context.params.provider) {
      console.log('[setSessionUnixUsername] Skipping - no provider (internal call)');
      return context;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context data is dynamic
    const data = context.data as any;
    const userId = context.params.user?.user_id;

    console.log('[setSessionUnixUsername] Hook called for session creation', {
      userId,
      hasProvider: !!context.params.provider,
    });

    if (!userId) {
      throw new NotAuthenticated('Authentication required to create session');
    }

    // Load user to get current unix_username
    const user = await userRepo.findById(userId);

    console.log('[setSessionUnixUsername] Loaded user:', {
      userId,
      email: user?.email,
      unix_username: user?.unix_username,
    });

    if (!user) {
      throw new NotAuthenticated('User not found');
    }

    // Stamp session with creator's current unix_username
    // This is IMMUTABLE - even if user's unix_username changes later, session keeps this value
    data.unix_username = user.unix_username || null;

    console.log('[setSessionUnixUsername] Stamped session with unix_username:', data.unix_username);

    return context;
  };
}

/**
 * Validate session unix_username before prompting
 *
 * DEFENSIVE CHECK: Before allowing operations that execute code (create tasks/messages),
 * verify that the session creator's current unix_username matches the session's stamped unix_username.
 *
 * If they differ, reject the operation with a clear error.
 *
 * This prevents security issues where:
 * - User's unix_username changed after session creation
 * - SDK session data would be inaccessible (stored in old home directory)
 * - Execution would happen as wrong Unix user
 *
 * @param userRepo - UserRepository instance
 */
export function validateSessionUnixUsername(
  // biome-ignore lint/suspicious/noExplicitAny: UserRepository type
  userRepo: any
) {
  return async (context: HookContext) => {
    // Only validate for operations that will execute code (create tasks/messages)
    if (context.method !== 'create') return context;
    if (context.path !== 'tasks' && context.path !== 'messages') return context;

    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    const session = context.params.session;

    if (!session) {
      throw new Error('loadSession hook must run before validateSessionUnixUsername');
    }

    // If session has no unix_username, allow (backward compatibility)
    if (!session.unix_username) {
      return context;
    }

    // Load session creator to check current unix_username
    const creator = await userRepo.findById(session.created_by);

    if (!creator) {
      throw new Forbidden(`Session creator not found: ${session.created_by}`);
    }

    // DEFENSIVE CHECK: Creator's current unix_username must match session's
    if (creator.unix_username !== session.unix_username) {
      throw new Forbidden(
        `Session security context has changed. ` +
          `Session was created with unix_username="${session.unix_username}" ` +
          `but creator's current unix_username="${creator.unix_username || 'null'}". ` +
          `Cannot execute this session with a different unix user. ` +
          `SDK session data is stored in the original user's home directory and cannot be accessed.`
      );
    }

    return context;
  };
}

/**
 * Check if user can create a session in a worktree
 *
 * Creating a session requires 'all' permission (full access).
 * Users with 'prompt' can only create tasks in existing sessions.
 *
 * @returns Feathers hook
 */
export function ensureCanCreateSession() {
  return ensureWorktreePermission('all', 'create sessions in this worktree');
}

/**
 * Check if user can prompt (create tasks/messages)
 *
 * Prompting requires 'prompt' or higher permission.
 *
 * @returns Feathers hook
 */
export function ensureCanPrompt() {
  return ensureWorktreePermission('prompt', 'create tasks/messages in this worktree');
}

/**
 * Check if user can view worktree resources
 *
 * Viewing requires 'view' or higher permission (i.e., any permission).
 *
 * @returns Feathers hook
 */
export function ensureCanView() {
  return ensureWorktreePermission('view', 'view this worktree');
}
