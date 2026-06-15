import type { LeaderboardEntry } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  buildAggregates,
  buildChartSeries,
  fmtCompact,
  fmtHours,
  fmtInt,
  fmtMoney,
  labelForRow,
  shortModel,
  type UsageData,
} from './usageTransforms';

/**
 * Build a LeaderboardEntry with sane metric defaults so tests only specify the
 * fields they care about.
 */
function entry(partial: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    totalTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    taskCount: 0,
    sessionCount: 0,
    totalDurationMs: 0,
    ...partial,
  };
}

describe('formatters', () => {
  it('fmtInt rounds and applies thousands separators', () => {
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(1234.6)).toBe('1,235');
    expect(fmtInt(Number.NaN)).toBe('0');
  });

  it('fmtMoney scales by magnitude', () => {
    expect(fmtMoney(0)).toBe('$0.00');
    expect(fmtMoney(12.5)).toBe('$12.50');
    expect(fmtMoney(250)).toBe('$250');
    expect(fmtMoney(12_345)).toBe('$12.3k');
  });

  it('fmtCompact abbreviates large numbers', () => {
    expect(fmtCompact(42)).toBe('42');
    expect(fmtCompact(1_500)).toBe('1.5k');
    expect(fmtCompact(2_300_000)).toBe('2.3M');
    expect(fmtCompact(4_100_000_000)).toBe('4.1B');
  });

  it('fmtHours converts milliseconds to hours', () => {
    expect(fmtHours(0)).toBe('0.0h');
    expect(fmtHours(1.8e6)).toBe('0.5h'); // 30 min
    expect(fmtHours(3.6e7)).toBe('10h'); // 10 h
    expect(fmtHours(3.6e9)).toBe('1.0k h'); // 1000 h
  });

  it('shortModel strips the claude- prefix and date suffix', () => {
    expect(shortModel('claude-opus-4-6-20250101')).toBe('opus-4-6');
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet-4-5');
    expect(shortModel(undefined)).toBe('unknown');
  });
});

describe('labelForRow', () => {
  it('prefers the human-friendly identifier per dimension', () => {
    expect(labelForRow(entry({ userName: 'Ada', userEmail: 'ada@x.io' }), 'user')).toBe('Ada');
    expect(labelForRow(entry({ tool: 'claude-code' }), 'tool')).toBe('claude-code');
    expect(labelForRow(entry({ model: 'claude-opus-4-6-20250101' }), 'model')).toBe('opus-4-6');
    expect(labelForRow(entry({ repoName: 'agor' }), 'repo')).toBe('agor');
    expect(labelForRow(entry({ branchName: 'feat-x' }), 'branch')).toBe('feat-x');
  });

  it('falls back to a truncated id, then to "unknown"', () => {
    expect(labelForRow(entry({ userEmail: 'a@b.io' }), 'user')).toBe('a@b.io');
    expect(labelForRow(entry({ userId: 'abcdef1234567890' }), 'user')).toBe('abcdef12');
    expect(labelForRow(entry({}), 'user')).toBe('unknown');
    expect(labelForRow(entry({ repoId: 'repo-aaaabbbb' }), 'repo')).toBe('repo-aaa');
    expect(labelForRow(entry({}), 'tool')).toBe('unknown');
  });
});

function usageData(partial: Partial<UsageData>): UsageData {
  return {
    series: [],
    overview: { user: [], tool: [], model: [], repo: [], branch: [] },
    ...partial,
  };
}

describe('buildChartSeries', () => {
  it('pivots bucketed rows into per-period stacked entries', () => {
    const data = usageData({
      series: [
        entry({ bucket: '2026-04-13T00:00:00.000Z', userName: 'Ada', totalCost: 10 }),
        entry({ bucket: '2026-04-13T00:00:00.000Z', userName: 'Lin', totalCost: 4 }),
        entry({ bucket: '2026-04-20T00:00:00.000Z', userName: 'Ada', totalCost: 6 }),
      ],
    });

    const { rows, keys } = buildChartSeries(data, 'cost', 'user', 'week');

    expect(keys).toEqual(['Ada', 'Lin']); // Ada (16) ranks above Lin (4)
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Ada: 10, Lin: 4 });
    expect(rows[1]).toMatchObject({ Ada: 6 });
    // chronological order preserved by ISO sort
    expect(rows[0].__bucket).toBe('2026-04-13T00:00:00.000Z');
    expect(rows[1].__bucket).toBe('2026-04-20T00:00:00.000Z');
  });

  it('folds everything beyond the top 12 keys into "Other"', () => {
    const series: LeaderboardEntry[] = [];
    for (let i = 0; i < 15; i++) {
      series.push(
        entry({ bucket: '2026-04-13T00:00:00.000Z', userName: `u${i}`, totalCost: 100 - i })
      );
    }
    const { keys, rows } = buildChartSeries(usageData({ series }), 'cost', 'user', 'week');

    expect(keys).toHaveLength(13); // 12 named + Other
    expect(keys[12]).toBe('Other');
    // Top 12 are costs 100..89; the remaining 3 (88 + 87 + 86) fold into Other.
    expect(rows[0].Other).toBe(261);
  });

  it('drops non-positive values and rows without a bucket', () => {
    const data = usageData({
      series: [
        entry({ bucket: '2026-04-13T00:00:00.000Z', userName: 'Ada', totalCost: 5 }),
        entry({ bucket: '2026-04-13T00:00:00.000Z', userName: 'Zero', totalCost: 0 }),
        entry({ userName: 'NoBucket', totalCost: 9 }),
      ],
    });
    const { rows, keys } = buildChartSeries(data, 'cost', 'user', 'week');

    expect(keys).toEqual(['Ada']);
    expect(rows).toHaveLength(1);
    expect(rows[0].Zero).toBeUndefined();
  });

  it('returns empty rows when no series data is present', () => {
    expect(buildChartSeries(usageData({}), 'cost', 'user', 'week')).toEqual({ rows: [], keys: [] });
  });
});

describe('buildAggregates', () => {
  const data = usageData({
    overview: {
      user: [
        entry({
          userName: 'Ada',
          userEmoji: '🦊',
          totalCost: 30,
          taskCount: 9,
          sessionCount: 3,
          totalOutputTokens: 1000,
          totalDurationMs: 7.2e6,
        }),
        entry({
          userName: 'Lin',
          totalCost: 10,
          taskCount: 1,
          sessionCount: 1,
          totalOutputTokens: 500,
          totalDurationMs: 3.6e6,
        }),
        entry({ userName: 'Idle', totalCost: 0 }),
      ],
      tool: [
        entry({ tool: 'claude-code', totalCost: 25 }),
        entry({ tool: 'codex', totalCost: 15 }),
      ],
      model: [
        entry({ model: 'claude-opus-4-6', totalCost: 28 }),
        entry({ model: 'claude-sonnet-4-5', totalCost: 12 }),
      ],
      repo: [entry({ repoName: 'agor', totalCost: 40 })],
      branch: [entry({ branchName: 'feat-x', totalCost: 22 })],
    },
  });

  it('ranks each dimension descending and drops zero-valued rows', () => {
    const agg = buildAggregates(data, 'cost');

    expect(agg.users.map((r) => r.name)).toEqual(['Ada', 'Lin']); // Idle dropped
    expect(agg.users[0]).toMatchObject({ name: 'Ada', value: 30, emoji: '🦊' });
    expect(agg.tools[0].name).toBe('claude-code');
    expect(agg.repos[0].name).toBe('agor');
  });

  it('sums KPIs from the user dimension', () => {
    const { kpis } = buildAggregates(data, 'cost');

    expect(kpis.totalCost).toBe(40);
    expect(kpis.totalPrompts).toBe(10);
    expect(kpis.totalSessions).toBe(4);
    expect(kpis.totalTokens).toBe(1500);
    expect(kpis.totalMs).toBe(10.8e6);
    expect(kpis.activeUsers).toBe(3); // counts all rows, including the idle one
  });

  it('derives opus cost share from the model dimension', () => {
    expect(buildAggregates(data, 'cost').kpis.opusCost).toBe(28);
  });

  it('re-ranks by the selected metric', () => {
    const data2 = usageData({
      overview: {
        ...data.overview,
        user: [
          entry({ userName: 'Cheap', totalCost: 1, taskCount: 100 }),
          entry({ userName: 'Pricey', totalCost: 50, taskCount: 2 }),
        ],
      },
    });

    expect(buildAggregates(data2, 'cost').users[0].name).toBe('Pricey');
    expect(buildAggregates(data2, 'prompts').users[0].name).toBe('Cheap');
  });
});
