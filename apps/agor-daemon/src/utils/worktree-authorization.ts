/**
 * Worktree-centric RBAC authorization utilities
 *
 * Enforces app-layer permissions for worktrees and their nested resources (sessions/tasks/messages).
 *
 * NOTE: This file uses `as any` casts for Feathers hook context.params extensions.
 * This is necessary because the FeathersJS type system doesn't support custom properties on context.params.
 * All `any` uses are isolated to safe type assertions for custom properties we add to the context.
 *
 * @see context/explorations/rbac.md
 * @see context/explorations/unix-user-modes.md
 */

// biome-ignore lint/suspicious/noExplicitAny: File uses type assertions for Feathers context extensions
import type { WorktreeRepository } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, UUID, Worktree, WorktreePermissionLevel } from '@agor/core/types';

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
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const userId = (context.params as any).user?.user_id;
    const isOwner = userId
      ? await worktreeRepo.isOwner(worktree.worktree_id, userId as UUID)
      : false;

    // Cache on context (use any to bypass type checking for custom properties)
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    (context.params as any).worktree = worktree;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    (context.params as any).isWorktreeOwner = isOwner;

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
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const worktree = (context.params as any).worktree;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const isOwner = (context.params as any).isWorktreeOwner ?? false;

    if (!worktree) {
      throw new Error('loadWorktree hook must run before ensureWorktreePermission');
    }

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const userId = (context.params as any).user.user_id;

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
 * Scope worktree query to only return authorized worktrees
 *
 * Injects filters into context.params.query so find() only returns worktrees
 * the user can access (owner OR others_can >= 'view').
 *
 * This is more complex than simple ownership checks because we need to join
 * with worktree_owners table and apply OR logic.
 *
 * For now, we'll implement this as a post-filter in the service hook.
 * In the future, we can optimize this with a custom SQL query.
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

    // For now, we'll rely on the service to filter results
    // The service will need to load all worktrees and filter based on ownership
    // This is not ideal for performance, but we can optimize later with custom SQL

    // Cache the repository on context for the service to use
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    (context.params as any).worktreeRepo = worktreeRepo;

    return context;
  };
}

/**
 * Filter worktrees by permission in find() results
 *
 * This is a post-query hook that filters out worktrees the user cannot access.
 * Should run AFTER the database query.
 *
 * @param worktreeRepo - WorktreeRepository instance
 * @returns Feathers hook
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

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const userId = (context.params as any).user?.user_id;
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
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const userId = (context.params as any).user?.user_id;
    const isOwner = userId ? await worktreeRepo.isOwner(worktree.worktree_id, userId) : false;

    // Cache on context
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    (context.params as any).session = session;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    (context.params as any).worktree = worktree;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    (context.params as any).isWorktreeOwner = isOwner;

    return context;
  };
}

/**
 * Ensure session is immutable to its creator
 *
 * Validates that critical session fields (created_by) cannot be changed.
 * This is CRITICAL for Unix isolation - session execution context is determined
 * by session.created_by (which maps to Unix user).
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
