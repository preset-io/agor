/**
 * Schedule hook tests
 *
 * Covers the two RBAC-independent paths that Codex's round-3 review
 * flagged as missing test coverage:
 *
 * 1. Patching `cron_expression` with RBAC disabled (i.e. without the
 *    `loadScheduleAndBranch` chain caching `params.schedule`) — the
 *    `ensureCurrentScheduleLoaded` lazy-load fetches the row, then
 *    `recomputeNextRunAt` updates `data.next_run_at`.
 *
 * 2. Patching `timezone_mode: 'local'` while relying on an existing
 *    `timezone` on the row — `validateScheduleConfig` must read the
 *    MERGED (current + patch) shape, not just the incoming payload.
 *
 * The hooks are dependency-injected (ScheduleRepository is a factory
 * arg) so we stub `findById` instead of spinning up the full app.
 */

import type { HookContext, Schedule, ScheduleID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureCurrentScheduleLoaded,
  ensureScheduleRunsAsCaller,
  recomputeNextRunAt,
  validateScheduleConfig,
} from './schedule-hooks';

/** Build a fully-populated Schedule fixture with overrides. */
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    schedule_id: 'sched-test-0001' as ScheduleID,
    branch_id: 'br-test-0001' as Schedule['branch_id'],
    name: 'Test schedule',
    cron_expression: '0 * * * *',
    timezone_mode: 'local',
    timezone: 'America/Los_Angeles',
    prompt: 'do the thing',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    last_run_at: undefined,
    last_run_session_id: undefined,
    next_run_at: 1_000_000_000_000, // arbitrary epoch ms
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'user-test-0001' as Schedule['created_by'],
    ...overrides,
  } as Schedule;
}

/** Minimal HookContext for unit-testing the schedules hooks. */
function makeContext(opts: {
  method: 'create' | 'patch';
  id?: string;
  data: Partial<Schedule>;
  cachedSchedule?: Schedule;
  provider?: string;
  user?: { user_id?: string; role?: string; _isServiceAccount?: boolean };
}): HookContext {
  return {
    method: opts.method,
    id: opts.id,
    data: opts.data,
    params: {
      provider: opts.provider,
      user: opts.user,
      ...(opts.cachedSchedule ? { schedule: opts.cachedSchedule } : {}),
    },
  } as unknown as HookContext;
}

/** Stub repo that records `findById` calls and returns a fixed row. */
function makeStubRepo(row: Schedule | null = null) {
  const findById = vi.fn().mockResolvedValue(row);
  return { findById } as unknown as import('@agor/core/db').ScheduleRepository & {
    findById: ReturnType<typeof vi.fn>;
  };
}

describe('ensureCurrentScheduleLoaded', () => {
  it('no-ops on create (no current row to load)', async () => {
    const repo = makeStubRepo();
    const ctx = makeContext({ method: 'create', data: { cron_expression: '0 * * * *' } });
    await ensureCurrentScheduleLoaded(repo)(ctx);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(ctx.params.schedule).toBeUndefined();
  });

  it('no-ops on patch when RBAC already cached the schedule', async () => {
    const cached = makeSchedule({ name: 'cached' });
    const repo = makeStubRepo();
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { cron_expression: '*/5 * * * *' },
      cachedSchedule: cached,
    });
    await ensureCurrentScheduleLoaded(repo)(ctx);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(ctx.params.schedule).toBe(cached);
  });

  it('loads on patch when RBAC is off and no cached schedule exists', async () => {
    const row = makeSchedule({ name: 'from-db' });
    const repo = makeStubRepo(row);
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { cron_expression: '*/5 * * * *' },
    });
    await ensureCurrentScheduleLoaded(repo)(ctx);
    expect(repo.findById).toHaveBeenCalledWith('sched-test-0001');
    expect(ctx.params.schedule).toBe(row);
  });

  it('returns gracefully on patch when context.id is missing', async () => {
    const repo = makeStubRepo();
    const ctx = makeContext({ method: 'patch', data: { cron_expression: '*/5 * * * *' } });
    await ensureCurrentScheduleLoaded(repo)(ctx);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(ctx.params.schedule).toBeUndefined();
  });
});

describe('validateScheduleConfig', () => {
  it('validates cron against merged tz on patch', async () => {
    // Current schedule has tz='America/Los_Angeles'; patch only sends a
    // new cron. Validator must compose merged tz from the current row.
    const current = makeSchedule({ timezone_mode: 'local', timezone: 'America/Los_Angeles' });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { cron_expression: '0 9 * * 1-5' },
      cachedSchedule: current,
    });
    await expect(validateScheduleConfig()(ctx)).resolves.not.toThrow();
  });

  it("M1: accepts timezone_mode='local' patch when current row already has a timezone", async () => {
    // The exact case Codex flagged: PATCH { timezone_mode: 'local' }
    // shouldn't require resending the existing timezone value.
    const current = makeSchedule({ timezone_mode: 'utc', timezone: 'America/Los_Angeles' });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { timezone_mode: 'local' },
      cachedSchedule: current,
    });
    await expect(validateScheduleConfig()(ctx)).resolves.not.toThrow();
  });

  it("rejects timezone_mode='local' patch when merged shape has no timezone", async () => {
    const current = makeSchedule({ timezone_mode: 'utc', timezone: undefined });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { timezone_mode: 'local' },
      cachedSchedule: current,
    });
    await expect(validateScheduleConfig()(ctx)).rejects.toThrow(/IANA timezone/);
  });

  it('rejects unknown IANA timezone on patch', async () => {
    // No cron in the payload so the IANA check is the first to fire.
    // (When a cron IS in the payload, cron-parser rejects the bad tz
    // first with "Invalid cron expression" — same net effect: rejected.)
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { timezone: 'Not/AReal_Zone' },
      cachedSchedule: makeSchedule(),
    });
    await expect(validateScheduleConfig()(ctx)).rejects.toThrow(/Unknown IANA timezone/);
  });

  it('rejects invalid cron expression', async () => {
    const ctx = makeContext({
      method: 'create',
      data: {
        cron_expression: 'not a cron',
        timezone_mode: 'utc',
        prompt: 'x',
      },
    });
    await expect(validateScheduleConfig()(ctx)).rejects.toThrow(/Invalid cron expression/);
  });

  it('rejects empty prompt', async () => {
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { prompt: '   ' },
      cachedSchedule: makeSchedule(),
    });
    await expect(validateScheduleConfig()(ctx)).rejects.toThrow(/Schedule prompt cannot be empty/);
  });
});

describe('ensureScheduleRunsAsCaller', () => {
  it('allows the schedule creator to patch their own schedule', () => {
    const current = makeSchedule({ created_by: 'user-alice' as Schedule['created_by'] });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { name: 'renamed' },
      cachedSchedule: current,
      provider: 'rest',
      user: { user_id: 'user-alice', role: 'member' },
    });

    expect(() => ensureScheduleRunsAsCaller()(ctx)).not.toThrow();
  });

  it('rejects external patch attempts against schedules created by another user', () => {
    const current = makeSchedule({ created_by: 'user-alice' as Schedule['created_by'] });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { prompt: 'do something else' },
      cachedSchedule: current,
      provider: 'rest',
      user: { user_id: 'user-bob', role: 'member' },
    });

    expect(() => ensureScheduleRunsAsCaller()(ctx)).toThrow(/only modify or run schedules/);
  });

  it('allows superadmins to patch schedules created by another user', () => {
    const current = makeSchedule({ created_by: 'user-alice' as Schedule['created_by'] });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { prompt: 'ops fix' },
      cachedSchedule: current,
      provider: 'rest',
      user: { user_id: 'user-admin', role: 'superadmin' },
    });

    expect(() => ensureScheduleRunsAsCaller()(ctx)).not.toThrow();
  });

  it('rejects attempts to change created_by/run-as even by the creator', () => {
    const current = makeSchedule({ created_by: 'user-alice' as Schedule['created_by'] });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { created_by: 'user-bob' as Schedule['created_by'] },
      cachedSchedule: current,
      provider: 'rest',
      user: { user_id: 'user-alice', role: 'member' },
    });

    expect(() => ensureScheduleRunsAsCaller()(ctx)).toThrow(/Cannot change/);
  });

  it('rejects attempts to change created_by/run-as even by a superadmin', () => {
    const current = makeSchedule({ created_by: 'user-alice' as Schedule['created_by'] });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { created_by: 'user-bob' as Schedule['created_by'] },
      cachedSchedule: current,
      provider: 'rest',
      user: { user_id: 'user-admin', role: 'superadmin' },
    });

    expect(() => ensureScheduleRunsAsCaller()(ctx)).toThrow(/Cannot change/);
  });

  it('allows internal scheduler/service calls', () => {
    const current = makeSchedule({ created_by: 'user-alice' as Schedule['created_by'] });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { created_by: 'user-bob' as Schedule['created_by'] },
      cachedSchedule: current,
    });

    expect(() => ensureScheduleRunsAsCaller()(ctx)).not.toThrow();
  });
});

describe('recomputeNextRunAt', () => {
  it('seeds next_run_at on create when cron is set and value is missing', async () => {
    const ctx = makeContext({
      method: 'create',
      data: {
        cron_expression: '0 9 * * *',
        timezone_mode: 'utc',
        prompt: 'x',
      },
    });
    await recomputeNextRunAt()(ctx);
    expect(typeof (ctx.data as Partial<Schedule>).next_run_at).toBe('number');
    expect((ctx.data as Partial<Schedule>).next_run_at).toBeGreaterThan(Date.now());
  });

  it('does not overwrite an explicit next_run_at on create', async () => {
    const explicit = Date.now() + 60_000;
    const ctx = makeContext({
      method: 'create',
      data: {
        cron_expression: '0 * * * *',
        timezone_mode: 'utc',
        prompt: 'x',
        next_run_at: explicit,
      },
    });
    await recomputeNextRunAt()(ctx);
    expect((ctx.data as Partial<Schedule>).next_run_at).toBe(explicit);
  });

  it('H1: recomputes on patch with RBAC off (current schedule loaded by ensureCurrentScheduleLoaded)', async () => {
    const current = makeSchedule({ cron_expression: '0 0 * * 0', next_run_at: 1_000_000_000_000 });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { cron_expression: '*/5 * * * *' },
      cachedSchedule: current, // simulates ensureCurrentScheduleLoaded having run
    });
    await recomputeNextRunAt()(ctx);
    const updated = (ctx.data as Partial<Schedule>).next_run_at;
    expect(typeof updated).toBe('number');
    expect(updated).not.toBe(1_000_000_000_000);
    expect(updated).toBeGreaterThan(Date.now() - 1000);
    expect(updated).toBeLessThan(Date.now() + 6 * 60 * 1000); // within next 6 minutes
  });

  it('recomputes on timezone_mode patch', async () => {
    const current = makeSchedule({
      cron_expression: '0 9 * * *',
      timezone_mode: 'utc',
      timezone: 'America/Los_Angeles',
      next_run_at: 1_000_000_000_000,
    });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { timezone_mode: 'local' },
      cachedSchedule: current,
    });
    await recomputeNextRunAt()(ctx);
    expect((ctx.data as Partial<Schedule>).next_run_at).not.toBe(1_000_000_000_000);
  });

  it('M2: recomputes when enabled flips false → true', async () => {
    const current = makeSchedule({
      enabled: false,
      cron_expression: '0 * * * *',
      next_run_at: 1_000_000_000_000, // stale
    });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { enabled: true },
      cachedSchedule: current,
    });
    await recomputeNextRunAt()(ctx);
    expect((ctx.data as Partial<Schedule>).next_run_at).not.toBe(1_000_000_000_000);
  });

  it('does NOT recompute on patches that touch neither timing nor enable-toggle', async () => {
    const current = makeSchedule({ next_run_at: 1_000_000_000_000 });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { name: 'renamed', retention: 10 },
      cachedSchedule: current,
    });
    await recomputeNextRunAt()(ctx);
    // next_run_at was not in the incoming payload and should not be set
    expect((ctx.data as Partial<Schedule>).next_run_at).toBeUndefined();
  });

  it('does NOT recompute when enabled flips true → false', async () => {
    const current = makeSchedule({ enabled: true, next_run_at: 1_000_000_000_000 });
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { enabled: false },
      cachedSchedule: current,
    });
    await recomputeNextRunAt()(ctx);
    expect((ctx.data as Partial<Schedule>).next_run_at).toBeUndefined();
  });

  it('bails gracefully on patch with no current row cached', async () => {
    // Defensive: shouldn't happen post-ensureCurrentScheduleLoaded, but
    // the hook should not crash.
    const ctx = makeContext({
      method: 'patch',
      id: 'sched-test-0001',
      data: { cron_expression: '*/5 * * * *' },
    });
    await expect(recomputeNextRunAt()(ctx)).resolves.not.toThrow();
    expect((ctx.data as Partial<Schedule>).next_run_at).toBeUndefined();
  });
});
