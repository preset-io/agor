/**
 * Pure data-shaping helpers for the Usage analytics page.
 *
 * Kept free of React / recharts so the pivot + aggregation logic can be unit
 * tested in isolation. `UsagePage.tsx` owns the data fetching and rendering.
 */

import type { LeaderboardBucket, LeaderboardEntry } from '@agor/core/types';
import dayjs from 'dayjs';

/* ------------------------------------------------------------------ */
/*  Config                                                            */
/* ------------------------------------------------------------------ */

export const CHART_COLORS = [
  '#6366f1',
  '#22d3ee',
  '#f59e0b',
  '#10b981',
  '#ec4899',
  '#8b5cf6',
  '#f97316',
  '#14b8a6',
  '#ef4444',
  '#38bdf8',
  '#a78bfa',
  '#34d399',
];
export const OTHER_COLOR = '#64748b';
const TOP_SERIES_KEYS = 12;

export type MetricKey = 'cost' | 'prompts' | 'sessions' | 'tokens' | 'hours';
export type DimensionKey = 'user' | 'tool' | 'model' | 'repo' | 'branch';
export type WindowKey = '7d' | '30d' | '90d' | 'all' | 'custom';

export interface MetricDef {
  field: keyof Pick<
    LeaderboardEntry,
    'totalCost' | 'taskCount' | 'sessionCount' | 'totalOutputTokens' | 'totalDurationMs'
  >;
  label: string;
  color: string;
  fmt: (v: number) => string;
  axis: (v: number) => string;
}

export const METRICS: Record<MetricKey, MetricDef> = {
  cost: {
    field: 'totalCost',
    label: 'Cost',
    color: '#6366f1',
    fmt: fmtMoney,
    axis: (v) => `$${fmtCompact(v)}`,
  },
  prompts: {
    field: 'taskCount',
    label: 'Prompts',
    color: '#22d3ee',
    fmt: fmtInt,
    axis: fmtCompact,
  },
  sessions: {
    field: 'sessionCount',
    label: 'Sessions',
    color: '#10b981',
    fmt: fmtInt,
    axis: fmtCompact,
  },
  tokens: {
    field: 'totalOutputTokens',
    label: 'Output Tokens',
    color: '#f59e0b',
    fmt: fmtCompact,
    axis: fmtCompact,
  },
  hours: {
    field: 'totalDurationMs',
    label: 'Agent Hours',
    color: '#ec4899',
    fmt: fmtHours,
    axis: (v) => `${fmtCompact(v / 3.6e6)}h`,
  },
};
export const METRIC_ORDER: MetricKey[] = ['cost', 'prompts', 'sessions', 'tokens', 'hours'];

export const DIMENSIONS: Record<DimensionKey, { label: string }> = {
  user: { label: 'User' },
  tool: { label: 'Agent' },
  model: { label: 'Model' },
  repo: { label: 'Repo' },
  branch: { label: 'Branch' },
};
export const DIMENSION_ORDER: DimensionKey[] = ['user', 'tool', 'model', 'repo', 'branch'];

export const WINDOWS: Record<
  Exclude<WindowKey, 'custom'>,
  { label: string; days: number | null }
> = {
  '7d': { label: '7 days', days: 7 },
  '30d': { label: '30 days', days: 30 },
  '90d': { label: '90 days', days: 90 },
  all: { label: 'All time', days: null },
};

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                */
/* ------------------------------------------------------------------ */

export function fmtInt(v: number): string {
  return Math.round(v || 0).toLocaleString('en-US');
}

export function fmtMoney(v: number): string {
  const n = v || 0;
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

export function fmtCompact(v: number): string {
  const n = v || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtHours(ms: number): string {
  const h = (ms || 0) / 3.6e6;
  if (h >= 1000) return `${(h / 1000).toFixed(1)}k h`;
  if (h >= 10) return `${Math.round(h)}h`;
  return `${h.toFixed(1)}h`;
}

export function shortModel(model?: string): string {
  if (!model) return 'unknown';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function labelForRow(row: LeaderboardEntry, dim: DimensionKey): string {
  switch (dim) {
    case 'user':
      return row.userName || row.userEmail || (row.userId ? row.userId.slice(0, 8) : 'unknown');
    case 'tool':
      return row.tool || 'unknown';
    case 'model':
      return shortModel(row.model);
    case 'repo':
      return row.repoName || (row.repoId ? row.repoId.slice(0, 8) : 'unknown');
    case 'branch':
      return row.branchName || (row.branchId ? row.branchId.slice(0, 8) : 'unknown');
  }
}

/* ------------------------------------------------------------------ */
/*  Data shapes                                                       */
/* ------------------------------------------------------------------ */

export interface DateRange {
  startDate?: string;
  endDate?: string;
}

export interface UsageData {
  /** Bucketed rows for the time series: one row per (bucket × dimension value). */
  series: LeaderboardEntry[];
  /** Un-bucketed rows per dimension for KPIs, leaderboards, and share donuts. */
  overview: Record<DimensionKey, LeaderboardEntry[]>;
}

export interface RankedRow {
  name: string;
  value: number;
  emoji?: string;
}

export interface ChartSeries {
  rows: Record<string, number | string>[];
  keys: string[];
}

export interface UsageAggregates {
  users: RankedRow[];
  repos: RankedRow[];
  branches: RankedRow[];
  tools: RankedRow[];
  models: RankedRow[];
  kpis: {
    totalCost: number;
    totalPrompts: number;
    totalSessions: number;
    totalTokens: number;
    totalMs: number;
    opusCost: number;
    activeUsers: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Transforms                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pivot bucketed leaderboard rows into stacked-area series. Keeps the top
 * {@link TOP_SERIES_KEYS} dimension values by total and folds the rest into an
 * "Other" series. Empty (≤0) values are dropped so the chart stays sparse.
 */
export function buildChartSeries(
  data: UsageData,
  metric: MetricKey,
  dim: DimensionKey,
  bucket: LeaderboardBucket
): ChartSeries {
  const field = METRICS[metric].field;

  const totals = new Map<string, number>();
  for (const row of data.series) {
    if (!row.bucket) continue;
    const label = labelForRow(row, dim);
    totals.set(label, (totals.get(label) || 0) + (Number(row[field]) || 0));
  }
  const topKeys = [...totals.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SERIES_KEYS)
    .map(([k]) => k);
  const topSet = new Set(topKeys);

  const byBucket = new Map<string, Record<string, number | string>>();
  let hasOther = false;
  for (const row of data.series) {
    if (!row.bucket) continue;
    const value = Number(row[field]) || 0;
    if (value <= 0) continue;
    let entry = byBucket.get(row.bucket);
    if (!entry) {
      entry = { __bucket: row.bucket };
      byBucket.set(row.bucket, entry);
    }
    const label = labelForRow(row, dim);
    if (topSet.has(label)) {
      entry[label] = ((entry[label] as number) || 0) + value;
    } else {
      entry.Other = ((entry.Other as number) || 0) + value;
      hasOther = true;
    }
  }

  const fmt = bucket === 'month' ? 'MMM YY' : bucket === 'hour' ? 'MMM D HH:mm' : 'MMM D';
  const rows = [...byBucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([iso, entry]) => ({ ...entry, period: dayjs(iso).format(fmt) }));

  return { rows, keys: hasOther ? [...topKeys, 'Other'] : topKeys };
}

/**
 * Collapse the per-dimension overview rows into ranked leaderboards plus the
 * KPI totals. Ranked rows are sorted descending by the selected metric and
 * drop zero-valued entries.
 */
export function buildAggregates(data: UsageData, metric: MetricKey): UsageAggregates {
  const field = METRICS[metric].field;
  const sum = (rows: LeaderboardEntry[], f: MetricDef['field']) =>
    rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const ranked = (rows: LeaderboardEntry[], d: DimensionKey): RankedRow[] =>
    rows
      .map((r) => ({ name: labelForRow(r, d), value: Number(r[field]) || 0, emoji: r.userEmoji }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);

  const byUser = data.overview.user;
  const opusCost = data.overview.model
    .filter((r) => (r.model || '').includes('opus'))
    .reduce((s, r) => s + (Number(r.totalCost) || 0), 0);

  return {
    users: ranked(byUser, 'user'),
    repos: ranked(data.overview.repo, 'repo'),
    branches: ranked(data.overview.branch, 'branch'),
    tools: ranked(data.overview.tool, 'tool'),
    models: ranked(data.overview.model, 'model'),
    kpis: {
      totalCost: sum(byUser, 'totalCost'),
      totalPrompts: sum(byUser, 'taskCount'),
      totalSessions: sum(byUser, 'sessionCount'),
      totalTokens: sum(byUser, 'totalOutputTokens'),
      totalMs: sum(byUser, 'totalDurationMs'),
      opusCost,
      activeUsers: byUser.length,
    },
  };
}
