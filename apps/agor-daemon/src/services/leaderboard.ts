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
  type SQL,
  messages,
  sessions,
  sql,
  tasks,
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
    const dimensions = groupBy.split(',').map(d => d.trim());
    const includeUser = dimensions.includes('user');
    const includeWorktree = dimensions.includes('worktree');
    const includeRepo = dimensions.includes('repo');

    // Build WHERE conditions
    const conditions: SQL[] = [];

    // Only count assistant messages (they have token usage in metadata)
    conditions.push(eq(messages.role, 'assistant'));

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
      const startMs = new Date(startDate).getTime();
      conditions.push(sql`${tasks.created_at} >= ${startMs}`);
    }

    if (endDate) {
      const endMs = new Date(endDate).getTime();
      conditions.push(sql`${tasks.created_at} <= ${endMs}`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Build dynamic SELECT clause
    // Aggregate token usage from messages (stored in metadata.tokens.input/output)
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic SQL fields require any
    const selectFields: Record<string, any> = {
      totalTokens: sql<number>`COALESCE(SUM(
        CAST(json_extract(${messages.data}, '$.metadata.tokens.input') AS INTEGER) +
        CAST(json_extract(${messages.data}, '$.metadata.tokens.output') AS INTEGER)
      ), 0)`.as('total_tokens'),
      // TODO: Calculate actual cost based on model and token counts using pricing utility
      totalCost: sql<number>`CAST(0.0 AS REAL)`.as('total_cost'),
      taskCount: sql<number>`COUNT(DISTINCT ${tasks.task_id})`.as('task_count'),
    };

    if (includeUser) {
      selectFields.userId = tasks.created_by;
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
    if (includeUser) groupByFields.push(tasks.created_by);
    if (includeWorktree) {
      groupByFields.push(worktrees.worktree_id);
      groupByFields.push(worktrees.name);
    }
    if (includeRepo) groupByFields.push(worktrees.repo_id);

    // Build sorting
    const sortField = sortBy === 'tokens' ? sql`total_tokens` : sql`total_cost`;
    const orderClause = sortOrder === 'desc' ? desc(sortField) : asc(sortField);

    // Execute aggregation query
    // Join: messages -> tasks -> sessions -> worktrees
    const results = await this.db
      .select(selectFields)
      .from(messages)
      .innerJoin(tasks, eq(messages.task_id, tasks.task_id))
      .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
      .innerJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
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

    const countResult = await this.db
      .select({
        count: sql<number>`${distinctExpr}`,
      })
      .from(messages)
      .innerJoin(tasks, eq(messages.task_id, tasks.task_id))
      .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
      .innerJoin(worktrees, eq(sessions.worktree_id, worktrees.worktree_id))
      .where(whereClause);

    const total = countResult[0]?.count || 0;

    // Transform results to match our interface
    const data: LeaderboardEntry[] = results.map(row => ({
      ...(includeUser && { userId: row.userId as string }),
      ...(includeWorktree && {
        worktreeId: row.worktreeId as string,
        worktreeName: row.worktreeName as string,
      }),
      ...(includeRepo && { repoId: row.repoId as string }),
      totalTokens: (row.totalTokens as number) || 0,
      totalCost: (row.totalCost as number) || 0,
      taskCount: (row.taskCount as number) || 0,
    }));

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
