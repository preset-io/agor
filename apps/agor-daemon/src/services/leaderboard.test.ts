/**
 * LeaderboardService tests.
 *
 * Exercises the aggregation service end-to-end against an in-memory SQLite
 * instance. Tasks are inserted directly (bypassing the repository) because
 * `TaskRepository.create` always stamps `created_at = new Date()`, and these
 * tests need deterministic timestamps for bucketing assertions.
 */

import {
  type Database,
  generateId,
  insert,
  RepoRepository,
  sessions,
  tasks,
  users,
  worktrees,
} from '@agor/core/db';
import { TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { LeaderboardService } from './leaderboard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fixed base timestamp (2026-04-15T12:00:00Z) so bucketing tests can assert
 * exact day/week/month boundaries without relying on wall-clock time.
 */
const BASE_TS = new Date('2026-04-15T12:00:00.000Z').getTime();

function tsAt({
  daysOffset = 0,
  hoursOffset = 0,
}: {
  daysOffset?: number;
  hoursOffset?: number;
} = {}): Date {
  return new Date(BASE_TS + daysOffset * 86_400_000 + hoursOffset * 3_600_000);
}

async function seedUser(db: Database, id: string, name: string, email: string): Promise<void> {
  await insert(db, users)
    .values({
      user_id: id,
      created_at: new Date(),
      email,
      password: 'x',
      name,
      emoji: 'emoji',
      role: 'member',
      data: {},
    })
    .run();
}

async function seedRepoAndWorktree(
  db: Database,
  opts: { slug: string; worktreeId: string; worktreeName: string; uniqueId: number }
): Promise<string> {
  const repoRepo = new RepoRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: opts.slug,
    name: `Repo ${opts.slug}`,
    repo_type: 'remote' as const,
    remote_url: `https://github.com/test/${opts.slug}.git`,
    local_path: `/tmp/${opts.slug}`,
    default_branch: 'main',
  });

  await insert(db, worktrees)
    .values({
      worktree_id: opts.worktreeId,
      repo_id: repo.repo_id,
      created_at: new Date(),
      name: opts.worktreeName,
      ref: 'main',
      worktree_unique_id: opts.uniqueId,
      data: { path: `/tmp/${opts.slug}/wt`, git_state: { ref_at_start: 'main' } },
    })
    .run();

  return repo.repo_id;
}

async function seedSession(
  db: Database,
  opts: { sessionId: string; worktreeId: string; tool: 'claude-code' | 'codex' | 'gemini' }
): Promise<void> {
  await insert(db, sessions)
    .values({
      session_id: opts.sessionId,
      created_at: new Date(),
      status: 'idle',
      agentic_tool: opts.tool,
      worktree_id: opts.worktreeId,
      created_by: 'anonymous',
      data: { genealogy: { children: [] }, contextFiles: [], tasks: [], git_state: {} },
    })
    .run();
}

async function seedTask(
  db: Database,
  opts: {
    sessionId: string;
    createdBy: string;
    createdAt: Date;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    durationMs?: number;
  }
): Promise<void> {
  const data = {
    description: 'test',
    full_prompt: 'test',
    message_range: { start_index: 0, end_index: 0, start_timestamp: opts.createdAt.toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
    model: opts.model,
    tool_use_count: 0,
    duration_ms: opts.durationMs,
    normalized_sdk_response: {
      tokenUsage: {
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        totalTokens: opts.inputTokens + opts.outputTokens,
      },
      costUsd: opts.costUsd,
      durationMs: opts.durationMs,
    },
  };

  await insert(db, tasks)
    .values({
      task_id: generateId(),
      session_id: opts.sessionId,
      created_at: opts.createdAt,
      status: TaskStatus.COMPLETED,
      created_by: opts.createdBy,
      data,
    })
    .run();
}

/**
 * Seed a canonical dataset used across several tests:
 *
 * - 2 users (alice, bob)
 * - 1 repo / 1 worktree (simplifies most assertions)
 * - 2 sessions, one claude-code (alice) and one codex (bob)
 * - 4 tasks spanning 3 consecutive days (Apr 15, 16, 17) on 2 models
 */
async function seedCanonicalDataset(db: Database): Promise<{
  aliceId: string;
  bobId: string;
  worktreeId: string;
  claudeSessionId: string;
  codexSessionId: string;
}> {
  const aliceId = 'user-alice';
  const bobId = 'user-bob';
  const worktreeId = 'wt-main';
  const claudeSessionId = 'sess-claude';
  const codexSessionId = 'sess-codex';

  await seedUser(db, aliceId, 'Alice', 'alice@example.com');
  await seedUser(db, bobId, 'Bob', 'bob@example.com');
  await seedRepoAndWorktree(db, {
    slug: 'main',
    worktreeId,
    worktreeName: 'main-wt',
    uniqueId: 1,
  });
  await seedSession(db, { sessionId: claudeSessionId, worktreeId, tool: 'claude-code' });
  await seedSession(db, { sessionId: codexSessionId, worktreeId, tool: 'codex' });

  // Alice / claude-code / sonnet — 2 tasks on Apr 15 (same day)
  await seedTask(db, {
    sessionId: claudeSessionId,
    createdBy: aliceId,
    createdAt: tsAt({ daysOffset: 0, hoursOffset: 0 }),
    model: 'claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.1,
    durationMs: 2000,
  });
  await seedTask(db, {
    sessionId: claudeSessionId,
    createdBy: aliceId,
    createdAt: tsAt({ daysOffset: 0, hoursOffset: 2 }),
    model: 'claude-sonnet-4-6',
    inputTokens: 2000,
    outputTokens: 1000,
    costUsd: 0.2,
    durationMs: 3000,
  });
  // Alice / claude-code / opus — Apr 16
  await seedTask(db, {
    sessionId: claudeSessionId,
    createdBy: aliceId,
    createdAt: tsAt({ daysOffset: 1 }),
    model: 'claude-opus-4-6',
    inputTokens: 4000,
    outputTokens: 2000,
    costUsd: 0.6,
    durationMs: 5000,
  });
  // Bob / codex / gpt-5 — Apr 17
  await seedTask(db, {
    sessionId: codexSessionId,
    createdBy: bobId,
    createdAt: tsAt({ daysOffset: 2 }),
    model: 'gpt-5',
    inputTokens: 800,
    outputTokens: 200,
    costUsd: 0.05,
    durationMs: 1000,
  });

  return { aliceId, bobId, worktreeId, claudeSessionId, codexSessionId };
}

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('LeaderboardService backward compatibility', () => {
  dbTest('legacy user/worktree/repo groupBy returns the same row shape', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find();

    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.data.length).toBeGreaterThan(0);

    for (const row of result.data) {
      // Legacy fields still present
      expect(row.userId).toBeDefined();
      expect(row.worktreeId).toBeDefined();
      expect(row.repoId).toBeDefined();
      expect(typeof row.totalTokens).toBe('number');
      expect(typeof row.totalCost).toBe('number');
      expect(typeof row.taskCount).toBe('number');
      // No bucket field by default
      expect(row.bucket).toBeUndefined();
      // No model/tool fields since neither was requested
      expect(row.model).toBeUndefined();
      expect(row.tool).toBeUndefined();
    }
  });

  dbTest('totalTokens still sums normalized totalTokens', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { groupBy: 'user' } });
    const alice = result.data.find((r) => r.userId === 'user-alice');
    expect(alice).toBeDefined();
    // Alice: (1000+500) + (2000+1000) + (4000+2000) = 10500
    expect(alice?.totalTokens).toBe(10_500);
    // New split metrics
    expect(alice?.totalInputTokens).toBe(7_000);
    expect(alice?.totalOutputTokens).toBe(3_500);
  });
});

// ---------------------------------------------------------------------------
// New dimensions
// ---------------------------------------------------------------------------

describe('LeaderboardService dimensions', () => {
  dbTest('groupBy: "model" returns one row per distinct model', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { groupBy: 'model' } });
    const modelNames = new Set(result.data.map((r) => r.model));
    expect(modelNames).toEqual(new Set(['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-5']));

    // Sonnet row aggregates both Apr 15 tasks
    const sonnet = result.data.find((r) => r.model === 'claude-sonnet-4-6');
    expect(sonnet?.taskCount).toBe(2);
    expect(sonnet?.totalTokens).toBe(4_500);
    expect(sonnet?.totalInputTokens).toBe(3_000);
    expect(sonnet?.totalOutputTokens).toBe(1_500);
  });

  dbTest('groupBy: "tool" returns one row per agentic tool', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { groupBy: 'tool' } });
    const tools = new Set(result.data.map((r) => r.tool));
    expect(tools).toEqual(new Set(['claude-code', 'codex']));

    const claude = result.data.find((r) => r.tool === 'claude-code');
    expect(claude?.taskCount).toBe(3);
    expect(claude?.sessionCount).toBe(1);

    const codex = result.data.find((r) => r.tool === 'codex');
    expect(codex?.taskCount).toBe(1);
    expect(codex?.sessionCount).toBe(1);
  });

  dbTest('groupBy: "user,model" returns rows keyed by both fields', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { groupBy: 'user,model' } });
    // Alice has 2 models, Bob has 1
    expect(result.data).toHaveLength(3);
    for (const row of result.data) {
      expect(row.userId).toBeDefined();
      expect(row.model).toBeDefined();
    }
    const aliceOpus = result.data.find(
      (r) => r.userId === 'user-alice' && r.model === 'claude-opus-4-6'
    );
    expect(aliceOpus?.totalTokens).toBe(6_000);
  });
});

// ---------------------------------------------------------------------------
// New metrics
// ---------------------------------------------------------------------------

describe('LeaderboardService metrics', () => {
  dbTest('sessionCount reflects distinct sessions per group', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { groupBy: 'user' } });
    // Alice used 1 session (claude), Bob used 1 (codex)
    const alice = result.data.find((r) => r.userId === 'user-alice');
    const bob = result.data.find((r) => r.userId === 'user-bob');
    expect(alice?.sessionCount).toBe(1);
    expect(bob?.sessionCount).toBe(1);
  });

  dbTest('totalDurationMs sums normalized durationMs per group', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { groupBy: 'user' } });
    const alice = result.data.find((r) => r.userId === 'user-alice');
    // Alice durations: 2000 + 3000 + 5000 = 10_000
    expect(alice?.totalDurationMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

describe('LeaderboardService bucketing', () => {
  dbTest('bucket: "day" emits one row per day and orders chronologically', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { bucket: 'day', groupBy: '' } });
    // 3 distinct days: Apr 15, 16, 17
    expect(result.data).toHaveLength(3);
    // Chronological order
    expect(result.data[0].bucket).toBe('2026-04-15T00:00:00.000Z');
    expect(result.data[1].bucket).toBe('2026-04-16T00:00:00.000Z');
    expect(result.data[2].bucket).toBe('2026-04-17T00:00:00.000Z');
    // Apr 15 aggregates the two sonnet tasks
    expect(result.data[0].taskCount).toBe(2);
    expect(result.data[0].totalTokens).toBe(4_500);
  });

  dbTest('bucket combined with groupBy:user returns per-user-per-day rows', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { bucket: 'day', groupBy: 'user' } });
    // Alice has tasks on 2 days, Bob on 1 → 3 rows total
    expect(result.data).toHaveLength(3);
    // First chronologically is Alice on Apr 15
    expect(result.data[0].bucket).toBe('2026-04-15T00:00:00.000Z');
    expect(result.data[0].userId).toBe('user-alice');

    // Each row has bucket + user dimension
    for (const row of result.data) {
      expect(row.bucket).toBeDefined();
      expect(row.userId).toBeDefined();
    }
  });

  dbTest('bucket: "month" collapses all fixture rows into one bucket', async ({ db }) => {
    await seedCanonicalDataset(db);
    const service = new LeaderboardService(db);

    const result = await service.find({ query: { bucket: 'month', groupBy: '' } });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].bucket).toBe('2026-04-01T00:00:00.000Z');
    expect(result.data[0].taskCount).toBe(4);
  });

  dbTest('invalid bucket value rejects with a clear error', async ({ db }) => {
    const service = new LeaderboardService(db);
    await expect(service.find({ query: { bucket: 'year' as never } })).rejects.toThrow(
      /Invalid bucket/
    );
  });
});
