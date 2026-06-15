/**
 * Leaderboard / usage analytics types.
 *
 * Shared between the daemon's `/leaderboard` service and UI consumers
 * (Usage page, board artifacts via the public API).
 */

/**
 * Supported groupBy dimensions. Callers can combine these in a comma-separated string,
 * e.g. `'user,model'` or `'tool,branch,repo'`.
 */
export type LeaderboardDimension = 'user' | 'branch' | 'repo' | 'model' | 'tool';

/** Time-bucket granularity for usage time series. */
export type LeaderboardBucket = 'hour' | 'day' | 'week' | 'month';

export interface LeaderboardQuery {
  // Filters
  userId?: string;
  branchId?: string;
  repoId?: string;

  // Time period (optional - ISO timestamps)
  startDate?: string;
  endDate?: string;

  // Group by dimensions (optional, comma-separated). Default matches legacy behaviour.
  // Supported values: 'user' | 'branch' | 'repo' | 'model' | 'tool' (any combination).
  groupBy?: string;

  // Time bucket (optional). When set, adds a `bucket` field (ISO-8601 UTC timestamp
  // truncated to the given granularity) to each row and to the GROUP BY.
  bucket?: LeaderboardBucket;

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
