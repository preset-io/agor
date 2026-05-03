/**
 * Worktree-centric RBAC authorization utilities
 *
 * Enforces app-layer permissions for worktrees and their nested resources (sessions/tasks/messages).
 *
 * Uses RBACParams to provide type-safe access to cached RBAC entities (worktree, session, ownership).
 * This avoids redundant database queries within hook chains.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type { BoardRepository, SessionRepository, WorktreeRepository } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  HookContext,
  Session,
  UUID,
  Worktree,
  WorktreePermissionLevel,
} from '@agor/core/types';
import { ROLES, WORKTREE_PERMISSION_LEVELS } from '@agor/core/types';

/**
 * Check if a user has the superadmin role (or deprecated 'owner' alias).
 * Superadmins bypass worktree-level RBAC — they can view all worktrees
 * (including others_can=none) and self-assign ownership.
 *
 * Note: This does NOT grant automatic prompt access. Superadmins must
 * self-assign as worktree owner first, leaving an audit trail.
 *
 * The allow_superadmin config flag gates this. When false, superadmins
 * are treated as regular admins (no worktree RBAC bypass).
 */
export function isSuperAdmin(role: string | undefined, allowSuperadmin = true): boolean {
  if (!allowSuperadmin) return false;
  return role === ROLES.SUPERADMIN || role === 'owner';
}

/**
 * Permission level hierarchy (for comparisons).
 * Derived from WORKTREE_PERMISSION_LEVELS — rank = array index - 1 (none=-1, view=0, …, all=3).
 */
export const PERMISSION_RANK: Record<WorktreePermissionLevel, number> = Object.fromEntries(
  WORKTREE_PERMISSION_LEVELS.map((level, i) => [level, i - 1])
) as Record<WorktreePermissionLevel, number>;

/**
 * Check if user has minimum required permission level on a worktree
 *
 * Logic:
 * - Owners always have 'all' permission
 * - Superadmins get 'view' permission on all worktrees (can see everything)
 *   but must self-assign ownership to get 'prompt'/'all' (leaves audit trail)
 * - Non-owners inherit from worktree.others_can
 * - Compare effective permission against required level
 *
 * @param worktree - Worktree to check
 * @param userId - User ID to check
 * @param isOwner - Whether user is an owner
 * @param requiredLevel - Minimum permission level required
 * @param userRole - User's global role (for superadmin bypass)
 * @returns true if user has sufficient permission
 */
export function hasWorktreePermission(
  worktree: Worktree,
  userId: UUID,
  isOwner: boolean,
  requiredLevel: WorktreePermissionLevel,
  userRole?: string,
  allowSuperadmin = true
): boolean {
  // Owners always have 'all' permission
  if (isOwner) {
    return true;
  }

  // Superadmins have full access to all worktrees
  if (isSuperAdmin(userRole, allowSuperadmin)) {
    return true;
  }

  // Non-owners inherit from worktree.others_can (defaults to 'session')
  const effectiveLevel = worktree.others_can ?? 'session';
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
 * @param userRole - User's global role (for superadmin bypass)
 * @returns Effective permission level ('none', 'view', 'prompt', or 'all')
 */
export function resolveWorktreePermission(
  worktree: Worktree,
  userId: UUID,
  isOwner: boolean,
  userRole?: string,
  allowSuperadmin = true
): WorktreePermissionLevel {
  if (isOwner) {
    return 'all';
  }
  // Superadmins get full access to all worktrees
  if (isSuperAdmin(userRole, allowSuperadmin)) {
    return 'all';
  }
  return worktree.others_can ?? 'session';
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

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
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
  action: string = 'perform this action',
  options?: { allowSuperadmin?: boolean }
) {
  return (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    if (!context.params.user) {
      throw new NotAuthenticated('Authentication required');
    }

    // Service accounts (executor) bypass RBAC — they perform privileged
    // internal operations (unix.sync-worktree, git.worktree.add, etc.)
    if (context.params.user._isServiceAccount) {
      return context;
    }

    // Worktree and ownership should have been cached by loadWorktree hook
    const worktree = context.params.worktree;
    const isOwner = context.params.isWorktreeOwner ?? false;

    if (!worktree) {
      throw new Error('loadWorktree hook must run before ensureWorktreePermission');
    }

    const userId = context.params.user.user_id as UUID;
    const userRole = context.params.user.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    if (
      !hasWorktreePermission(worktree, userId, isOwner, requiredLevel, userRole, allowSuperadmin)
    ) {
      const effectiveLevel = resolveWorktreePermission(
        worktree,
        userId,
        isOwner,
        userRole,
        allowSuperadmin
      );
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
export function scopeWorktreeQuery(
  worktreeRepo: WorktreeRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
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

    // Superadmins see all worktrees (bypass access filtering)
    const userRole = context.params.user?.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // Use optimized repository method (single SQL query with JOIN)
    const query = context.params.query ?? {};
    let accessibleWorktrees: Worktree[];
    if (isSuperAdmin(userRole, allowSuperadmin)) {
      // Superadmins see all worktrees — use findAll and apply archived filter manually
      const all = await worktreeRepo.findAll({ includeArchived: true });
      if (query.archived === true) {
        accessibleWorktrees = all.filter((wt) => wt.archived === true);
      } else if (query.archived === false) {
        accessibleWorktrees = all.filter((wt) => !wt.archived);
      } else {
        accessibleWorktrees = all;
      }
    } else {
      accessibleWorktrees = await worktreeRepo.findAccessibleWorktrees(userId, {
        archived: query.archived,
      });
    }

    // Apply client-side filtering for non-special query params (repo_id, name, etc.)
    let filtered = accessibleWorktrees;
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('$') || key === 'archived') continue; // Skip operators and already-applied filters
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic property access for generic query filtering
      filtered = filtered.filter((item: any) => item[key] === value);
    }

    // Apply sorting if specified (matches scopeSessionQuery behavior)
    const sort = query.$sort;
    if (sort) {
      const sortField = Object.keys(sort)[0] as keyof Worktree;
      const sortOrder = sort[sortField] as 1 | -1;
      filtered = [...filtered].sort((a, b) => {
        const aVal = a[sortField];
        const bVal = b[sortField];
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (aVal < bVal) return sortOrder === -1 ? 1 : -1;
        if (aVal > bVal) return sortOrder === -1 ? -1 : 1;
        return 0;
      });
    }

    // Apply pagination
    const limit = query.$limit ?? filtered.length;
    const skip = query.$skip ?? 0;
    const paginated = filtered.slice(skip, skip + limit);

    // Set result directly to bypass default query
    // This prevents the N+1 problem from the old filterWorktreesByPermission approach
    context.result = {
      total: filtered.length,
      limit,
      skip,
      data: paginated,
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
export function scopeSessionQuery(
  sessionRepo: SessionRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
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

    // Superadmins see all sessions (bypass access filtering)
    const userRole = context.params.user?.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // Use optimized repository method (single SQL query with JOINs)
    const accessibleSessions = isSuperAdmin(userRole, allowSuperadmin)
      ? await sessionRepo.findAll()
      : await sessionRepo.findAccessibleSessions(userId);

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

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
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
      const effectivePermission = worktree.others_can ?? 'session';
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

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
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
 * @see context/guides/rbac-and-unix-isolation.md — Session Ownership / Execution Model
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
 * Decide which `unix_username` to stamp on a child session created via
 * fork() or spawn(). Pure function — no DB, no context — so it can be unit
 * tested directly and kept aligned with {@link determineSpawnIdentity}.
 *
 * Rules:
 * - Legacy sharing (worktree opt-in `dangerously_allow_session_sharing` triggered) →
 *   inherit `parent.unix_username`. Identity borrowing is the whole point of this flag.
 * - Otherwise (including the common same-user path) → use the caller's CURRENT
 *   `unix_username`. We must NOT fall back to `parent.unix_username` just because
 *   caller and parent owner share an id: the user's unix_username may have drifted
 *   since the parent was created, and `validateSessionUnixUsername` would then
 *   reject every prompt on the child.
 *
 * @param parentUnixUsername  - `parent.unix_username` from the parent session (may be null)
 * @param callerUnixUsername  - Caller's CURRENT unix_username (loaded fresh via
 *                              {@link loadUnixUsernameForUser}); may be null
 * @param usedLegacySharing   - Whether {@link determineSpawnIdentity} fell into
 *                              the legacy identity-borrowing branch
 * @returns The unix_username to stamp on the child (string or null)
 */
export function resolveChildUnixUsername(
  parentUnixUsername: string | null | undefined,
  callerUnixUsername: string | null,
  usedLegacySharing: boolean
): string | null {
  if (usedLegacySharing) {
    return parentUnixUsername ?? null;
  }
  return callerUnixUsername;
}

/**
 * Load a user's current `unix_username` by user id.
 *
 * Single source of truth used by both the `setSessionUnixUsername` hook
 * (external session create) and `SessionsService.fork()` / `spawn()`
 * (internal create that bypasses the hook pipeline). Keeps the two paths
 * from drifting on loader choice, error type, or null-handling.
 *
 * Throws `NotAuthenticated` when the user record can't be loaded — callers
 * should let this bubble up rather than swallowing it, because a session
 * stamped with the wrong unix_username is a latent security/UX bug.
 *
 * @param userRepo - UsersRepository instance
 * @param userId   - User id to resolve
 * @returns The user's current `unix_username`, or `null` if they don't have one set
 */
export async function loadUnixUsernameForUser(
  // biome-ignore lint/suspicious/noExplicitAny: UsersRepository type lives in @agor/core/db but both callers pass compatible instances
  userRepo: any,
  userId: string
): Promise<string | null> {
  const user = await userRepo.findById(userId);
  if (!user) {
    throw new NotAuthenticated(`User ${userId} not found`);
  }
  return user.unix_username ?? null;
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
 * NOTE: This hook only fires for external calls (`params.provider != null`).
 * Internal callers that bypass the hook pipeline (e.g. `SessionsService.fork()` /
 * `spawn()` calling `this.create(...)`) must stamp `unix_username` themselves via
 * {@link loadUnixUsernameForUser} to keep the two paths in sync.
 *
 * @param userRepo - UserRepository instance
 */
export function setSessionUnixUsername(
  // biome-ignore lint/suspicious/noExplicitAny: UserRepository type
  userRepo: any
) {
  return async (context: HookContext) => {
    // Only for session creation
    if (context.method !== 'create' || context.path !== 'sessions') {
      return context;
    }

    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context data is dynamic
    const data = context.data as any;
    const userId = context.params.user?.user_id;

    if (!userId) {
      throw new NotAuthenticated('Authentication required to create session');
    }

    // Stamp session with creator's current unix_username.
    // IMMUTABLE - even if user's unix_username changes later, session keeps this value.
    data.unix_username = await loadUnixUsernameForUser(userRepo, userId);

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
 * Validate that a user can prompt a specific session.
 *
 * Standalone helper (not a Feathers hook) — usable from MCP tools, service hooks, or anywhere
 * with access to the app and worktree repository. Resolves worktree ownership internally.
 *
 * Respects the 'session' tier: users with 'session' permission can prompt their own sessions
 * but not sessions created by other users.
 *
 * Use case: validating callback targets ("can this user queue a prompt to that session?").
 *
 * @param sessionId - Target session ID to check prompt permission for
 * @param userId - User ID requesting access
 * @param app - FeathersJS app (for session lookup)
 * @param worktreeRepo - WorktreeRepository (for worktree + ownership lookup)
 * @returns The target session (for further use by caller)
 * @throws Forbidden if user lacks prompt permission
 * @throws Error if session or worktree not found
 */
export async function ensureCanPromptTargetSession(
  sessionId: string,
  userId: string,
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS app type
  app: { service(name: string): any },
  worktreeRepo: WorktreeRepository
): Promise<Session> {
  // Load target session
  let targetSession: Session;
  try {
    targetSession = await app.service('sessions').get(sessionId, { provider: undefined });
  } catch {
    throw new Forbidden(`Invalid callback target: session ${sessionId.substring(0, 8)} not found`);
  }

  // Load its worktree
  const worktree = await worktreeRepo.findById(targetSession.worktree_id);
  if (!worktree) {
    throw new Forbidden(
      `Cannot resolve permissions: worktree ${targetSession.worktree_id} not found`
    );
  }

  // Resolve ownership internally — callers shouldn't need to know this
  const isOwner = await worktreeRepo.isOwner(worktree.worktree_id, userId as UUID);

  // Owners can always prompt
  if (isOwner) {
    return targetSession;
  }

  const effectiveLevel = resolveWorktreePermission(worktree, userId as UUID, isOwner);

  // 'prompt' or 'all' → can prompt any session
  if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt) {
    return targetSession;
  }

  // 'session' → can only prompt own sessions
  if (effectiveLevel === 'session') {
    if (targetSession.created_by === userId) {
      return targetSession;
    }
    throw new Forbidden(
      `You have 'session' permission — you can only prompt sessions you created. ` +
        `This session was created by another user. ` +
        `Ask a worktree owner to upgrade your access to 'prompt' if needed.`
    );
  }

  throw new Forbidden(
    `Cannot set callback target: you need at least 'session' permission on worktree ` +
      `${worktree.name || worktree.worktree_id.substring(0, 8)}. ` +
      `You have '${effectiveLevel}' permission.`
  );
}

/**
 * Check if user can create a session in a worktree
 *
 * Creating a session requires 'session' or higher permission.
 * Users with 'session' can create new sessions (which run as their own identity).
 * Users with 'view' can only read — they cannot create sessions.
 *
 * @returns Feathers hook
 */
export function ensureCanCreateSession(options?: { allowSuperadmin?: boolean }) {
  return ensureWorktreePermission('session', 'create sessions in this worktree', options);
}

/**
 * Check if user can prompt (create tasks/messages)
 *
 * Prompting requires 'prompt' or higher permission.
 *
 * @returns Feathers hook
 */
export function ensureCanPrompt(options?: { allowSuperadmin?: boolean }) {
  return ensureWorktreePermission('prompt', 'create tasks/messages in this worktree', options);
}

/**
 * Check if user can prompt (create tasks/messages) in a session, respecting the 'session' tier.
 *
 * For users with 'prompt' or 'all' permission: always allowed.
 * For users with 'session' permission: only allowed if session.created_by === userId (own sessions).
 * For users with 'view' or 'none': denied.
 *
 * IMPORTANT: Must run AFTER loadWorktree (or loadWorktreeFromSession) AND loadSession hooks,
 * since it reads context.params.session and context.params.worktree.
 *
 * Use this INSTEAD of ensureCanPrompt when the operation targets a specific session
 * (e.g., creating tasks/messages). The 'session' tier allows prompting own sessions only.
 *
 * @returns Feathers hook
 */
export function ensureCanPromptInSession(options?: { allowSuperadmin?: boolean }) {
  return (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    if (!context.params.user) {
      throw new NotAuthenticated('Authentication required');
    }

    // Service accounts (executor) bypass RBAC
    if (context.params.user._isServiceAccount) {
      return context;
    }

    const worktree = context.params.worktree;
    const isOwner = context.params.isWorktreeOwner ?? false;

    if (!worktree) {
      throw new Error('loadWorktree hook must run before ensureCanPromptInSession');
    }

    const userId = context.params.user.user_id as UUID;
    const userRole = context.params.user.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // Owners always have full access
    if (isOwner) {
      return context;
    }

    const effectiveLevel = resolveWorktreePermission(
      worktree,
      userId,
      isOwner,
      userRole,
      allowSuperadmin
    );

    // 'prompt' or 'all' → can prompt any session
    if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt) {
      return context;
    }

    // 'session' → can only prompt own sessions
    if (effectiveLevel === 'session') {
      const session = context.params.session;
      if (!session) {
        throw new Error('loadSession hook must run before ensureCanPromptInSession');
      }

      if (session.created_by === userId) {
        return context;
      }

      throw new Forbidden(
        `You have 'session' permission — you can only prompt sessions you created. ` +
          `This session was created by another user. ` +
          `Ask a worktree owner to upgrade your access to 'prompt' if you need to prompt other users' sessions.`
      );
    }

    // 'view' or 'none' → denied
    throw new Forbidden(
      `You need 'prompt' permission to create tasks/messages in this worktree. You have '${effectiveLevel}' permission.`
    );
  };
}

/**
 * Check if user can view worktree resources
 *
 * Viewing requires 'view' or higher permission (i.e., any permission).
 *
 * @returns Feathers hook
 */
export function ensureCanView(options?: { allowSuperadmin?: boolean }) {
  return ensureWorktreePermission('view', 'view this worktree', options);
}

/**
 * Empty paginated result helper — used to short-circuit find() for unauthenticated
 * callers or callers whose query falls outside their accessible worktree set.
 */
function emptyFindResult(context: HookContext): HookContext {
  const query = (context.params.query ?? {}) as Record<string, unknown>;
  context.result = {
    total: 0,
    limit: (query.$limit as number) ?? 0,
    skip: (query.$skip as number) ?? 0,
    data: [],
  };
  return context;
}

/**
 * Result of the common find-scope guard checks (provider/service-account/
 * auth/superadmin). Returned by {@link resolveFindScopeAccess} so the two
 * scope hook factories below don't repeat the same preamble.
 */
type FindScopeDecision =
  | { kind: 'passThrough' }
  | { kind: 'handled' }
  | { kind: 'filter'; accessibleIds: Set<string> };

/**
 * Shared guard for the find-scoping hooks. Handles internal/service-account
 * pass-through, unauthenticated short-circuit, and superadmin bypass. If the
 * caller is a regular user, resolves accessible ids via `loadAccessibleIds`.
 *
 * Callers inspect the returned decision:
 * - 'passThrough': nothing to do, return context unchanged.
 * - 'handled':     context.result was set (empty result); return context.
 * - 'filter':      apply intersection using `accessibleIds`.
 */
async function resolveFindScopeAccess(
  context: HookContext,
  options: { allowSuperadmin?: boolean } | undefined,
  loadAccessibleIds: (userId: UUID) => Promise<string[]>
): Promise<FindScopeDecision> {
  if (context.method !== 'find') return { kind: 'passThrough' };
  if (!context.params.provider) return { kind: 'passThrough' };
  if (context.params.user?._isServiceAccount) return { kind: 'passThrough' };

  const userId = context.params.user?.user_id as UUID | undefined;
  if (!userId) {
    emptyFindResult(context);
    return { kind: 'handled' };
  }

  const userRole = context.params.user?.role as string | undefined;
  const allowSuperadmin = options?.allowSuperadmin ?? true;
  if (isSuperAdmin(userRole, allowSuperadmin)) return { kind: 'passThrough' };

  const ids = await loadAccessibleIds(userId);
  return { kind: 'filter', accessibleIds: new Set<string>(ids) };
}

/**
 * Intersect the existing `query[field]` filter with the caller's accessible
 * id set. Handles scalar string, `{ $in: [...] }`, and unset cases.
 *
 * - Scalar outside the accessible set → empty result.
 * - `$in` intersected with accessible set; empty intersection → empty result.
 * - Unset → inject `{ $in: [...accessibleIds] }` (empty set → empty result).
 */
function intersectFindQuery(
  context: HookContext,
  field: string,
  accessibleIds: Set<string>
): HookContext {
  // biome-ignore lint/suspicious/noExplicitAny: Feathers query shape is dynamic
  const query = (context.params.query ?? {}) as any;
  const existing = query[field];

  if (typeof existing === 'string') {
    if (!accessibleIds.has(existing)) return emptyFindResult(context);
    return context;
  }

  if (existing && typeof existing === 'object' && Array.isArray(existing.$in)) {
    const intersect = (existing.$in as string[]).filter((id) => accessibleIds.has(id));
    if (intersect.length === 0) return emptyFindResult(context);
    query[field] = { $in: intersect };
    context.params.query = query;
    return context;
  }

  if (accessibleIds.size === 0) return emptyFindResult(context);
  query[field] = { $in: Array.from(accessibleIds) };
  context.params.query = query;
  return context;
}

/**
 * Scope find() queries on worktree-scoped resources to the set of worktrees
 * the caller can access.
 *
 * This is a BEFORE hook factory for services whose rows carry a `worktree_id`
 * foreign key (e.g. artifacts, board-objects tied to a worktree, etc.).
 *
 * Behavior:
 * - Internal calls (no `context.params.provider`) pass through unchanged.
 * - Service accounts (`context.params.user._isServiceAccount`) pass through.
 * - Unauthenticated requests short-circuit with an empty paginated result.
 * - Superadmins (when `allowSuperadmin` is true) pass through; the default
 *   query runs unmodified and returns all rows.
 * - Non-superadmin authenticated users get their accessible worktree set
 *   resolved via `findAccessibleWorktrees(userId)`. The set is then intersected
 *   with any existing `worktree_id` filter in `context.params.query`:
 *   - If the caller passed `worktree_id` (string) outside the accessible set,
 *     short-circuit with an empty result.
 *   - If the caller passed `worktree_id` within the accessible set, preserve it.
 *   - If the caller passed `{ $in: [...] }`, intersect with accessible ids.
 *   - Otherwise, inject `worktree_id: { $in: [...accessibleIds] }`.
 *
 * Only applies when `context.method === 'find'`. No-op for other methods.
 *
 * @param worktreeRepo - WorktreeRepository instance
 * @param options - Optional flags (allowSuperadmin)
 * @returns Feathers hook
 */
export function scopeFindToAccessibleWorktrees(
  worktreeRepo: WorktreeRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    const decision = await resolveFindScopeAccess(context, options, async (uid) => {
      const accessible = await worktreeRepo.findAccessibleWorktrees(uid);
      return accessible.map((w) => w.worktree_id as string);
    });

    if (decision.kind !== 'filter') return context;
    return intersectFindQuery(context, 'worktree_id', decision.accessibleIds);
  };
}

/**
 * Scope find() queries on session-scoped resources to the set of sessions
 * the caller can access (via their accessible worktrees).
 *
 * This is a BEFORE hook factory for services whose rows carry a `session_id`
 * foreign key (e.g. tasks, messages, session-mcp-servers).
 *
 * Behavior mirrors {@link scopeFindToAccessibleWorktrees} but resolves via
 * `findAccessibleSessions(userId)` and mutates `context.params.query.session_id`:
 * - Internal / service-account calls pass through.
 * - Unauthenticated → empty result.
 * - Superadmins pass through.
 * - Regular users: if an explicit `session_id` is passed, it must be in the
 *   accessible set; otherwise inject `session_id: { $in: [...accessibleIds] }`.
 *
 * Only applies when `context.method === 'find'`.
 *
 * @param sessionRepo - SessionRepository instance
 * @param options - Optional flags (allowSuperadmin)
 * @returns Feathers hook
 */
export function scopeFindToAccessibleSessions(
  sessionRepo: SessionRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    const decision = await resolveFindScopeAccess(context, options, async (uid) => {
      const accessible = await sessionRepo.findAccessibleSessions(uid);
      return accessible.map((s) => s.session_id as string);
    });

    if (decision.kind !== 'filter') return context;
    return intersectFindQuery(context, 'session_id', decision.accessibleIds);
  };
}

/**
 * Scope find() queries on the boards service to the set of boards the caller
 * can see.
 *
 * A board is visible if the caller created it OR any worktree on the board is
 * accessible to them (owner or `others_can` permits at least 'view'). Empty
 * boards stay visible to their creator; superadmins bypass.
 *
 * Resolution happens in a single SQL EXISTS query via
 * {@link BoardRepository.findVisibleBoardIds}, avoiding the hydrate-every-
 * worktree cost of the previous in-memory after-hook and letting Feathers'
 * pagination/sort run against the already-scoped id set.
 *
 * @param boardRepo - BoardRepository instance
 * @param options - Optional flags (allowSuperadmin)
 * @returns Feathers hook
 */
export function scopeFindToAccessibleBoards(
  boardRepo: BoardRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    const decision = await resolveFindScopeAccess(context, options, (uid) =>
      boardRepo.findVisibleBoardIds(uid)
    );

    if (decision.kind !== 'filter') return context;
    return intersectFindQuery(context, 'board_id', decision.accessibleIds);
  };
}

/**
 * Core check: is the caller the session's creator OR a global admin/superadmin?
 *
 * Pure function (no FeathersJS dependency) so it can be reused from Feathers
 * hooks (see {@link ensureSessionOwnerOrAdmin}) AND from raw Express route
 * handlers that load the session themselves.
 *
 * Behavior:
 * - Service accounts (executor) pass through.
 * - Admin / superadmin pass through (respecting `allowSuperadmin`).
 * - Session creator passes through.
 * - Everyone else → Forbidden. Worktree `all` does NOT grant access: session
 *   env selections expose the creator's private credentials to the executor.
 *
 * Caller is responsible for rejecting unauthenticated requests (pass a user
 * or throw NotAuthenticated before calling this).
 */
export function checkSessionOwnerOrAdmin(
  user: { user_id?: string; role?: string; _isServiceAccount?: boolean },
  session: Pick<Session, 'created_by'>,
  options?: { allowSuperadmin?: boolean }
): void {
  // Service accounts (executor) bypass RBAC
  if (user._isServiceAccount) return;

  const allowSuperadmin = options?.allowSuperadmin ?? true;
  const userRole = user.role;

  if (userRole === ROLES.ADMIN || isSuperAdmin(userRole, allowSuperadmin)) {
    return;
  }

  if (session.created_by && user.user_id && session.created_by === (user.user_id as UUID)) {
    return;
  }

  throw new Forbidden(
    "Only the session's creator or an admin can modify this session's env var selections. " +
      "Worktree 'all' permission does NOT grant access — session env selections expose the " +
      "creator's private credentials to the executor process."
  );
}

/**
 * Ensure the caller is the session's creator OR a global admin/superadmin.
 *
 * Intended for session-scoped configuration that should NEVER inherit from
 * worktree-tier permissions — notably session env-var selection (v0.5
 * env-var-access). Even a worktree `all` grantee is NOT allowed to modify
 * another user's session env selections, because those selections decrypt and
 * export the session creator's private env vars into the executor process.
 *
 * Preconditions (run AFTER): {@link resolveSessionContext} and {@link loadSession}.
 *
 * Behavior:
 * - Internal calls (no provider) pass through.
 * - Service accounts pass through.
 * - Unauthenticated callers → NotAuthenticated.
 * - Admin/superadmin → pass through.
 * - Session creator → pass through.
 * - Everyone else → Forbidden (worktree `all` does NOT grant access).
 *
 * @returns Feathers hook
 */
export function ensureSessionOwnerOrAdmin(options?: { allowSuperadmin?: boolean }) {
  return (context: HookContext) => {
    // Skip internal calls
    if (!context.params.provider) {
      return context;
    }

    if (!context.params.user) {
      throw new NotAuthenticated('Authentication required');
    }

    const session = context.params.session;
    if (!session) {
      throw new Error('loadSession hook must run before ensureSessionOwnerOrAdmin');
    }

    checkSessionOwnerOrAdmin(context.params.user, session, options);
    return context;
  };
}

/**
 * Decide the `created_by` identity for a child session created via spawn or
 * fork (sessions service: spawn() / fork(), or MCP tools agor_sessions_spawn /
 * agor_sessions_prompt(mode:"fork"|"subsession")).
 *
 * Default behavior — and the behavior whenever the caller is the parent owner,
 * an admin, or a superadmin — attributes the child to the **caller** so it
 * runs under the caller's Unix identity, credentials, and env vars.
 *
 * Legacy "identity borrowing" (child inherits parent.created_by, so it runs
 * under the *parent owner's* identity even when spawned by a different user)
 * is preserved only when the worktree opts in via
 * `dangerously_allow_session_sharing: true`. When that legacy path triggers
 * for a cross-user spawn, the daemon emits a loud warning so it appears in
 * audit logs.
 *
 * Pure function — no DB, no FeathersJS context — so it can be unit tested
 * directly and invoked from both service methods and MCP tool handlers.
 *
 * @param parent  - Parent session (must include created_by)
 * @param caller  - Authenticated caller (MCP-authenticated user / Feathers user)
 * @param worktree - Parent's worktree (used for the opt-in flag)
 * @param options - allowSuperadmin (defaults to true)
 * @returns The created_by UUID to stamp on the child session
 */
export function determineSpawnIdentity(
  parent: { created_by: string },
  caller: { user_id?: string; role?: string; _isServiceAccount?: boolean },
  worktree: { worktree_id: string; dangerously_allow_session_sharing?: boolean } | undefined,
  options?: { allowSuperadmin?: boolean }
): { created_by: string; usedLegacySharing: boolean } {
  const allowSuperadmin = options?.allowSuperadmin ?? true;
  const callerId = caller.user_id;
  const role = caller.role;

  // Service accounts (executor, internal jobs) preserve parent attribution.
  // They have no human user_id to attribute to, and their callers (the
  // scheduler, callbacks) already ran their own RBAC checks.
  if (caller._isServiceAccount) {
    return { created_by: parent.created_by, usedLegacySharing: false };
  }

  // Admin / superadmin → always attributed to themselves so the audit trail
  // points at the human who pressed the button. Never inherit parent identity.
  if (role === ROLES.ADMIN || isSuperAdmin(role, allowSuperadmin)) {
    if (!callerId) {
      // Should not happen — admins always have an id — but fall back safely.
      return { created_by: parent.created_by, usedLegacySharing: false };
    }
    return { created_by: callerId, usedLegacySharing: false };
  }

  // Same user spawning their own session → attribute to caller (same value
  // as parent.created_by, but explicit).
  if (callerId && parent.created_by === callerId) {
    return { created_by: callerId, usedLegacySharing: false };
  }

  // Cross-user spawn: a non-admin caller is spawning/forking from someone
  // else's session.
  if (worktree?.dangerously_allow_session_sharing === true) {
    // Opt-in legacy behavior: preserve identity borrowing. Log loudly.
    // Structured key/value form so it can be queried by log shippers.
    console.warn('[SECURITY] legacy_session_sharing', {
      event: 'legacy_session_sharing',
      caller_id: callerId ?? null,
      parent_owner_id: parent.created_by,
      worktree_id: worktree.worktree_id,
    });
    return { created_by: parent.created_by, usedLegacySharing: true };
  }

  // Default: attribute child to caller (no identity borrowing).
  // If we don't have a caller id at this point we cannot safely proceed —
  // refuse rather than silently fall back to parent ownership.
  if (!callerId) {
    throw new Forbidden('Cannot spawn/fork session without an authenticated caller identity.');
  }
  return { created_by: callerId, usedLegacySharing: false };
}
