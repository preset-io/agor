/**
 * Schedule normalization + validation hooks.
 *
 * Three before-hooks that wire into the `schedules` Feathers service:
 *
 * 1. `ensureCurrentScheduleLoaded(repo)` — lazy-loads the current
 *    schedule onto `params.schedule` on `patch`. `loadScheduleAndBranch`
 *    already caches it under branch-RBAC, but RBAC is off by default
 *    and the validation/recompute hooks need the current row on every
 *    install.
 *
 * 2. `validateScheduleConfig()` — cron + IANA + prompt-template
 *    validation against the merged (current + patch) shape so
 *    e.g. switching `timezone_mode: 'local'` doesn't require resending
 *    the existing `timezone` value just to pass.
 *
 * 3. `recomputeNextRunAt()` — keeps the `next_run_at` invariant fresh
 *    on create, on any timing-field change, and on enable-toggle. The
 *    scheduler tick reads this column for its hot-path query
 *    (`findDue`); leaving it stale after a cron change would fire the
 *    schedule on the OLD cadence until the old `next_run_at` finally
 *    passes. The scheduler bypasses the service when it advances
 *    metadata after a run, so its `scheduleRepo.update({next_run_at})`
 *    writes are not double-handled.
 *
 * Tests live in `schedule-hooks.test.ts`. The hooks are intentionally
 * dependency-injected (the repo is a factory arg) so the tests can
 * stub `findById` without spinning up the full Feathers app.
 */

import type { ScheduleRepository } from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, Schedule } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

/**
 * Lazy-load the current schedule into `context.params.schedule` on
 * patch when the RBAC chain didn't cache it. Idempotent: no-op when
 * already present.
 */
export function ensureCurrentScheduleLoaded(scheduleRepo: ScheduleRepository) {
  return async (context: HookContext) => {
    if (context.method !== 'patch') return context;
    if (context.params.schedule) return context;
    const id = context.id as string | undefined;
    if (!id) return context;
    const current = await scheduleRepo.findById(id);
    if (current) context.params.schedule = current;
    return context;
  };
}

/**
 * Cron + IANA + prompt-template validator. Runs on both create and
 * patch — on patch, validates against the merged (current + patch)
 * shape so partial updates don't need to resend untouched fields.
 *
 * Must run AFTER `ensureCurrentScheduleLoaded` on patch so the merged
 * shape can include the current row's `timezone` / `timezone_mode`.
 */
export function validateScheduleConfig() {
  return async (context: HookContext) => {
    const data = context.data as Partial<Schedule> | undefined;
    if (!data) return context;

    const current =
      context.method === 'patch' ? (context.params.schedule as Schedule | undefined) : undefined;
    const merged = { ...(current ?? {}), ...data } as Partial<Schedule>;

    // Use the dialect-agnostic cron helper. We pass the schedule's
    // effective tz so DST-sensitive crons get validated against the
    // right timezone (cron-parser rejects e.g. tz='not_a_zone').
    if (data.cron_expression !== undefined) {
      const { isValidCron } = await import('@agor/core/utils/cron');
      const tz = merged.timezone_mode === 'local' && merged.timezone ? merged.timezone : 'UTC';
      if (!isValidCron(data.cron_expression, tz)) {
        throw new BadRequest(`Invalid cron expression: '${data.cron_expression}'`);
      }
    }

    if (merged.timezone_mode === 'local' && !merged.timezone) {
      throw new BadRequest("timezone_mode='local' requires a non-empty IANA timezone.");
    }
    if (data.timezone) {
      // Cheap IANA validation via Intl.DateTimeFormat — throws RangeError
      // on unknown zones. No external dep required.
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: data.timezone });
      } catch {
        throw new BadRequest(`Unknown IANA timezone: '${data.timezone}'`);
      }
    }

    if (data.prompt !== undefined && data.prompt.trim() === '') {
      throw new BadRequest('Schedule prompt cannot be empty.');
    }

    return context;
  };
}

/**
 * Enforce the schedule run-as contract for external callers.
 *
 * Today `schedules.created_by` is both audit attribution ("scheduled by")
 * and execution identity ("run as"). That makes it security-sensitive:
 * patching or manually triggering another user's schedule means controlling
 * an agent that will execute with that user's Agor MCP token / Unix identity.
 *
 * External callers may therefore only modify/run schedules they created.
 * Superadmins remain an ops escape hatch for modifying schedule definitions,
 * but the run-as field itself is immutable for everyone. Internal scheduler
 * ticks bypass this hook.
 */
export function ensureScheduleRunsAsCaller(options?: { allowSuperadmin?: boolean }) {
  return (context: HookContext): HookContext => {
    if (!context.params.provider) return context;
    if (context.params.user?._isServiceAccount) return context;

    const user = context.params.user;
    if (!user?.user_id) {
      throw new NotAuthenticated('Authentication required');
    }

    const schedule = context.params.schedule as Schedule | undefined;
    if (!schedule) {
      throw new Error('ensureScheduleRunsAsCaller requires params.schedule');
    }

    const data = context.data as Partial<Schedule> | undefined;
    if (data?.created_by !== undefined && data.created_by !== schedule.created_by) {
      throw new Forbidden('Cannot change the user a schedule runs as.');
    }

    const allowSuperadmin = options?.allowSuperadmin ?? true;
    if (allowSuperadmin && hasMinimumRole(user.role, ROLES.SUPERADMIN)) {
      return context;
    }

    if (schedule.created_by !== user.user_id) {
      throw new Forbidden(
        'Schedules run as the user who created them. You can only modify or run schedules you created.'
      );
    }

    return context;
  };
}

/**
 * Keep `next_run_at` coherent on every persisted write.
 *
 * - On `create`: seed `next_run_at` from `cron_expression` + effective
 *   timezone (unless the caller passed an explicit value).
 * - On `patch`: recompute when any timing field changes OR when a
 *   disabled schedule flips to enabled (so the row doesn't sit
 *   hot-path-due every tick until the next fire).
 *
 * Must run AFTER `ensureCurrentScheduleLoaded` on patch (it reads
 * `params.schedule`).
 */
export function recomputeNextRunAt() {
  return async (context: HookContext) => {
    const data = context.data as Partial<Schedule> | undefined;
    if (!data) return context;

    const { getNextRunTime } = await import('@agor/core/utils/cron');

    if (context.method === 'create') {
      if (data.cron_expression && data.next_run_at == null) {
        const tz = data.timezone_mode === 'local' && data.timezone ? data.timezone : 'UTC';
        try {
          data.next_run_at = getNextRunTime(data.cron_expression, new Date(), tz);
        } catch {
          // validateScheduleConfig already rejected invalid crons; ignore here.
        }
      }
      return context;
    }

    const current = context.params.schedule as Schedule | undefined;
    if (!current) return context; // No current row (shouldn't happen post-ensureCurrentScheduleLoaded).

    const touchesTiming =
      data.cron_expression !== undefined ||
      data.timezone_mode !== undefined ||
      data.timezone !== undefined;
    const reEnabling = data.enabled === true && current.enabled === false;
    if (!touchesTiming && !reEnabling) return context;

    const merged = { ...current, ...data };
    const tz = merged.timezone_mode === 'local' && merged.timezone ? merged.timezone : 'UTC';
    try {
      data.next_run_at = getNextRunTime(merged.cron_expression, new Date(), tz);
    } catch {
      // validateScheduleConfig already rejected invalid crons; ignore here.
    }
    return context;
  };
}
