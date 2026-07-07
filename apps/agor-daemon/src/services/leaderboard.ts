/**
 * Leaderboard Service
 *
 * Provides usage analytics endpoint for token and cost tracking.
 * Allows breakdown by user, branch, repo, model, and agentic tool, with
 * optional time bucketing (hour/day/week/month) and flexible filtering.
 */

import {
  and,
  asc,
  branches,
  type DateBucket,
  dateTruncUtc,
  desc,
  eq,
  gte,
  inArray,
  jsonExtract,
  lte,
  type SQL,
  sessions,
  sql,
  type TenantScopeAwareDatabase,
  tasks,
  users,
} from '@agor/core/db';

interface Params {
  query?: Record<string, unknown>;
}

/**
 * Supported groupBy dimensions. Callers can combine these in a comma-separated string,
 * e.g. `'user,model'` or `'tool,branch,repo'`.
 */
export type LeaderboardDimension = 'user' | 'branch' | 'repo' | 'model' | 'tool';

const ALL_DIMENSIONS: LeaderboardDimension[] = ['user', 'branch', 'repo', 'model', 'tool'];

type StringFilterValue = string | string[];

export interface LeaderboardQuery {
  // Filters
  userId?: StringFilterValue;
  userIds?: StringFilterValue;
  branchId?: StringFilterValue;
  branchIds?: StringFilterValue;
  repoId?: StringFilterValue;
  repoIds?: StringFilterValue;
  model?: StringFilterValue;
  models?: StringFilterValue;
  tool?: StringFilterValue;
  tools?: StringFilterValue;

  // Time period (optional - ISO timestamps)
  startDate?: string;
  endDate?: string;

  // Group by dimensions (optional, comma-separated). Default matches legacy behaviour.
  // Supported values: 'user' | 'branch' | 'repo' | 'model' | 'tool' (any combination).
  groupBy?: string;

  // Time bucket (optional). When set, adds a `bucket` field (ISO-8601 UTC timestamp
  // truncated to the given granularity) to each row and to the GROUP BY.
  bucket?: DateBucket;

  // Sorting. When bucket is set, results are ordered by bucket ASC first, then by
  // sortBy within each bucket.
  sortBy?: 'tokens' | 'cost';
  sortOrder?: 'asc' | 'desc';

  // Pagination
  limit?: number;
  offset?: number;
}

export interface LeaderboardEntry {
  // Dimension fields (present only when the corresponding dimension is in groupBy)
  userId?: string;
  userName?: string;
  userEmail?: string;
  userEmoji?: string;
  branchId?: string;
  branchName?: string;
  repoId?: string;
  repoName?: string;
  model?: string;
  tool?: string;

  // Time-series field (present only when `bucket` is set)
  bucket?: string;

  // Metrics (always present)
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  taskCount: number;
  sessionCount: number;
  totalDurationMs: number;
}

export interface LeaderboardResult {
  data: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

const VALID_BUCKETS = new Set<DateBucket>(['hour', 'day', 'week', 'month']);
const MAX_LIMIT = 10_000;

function parseIntegerParam(
  value: unknown,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeStringFilterValues(...values: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'string') return;
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  };

  for (const value of values) visit(value);
  return normalized;
}

function stringFilter(column: unknown, values: string[]): SQL | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return eq(column as never, values[0]);
  return inArray(column as never, values);
}

/**
 * Parse the comma-separated groupBy string into a set of known dimensions.
 * Throws on unknown values so typos surface loudly rather than silently
 * collapsing the result set to an unexpected grouping. Matches the strict
 * validation we do for `bucket`.
 */
function parseGroupBy(groupBy: string): Set<LeaderboardDimension> {
  const dims = new Set<LeaderboardDimension>();
  for (const raw of groupBy.split(',')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (!ALL_DIMENSIONS.includes(trimmed as LeaderboardDimension)) {
      throw new Error(
        `Invalid groupBy dimension: "${trimmed}". Expected one of: ${ALL_DIMENSIONS.join(', ')}.`
      );
    }
    dims.add(trimmed as LeaderboardDimension);
  }
  return dims;
}

/**
 * Leaderboard service
 *
 * Custom service that doesn't use DrizzleService adapter since we need
 * custom aggregation queries.
 */
export class LeaderboardService {
  private db: TenantScopeAwareDatabase;

  constructor(db: TenantScopeAwareDatabase) {
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
      userIds: userIdsQuery,
      branchId,
      branchIds: branchIdsQuery,
      repoId,
      repoIds: repoIdsQuery,
      model,
      models,
      tool,
      tools,
      startDate,
      endDate,
      groupBy = 'user,branch,repo',
      bucket,
      sortBy = 'cost',
      sortOrder = 'desc',
    } = query;

    const limit = parseIntegerParam(query.limit, 50, { min: 1, max: MAX_LIMIT });
    const offset = parseIntegerParam(query.offset, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });

    if (bucket !== undefined && !VALID_BUCKETS.has(bucket)) {
      throw new Error(`Invalid bucket: "${bucket}". Expected one of: hour, day, week, month.`);
    }

    // Parse groupBy dimensions
    const dims = parseGroupBy(groupBy);
    const includeUser = dims.has('user');
    const includeBranch = dims.has('branch');
    const includeRepo = dims.has('repo');
    const includeModel = dims.has('model');
    const includeTool = dims.has('tool');
    const repoIds = normalizeStringFilterValues(repoId, repoIdsQuery);
    const needsBranchesJoin = includeBranch || includeRepo || repoIds.length > 0;

    const modelExpr = jsonExtract(this.db, tasks.data, 'model');

    // Build WHERE conditions
    const conditions: SQL[] = [];

    const userFilter = stringFilter(
      tasks.created_by,
      normalizeStringFilterValues(userId, userIdsQuery)
    );
    if (userFilter) conditions.push(userFilter);

    const branchFilter = stringFilter(
      sessions.branch_id,
      normalizeStringFilterValues(branchId, branchIdsQuery)
    );
    if (branchFilter) conditions.push(branchFilter);

    const repoFilter = stringFilter(branches.repo_id, repoIds);
    if (repoFilter) conditions.push(repoFilter);

    const modelFilter = stringFilter(modelExpr, normalizeStringFilterValues(model, models));
    if (modelFilter) conditions.push(modelFilter);

    const toolFilter = stringFilter(
      sessions.agentic_tool,
      normalizeStringFilterValues(tool, tools)
    );
    if (toolFilter) conditions.push(toolFilter);

    // Use gte/lte so drizzle encodes the bound via the column's timestamp mapper
    // (integer ms on SQLite, timestamp-with-tz on Postgres). Passing an ISO string
    // through `sql` compared SQLite ms-epoch integers against text and excluded
    // everything.
    if (startDate) {
      const parsed = new Date(startDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid startDate: "${startDate}". Expected ISO 8601 format.`);
      }
      conditions.push(gte(tasks.created_at, parsed));
    }

    if (endDate) {
      const parsed = new Date(endDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid endDate: "${endDate}". Expected ISO 8601 format.`);
      }
      conditions.push(lte(tasks.created_at, parsed));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Build dynamic SELECT clause.
    //
    // Metrics are sourced from `normalized_sdk_response` (written by the executor,
    // agent-agnostic). For duration we prefer the normalized value; if unset we fall
    // back to the top-level `tasks.data.duration_ms`. Tasks without either field
    // (legacy / in-flight) contribute 0 duration, which is the same behaviour as
    // tokens/cost today.
    const inputTokensExpr = jsonExtract(
      this.db,
      tasks.data,
      'normalized_sdk_response.tokenUsage.inputTokens'
    );
    const outputTokensExpr = jsonExtract(
      this.db,
      tasks.data,
      'normalized_sdk_response.tokenUsage.outputTokens'
    );
    const totalTokensExpr = jsonExtract(
      this.db,
      tasks.data,
      'normalized_sdk_response.tokenUsage.totalTokens'
    );
    const costExpr = jsonExtract(this.db, tasks.data, 'normalized_sdk_response.costUsd');
    const normalizedDurationExpr = jsonExtract(
      this.db,
      tasks.data,
      'normalized_sdk_response.durationMs'
    );
    const topLevelDurationExpr = jsonExtract(this.db, tasks.data, 'duration_ms');

    // biome-ignore lint/suspicious/noExplicitAny: Dynamic SQL fields require any
    const selectFields: Record<string, any> = {
      totalInputTokens: sql<number>`COALESCE(SUM(
        CAST(${inputTokensExpr} AS INTEGER)
      ), 0)`.as('total_input_tokens'),
      totalOutputTokens: sql<number>`COALESCE(SUM(
        CAST(${outputTokensExpr} AS INTEGER)
      ), 0)`.as('total_output_tokens'),
      totalTokens: sql<number>`COALESCE(SUM(
        CAST(${totalTokensExpr} AS INTEGER)
      ), 0)`.as('total_tokens'),
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${costExpr} AS REAL)
      ), 0.0)`.as('total_cost'),
      taskCount: sql<number>`COUNT(DISTINCT ${tasks.task_id})`.as('task_count'),
      sessionCount: sql<number>`COUNT(DISTINCT ${tasks.session_id})`.as('session_count'),
      totalDurationMs: sql<number>`COALESCE(SUM(
        CAST(COALESCE(${normalizedDurationExpr}, ${topLevelDurationExpr}) AS INTEGER)
      ), 0)`.as('total_duration_ms'),
    };

    if (includeUser) {
      selectFields.userId = tasks.created_by;
      selectFields.userName = users.name;
      selectFields.userEmail = users.email;
      selectFields.userEmoji = users.emoji;
    }
    if (includeBranch) {
      selectFields.branchId = branches.branch_id;
      selectFields.branchName = branches.name;
    }
    if (includeRepo) {
      selectFields.repoId = branches.repo_id;
    }
    if (includeModel) {
      selectFields.model = sql<string>`${modelExpr}`.as('model');
    }
    if (includeTool) {
      selectFields.tool = sessions.agentic_tool;
    }

    // Bucketing: compute a UTC-truncated ISO timestamp string.
    const bucketExpr = bucket ? dateTruncUtc(this.db, tasks.created_at, bucket) : undefined;
    if (bucketExpr) {
      selectFields.bucket = sql<string>`${bucketExpr}`.as('bucket');
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
    if (includeBranch) {
      groupByFields.push(branches.branch_id);
      groupByFields.push(branches.name);
    }
    if (includeRepo) groupByFields.push(branches.repo_id);
    if (includeModel) groupByFields.push(sql`${modelExpr}`);
    if (includeTool) groupByFields.push(sessions.agentic_tool);
    if (bucketExpr) groupByFields.push(sql`${bucketExpr}`);

    // Build sorting. When bucketing, order by bucket ASC first so the caller receives
    // chronologically-ordered time series, then by the requested metric within each bucket.
    const sortField = sortBy === 'tokens' ? sql`total_tokens` : sql`total_cost`;
    const metricOrder = sortOrder === 'desc' ? desc(sortField) : asc(sortField);
    const orderClauses = bucketExpr ? [asc(sql`bucket`), metricOrder] : [metricOrder];

    // Execute aggregation query. We only join branches when a selected/filtering
    // dimension needs it; common dashboard views such as groupBy=tool or model can
    // aggregate from tasks -> sessions without paying for the extra join.
    // Optionally LEFT JOIN users for display info
    // Cast required: Database is a LibSQL|Postgres union; TypeScript cannot narrow the union
    // for dynamic-field SELECT queries even though both dialects share identical .select() API.
    // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
    let qb = (this.db as any)
      .select(selectFields)
      .from(tasks)
      .innerJoin(sessions, eq(tasks.session_id, sessions.session_id));

    if (needsBranchesJoin) {
      qb = qb.innerJoin(branches, eq(sessions.branch_id, branches.branch_id));
    }

    if (includeUser) {
      qb = qb.leftJoin(users, eq(tasks.created_by, users.user_id));
    }

    const results = await qb
      .where(whereClause)
      .groupBy(...groupByFields)
      .orderBy(...orderClauses)
      .limit(limit)
      .offset(offset);

    // Build distinct count for pagination. We wrap the aggregation query (without
    // ordering/limits) as a subquery and COUNT its groups. This is exact — no NULL
    // collisions and no dependence on a separator character — and always matches
    // the GROUP BY used for the paginated query above.
    let total: number;
    if (groupByFields.length === 0) {
      // No grouping: the main query returns a single aggregate row.
      total = results.length;
    } else if (offset === 0 && results.length < limit) {
      // If the first page is not full, the data query already proved the exact
      // number of groups. Avoid repeating the same expensive aggregation just to
      // COUNT it; leaderboard metrics extract/cast JSON on every matching task.
      total = results.length;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
      let countInner = (this.db as any)
        .select({ one: sql`1` })
        .from(tasks)
        .innerJoin(sessions, eq(tasks.session_id, sessions.session_id));

      if (needsBranchesJoin) {
        countInner = countInner.innerJoin(branches, eq(sessions.branch_id, branches.branch_id));
      }

      if (includeUser) {
        countInner = countInner.leftJoin(users, eq(tasks.created_by, users.user_id));
      }

      const groupedSubquery = countInner
        .where(whereClause)
        .groupBy(...groupByFields)
        .as('g');

      // biome-ignore lint/suspicious/noExplicitAny: Database union type prevents calling .select() with dynamic fields
      const countResult = await (this.db as any)
        .select({ count: sql<number>`COUNT(*)` })
        .from(groupedSubquery);

      total = Number(countResult[0]?.count) || 0;
    }

    // Define result row type based on selected fields
    interface ResultRow {
      userId?: string;
      userName?: string | null;
      userEmail?: string | null;
      userEmoji?: string | null;
      branchId?: string;
      branchName?: string;
      repoId?: string;
      model?: string | null;
      tool?: string | null;
      bucket?: string | null;
      totalTokens: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCost: number;
      taskCount: number;
      sessionCount: number;
      totalDurationMs: number;
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
        ...(includeBranch && {
          branchId: r.branchId as string,
          branchName: r.branchName as string,
        }),
        ...(includeRepo && { repoId: r.repoId as string }),
        ...(includeModel && { model: r.model || undefined }),
        ...(includeTool && { tool: r.tool || undefined }),
        ...(bucketExpr && { bucket: r.bucket || undefined }),
        totalTokens: Number(r.totalTokens) || 0,
        totalInputTokens: Number(r.totalInputTokens) || 0,
        totalOutputTokens: Number(r.totalOutputTokens) || 0,
        totalCost: Number(r.totalCost) || 0,
        taskCount: Number(r.taskCount) || 0,
        sessionCount: Number(r.sessionCount) || 0,
        totalDurationMs: Number(r.totalDurationMs) || 0,
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
export function createLeaderboardService(db: TenantScopeAwareDatabase): LeaderboardService {
  return new LeaderboardService(db);
}
