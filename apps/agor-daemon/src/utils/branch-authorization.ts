/**
 * Branch-centric RBAC authorization utilities
 *
 * Enforces app-layer permissions for branches and their nested resources (sessions/tasks/messages).
 *
 * Uses RBACParams to provide type-safe access to cached RBAC entities (branch, session, ownership).
 * This avoids redundant database queries within hook chains.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import type {
  BoardRepository,
  BranchRepository,
  ScheduleRepository,
  SessionRepository,
} from '@agor/core/db';
import { shortId } from '@agor/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  BranchID,
  BranchPermissionLevel,
  HookContext,
  Session,
  UUID,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS, hasMinimumRole, ROLES } from '@agor/core/types';

/**
 * Check if a user has the superadmin role (or deprecated 'owner' alias).
 * Superadmins bypass branch-level RBAC — they can view all branches
 * (including others_can=none) and self-assign ownership.
 *
 * Note: This does NOT grant automatic prompt access. Superadmins must
 * self-assign as branch owner first, leaving an audit trail.
 *
 * The allow_superadmin config flag gates this. When false, superadmins
 * are treated as regular admins (no branch RBAC bypass).
 */
export function isSuperAdmin(role: string | undefined, allowSuperadmin = true): boolean {
  if (!allowSuperadmin) return false;
  return role === ROLES.SUPERADMIN || role === 'owner';
}

/**
 * Permission level hierarchy (for comparisons).
 * Derived from BRANCH_PERMISSION_LEVELS — rank = array index - 1 (none=-1, view=0, …, all=3).
 */
export const PERMISSION_RANK: Record<BranchPermissionLevel, number> = Object.fromEntries(
  BRANCH_PERMISSION_LEVELS.map((level, i) => [level, i - 1])
) as Record<BranchPermissionLevel, number>;

const REQUEST_RBAC_CACHE_LIMIT = 32;

interface RequestScopedRbacCache {
  sessions: Map<string, Session>;
  branches: Map<string, Branch>;
  branchAccess: Map<
    string,
    {
      isOwner: boolean;
      branchPermission: BranchPermissionLevel;
    }
  >;
}

type PrefetchParams = AuthenticatedParams & {
  branch?: Branch;
  session?: Session;
  _agorRbacCache?: RequestScopedRbacCache;
  _agorPrefetchedRecord?: {
    id: string;
    idField: string;
    record: unknown;
  };
};

function getRequestRbacCache(params: AuthenticatedParams): RequestScopedRbacCache {
  const prefetchParams = params as PrefetchParams;
  if (!prefetchParams._agorRbacCache) {
    prefetchParams._agorRbacCache = {
      sessions: new Map(),
      branches: new Map(),
      branchAccess: new Map(),
    };
  }
  return prefetchParams._agorRbacCache;
}

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): T {
  if (!map.has(key) && map.size >= REQUEST_RBAC_CACHE_LIMIT) {
    const oldestKey = map.keys().next().value;
    if (oldestKey) map.delete(oldestKey);
  }
  map.set(key, value);
  return value;
}

function inferIdFieldForPath(path: string): string | undefined {
  switch (path) {
    case 'branches':
      return 'branch_id';
    case 'sessions':
      return 'session_id';
    case 'tasks':
      return 'task_id';
    case 'messages':
      return 'message_id';
    default:
      return undefined;
  }
}

function rememberPrefetchedRecord(
  context: HookContext,
  record: unknown,
  idField: string,
  id: string
): void {
  (context.params as PrefetchParams)._agorPrefetchedRecord = {
    id,
    idField,
    record,
  };
}

async function loadCachedSession(
  params: AuthenticatedParams,
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  sessionService: any,
  sessionId: string
): Promise<Session> {
  const cachedParamSession = (params as PrefetchParams).session as Session | undefined;
  if (cachedParamSession?.session_id === sessionId) {
    return cachedParamSession;
  }

  const cache = getRequestRbacCache(params);
  const cached = cache.sessions.get(sessionId);
  if (cached) return cached;

  const session = (await sessionService.get(sessionId, { provider: undefined })) as Session | null;
  if (!session) {
    throw new Forbidden(`Session not found: ${sessionId}`);
  }
  return rememberBounded(cache.sessions, sessionId, session);
}

async function loadCachedBranch(
  params: AuthenticatedParams,
  branchRepo: BranchRepository,
  branchId: string
): Promise<Branch> {
  const cachedParamBranch = (params as PrefetchParams).branch as Branch | undefined;
  if (cachedParamBranch?.branch_id === branchId) {
    return cachedParamBranch;
  }

  const cache = getRequestRbacCache(params);
  const cached = cache.branches.get(branchId);
  if (cached) return cached;

  const branch = await branchRepo.findById(branchId);
  if (!branch) {
    throw new Forbidden(`Branch not found: ${branchId}`);
  }
  return rememberBounded(cache.branches, branchId, branch);
}

/**
 * Check if user has minimum required permission level on a branch
 *
 * Logic:
 * - Owners always have 'all' permission
 * - Superadmins get 'view' permission on all branches (can see everything)
 *   but must self-assign ownership to get 'prompt'/'all' (leaves audit trail)
 * - Non-owners inherit from branch.others_can
 * - Compare effective permission against required level
 *
 * @param branch - Branch to check
 * @param userId - User ID to check
 * @param isOwner - Whether user is an owner
 * @param requiredLevel - Minimum permission level required
 * @param userRole - User's global role (for superadmin bypass)
 * @returns true if user has sufficient permission
 */
export function hasBranchPermission(
  branch: Branch,
  userId: UUID,
  isOwner: boolean,
  requiredLevel: BranchPermissionLevel,
  userRole?: string,
  allowSuperadmin = true,
  effectivePermission?: BranchPermissionLevel
): boolean {
  // Owners always have 'all' permission
  if (isOwner) {
    return true;
  }

  // Superadmins have full access to all branches
  if (isSuperAdmin(userRole, allowSuperadmin)) {
    return true;
  }

  // Non-owners inherit from branch.others_can (defaults to 'session')
  const effectiveLevel = effectivePermission ?? branch.others_can ?? 'session';
  const effectiveRank = PERMISSION_RANK[effectiveLevel];
  const requiredRank = PERMISSION_RANK[requiredLevel];

  return effectiveRank >= requiredRank;
}

/**
 * Resolve branch permission for a user
 *
 * Returns the effective permission level the user has on the branch.
 *
 * @param branch - Branch to check
 * @param userId - User ID to check
 * @param isOwner - Whether user is an owner
 * @param userRole - User's global role (for superadmin bypass)
 * @returns Effective permission level ('none', 'view', 'prompt', or 'all')
 */
export function resolveBranchPermission(
  branch: Branch,
  userId: UUID,
  isOwner: boolean,
  userRole?: string,
  allowSuperadmin = true,
  effectivePermission?: BranchPermissionLevel
): BranchPermissionLevel {
  if (isOwner) {
    return 'all';
  }
  // Superadmins get full access to all branches
  if (isSuperAdmin(userRole, allowSuperadmin)) {
    return 'all';
  }
  return effectivePermission ?? branch.others_can ?? 'session';
}

/**
 * Cache branch access fields on Feathers params for downstream authorization
 * hooks. Keep this as the single place that translates "current user + branch"
 * into the direct-owner bit and the group-aware effective permission.
 */
export async function cacheBranchAccess(
  params: AuthenticatedParams,
  branchRepo: BranchRepository,
  branch: Branch
): Promise<void> {
  const cache = getRequestRbacCache(params);
  rememberBounded(cache.branches, branch.branch_id as string, branch);

  const userId = params.user?.user_id as UUID | undefined;
  const accessKey = `${branch.branch_id}:${userId ?? '__anonymous__'}`;
  let access = cache.branchAccess.get(accessKey);
  if (!access) {
    access = {
      isOwner: userId ? await branchRepo.isOwner(branch.branch_id, userId) : false,
      branchPermission: userId
        ? await branchRepo.resolveUserPermission(branch, userId)
        : (branch.others_can ?? 'session'),
    };
    rememberBounded(cache.branchAccess, accessKey, access);
  }

  const rbacParams = params as AuthenticatedParams & {
    branch?: Branch;
    isBranchOwner?: boolean;
    branchPermission?: BranchPermissionLevel;
  };
  rbacParams.branch = branch;
  rbacParams.isBranchOwner = access.isOwner;
  rbacParams.branchPermission = access.branchPermission;
}

/**
 * Ensure the caller can control or mutate a branch's managed environment.
 *
 * Managed environment controls may run shell/webhook actions with impact tied
 * to the branch rather than the triggering user. Keep these controls limited
 * to users with effective `all` permission on the branch and global admins.
 * Internal daemon/service-account calls bypass so health loops and executor
 * plumbing can continue to operate.
 */
export async function ensureCanControlBranchEnvironment(
  branchRepo: BranchRepository,
  branchId: BranchID,
  params: AuthenticatedParams | undefined,
  action: string = 'control this branch environment'
): Promise<void> {
  if (!params?.provider) {
    return;
  }

  const user = params.user;
  if (!user) {
    throw new NotAuthenticated('Authentication required');
  }

  if (user._isServiceAccount) {
    return;
  }

  if (hasMinimumRole(user.role, ROLES.ADMIN)) {
    return;
  }

  const branch = await branchRepo.findById(branchId);
  if (!branch) {
    throw new Forbidden(`Branch not found: ${branchId}`);
  }

  const effectivePermission = await branchRepo.resolveUserPermission(branch, user.user_id as UUID);
  if (effectivePermission === 'all') {
    return;
  }

  throw new Forbidden(`You need 'all' branch permission or admin access to ${action}`);
}

/**
 * Load branch and cache it on context.params
 *
 * Fetches the branch once and caches it on context.params.branch.
 * Also resolves ownership and caches it on context.params.isBranchOwner.
 *
 * This hook should run BEFORE ensureBranchPermission.
 *
 * @param branchRepo - BranchRepository instance
 * @param branchIdField - Field name containing branch_id (default: 'branch_id')
 * @returns Feathers hook
 */
export function loadBranch(branchRepo: BranchRepository, branchIdField = 'branch_id') {
  return async (context: HookContext) => {
    // Skip for internal calls
    if (!context.params.provider) {
      return context;
    }

    // Service accounts (executor) bypass RBAC
    if (context.params.user?._isServiceAccount) {
      return context;
    }

    // Extract branch_id from data or query
    let branchId: string | undefined;

    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const data = context.data as any;
    // biome-ignore lint/suspicious/noExplicitAny: Feathers context extension
    const query = context.params.query as any;

    if (context.method === 'create' && data?.[branchIdField]) {
      branchId = data[branchIdField];
    } else if (context.id) {
      // For get/patch/remove, branch_id might be the ID itself (for branches service)
      // or we need to load the parent resource (for sessions/tasks/messages)
      if (context.path === 'branches') {
        branchId = context.id as string;
      } else {
        // For nested resources, branch_id should be in data/query
        branchId = data?.[branchIdField] || query?.[branchIdField];
      }
    } else if (query?.[branchIdField]) {
      branchId = query[branchIdField];
    }

    if (!branchId) {
      throw new Error(`Cannot load branch: ${branchIdField} not found`);
    }

    const branch = await loadCachedBranch(context.params, branchRepo, branchId);
    if (context.path === 'branches' && context.id && String(context.id) === branchId) {
      rememberPrefetchedRecord(context, branch, 'branch_id', branchId);
    }

    // Cache on context for downstream hooks (type-safe via RBACParams)
    await cacheBranchAccess(context.params, branchRepo, branch);

    return context;
  };
}

/**
 * Ensure user has minimum required permission on the branch
 *
 * Throws Forbidden if user lacks permission.
 * Internal calls (no params.provider) bypass this check.
 *
 * IMPORTANT: Must run AFTER loadBranch hook (which caches branch and ownership).
 *
 * @param requiredLevel - Minimum permission level required
 * @param action - Human-readable action description (for error messages)
 * @returns Feathers hook
 */
export function ensureBranchPermission(
  requiredLevel: BranchPermissionLevel,
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
    // internal operations (unix.sync-branch, git.branch.add, etc.)
    if (context.params.user._isServiceAccount) {
      return context;
    }

    // Branch and ownership should have been cached by loadBranch hook
    const branch = context.params.branch;
    const isOwner = context.params.isBranchOwner ?? false;

    if (!branch) {
      throw new Error('loadBranch hook must run before ensureBranchPermission');
    }

    const userId = context.params.user.user_id as UUID;
    const userRole = context.params.user.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    if (
      !hasBranchPermission(
        branch,
        userId,
        isOwner,
        requiredLevel,
        userRole,
        allowSuperadmin,
        context.params.branchPermission
      )
    ) {
      const effectiveLevel = resolveBranchPermission(
        branch,
        userId,
        isOwner,
        userRole,
        allowSuperadmin,
        context.params.branchPermission
      );
      throw new Forbidden(
        `You need '${requiredLevel}' permission to ${action}. You have '${effectiveLevel}' permission.`
      );
    }

    return context;
  };
}

/**
 * Scope branch query to only return authorized branches (OPTIMIZED SQL VERSION)
 *
 * Replaces the default find() query with an optimized SQL query that uses JOIN
 * to filter branches by access in a single database query instead of N+1 queries.
 *
 * This is a BEFORE hook that modifies the query to use the repository's
 * findAccessibleBranches method which does a LEFT JOIN with branch_owners.
 *
 * @param branchRepo - BranchRepository instance
 * @returns Feathers hook
 */
export function scopeBranchQuery(
  branchRepo: BranchRepository,
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

    // Superadmins see all branches (bypass access filtering)
    const userRole = context.params.user?.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // Use optimized repository method (single SQL query with JOIN)
    const query = context.params.query ?? {};
    let accessibleBranches: Branch[];
    if (isSuperAdmin(userRole, allowSuperadmin)) {
      // Superadmins see all branches — use findAll and apply archived filter manually
      const all = await branchRepo.findAll({ includeArchived: true });
      if (query.archived === true) {
        accessibleBranches = all.filter((wt) => wt.archived === true);
      } else if (query.archived === false) {
        accessibleBranches = all.filter((wt) => !wt.archived);
      } else {
        accessibleBranches = all;
      }
    } else {
      accessibleBranches = await branchRepo.findAccessibleBranches(userId, {
        archived: query.archived,
      });
    }

    // `archived` is already applied at the repo level; everything else
    // (repo_id, name, etc.) goes through the generic client-side pass.
    context.result = paginateClientSide(
      accessibleBranches,
      query as Record<string, unknown>,
      new Set(['archived'])
    );
    return context;
  };
}

/**
 * Shared filter / sort / paginate pass for `scope*Query` hooks.
 *
 * After the SQL-side access query returns the user's accessible rows,
 * all three scope hooks (`scopeBranchQuery`, `scopeSessionQuery`,
 * `scopeScheduleQuery`) need to:
 *   1. Apply Feathers query filters that the SQL layer didn't already
 *      handle (e.g. `schedule_id` on sessions).
 *   2. Apply `$sort` with null-safe comparison.
 *   3. Apply `$limit` / `$skip` pagination.
 *
 * Diverging implementations of this drift quickly (`scopeSessionQuery`
 * previously dropped all non-`$` filters silently, which broke the
 * schedules runs panel). Centralizing keeps the semantics aligned.
 *
 * @param rows                — the accessible rows from the repo
 * @param query               — the Feathers query object
 * @param skipFilterKeys      — keys to skip in the generic filter pass
 *                              (already applied SQL-side or special-case)
 */
export function paginateClientSide<T>(
  rows: T[],
  query: Record<string, unknown> | undefined,
  skipFilterKeys: ReadonlySet<string> = new Set()
): { total: number; limit: number; skip: number; data: T[] } {
  const q = query ?? {};

  // 1. Generic equality filter for non-`$`-prefixed keys.
  let filtered = rows;
  for (const [key, value] of Object.entries(q)) {
    if (key.startsWith('$') || skipFilterKeys.has(key)) continue;
    filtered = filtered.filter(
      // biome-ignore lint/suspicious/noExplicitAny: dynamic property access for generic query filtering
      (item: any) => item[key] === value
    );
  }

  // 2. $sort with null-safe comparison.
  const sort = q.$sort as Record<string, 1 | -1> | undefined;
  if (sort) {
    const sortField = Object.keys(sort)[0] as keyof T;
    const sortOrder = sort[sortField as string];
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

  // 3. Pagination.
  const limit = (q.$limit as number | undefined) ?? filtered.length;
  const skip = (q.$skip as number | undefined) ?? 0;
  return {
    total: filtered.length,
    limit,
    skip,
    data: filtered.slice(skip, skip + limit),
  };
}

/**
 * Scope session query to only return sessions from authorized branches (OPTIMIZED SQL VERSION)
 *
 * Uses an optimized SQL query with JOINs to filter sessions by branch access
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

    // Push board_id down to SQL via the branch join (session → branch →
    // board). The client-side pass below CANNOT filter board_id: sessions
    // expose the board as `branch_board_id`, never `board_id`, so a generic
    // `item.board_id === value` would wipe every row. We therefore both
    // push it to SQL here AND skip it in paginateClientSide.
    const query = context.params.query as Record<string, unknown> | undefined;
    const boardId = query?.board_id as UUID | undefined;

    // Use optimized repository method (single SQL query with JOINs)
    const accessibleSessions = isSuperAdmin(userRole, allowSuperadmin)
      ? boardId
        ? await sessionRepo.findByBoard(boardId)
        : await sessionRepo.findAll()
      : await sessionRepo.findAccessibleSessions(userId, boardId);

    // `updated_at` is the ONE sort key paginateClientSide can't order: the
    // Session object exposes that timestamp as `last_updated`, so its
    // `item.updated_at` lookup is undefined → a silent no-op. Handle exactly
    // that single-key case here on the real field and strip it below. EVERY
    // OTHER sort (created_at, scheduled_run_at, last_updated, …) maps to a real
    // Session field, so it MUST pass through to paginateClientSide unchanged —
    // dropping it here would silently break the ScheduleRunsPanel
    // (`$sort:{scheduled_run_at:-1}`), branch/session/CLI lists
    // (`$sort:{created_at:-1}`), and the MCP sessions tool (`$sort:{last_updated:-1}`).
    const sortSpec = query?.$sort as Record<string, 1 | -1> | undefined;
    const sortKeys = sortSpec ? Object.keys(sortSpec) : [];
    const isUpdatedAtSort = sortKeys.length === 1 && sortKeys[0] === 'updated_at';
    if (isUpdatedAtSort) {
      const dir = sortSpec!.updated_at;
      accessibleSessions.sort((a, b) => {
        const av = a.last_updated ?? '';
        const bv = b.last_updated ?? '';
        if (av < bv) return dir === -1 ? 1 : -1;
        if (av > bv) return dir === -1 ? -1 : 1;
        return 0;
      });
    }

    // Apply remaining query filters (branch_id, schedule_id, status, $sort, …)
    // client-side. Without this pass, `sessions.find({ schedule_id })` silently
    // returns all accessible sessions — which is what the ScheduleRunsPanel was
    // hitting before this fix. board_id is already applied SQL-side above; the
    // `updated_at`-only sort is applied above on the real field, so it's the
    // only `$sort` we drop here (every other sort flows through).
    let paginateQuery: Record<string, unknown> = query ?? {};
    if (isUpdatedAtSort) {
      const { $sort: _ignoredUpdatedAtSort, ...rest } = paginateQuery;
      paginateQuery = rest;
    }
    context.result = paginateClientSide(accessibleSessions, paginateQuery, new Set(['board_id']));
    return context;
  };
}

/**
 * Filter branches by permission in find() results (DEPRECATED - use scopeBranchQuery instead)
 *
 * This is a post-query hook that filters out branches the user cannot access.
 * Should run AFTER the database query.
 *
 * WARNING: This has an N+1 query problem. Use scopeBranchQuery instead.
 *
 * @param branchRepo - BranchRepository instance
 * @returns Feathers hook
 * @deprecated Use scopeBranchQuery for optimized SQL-based filtering
 */
export function filterBranchesByPermission(branchRepo: BranchRepository) {
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

    // Get all branches from result
    const branches: Branch[] = context.result?.data ?? context.result ?? [];

    // Filter branches by permission
    const authorizedBranches = [];
    for (const branch of branches) {
      const isOwner = await branchRepo.isOwner(branch.branch_id, userId);
      // User can access if they're an owner OR others_can allows at least 'view' permission
      // Check against permission rank: 'none' (-1) blocks access, 'view' (0) and above allows
      const effectivePermission = await branchRepo.resolveUserPermission(branch, userId);
      const hasAccess = isOwner || PERMISSION_RANK[effectivePermission] >= PERMISSION_RANK.view;

      if (hasAccess) {
        authorizedBranches.push(branch);
      }
    }

    // Update result
    if (context.result?.data) {
      context.result.data = authorizedBranches;
      context.result.total = authorizedBranches.length;
    } else {
      context.result = authorizedBranches;
    }

    return context;
  };
}

/**
 * Load session's branch and cache it on context.params
 *
 * For session/task/message operations, we need to resolve the branch first.
 * This hook loads the session, then loads its branch.
 *
 * @param sessionService - FeathersJS sessions service
 * @param branchRepo - BranchRepository instance
 * @returns Feathers hook
 */
export function loadSessionBranch(
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  sessionService: any, // Type as FeathersService if available
  branchRepo: BranchRepository
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
        // For id-addressed nested resources, trust the stored parent pointer,
        // not client-supplied data/query. Otherwise a caller could authorize
        // against a session they can access while fetching/patching/removing a
        // task/message that actually belongs to a different session.
        if (context.method === 'get' || context.method === 'patch' || context.method === 'remove') {
          try {
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
            const existingRecord = await (context.service as any).get(context.id, {
              provider: undefined, // Bypass provider to avoid recursion
            });
            sessionId = existingRecord?.session_id;
            const idField = inferIdFieldForPath(context.path);
            if (existingRecord && idField) {
              rememberPrefetchedRecord(context, existingRecord, idField, String(context.id));
            }
          } catch (error) {
            console.error(
              `[loadSessionBranch] Failed to load existing ${context.path} record for session_id:`,
              error
            );
          }
        } else {
          // For create/find on nested resources, session_id should be in data/query.
          sessionId = data?.session_id || query?.session_id;
        }
      }
    } else if (query?.session_id) {
      sessionId = query.session_id;
    }

    if (!sessionId) {
      throw new Error('Cannot load session branch: session_id not found');
    }

    const session = await loadCachedSession(context.params, sessionService, sessionId);
    if (context.path === 'sessions' && context.id && String(context.id) === sessionId) {
      rememberPrefetchedRecord(context, session, 'session_id', sessionId);
    }

    const branch = await loadCachedBranch(context.params, branchRepo, session.branch_id);

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.session = session;
    await cacheBranchAccess(context.params, branchRepo, branch);

    return context;
  };
}

/**
 * Resolve session context for branch-nested resources
 *
 * Extracts session_id from various sources based on the operation:
 * - Sessions: context.id (for get/patch/remove) or data.session_id (for create)
 * - Tasks/Messages: data.session_id (for create/find) or load from existing record (for get/patch/remove)
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
      } else if (
        context.method === 'get' ||
        context.method === 'patch' ||
        context.method === 'remove'
      ) {
        // Id-addressed nested resources must authorize against the stored
        // parent session, not a client-supplied session_id in data/query. The
        // prefetched record is reused by DrizzleService.get/patch/remove, so
        // this safety read does not add a second primary-key read later.
        if (context.id) {
          try {
            // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type
            const existing = await (context.service as any).get(context.id, {
              provider: undefined,
            });
            sessionId = existing?.session_id;
            const idField = inferIdFieldForPath(context.path);
            if (existing && idField) {
              rememberPrefetchedRecord(context, existing, idField, String(context.id));
            }
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

    const session = await loadCachedSession(context.params, sessionService, sessionId);
    if (context.path === 'sessions' && context.id && String(context.id) === sessionId) {
      rememberPrefetchedRecord(context, session, 'session_id', sessionId);
    }

    // Cache on context for downstream hooks (type-safe via RBACParams)
    context.params.session = session;

    return context;
  };
}

/**
 * Load branch from session and check ownership
 *
 * Loads the branch referenced by the session (session.branch_id).
 * Checks ownership and caches both branch and ownership on context.params.
 *
 * This is Step 3 of the RBAC hook chain.
 *
 * @param branchRepo - BranchRepository instance
 */
export function loadBranchFromSession(branchRepo: BranchRepository) {
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
      throw new Error('loadSession hook must run before loadBranchFromSession');
    }

    const branch = await loadCachedBranch(context.params, branchRepo, session.branch_id);

    // Cache on context for downstream hooks (type-safe via RBACParams)
    await cacheBranchAccess(context.params, branchRepo, branch);

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
 * - Legacy sharing (branch opt-in `dangerously_allow_session_sharing` triggered) →
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
 * with access to the app and branch repository. Resolves branch ownership internally.
 *
 * Respects the 'session' tier: users with 'session' permission can prompt their own sessions
 * but not sessions created by other users.
 *
 * Use case: validating callback targets ("can this user queue a prompt to that session?").
 *
 * @param sessionId - Target session ID to check prompt permission for
 * @param userId - User ID requesting access
 * @param app - FeathersJS app (for session lookup)
 * @param branchRepo - BranchRepository (for branch + ownership lookup)
 * @returns The target session (for further use by caller)
 * @throws Forbidden if user lacks prompt permission
 * @throws Error if session or branch not found
 */
export async function ensureCanPromptTargetSession(
  sessionId: string,
  userId: string,
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS app type
  app: { service(name: string): any },
  branchRepo: BranchRepository
): Promise<Session> {
  // Load target session
  let targetSession: Session;
  try {
    targetSession = await app.service('sessions').get(sessionId, { provider: undefined });
  } catch {
    throw new Forbidden(`Invalid callback target: session ${shortId(sessionId)} not found`);
  }

  // Load its branch
  const branch = await branchRepo.findById(targetSession.branch_id);
  if (!branch) {
    throw new Forbidden(`Cannot resolve permissions: branch ${targetSession.branch_id} not found`);
  }

  // Resolve ownership internally — callers shouldn't need to know this
  const isOwner = await branchRepo.isOwner(branch.branch_id, userId as UUID);

  // Owners can always prompt
  if (isOwner) {
    return targetSession;
  }

  const effectiveLevel = await branchRepo.resolveUserPermission(branch, userId as UUID);

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
        `Ask a branch owner to upgrade your access to 'prompt' if needed.`
    );
  }

  throw new Forbidden(
    `Cannot set callback target: you need at least 'session' permission on branch ` +
      `${branch.name || shortId(branch.branch_id)}. ` +
      `You have '${effectiveLevel}' permission.`
  );
}

/**
 * Check if user can create a session in a branch
 *
 * Creating a session requires 'session' or higher permission.
 * Users with 'session' can create new sessions (which run as their own identity).
 * Users with 'view' can only read — they cannot create sessions.
 *
 * @returns Feathers hook
 */
export function ensureCanCreateSession(options?: { allowSuperadmin?: boolean }) {
  return ensureBranchPermission('session', 'create sessions in this branch', options);
}

/**
 * Check if user can prompt (create tasks/messages)
 *
 * Prompting requires 'prompt' or higher permission.
 *
 * @returns Feathers hook
 */
export function ensureCanPrompt(options?: { allowSuperadmin?: boolean }) {
  return ensureBranchPermission('prompt', 'create tasks/messages in this branch', options);
}

/**
 * Check if user can prompt (create tasks/messages) in a session, respecting the 'session' tier.
 *
 * For users with 'prompt' or 'all' permission: always allowed.
 * For users with 'session' permission: only allowed if session.created_by === userId (own sessions).
 * For users with 'view' or 'none': denied.
 *
 * IMPORTANT: Must run AFTER loadBranch (or loadBranchFromSession) AND loadSession hooks,
 * since it reads context.params.session and context.params.branch.
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

    const branch = context.params.branch;
    const isOwner = context.params.isBranchOwner ?? false;

    if (!branch) {
      throw new Error('loadBranch hook must run before ensureCanPromptInSession');
    }

    const userId = context.params.user.user_id as UUID;
    const userRole = context.params.user.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // Owners always have full access
    if (isOwner) {
      return context;
    }

    const effectiveLevel = resolveBranchPermission(
      branch,
      userId,
      isOwner,
      userRole,
      allowSuperadmin,
      context.params.branchPermission
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
          `Ask a branch owner to upgrade your access to 'prompt' if you need to prompt other users' sessions.`
      );
    }

    // 'view' or 'none' → denied
    throw new Forbidden(
      `You need 'prompt' permission to create tasks/messages in this branch. You have '${effectiveLevel}' permission.`
    );
  };
}

/**
 * Check if user can view branch resources
 *
 * Viewing requires 'view' or higher permission (i.e., any permission).
 *
 * @returns Feathers hook
 */
export function ensureCanView(options?: { allowSuperadmin?: boolean }) {
  return ensureBranchPermission('view', 'view this branch', options);
}

/**
 * Empty paginated result helper — used to short-circuit find() for unauthenticated
 * callers or callers whose query falls outside their accessible branch set.
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

type FindSqlScopeDecision =
  | { kind: 'passThrough' }
  | { kind: 'handled' }
  | { kind: 'filter'; userId: UUID };

async function resolveFindSqlScopeAccess(
  context: HookContext,
  options: { allowSuperadmin?: boolean } | undefined
): Promise<FindSqlScopeDecision> {
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

  return { kind: 'filter', userId };
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
 * Scope find() queries on branch-scoped resources to the set of branches
 * the caller can access.
 *
 * This is a BEFORE hook factory for services whose rows carry a `branch_id`
 * foreign key (e.g. artifacts, board-objects tied to a branch, etc.).
 *
 * Behavior:
 * - Internal calls (no `context.params.provider`) pass through unchanged.
 * - Service accounts (`context.params.user._isServiceAccount`) pass through.
 * - Unauthenticated requests short-circuit with an empty paginated result.
 * - Superadmins (when `allowSuperadmin` is true) pass through; the default
 *   query runs unmodified and returns all rows.
 * - Non-superadmin authenticated users get their accessible branch set
 *   resolved via `findAccessibleBranches(userId)`. The set is then intersected
 *   with any existing `branch_id` filter in `context.params.query`:
 *   - If the caller passed `branch_id` (string) outside the accessible set,
 *     short-circuit with an empty result.
 *   - If the caller passed `branch_id` within the accessible set, preserve it.
 *   - If the caller passed `{ $in: [...] }`, intersect with accessible ids.
 *   - Otherwise, inject `branch_id: { $in: [...accessibleIds] }`.
 *
 * Only applies when `context.method === 'find'`. No-op for other methods.
 *
 * @param branchRepo - BranchRepository instance
 * @param options - Optional flags (allowSuperadmin)
 * @returns Feathers hook
 */
export function scopeFindToAccessibleBranches(
  branchRepo: BranchRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    const decision = await resolveFindScopeAccess(context, options, async (uid) => {
      const accessible = await branchRepo.findAccessibleBranches(uid);
      return accessible.map((w) => w.branch_id as string);
    });

    if (decision.kind !== 'filter') return context;
    return intersectFindQuery(context, 'branch_id', decision.accessibleIds);
  };
}

/**
 * Mark a branch-scoped find() request for repository-level SQL RBAC pushdown.
 *
 * This is the single-query alternative to {@link scopeFindToAccessibleBranches}:
 * instead of preloading every accessible branch id and injecting a large
 * `branch_id IN (...)` filter, services that understand this marker compose the
 * shared branch visibility predicate directly into their repository query.
 */
export function scopeFindToAccessibleBranchesSql(options?: { allowSuperadmin?: boolean }) {
  return async (context: HookContext) => {
    const decision = await resolveFindSqlScopeAccess(context, options);
    if (decision.kind !== 'filter') return context;

    (context.params as { _agorSqlBranchAccessUserId?: UUID })._agorSqlBranchAccessUserId =
      decision.userId;
    return context;
  };
}

/**
 * Scope find() queries on session-scoped resources to the set of sessions
 * the caller can access (via their accessible branches).
 *
 * This is a BEFORE hook factory for services whose rows carry a `session_id`
 * foreign key (e.g. tasks, messages, session-mcp-servers).
 *
 * Behavior mirrors {@link scopeFindToAccessibleBranches} but resolves via
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
 * Mark a session-scoped find() request for repository-level SQL RBAC pushdown.
 *
 * This is the single-query alternative to {@link scopeFindToAccessibleSessions}:
 * instead of preloading every accessible session id and injecting a large
 * `session_id IN (...)` filter, services that understand this marker compose
 * the shared branch visibility predicate through the session's branch.
 */
export function scopeFindToAccessibleSessionsSql(options?: { allowSuperadmin?: boolean }) {
  return async (context: HookContext) => {
    const decision = await resolveFindSqlScopeAccess(context, options);
    if (decision.kind !== 'filter') return context;

    (context.params as { _agorSqlSessionAccessUserId?: UUID })._agorSqlSessionAccessUserId =
      decision.userId;
    return context;
  };
}

/**
 * Scope find() queries on the boards service to the set of boards the caller
 * can see.
 *
 * A board is visible if the caller owns it, it is shared, any branch on the
 * board is accessible to them, or the board's primary assistant branch is
 * accessible to them. Empty private boards stay visible to their owners;
 * superadmins bypass.
 *
 * Resolution happens in a single SQL EXISTS query via
 * {@link BoardRepository.findVisibleBoardIds}, avoiding the hydrate-every-
 * branch cost of the previous in-memory after-hook and letting Feathers'
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
 * Mark a boards.find() request for repository-level SQL board-visibility
 * pushdown. Avoids resolving visible board ids into a large `board_id IN (...)`
 * list before the service query runs.
 */
export function scopeFindToAccessibleBoardsSql(options?: { allowSuperadmin?: boolean }) {
  return async (context: HookContext) => {
    const decision = await resolveFindSqlScopeAccess(context, options);
    if (decision.kind !== 'filter') return context;

    (context.params as { _agorSqlBoardAccessUserId?: UUID })._agorSqlBoardAccessUserId =
      decision.userId;
    return context;
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
 * - Everyone else → Forbidden. Branch `all` does NOT grant access: session
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
    "Only the session's creator or an admin can access this session-scoped runtime configuration. " +
      "Branch 'all' permission does NOT grant access."
  );
}

/**
 * Ensure the caller is the session's creator OR a global admin/superadmin.
 *
 * Intended for session-scoped configuration that should NEVER inherit from
 * branch-tier permissions — notably session env-var selection (v0.5
 * env-var-access). Even a branch `all` grantee is NOT allowed to modify
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
 * - Everyone else → Forbidden (branch `all` does NOT grant access).
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
 * is preserved only when the branch opts in via
 * `dangerously_allow_session_sharing: true`. When that legacy path triggers
 * for a cross-user spawn, the daemon emits a loud warning so it appears in
 * audit logs.
 *
 * Pure function — no DB, no FeathersJS context — so it can be unit tested
 * directly and invoked from both service methods and MCP tool handlers.
 *
 * @param parent  - Parent session (must include created_by)
 * @param caller  - Authenticated caller (MCP-authenticated user / Feathers user)
 * @param branch - Parent's branch (used for the opt-in flag)
 * @param options - allowSuperadmin (defaults to true)
 * @returns The created_by UUID to stamp on the child session
 */
export function determineSpawnIdentity(
  parent: { created_by: string },
  caller: { user_id?: string; role?: string; _isServiceAccount?: boolean },
  branch: { branch_id: string; dangerously_allow_session_sharing?: boolean } | undefined,
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
  if (branch?.dangerously_allow_session_sharing === true) {
    // Opt-in legacy behavior: preserve identity borrowing. Log loudly.
    // Structured key/value form so it can be queried by log shippers.
    console.warn('[SECURITY] legacy_session_sharing', {
      event: 'legacy_session_sharing',
      caller_id: callerId ?? null,
      parent_owner_id: parent.created_by,
      branch_id: branch.branch_id,
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

// ============================================================================
// Schedule-tier RBAC helpers
// ============================================================================
// Schedules inherit their RBAC from the parent branch (same model as
// sessions). See docs/internal/schedules-first-class-design-2026-05-24.md §4.4.

/**
 * Scope schedules.find() to schedules whose parent branch the user can view.
 *
 * Sibling of `scopeSessionQuery` — uses an indexed SQL JOIN rather than
 * an N+1 fan-out.
 *
 * @param scheduleRepo - ScheduleRepository instance
 * @returns Feathers hook
 */
export function scopeScheduleQuery(
  scheduleRepo: ScheduleRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;
    if (context.params.user?._isServiceAccount) return context;
    if (context.method !== 'find') return context;

    const userId = context.params.user?.user_id as UUID | undefined;
    if (!userId) {
      context.result = { total: 0, limit: 0, skip: 0, data: [] };
      return context;
    }

    const userRole = context.params.user?.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // Lift query filters that the repository understands (pushed into
    // the SQL JOIN for efficiency); the rest go through the generic
    // client-side filter pass below.
    // biome-ignore lint/suspicious/noExplicitAny: Feathers query is loosely-typed
    const q = (context.params.query ?? {}) as any;
    const filter = {
      branch_id: q.branch_id,
      enabled:
        q.enabled === true || q.enabled === 'true'
          ? true
          : q.enabled === false || q.enabled === 'false'
            ? false
            : undefined,
      created_by: q.created_by,
    };

    const allSchedules = isSuperAdmin(userRole, allowSuperadmin)
      ? await scheduleRepo.findAll(filter)
      : await scheduleRepo.findAccessibleSchedules(userId, filter);

    // `branch_id` / `enabled` / `created_by` are already applied SQL-side;
    // pass the rest of the query through the shared paginate+sort helper.
    context.result = paginateClientSide(
      allSchedules,
      q as Record<string, unknown>,
      new Set(['branch_id', 'enabled', 'created_by'])
    );
    return context;
  };
}

/**
 * Load a schedule by ID from context.id, then load its parent branch,
 * and cache both (plus ownership) on `context.params`.
 *
 * Mirrors `loadSessionBranch` — the canonical pattern for
 * "look up the nested resource, then load its branch for RBAC".
 *
 * Must run BEFORE `ensureBranchPermission`.
 *
 * @param scheduleRepo - ScheduleRepository instance
 * @param branchRepo - BranchRepository instance
 */
export function loadScheduleAndBranch(
  scheduleRepo: ScheduleRepository,
  branchRepo: BranchRepository
) {
  return async (context: HookContext) => {
    if (!context.params.provider) return context;
    if (context.params.user?._isServiceAccount) return context;

    const id = context.id ?? context.params.route?.id;
    if (!id) throw new Error('Schedule ID required');

    const schedule = await scheduleRepo.findById(id as string);
    if (!schedule) throw new NotFound(`Schedule not found: ${id}`);

    const branch = await branchRepo.findById(schedule.branch_id);
    if (!branch) {
      // Cascaded delete means this should never happen; treat as a
      // bug-class error rather than a not-found.
      throw new NotFound(`Branch not found for schedule: ${schedule.schedule_id}`);
    }

    context.params.schedule = schedule;
    await cacheBranchAccess(context.params, branchRepo, branch);
    return context;
  };
}

/**
 * Enforce the modify-schedule tier: `session` for the schedule's
 * creator, `all` for everyone else. Mirrors the
 * sessions.patch rule (see register-hooks.ts:1765-1791).
 *
 * Must run AFTER `loadScheduleAndBranch`.
 */
export function ensureCanModifySchedule(options?: { allowSuperadmin?: boolean }) {
  return (context: HookContext) => {
    if (!context.params.provider) return context;
    if (context.params.user?._isServiceAccount) return context;
    if (!context.params.user) throw new NotAuthenticated('Authentication required');

    const branch = context.params.branch;
    const schedule = context.params.schedule;
    const isOwner = context.params.isBranchOwner ?? false;
    if (!branch || !schedule) {
      throw new Error('loadScheduleAndBranch hook must run before ensureCanModifySchedule');
    }

    const userId = context.params.user.user_id as UUID;
    const userRole = context.params.user.role as string | undefined;
    const allowSuperadmin = options?.allowSuperadmin ?? true;

    // "Own" = the schedule's creator gets the session-tier bar
    // (i.e. branch.others_can >= session); everyone else needs 'all'.
    const requiredTier: BranchPermissionLevel = schedule.created_by === userId ? 'session' : 'all';

    if (
      !hasBranchPermission(
        branch,
        userId,
        isOwner,
        requiredTier,
        userRole,
        allowSuperadmin,
        context.params.branchPermission
      )
    ) {
      throw new Forbidden(
        `You need '${requiredTier}' permission on branch ${shortId(branch.branch_id)} to modify schedule ${shortId(schedule.schedule_id)}.`
      );
    }

    return context;
  };
}
