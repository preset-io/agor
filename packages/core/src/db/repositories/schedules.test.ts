/**
 * ScheduleRepository Tests
 *
 * Focuses on the new behavior introduced with first-class schedules:
 *   - findDue: the scheduler hot-path query (enabled + due)
 *   - findAccessibleSchedules: SQL-JOIN RBAC filter
 *   - findByBranchId: list a branch's schedules newest-first
 *   - basic CRUD round-trip + agentic_tool_config jsonb/text roundtrip
 */

import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { ScheduleRepository } from './schedules';
import { UsersRepository } from './users';

async function setupContext(db: Database) {
  const userRepo = new UsersRepository(db);
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const scheduleRepo = new ScheduleRepository(db);

  const user = await userRepo.create({
    email: `schedule-test-${Date.now()}-${Math.random()}@example.com`,
    name: 'Schedule Test',
  });
  const userId = user.user_id as UUID;

  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: `schedule-test-${Date.now()}`,
    name: 'sched-test',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/sched-test',
    default_branch: 'main',
  });

  const branch = await branchRepo.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'feat-sched',
    ref: 'refs/heads/feat-sched',
    branch_unique_id: 1,
    path: '/tmp/sched-test/feat-sched',
    new_branch: false,
    last_used: new Date().toISOString(),
    created_by: userId,
    others_can: 'view',
  });

  return {
    branchId: branch.branch_id as BranchID,
    userId,
    branchRepo,
    scheduleRepo,
  };
}

function scheduleData(overrides?: {
  name?: string;
  enabled?: boolean;
  next_run_at?: number | null;
  retention?: number;
}) {
  return {
    name: overrides?.name ?? 'Hourly heartbeat',
    cron_expression: '0 * * * *',
    timezone_mode: 'utc' as const,
    prompt: 'Heartbeat for {{branch.name}}',
    agentic_tool_config: {
      agentic_tool: 'claude-code' as const,
    },
    enabled: overrides?.enabled ?? true,
    allow_concurrent_runs: false,
    retention: overrides?.retention ?? 5,
    next_run_at: overrides?.next_run_at ?? undefined,
  };
}

describe('ScheduleRepository.create + findById', () => {
  dbTest('round-trips a schedule with all fields populated', async ({ db }) => {
    const ctx = await setupContext(db);

    const created = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'Daily summary' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    expect(created.schedule_id).toBeTruthy();
    expect(created.name).toBe('Daily summary');
    expect(created.cron_expression).toBe('0 * * * *');
    expect(created.timezone_mode).toBe('utc');
    expect(created.agentic_tool_config.agentic_tool).toBe('claude-code');
    expect(created.enabled).toBe(true);
    expect(created.allow_concurrent_runs).toBe(false);

    const fetched = await ctx.scheduleRepo.findById(created.schedule_id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Daily summary');
    // agentic_tool_config round-trips through text/jsonb cleanly
    expect(fetched?.agentic_tool_config).toEqual({ agentic_tool: 'claude-code' });
  });

  dbTest('rejects schedule without required fields', async ({ db }) => {
    const ctx = await setupContext(db);
    await expect(
      ctx.scheduleRepo.create({
        branch_id: ctx.branchId,
        created_by: ctx.userId,
        // missing name, cron, prompt, agentic_tool_config
      })
    ).rejects.toThrow();
  });
});

describe('ScheduleRepository.findByBranchId', () => {
  dbTest('returns newest-first schedules for the given branch', async ({ db }) => {
    const ctx = await setupContext(db);

    const first = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'first' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Force a small gap so created_at orders correctly even at sub-ms speeds.
    await new Promise((r) => setTimeout(r, 5));
    const second = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'second' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const all = await ctx.scheduleRepo.findByBranchId(ctx.branchId);
    expect(all.map((s) => s.name)).toEqual(['second', 'first']);
    expect(all[0].schedule_id).toBe(second.schedule_id);
    expect(all[1].schedule_id).toBe(first.schedule_id);
  });
});

describe('ScheduleRepository.findDue', () => {
  dbTest('returns enabled schedules whose next_run_at <= now', async ({ db }) => {
    const ctx = await setupContext(db);
    const now = Date.now();

    // Due — past next_run_at.
    const due = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'due', next_run_at: now - 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Due — never-fired (next_run_at IS NULL).
    const never = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'never', next_run_at: null }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Not due — future next_run_at.
    await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'future', next_run_at: now + 60 * 60 * 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Disabled.
    await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'disabled', enabled: false, next_run_at: now - 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const dueList = await ctx.scheduleRepo.findDue(now);
    const dueIds = new Set(dueList.map((s) => s.schedule_id));
    expect(dueIds.has(due.schedule_id)).toBe(true);
    expect(dueIds.has(never.schedule_id)).toBe(true);
    expect(dueList.length).toBe(2);
  });

  dbTest('findDueRefs returns only due schedule routing refs', async ({ db }) => {
    const ctx = await setupContext(db);
    const now = Date.now();

    const due = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'due-ref', next_run_at: now - 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'future-ref', next_run_at: now + 60 * 60 * 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const refs = await ctx.scheduleRepo.findDueRefs(now);

    expect(refs).toEqual([{ schedule_id: due.schedule_id }]);
  });
});

describe('ScheduleRepository.findAccessibleSchedules', () => {
  dbTest('returns schedules whose parent branch the user can view', async ({ db }) => {
    const userRepo = new UsersRepository(db);
    const repoRepo = new RepoRepository(db);
    const branchRepo = new BranchRepository(db);
    const scheduleRepo = new ScheduleRepository(db);

    // Two users, two branches: alice owns one and the other is restricted.
    const alice = await userRepo.create({
      email: `alice-${Date.now()}@example.com`,
      name: 'Alice',
    });
    const bob = await userRepo.create({
      email: `bob-${Date.now()}@example.com`,
      name: 'Bob',
    });

    const repo = await repoRepo.create({
      repo_id: generateId() as UUID,
      slug: `acc-test-${Date.now()}`,
      name: 'acc-test',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/acc-test',
      default_branch: 'main',
    });

    const aliceBranch = await branchRepo.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id as UUID,
      name: 'alice-branch',
      ref: 'refs/heads/alice',
      branch_unique_id: 1,
      path: '/tmp/acc-test/alice',
      new_branch: false,
      last_used: new Date().toISOString(),
      created_by: alice.user_id as UUID,
      others_can: 'view', // bob can view via others_can
    });

    const lockedBranch = await branchRepo.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id as UUID,
      name: 'locked-branch',
      ref: 'refs/heads/locked',
      branch_unique_id: 2,
      path: '/tmp/acc-test/locked',
      new_branch: false,
      last_used: new Date().toISOString(),
      created_by: bob.user_id as UUID,
      others_can: 'none', // alice cannot view
    });

    const aliceSchedule = await scheduleRepo.create({
      ...scheduleData({ name: 'alice-sched' }),
      branch_id: aliceBranch.branch_id as BranchID,
      created_by: alice.user_id as UUID,
    });
    await scheduleRepo.create({
      ...scheduleData({ name: 'locked-sched' }),
      branch_id: lockedBranch.branch_id as BranchID,
      created_by: bob.user_id as UUID,
    });

    // alice-branch has others_can='view', so both alice and bob see its
    // schedule via the public-view path.
    const aliceVisible = await scheduleRepo.findAccessibleSchedules(alice.user_id as UUID);
    const aliceIds = new Set(aliceVisible.map((s) => s.schedule_id));
    expect(aliceIds.has(aliceSchedule.schedule_id)).toBe(true);
    // locked-branch is others_can='none' and alice has no branchOwners
    // row on it, so its schedule must not appear.
    expect(aliceVisible.every((s) => s.branch_id === aliceBranch.branch_id)).toBe(true);

    // Bob is the creator of locked-branch but `created_by` does NOT grant
    // ownership — the RBAC owner check goes through `branch_owners`. So
    // bob only sees alice-branch's schedule (others_can=view) and NOT
    // locked-branch's. This matches `SessionRepository.findAccessibleSessions`.
    const bobVisible = await scheduleRepo.findAccessibleSchedules(bob.user_id as UUID);
    const bobIds = new Set(bobVisible.map((s) => s.schedule_id));
    expect(bobIds.has(aliceSchedule.schedule_id)).toBe(true);
    expect(bobVisible.every((s) => s.branch_id === aliceBranch.branch_id)).toBe(true);
  });
});

describe('ScheduleRepository.update', () => {
  dbTest('patches a subset of fields without nuking the rest', async ({ db }) => {
    const ctx = await setupContext(db);
    const created = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'before' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const patched = await ctx.scheduleRepo.update(created.schedule_id, {
      name: 'after',
      enabled: false,
    });

    expect(patched.name).toBe('after');
    expect(patched.enabled).toBe(false);
    expect(patched.cron_expression).toBe(created.cron_expression);
    expect(patched.prompt).toBe(created.prompt);
    expect(patched.agentic_tool_config).toEqual(created.agentic_tool_config);
  });
});

describe('ScheduleRepository.delete', () => {
  dbTest('removes a schedule and subsequent findById returns null', async ({ db }) => {
    const ctx = await setupContext(db);
    const created = await ctx.scheduleRepo.create({
      ...scheduleData(),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    await ctx.scheduleRepo.delete(created.schedule_id);
    const after = await ctx.scheduleRepo.findById(created.schedule_id);
    expect(after).toBeNull();
  });
});
