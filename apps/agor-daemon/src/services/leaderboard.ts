/**
 * Leaderboard Service
 *
 * Provides usage analytics endpoint for token and cost tracking.
 * Allows breakdown by user, worktree, and repo with flexible filtering and sorting.
 */

import {
  and,
  asc,
  type Database,
  desc,
  eq,
  jsonExtract,
  type SQL,
  sessions,
  sql,
  tasks,
  users,
  worktrees,
} from '@agor/core/db';

interface Params {
  query?: Record<string, unknown>;
}

export interface LeaderboardQuery {
  // Filters
  userId?: string;
  worktreeId?: string;
  repoId?: string;

  // Time period (optional - ISO timestamps)
  startDate?: string;
  endDate?: string;

  // Group by dimension (optional - defaults to all three)
  groupBy?:
    | 'user'
    | 'worktree'
    | 'repo'
    | 'user,worktree'
    | 'user,repo'
    | 'worktree,repo'
    | 'user,worktree,repo';

  // Sorting
  sortBy?: 'tokens' | 'cost';
  sortOrder?: 'asc' | 'desc';

  // Pagination
  limit?: number;
  offset?: number;
}

export interface LeaderboardEntry {
  userId?: string;
  userName?: string;
  userEmail?: string;
  userEmoji?: string;
  worktreeId?: string;
  worktreeName?: string;
  repoId?: string;
  repoName?: string;
  totalTokens: number;
  totalCost: number;
  taskCount: number;
}

export interface LeaderboardResult {
  data: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Leaderboard service
 *
 * Custom service that doesn't use DrizzleService adapter since we need
 * custom aggregation queries.
 */
export class LeaderboardService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Find leaderboard entries with filters and sorting
   */
  async find(params?: Params): Promise<LeaderboardResult> {
    const query = (params?.query || {}) as LeaderboardQuery;

    // Extract query params
    const {
      userId,
      worktreeId,
      repoId,
      startDate,
      endDate,
      groupBy = 'user,worktree,repo',
      sortBy = 'cost',
      sortOrder = 'desc',
      limit = 50,
      offset = 0,
    } = query;

    // Parse groupBy dimensions
    const dimensions = groupBy.split(',').map((d) => d.trim());
    const includeUser = dimensions.includes('user');
    const includeWorktree = dimensions.includes('worktree');
    const includeRepo = dimensions.includes('repo');

    // Build WHERE conditions
    const conditions: SQL[] = [];

    if (userId) {
      conditions.push(eq(tasks.created_by, userId));
    }

    if (worktreeId) {
      conditions.push(eq(sessions.worktree_id, worktreeId));
    }

    if (repoId) {
      conditions.push(eq(worktrees.repo_id, repoId));
    }

    if (startDate) {
      // Use Date object for Postgres compatibility (timestamp with time zone)
      // For SQLite (stored as integer ms), Drizzle will auto-convert Date to ms
      const startDateObj = new Date(startDate);
      conditions.push(sql`${tasks.created_at} >= ${startDateObj}`);
    }

    if (endDate) {
      // Use Date object for Postgres compatibility (timestamp with time zone)
      // For SQLite (stored as integer ms), Drizzle will auto-convert Date to ms
      const endDateObj = new Date(endDate);
      conditions.push(sql`${tasks.created_at} <= ${endDateObj}`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Build dynamic SELECT clause
    // Aggregate token usage from normalized_sdk_response.tokenUsage
    // The executor normalizes raw SDK responses into a consistent format across all agents
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic SQL fields require any
    const selectFields: Record<string, any> = {
      totalTokens: sql<number>`COALESCE(SUM(
        CAST(${jsonExtract(this.db, tasks.data, 'normalized_sdk_response.tokenUsage.totalTokens')} AS INTEGER)
      ), 0)`.as('total_tokens'),
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${jsonExtract(this.db, tasks.data, 'normalized_sdk_response.costUsd')} AS REAL)
      ), 0.0)`.as('total_cost'),
      taskCount: sql<number>`COUNT(DISTINCT ${tasks.task_id})`.as('task_count'),
    };

    if (includeUser) {
      selectFields.userId = tasks.created_by;
      selectFields.userName = users.name;
      selectFields.userEmail = users.email;
      selectFields.userEmoji = users.emoji;
    }
    if (includeWorktree) {
      selectFields.worktreeId = worktrees.worktree_id;
      selectFields.worktreeName = worktrees.name;
    }
    if (includeRepo) {
      selectFields.repoId = worktrees.repo_id;
    }

    // Build dynamic GROUP BY clause
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic SQL fields require any
    const groupByFields: any[] = [];
    if (includeUser) {
      groupByFields.push(tasks.created_by);
      groupByFields.push(users.name);
      groupByFields.push(users.email);
      groupByFields.push(users.emoji);
    }
    if (includeWorktree) {
      groupByFields.push(worktrees.worktree_id);
      groupByFields.push(worktrees.name);
    }
    if (includeRepo) groupByFields.push(worktrees.repo_id);

    // Build sorting
    const sortField = sortBy === 'tokens' ? sql`total_tokens` : sql`total_cost`;
    const orderClause = sortOrder === 'desc' ? desc(sortField) : asc(sortField);

    // Execute aggregation query
    // Join: tasks -> sessions -> worktrees, optionally LEFT JOIN users for display info
    // biome-ignore lint/suspicious/noExplicitAny: Complex multi-table join with dynamic grouping requires Drizzle type assertion
    let qb = (this.db as any)
      .select(selectFields)
      .from(tasks)
      .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
      .innerJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id));

    if (includeUser) {
      qb = qb.leftJoin(users, eq(tasks.created_by, users.user_id));
    }

    const results = await qb
      .where(whereClause)
      .groupBy(...groupByFields)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);

    // Build distinct count for pagination
    const distinctParts: string[] = [];
    if (includeUser) distinctParts.push('tasks.created_by');
    if (includeWorktree) distinctParts.push('worktrees.worktree_id');
    if (includeRepo) distinctParts.push('worktrees.repo_id');
    const distinctExpr =
      distinctParts.length > 0
        ? sql`COUNT(DISTINCT ${sql.raw(distinctParts.join(" || '-' || "))})`
        : sql`COUNT(*)`;

    // biome-ignore lint/suspicious/noExplicitAny: Complex aggregation query with dynamic SELECT fields requires Drizzle type assertion
    let countQb = (this.db as any)
      .select({
        count: sql<number>`${distinctExpr}`,
      })
      .from(tasks)
      .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
      .innerJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id));

    if (includeUser) {
      countQb = countQb.leftJoin(users, eq(tasks.created_by, users.user_id));
    }

    const countResult = await countQb.where(whereClause);

    const total = countResult[0]?.count || 0;

    // Define result row type based on selected fields
    interface ResultRow {
      userId?: string;
      userName?: string | null;
      userEmail?: string | null;
      userEmoji?: string | null;
      worktreeId?: string;
      worktreeName?: string;
      repoId?: string;
      totalTokens: number;
      totalCost: number;
      taskCount: number;
    }

    // Transform results to match our interface
    const data: LeaderboardEntry[] = results.map((row: unknown) => {
      const r = row as ResultRow;
      return {
        ...(includeUser && {
          userId: r.userId as string,
          userName: r.userName || undefined,
          userEmail: r.userEmail || undefined,
          userEmoji: r.userEmoji || undefined,
        }),
        ...(includeWorktree && {
          worktreeId: r.worktreeId as string,
          worktreeName: r.worktreeName as string,
        }),
        ...(includeRepo && { repoId: r.repoId as string }),
        totalTokens: r.totalTokens || 0,
        totalCost: r.totalCost || 0,
        taskCount: r.taskCount || 0,
      };
    });

    return {
      data,
      total,
      limit,
      offset,
    };
  }

  /**
   * Setup hooks for the service
   */
  async setup(_app: unknown, _path: string): Promise<void> {
    // No setup needed for now
  }
}

/**
 * Service factory function
 */
export function createLeaderboardService(db: Database): LeaderboardService {
  return new LeaderboardService(db);
}
