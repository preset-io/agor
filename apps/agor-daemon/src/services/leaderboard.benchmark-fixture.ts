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

async function seedBenchmarkBranch(db: TenantScopeAwareDatabase) {
  const owner = await new UsersRepository(db).create({
    email: `benchmark-${generateId()}@example.invalid`,
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    slug: `benchmark-${generateId()}`,
    name: 'Benchmark',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/benchmark.git',
    local_path: `/tmp/benchmark-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: 'benchmark',
    path: `/tmp/benchmark-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
    created_by: owner.user_id as UUID,
  });
  return { owner, branch };
}

export async function benchmarkLeaderboard(db: TenantScopeAwareDatabase): Promise<void> {
  const { owner, branch } = await seedBenchmarkBranch(db);
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

/** One long parent, 30 tasks per fork; all forks run after the parent finishes. */
export async function benchmarkForkLeaderboard(db: TenantScopeAwareDatabase): Promise<void> {
  const shapes = process.env.AGOR_LEADERBOARD_FORK_SHAPES ?? '500x1,500x50,1000x100,5000x500';
  const timings = new Map<string, { full: number; filtered: number }>();
  for (const shape of shapes.split(',')) {
    const [parentTasks, forkCount] = shape.split('x').map(Number);
    if (!parentTasks || !forkCount) throw new Error(`Invalid fork benchmark shape: ${shape}`);
    const { owner, branch } = await seedBenchmarkBranch(db);
    const start = Date.UTC(2026, 0, 1);
    const forkStart = start + parentTasks * 60_000 + 86_400_000;
    const sessionIds = Array.from({ length: forkCount + 1 }, () => generateId());
    for (let offset = 0; offset < sessionIds.length; offset += 100) {
      await insert(db, sessions)
        .values(
          sessionIds.slice(offset, offset + 100).map((id, i) => ({
            session_id: id,
            branch_id: branch.branch_id,
            agentic_tool: 'codex',
            status: 'idle',
            created_by: owner.user_id,
            created_at: new Date(start),
            updated_at: new Date(start),
            forked_from_session_id: offset + i === 0 ? null : sessionIds[0],
            data: {},
          }))
        )
        .run();
    }
    const count = parentTasks + forkCount * 30;
    for (let offset = 0; offset < count; offset += 100) {
      const rows = Array.from({ length: Math.min(100, count - offset) }, (_, i) => {
        const n = offset + i;
        const parent = n < parentTasks;
        const turn = parent ? n + 1 : parentTasks + ((n - parentTasks) % 30) + 1;
        const at = new Date(
          parent ? start + n * 60_000 : forkStart + ((n - parentTasks) % 30) * 60_000
        );
        const data = {
          model: 'benchmark-model',
          normalized_sdk_response: {
            costUsd: turn / 100,
            tokenUsage: {
              inputTokens: turn * 100,
              outputTokens: turn * 10,
              totalTokens: turn * 110,
              cacheReadTokens: turn * 20,
              cacheCreationTokens: turn * 5,
            },
          },
          padding: '',
        };
        data.padding = 'x'.repeat(4096 - JSON.stringify(data).length);
        return {
          task_id: generateId(),
          session_id: sessionIds[parent ? 0 : 1 + Math.floor((n - parentTasks) / 30)],
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
    await executeRaw(db, sql`ANALYZE tasks`);
    await executeRaw(db, sql`ANALYZE sessions`);
    const service = new LeaderboardService(db);
    const measure = async (filtered: boolean) => {
      const began = performance.now();
      const result = await service.find({
        query: {
          groupBy: 'tool',
          branchId: branch.branch_id,
          ...(filtered ? { startDate: new Date(forkStart).toISOString() } : {}),
        },
      });
      const ms = performance.now() - began;
      expect(result.data[0]?.taskCount).toBe(filtered ? forkCount * 30 : count);
      return ms;
    };
    await measure(false);
    await measure(true);
    const full = [],
      filtered = [];
    for (let i = 0; i < 3; i++) {
      full.push(await measure(false));
      filtered.push(await measure(true));
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
    const result = { full: median(full), filtered: median(filtered) };
    timings.set(shape, result);
    console.info(
      `fork benchmark: ${shape}, ${count} tasks, 4096-byte data; full=${result.full.toFixed(1)}ms lastDay=${result.filtered.toFixed(1)}ms`
    );
  }
  const control = timings.get('500x1'),
    many = timings.get('500x50');
  if (control && many) {
    // 50 forks must not re-extract/re-sort the same wide parent history 50 times.
    // Compared with 530 control tasks, 2000 tasks allow an 8x full-query budget.
    // Use the full control for both: its parent history must be read even
    // when a date filter excludes it from the aggregate.
    expect(many.full).toBeLessThan(control.full * 8);
    expect(many.filtered).toBeLessThan(control.full * 8);
  }
}
