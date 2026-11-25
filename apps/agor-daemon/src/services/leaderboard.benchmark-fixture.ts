/** Shared opt-in SQLite/PostgreSQL query-cost regression (no provider calls). */
import {
  BranchRepository,
  executeRaw,
  generateId,
  insert,
  RepoRepository,
  sessions,
  sql,
  type TenantScopeAwareDatabase,
  tasks,
  UsersRepository,
} from '@agor/core/db';
import { TaskStatus, type UUID } from '@agor/core/types';
import { expect } from 'vitest';
import { LeaderboardService } from './leaderboard';

export async function benchmarkLeaderboard(db: TenantScopeAwareDatabase): Promise<void> {
  const owner = await new UsersRepository(db).create({
    email: `benchmark-${generateId()}@example.invalid`,
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    slug: `benchmark-${generateId()}`,
    name: 'Benchmark',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/benchmark.git',
    local_path: '/tmp/benchmark',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: 'benchmark',
    path: '/tmp/benchmark',
    ref: 'main',
    branch_unique_id: 1,
    created_by: owner.user_id as UUID,
  });
  const start = Date.UTC(2026, 0, 1);
  const sessionIds = Array.from({ length: 1_000 }, () => generateId());
  for (let offset = 0; offset < sessionIds.length; offset += 100) {
    await insert(db, sessions)
      .values(
        sessionIds.slice(offset, offset + 100).map((id) => ({
          session_id: id,
          branch_id: branch.branch_id,
          agentic_tool: 'codex',
          status: 'idle',
          created_by: owner.user_id,
          created_at: new Date(start),
          updated_at: new Date(start),
          data: {},
        }))
      )
      .run();
  }
  // Consecutive 30-turn sessions, one task/minute, with 4 KiB JSON rows.
  for (let offset = 0; offset < 30_000; offset += 100) {
    const rows = Array.from({ length: 100 }, (_, i) => {
      const n = offset + i;
      const turn = (n % 30) + 1;
      const at = new Date(start + n * 60_000);
      const usage = {
        costUsd: turn / 100,
        tokenUsage: {
          inputTokens: turn * 100,
          outputTokens: turn * 10,
          totalTokens: turn * 110,
          cacheReadTokens: turn * 20,
          cacheCreationTokens: turn * 5,
        },
      };
      const data = { model: 'benchmark-model', normalized_sdk_response: usage, padding: '' };
      data.padding = 'x'.repeat(4096 - JSON.stringify(data).length);
      return {
        task_id: generateId(),
        session_id: sessionIds[Math.floor(n / 30)],
        created_by: owner.user_id,
        status: TaskStatus.COMPLETED,
        created_at: at,
        started_at: at,
        completed_at: at,
        data,
      };
    });
    await insert(db, tasks).values(rows).run();
  }
  // Fresh bulk inserts need statistics before comparing planner choices.
  await executeRaw(db, sql`ANALYZE tasks`);
  await executeRaw(db, sql`ANALYZE sessions`);
  const service = new LeaderboardService(db);
  const lastDay = new Date(start + (30_000 - 1440) * 60_000).toISOString();
  const measure = async (startDate?: string) => {
    const began = performance.now();
    const result = await service.find({ query: { groupBy: 'tool', startDate } });
    const ms = performance.now() - began;
    expect(result.data[0]?.taskCount).toBe(startDate ? 1440 : 30_000);
    return ms;
  };
  // Warm both paths, then compare medians rather than a brittle absolute budget.
  await measure();
  await measure(lastDay);
  const full = [],
    filtered = [];
  for (let n = 0; n < 3; n++) {
    full.push(await measure());
    filtered.push(await measure(lastDay));
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
  const fullMs = median(full),
    filteredMs = median(filtered);
  console.info(
    `leaderboard benchmark: 30000 tasks, 1000 sessions, 4096-byte data; full=${fullMs.toFixed(1)}ms lastDay=${filteredMs.toFixed(1)}ms ratio=${(filteredMs / fullMs).toFixed(3)}`
  );
  // 4.8% of sessions qualify. A tenant-wide window makes this ratio near 1.
  expect(filteredMs).toBeLessThan(fullMs * 0.35);
}
