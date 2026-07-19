/**
 * Scheduler Service
 *
 * Manages cron-based scheduling. Reads from the first-class `schedules`
 * table (see docs/internal/schedules-first-class-design-2026-05-24.md);
 * spawns sessions, and enforces retention.
 *
 * **Architecture:**
 * - Runs on a configurable tick interval (default 30s)
 * - Hot path is the indexed `schedules.findDue(now)` query
 *   (`WHERE enabled = true AND next_run_at <= now`)
 * - Spawns sessions when current time matches/exceeds next_run_at
 * - Updates schedule metadata (last_run_at, last_run_session_id,
 *   next_run_at)
 * - Enforces retention policy per-schedule (deletes oldest scheduled
 *   sessions linked via `sessions.schedule_id`)
 *
 * Multi-daemon dedup is enforced by the partial unique index
 * `sessions_schedule_run_unique`. We deliberately do not hold an advisory
 * transaction while spawning an agent: external work must never extend a
 * tenant DB transaction or monopolize a pooled connection.
 *
 * **Smart Recovery:**
 * - If scheduler is down for an extended period, only schedules LATEST
 *   missed run (no backfill)
 * - Grace period: 2 minutes (schedules within 2min of current time are
 *   considered "on time")
 *
 * **Deduplication:**
 * - Uses scheduled_run_at (minute-rounded) as unique run identifier
 * - Indexed lookup `WHERE schedule_id = ? AND scheduled_run_at = ?`
 *   against `sessions_schedule_run_unique`
 *
 * **Template Rendering:**
 * - Uses Handlebars to render prompt templates with branch + schedule
 *   context. Branch fields are also exposed under `{{ worktree.* }}`
 *   as a v0.19 backwards-compat alias.
 */

import {
  assertInlineAgenticConfigurationAllowed,
  normalizeScheduleAgenticToolConfig,
  presetConfigurationToScheduleConfig,
  resolveAgenticConfigurationReference,
  resolveAgenticToolPreset,
} from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  BranchRepository,
  getCurrentTenantId,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionMCPServerRepository,
  SessionRepository,
  shortId,
  UsersRepository,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import { resolveSessionDefaults } from '@agor/core/sessions';
import type {
  Branch,
  MCPServerID,
  PermissionMode,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleID,
  Session,
  SessionID,
  TenantID,
  User,
  UUID,
} from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import {
  getNextRunTime,
  getPrevRunTime,
  resolveScheduleTz,
  roundToMinute,
} from '@agor/core/utils/cron';
import Handlebars from 'handlebars';
import type { Application } from '../declarations';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import type { SessionParams } from './sessions.js';

/**
 * Session statuses that count as "actively consuming the branch" for
 * the scheduler's concurrency guard. Owned by the scheduler (not the
 * SessionRepository) because the definition of "busy" is a scheduler-
 * policy decision, not a generic session-store fact.
 */
const ACTIVE_SESSION_STATUSES: ReadonlyArray<SessionStatus> = [
  SessionStatus.RUNNING,
  SessionStatus.STOPPING,
  SessionStatus.AWAITING_PERMISSION,
  SessionStatus.AWAITING_INPUT,
];

/**
 * Best-effort detection of the partial-unique-index conflict raised by
 * `sessions_schedule_run_unique` when a concurrent spawn races past
 * the dedup check. SQLite returns `SQLITE_CONSTRAINT_UNIQUE` /
 * `SQLITE_CONSTRAINT`; postgres-js raises an error whose `.code` is
 * `'23505'`. We match on the message too in case the underlying error
 * is wrapped (the repo wraps insert errors in `RepositoryError`).
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e.code ?? e.cause?.code ?? '';
  if (code === '23505') return true; // postgres
  if (code.startsWith('SQLITE_CONSTRAINT')) return true; // libsql / sqlite
  const msg = (e.message ?? '').toLowerCase();
  return msg.includes('unique constraint') || msg.includes('sqlite_constraint_unique');
}

/**
 * Render a Handlebars schedule-prompt template against the schedule's
 * branch metadata.
 *
 * Exposes branch fields under both `{{branch.*}}` (canonical) and
 * `{{worktree.*}}` (legacy v0.19 alias) so pre-rename prompts still
 * render. Also exposes `{{schedule.*}}` for cron / scheduled-time
 * substitutions.
 *
 * Falls back to the raw template on render error so a bad user template
 * never crashes the scheduler tick.
 */
export function renderSchedulePrompt(
  template: string,
  branch: Branch,
  schedule: Schedule,
  scheduledRunAt: number
): string {
  try {
    const compiledTemplate = Handlebars.compile(template);
    const branchEntity = {
      name: branch.name,
      ref: branch.ref,
      path: branch.path,
      issue_url: branch.issue_url,
      pull_request_url: branch.pull_request_url,
      notes: branch.notes,
      custom_context: branch.custom_context,
    };
    const context = {
      branch: branchEntity,
      worktree: branchEntity,
      // TODO: Add board context if needed (requires fetching board data)
      schedule: {
        schedule_id: schedule.schedule_id,
        name: schedule.name,
        cron: schedule.cron_expression,
        timezone_mode: schedule.timezone_mode,
        timezone: schedule.timezone,
        scheduled_time: new Date(scheduledRunAt).toISOString(),
      },
    };
    return compiledTemplate(context);
  } catch (error) {
    console.error(`❌ Failed to render prompt template:`, error);
    return template;
  }
}

/** Resolve a persisted schedule source into session-ready configuration for one run. */
export async function materializeScheduleAgenticToolConfig(
  db: TenantScopeAwareDatabase,
  schedule: Pick<Schedule, 'agentic_tool_config' | 'created_by'>
): Promise<ScheduleAgenticToolConfig> {
  const cfg = normalizeScheduleAgenticToolConfig(schedule.agentic_tool_config);
  if (cfg.configuration_reference) {
    const resolved = await resolveAgenticConfigurationReference(
      db,
      cfg.agentic_tool,
      cfg.configuration_reference,
      schedule.created_by as import('@agor/core/types').UserID
    );
    if (resolved.preset) {
      return presetConfigurationToScheduleConfig(
        cfg.agentic_tool,
        resolved.preset.preset_id,
        resolved.preset.configuration
      );
    }
    const materialized = presetConfigurationToScheduleConfig(
      cfg.agentic_tool,
      cfg.configuration_reference,
      resolved.configuration ?? {}
    );
    const { preset_id: _presetId, ...inline } = materialized;
    return inline;
  }
  if (cfg.preset_id) {
    const preset = await resolveAgenticToolPreset(db, cfg.agentic_tool, cfg.preset_id);
    return presetConfigurationToScheduleConfig(
      cfg.agentic_tool,
      preset.preset_id,
      preset.configuration
    );
  }
  await assertInlineAgenticConfigurationAllowed(db, cfg.agentic_tool);
  return cfg;
}

/**
 * Error thrown when execute-now is blocked because an active run from the same
 * schedule exists and allow_concurrent_runs is not enabled. Routes can catch
 * this and surface it as a 409 Conflict.
 */
export class ScheduleBusyError extends Error {
  public readonly code = 'schedule_busy';
  constructor(scheduleName: string) {
    super(
      `An active run from schedule "${scheduleName}" is already in progress and allow_concurrent_runs is disabled.`
    );
    this.name = 'ScheduleBusyError';
  }
}

/**
 * Error thrown when execute-now is called on a schedule that is not
 * runnable (disabled, missing entity, etc.).
 */
export class ScheduleNotReadyError extends Error {
  public readonly code: 'schedule_disabled' | 'schedule_incomplete';
  constructor(code: 'schedule_disabled' | 'schedule_incomplete', message: string) {
    super(message);
    this.name = 'ScheduleNotReadyError';
    this.code = code;
  }
}

export interface SchedulerConfig {
  /** Tick interval in milliseconds (default: 30000 = 30s) */
  tickInterval?: number;
  /** Grace period for missed runs in milliseconds (default: 120000 = 2min) */
  gracePeriod?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Unix user mode for validation (default: 'simple') */
  unixUserMode?: UnixUserMode;
  /** Static/single-tenant id used for request-less cron ticks. Undefined means discover due schedule tenants from schedule rows. */
  tenantId?: TenantID | string;
}

export class SchedulerService {
  private app: Application;
  private db: TenantScopeAwareDatabase;
  private config: Required<Omit<SchedulerConfig, 'tenantId'>> & Pick<SchedulerConfig, 'tenantId'>;
  private intervalHandle?: NodeJS.Timeout;
  private isRunning = false;
  private branchRepo: BranchRepository;
  private scheduleRepo: ScheduleRepository;
  private sessionRepo: SessionRepository;
  private userRepo: UsersRepository;
  private sessionMCPRepo: SessionMCPServerRepository;

  constructor(db: TenantScopeAwareDatabase, app: Application, config: SchedulerConfig = {}) {
    this.app = app;
    this.db = db;
    this.config = {
      tickInterval: config.tickInterval ?? 30000, // 30 seconds
      gracePeriod: config.gracePeriod ?? 120000, // 2 minutes
      debug: config.debug ?? false,
      unixUserMode: config.unixUserMode ?? 'simple',
      tenantId:
        typeof config.tenantId === 'string' && config.tenantId.trim()
          ? config.tenantId.trim()
          : undefined,
    };
    this.branchRepo = new BranchRepository(db);
    this.scheduleRepo = new ScheduleRepository(db);
    this.sessionRepo = new SessionRepository(db);
    this.userRepo = new UsersRepository(db);
    this.sessionMCPRepo = new SessionMCPServerRepository(db);
  }

  private withTenantDatabase<T>(work: () => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.db, getCurrentTenantId(), work);
  }

  /**
   * Start the scheduler tick loop
   */
  start(): void {
    if (this.isRunning) {
      console.warn('⚠️  Scheduler already running');
      return;
    }

    if (this.config.debug) {
      console.log(`🔄 Starting scheduler (tick interval: ${this.config.tickInterval}ms)`);
    }
    this.isRunning = true;

    // Run first tick immediately
    this.tick().catch((error) => {
      console.error('❌ Scheduler tick failed:', error);
    });

    // Schedule recurring ticks
    this.intervalHandle = setInterval(() => {
      this.tick().catch((error) => {
        console.error('❌ Scheduler tick failed:', error);
      });
    }, this.config.tickInterval);
  }

  /**
   * Stop the scheduler tick loop
   */
  stop(): void {
    if (!this.isRunning) {
      console.warn('⚠️  Scheduler not running');
      return;
    }

    console.log('🛑 Scheduler stopped');
    this.isRunning = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /**
   * Execute one scheduler tick.
   *
   * 1. Fetch all due schedules via the indexed
   *    `WHERE enabled = true AND next_run_at <= now` query.
   * 2. For each due schedule, try to acquire its per-schedule advisory
   *    lock (Postgres only; no-op on SQLite). On miss, skip — another
   *    daemon is handling that one.
   * 3. Process the schedule (dedup, concurrency check, spawn).
   */
  private async tick(): Promise<void> {
    const now = Date.now();

    try {
      const dueScheduleRefs = await this.findDueScheduleRefs(now);

      if (this.config.debug) {
        console.log(`🔄 Scheduler tick: Found ${dueScheduleRefs.length} due schedules`);
      }

      for (const ref of dueScheduleRefs) {
        if (!ref.tenantId) {
          console.error(
            `❌ Skipping due schedule ${shortId(ref.scheduleId)}: missing tenant metadata`
          );
          continue;
        }

        try {
          await runWithTenantContext(ref.tenantId, async () => {
            // Re-load inside the tenant scope before reading schedule content or
            // spawning work. The system discovery phase only supplies routing
            // metadata.
            const schedule = await this.withTenantDatabase(() =>
              this.scheduleRepo.findById(ref.scheduleId)
            );
            if (!schedule) return;
            await this.processSchedule(schedule, now);
          });
        } catch (error) {
          console.error(`❌ Failed to process schedule ${shortId(ref.scheduleId)}:`, error);
          // Continue processing other schedules
        }
      }
    } catch (error) {
      console.error('❌ Scheduler tick failed:', error);
      throw error;
    }
  }

  private async findDueScheduleRefs(
    now: number
  ): Promise<Array<{ scheduleId: ScheduleID; tenantId?: TenantID | string }>> {
    const findDue = async (tenantId?: TenantID | string) => {
      const dueSchedules = await this.scheduleRepo.findDueRefs(now + this.config.gracePeriod);
      return dueSchedules.map((schedule) => ({
        scheduleId: schedule.schedule_id,
        tenantId: tenantId ?? schedule.tenant_id,
      }));
    };

    if (this.config.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.config.tenantId, () =>
        findDue(this.config.tenantId)
      );
    }

    return runWithSystemDatabaseScope(this.db, 'scheduler due schedule discovery', () => findDue());
  }

  /**
   * Process a single schedule.
   *
   * Strategy:
   * 1. Get the most recent scheduled time (prev) from cron, in the
   *    schedule's effective tz.
   * 2. If prev is within grace period and no session exists, spawn it.
   * 3. Otherwise, check if we're close to the next scheduled time.
   *
   * Wrapped in a Postgres advisory lock that guards same-schedule
   * duplicate work; Agor remains single-daemon for branch-wide
   * concurrency (see top-of-file docblock). On SQLite the lock is a
   * no-op.
   */
  private async processSchedule(schedule: Schedule, now: number): Promise<void> {
    const tz = resolveScheduleTz(schedule.timezone_mode, schedule.timezone);
    const nowDate = new Date(now);

    // Cron evaluation is the per-tick hot path. Parse once for prev,
    // once for next, and reuse below — cron-parser instantiates a fresh
    // parser per call, so two calls is the floor.
    const prevRunAt = getPrevRunTime(schedule.cron_expression, nowDate, tz);
    const nextRunAt = getNextRunTime(schedule.cron_expression, nowDate, tz);

    const timeSincePrev = now - prevRunAt;
    const isPrevDue = timeSincePrev >= 0 && timeSincePrev < this.config.gracePeriod;
    const timeSinceNext = now - nextRunAt;
    const isNextDue = timeSinceNext >= 0 && timeSinceNext < this.config.gracePeriod;

    const scheduledRunAt = isPrevDue ? prevRunAt : nextRunAt;
    const isDue = isPrevDue || isNextDue;

    if (!isDue) {
      // Advance `next_run_at` to the real next fire whenever the stored
      // value isn't already pointing at it. This covers both the
      // never-fired case (NULL) and the stale-past case (a missed fire
      // is outside the grace window — e.g. a weekly schedule that was
      // disabled past its Monday-9am slot, or the daemon was down long
      // enough to miss the window). Without this, findDue keeps
      // returning the schedule on every tick until the next real fire,
      // turning the hot-path index back into a scan of stale rows.
      if (schedule.next_run_at == null || schedule.next_run_at <= now) {
        await this.withTenantDatabase(() =>
          this.scheduleRepo.update(schedule.schedule_id, { next_run_at: nextRunAt })
        ).catch((err) =>
          console.error(`Failed to advance next_run_at for ${schedule.schedule_id}:`, err)
        );
      }
      if (this.config.debug) {
        const timeUntilNext = nextRunAt - now;
        console.log(
          `   ⏱️  ${schedule.name}: Not due yet (next run in ${Math.round(timeUntilNext / 1000)}s)`
        );
      }
      return;
    }

    console.log(
      `   🕒 Scheduler due: "${schedule.name}" scheduled_at=${new Date(scheduledRunAt).toISOString()} — spawning session`
    );
    await this.spawnScheduledSession(schedule, scheduledRunAt, now, { source: 'cron' });
  }

  /**
   * Public: trigger a scheduled run on-demand.
   *
   * Used by `POST /schedules/:id/run-now`. Reuses the same spawn path as
   * the cron tick (via spawnScheduledSession) so scheduled and manual
   * runs are indistinguishable downstream, except for a
   * `triggered_manually: true` marker in custom_context and a different
   * session title.
   *
   * @throws ScheduleNotReadyError when the schedule is disabled or its
   *   branch can't be loaded.
   * @throws ScheduleBusyError when allow_concurrent_runs is false and
   *   this schedule already has an active run.
   */
  async executeScheduleNow(opts: { scheduleId: ScheduleID; triggeredBy: UUID }): Promise<Session> {
    const { scheduleId, triggeredBy } = opts;
    const schedule = await this.withTenantDatabase(() => this.scheduleRepo.findById(scheduleId));
    if (!schedule) {
      throw new ScheduleNotReadyError('schedule_incomplete', `Schedule not found: ${scheduleId}`);
    }
    if (!schedule.enabled) {
      throw new ScheduleNotReadyError(
        'schedule_disabled',
        'Schedule is disabled. Enable it before running manually.'
      );
    }
    if (schedule.created_by !== triggeredBy) {
      throw new Forbidden(
        'Schedules run as the user who created them. You can only manually run schedules you created.'
      );
    }

    const now = Date.now();
    // Minute-rounded so back-to-back manual clicks (and manual+cron
    // collisions within the same minute) dedupe via scheduled_run_at.
    const scheduledRunAt = roundToMinute(new Date(now)).getTime();

    console.log(
      `   🖐️  ${schedule.name}: manual execute-now triggered by ${triggeredBy.substring(0, 8)}`
    );

    const session = await this.spawnScheduledSession(schedule, scheduledRunAt, now, {
      source: 'manual',
      triggeredBy,
    });
    if (!session) {
      throw new Error(
        `Unexpected null result from spawnScheduledSession for manual run on schedule ${scheduleId}`
      );
    }
    return session;
  }

  /**
   * Resolve creator's unix_username for scheduled session execution.
   *
   * The schedule's `created_by` user is the execution identity (same
   * model as today, but keyed off `schedules.created_by` rather than
   * `branches.created_by`).
   *
   * - simple: unix_username optional (no impersonation)
   * - insulated: unix_username optional (uses executor user)
   * - strict: unix_username required (throws if missing)
   *
   * @returns Object with creator and resolved unixUsername (may be null
   *   in non-strict modes)
   * @throws Error if creator not found or unix_username missing in
   *   strict mode
   */
  private async resolveCreatorUnixUsername(
    schedule: Schedule
  ): Promise<{ creator: User; unixUsername: string | null }> {
    const creator = await this.withTenantDatabase(() =>
      this.userRepo.findById(schedule.created_by)
    );

    if (!creator) {
      console.error(`      ❌ Cannot spawn scheduled session: Schedule creator not found`, {
        schedule_id: schedule.schedule_id,
        schedule_name: schedule.name,
        created_by: schedule.created_by,
        unix_user_mode: this.config.unixUserMode,
      });
      throw new Error(
        `Schedule creator ${schedule.created_by} not found. Cannot spawn scheduled session.`
      );
    }

    const unixUsername = creator.unix_username || null;

    if (!unixUsername && this.config.unixUserMode === 'strict') {
      console.error(
        `      ❌ Cannot spawn scheduled session: Creator has no unix_username (strict mode)`,
        {
          schedule_id: schedule.schedule_id,
          schedule_name: schedule.name,
          created_by: schedule.created_by,
          creator_email: creator.email,
          unix_user_mode: this.config.unixUserMode,
        }
      );
      throw new Error(
        `Schedule creator ${creator.email} has no unix_username set. Cannot spawn scheduled session in strict Unix user mode.`
      );
    }

    return { creator, unixUsername };
  }

  /**
   * Spawn a scheduled session for a schedule.
   *
   * Shared path for both cron-driven and manual (execute-now) runs.
   * - `source: 'cron'`: concurrency violation is a silent skip (metadata
   *   still advanced to avoid repeated checks).
   * - `source: 'manual'`: concurrency violation throws `ScheduleBusyError`
   *   so the API route can surface a 409.
   *
   * Steps:
   * 1. Look up the schedule's branch (cascaded delete means it should
   *    always exist; we still handle null defensively).
   * 2. Dedup against `sessions(schedule_id, scheduled_run_at)`.
   * 3. Enforce `allow_concurrent_runs` against any active session spawned
   *    by the SAME SCHEDULE. Different schedules on the same branch do not
   *    block one another.
   * 4. Render prompt template (Handlebars).
   * 5. Look up creator's unix_username for execution context.
   * 6. Create session with schedule metadata + `schedule_id` FK.
   *    A partial unique index on (schedule_id, scheduled_run_at) acts
   *    as the DB-level race guard — if a concurrent path raced past
   *    the dedup check, the insert fails and we treat it as dedup.
   * 7. Attach MCP servers and trigger prompt.
   * 8. Update schedule metadata (last_run_at, last_run_session_id,
   *    next_run_at).
   * 9. Enforce retention policy (oldest sessions on this schedule_id
   *    are deleted).
   *
   * NOTE (multi-daemon, deferred): the per-schedule advisory lock and
   * partial unique index guard same-schedule races. They deliberately do
   * not serialize sibling schedules on the same branch, matching the
   * schedule-scoped meaning of `allow_concurrent_runs=false`.
   */
  private async spawnScheduledSession(
    schedule: Schedule,
    scheduledRunAt: number,
    now: number,
    options: { source: 'cron' | 'manual'; triggeredBy?: UUID } = { source: 'cron' }
  ): Promise<Session | null> {
    const { source, triggeredBy } = options;
    const manual = source === 'manual';

    const branch = await this.withTenantDatabase(() =>
      this.branchRepo.findById(schedule.branch_id)
    );
    if (!branch) {
      console.error(
        `❌ Schedule ${schedule.schedule_id} references missing branch ${schedule.branch_id}`
      );
      throw new ScheduleNotReadyError(
        'schedule_incomplete',
        `Schedule ${schedule.schedule_id} references missing branch ${schedule.branch_id}`
      );
    }

    // 1. Dedup: indexed (schedule_id, scheduled_run_at) lookup.
    const existingSession = await this.withTenantDatabase(() =>
      this.sessionRepo.findScheduleRun(schedule.schedule_id, scheduledRunAt)
    );

    if (existingSession) {
      // Already spawned. Advance metadata so we don't keep finding this
      // schedule due on every tick within the grace window.
      await this.updateScheduleMetadata(schedule, scheduledRunAt, existingSession.session_id, now);
      return existingSession;
    }

    // 2. Concurrency guard — per-schedule. An active run from this same
    //    schedule blocks its next fire by default, but sibling schedules
    //    on the same branch are independent and should not suppress one
    //    another. Existence probe (LIMIT 1) — no need to count.
    if (!schedule.allow_concurrent_runs) {
      const active = await this.withTenantDatabase(() =>
        this.sessionRepo.existsInScheduleWithStatuses(schedule.schedule_id, ACTIVE_SESSION_STATUSES)
      );
      if (active) {
        if (manual) {
          console.log(
            `   ⛔ ${schedule.name}: manual run blocked — active run from this schedule present (allow_concurrent_runs=false)`
          );
          throw new ScheduleBusyError(schedule.name);
        }
        console.log(
          `   ⏭️  ${schedule.name}: scheduled run skipped — active run from this schedule present (allow_concurrent_runs=false)`
        );
        await this.updateScheduleMetadata(schedule, scheduledRunAt, null, now);
        return null;
      }
    }

    // 3. Render prompt template.
    const renderedPrompt = renderSchedulePrompt(schedule.prompt, branch, schedule, scheduledRunAt);

    // 4. Run index = count of all sessions for this schedule + 1.
    //    Indexed COUNT, not a full scan + filter.
    const runIndex =
      (await this.withTenantDatabase(() =>
        this.sessionRepo.countByScheduleId(schedule.schedule_id)
      )) + 1;

    try {
      // 5. Resolve unix_username (schedule's creator is the execution identity).
      const { creator, unixUsername } = await this.resolveCreatorUnixUsername(schedule);

      const persistedCfg = normalizeScheduleAgenticToolConfig(schedule.agentic_tool_config);
      const cfg = await this.withTenantDatabase(() =>
        materializeScheduleAgenticToolConfig(this.db, schedule)
      );
      const inheritsCreatorDefaults =
        persistedCfg.configuration_reference === undefined && persistedCfg.preset_id === undefined;
      const runtimeDefaults = resolveSessionDefaults({
        agenticTool: cfg.agentic_tool,
        user: inheritsCreatorDefaults ? creator : null,
        overrides: {
          permissionMode: cfg.permission_mode as PermissionMode | undefined,
          modelConfig: cfg.model_config,
          codexSandboxMode: cfg.codex_sandbox_mode,
          codexApprovalPolicy: cfg.codex_approval_policy,
          codexNetworkAccess: cfg.codex_network_access,
        },
        now: new Date(now),
      });

      // 6. Create session with schedule metadata + FK back to schedule.
      const session: Partial<Session> = {
        branch_id: branch.branch_id,
        agentic_tool: cfg.agentic_tool,
        agentic_tool_preset_id: cfg.preset_id,
        status: SessionStatus.IDLE,
        created_by: schedule.created_by,
        unix_username: unixUsername,
        scheduled_run_at: scheduledRunAt,
        scheduled_from_branch: true,
        schedule_id: schedule.schedule_id,
        // Lead with the schedule name so the session list is scannable
        // — "hourly heartbeat — 2026-05-25T14:08:00.000Z" is more useful
        // than the generic "[Scheduled run - ...]" we used pre-#1253.
        title: manual
          ? `${schedule.name} — manual @ ${new Date(scheduledRunAt).toISOString()}`
          : `${schedule.name} — ${new Date(scheduledRunAt).toISOString()}`,
        contextFiles: cfg.context_files ?? [],
        permission_config: runtimeDefaults.permission_config,
        // DefaultModelConfig → Session.model_config. If the schedule
        // only sets ancillary fields (e.g. Claude effort), resolve them
        // against the same model defaults used by fresh sessions.
        model_config: runtimeDefaults.model_config,
        custom_context: {
          scheduled_run: {
            rendered_prompt: renderedPrompt,
            run_index: runIndex,
            triggered_manually: manual,
            triggered_by: manual ? triggeredBy : undefined,
            schedule_config_snapshot: {
              schedule_id: schedule.schedule_id,
              cron: schedule.cron_expression,
              timezone: resolveScheduleTz(schedule.timezone_mode, schedule.timezone),
              retention: schedule.retention,
              allow_concurrent_runs: schedule.allow_concurrent_runs,
            },
          },
        },
      };

      // Use service for session creation (triggers WebSocket events).
      // The partial unique index on (schedule_id, scheduled_run_at)
      // catches any concurrent path that raced past the dedup check —
      // we surface that as a normal dedup hit rather than an error.
      const sessionsService = this.app.service('sessions');
      const sessionCreateParams: SessionParams = { _agenticConfigResolved: true };
      let createdSession: Session;
      try {
        createdSession = await sessionsService.create(session, sessionCreateParams);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          const winner = await this.withTenantDatabase(() =>
            this.sessionRepo.findScheduleRun(schedule.schedule_id, scheduledRunAt)
          );
          if (winner) {
            console.log(
              `      🪞 ${schedule.name}: lost the spawn race — using existing session ${shortId(winner.session_id)}`
            );
            await this.updateScheduleMetadata(schedule, scheduledRunAt, winner.session_id, now);
            return winner;
          }
        }
        throw err;
      }
      console.log(
        `      ✅ Spawned ${manual ? 'manual' : 'scheduled'} session for ${schedule.name} (run #${runIndex})` +
          (manual && triggeredBy ? ` triggered_by=${triggeredBy.substring(0, 8)}` : '')
      );

      // 7. Attach MCP servers BEFORE triggering prompt.
      // Precedence: schedule config (if defined) > branch defaults.
      // An explicit empty array in schedule means "no MCPs" — does NOT
      // fall through to branch.
      const effectiveMcpIds =
        schedule.mcp_server_ids !== undefined
          ? schedule.mcp_server_ids
          : branch.mcp_server_ids && branch.mcp_server_ids.length > 0
            ? branch.mcp_server_ids
            : [];

      if (effectiveMcpIds.length > 0) {
        for (const serverId of effectiveMcpIds) {
          try {
            await this.withTenantDatabase(() =>
              this.sessionMCPRepo.addServer(
                createdSession.session_id as SessionID,
                serverId as MCPServerID
              )
            );
            emitServiceEvent(this.app, {
              path: 'session-mcp-servers',
              event: 'created',
              data: {
                session_id: createdSession.session_id,
                mcp_server_id: serverId,
                enabled: true,
                added_at: new Date(),
              },
            });
          } catch {
            // Silently skip deleted/invalid MCP servers
          }
        }
      }

      // 8. Trigger prompt execution (creates task and starts agent).
      const promptService = this.app.service('/sessions/:id/prompt');
      const tenantId = getCurrentTenantId();
      await promptService.create(
        {
          prompt: renderedPrompt,
          permissionMode: createdSession.permission_config?.mode || 'acceptEdits',
          stream: true,
        },
        {
          route: { id: createdSession.session_id },
          provider: undefined, // Bypass auth for internal scheduler call
          user: creator, // Pass creator user for session token generation
          ...(tenantId ? { tenant: { tenant_id: tenantId, source: 'explicit' as const } } : {}),
        } as import('@agor/core/types').AuthenticatedParams & { route: { id: string } }
      );

      // 9. Update schedule metadata (last_run_at, last_run_session_id, next_run_at).
      await this.updateScheduleMetadata(
        schedule,
        scheduledRunAt,
        createdSession.session_id as SessionID,
        now
      );

      // 10. Enforce retention policy.
      await this.enforceRetentionPolicy(schedule);

      return createdSession;
    } catch (error) {
      console.error(`      ❌ Failed to spawn session for ${schedule.name}:`, error);
      throw error;
    }
  }

  /**
   * Update schedule metadata after a fire (or a deduped/skipped no-op
   * that still needs `next_run_at` to advance).
   */
  private async updateScheduleMetadata(
    schedule: Schedule,
    scheduledRunAt: number,
    lastRunSessionId: SessionID | null,
    now: number
  ): Promise<void> {
    try {
      const tz = resolveScheduleTz(schedule.timezone_mode, schedule.timezone);
      const nextRunAt = getNextRunTime(schedule.cron_expression, new Date(now), tz);

      const updates: Partial<Schedule> = {
        last_run_at: scheduledRunAt,
        next_run_at: nextRunAt,
      };
      if (lastRunSessionId) updates.last_run_session_id = lastRunSessionId;

      await this.withTenantDatabase(() => this.scheduleRepo.update(schedule.schedule_id, updates));
    } catch (error) {
      console.error(`      ❌ Failed to update schedule metadata:`, error);
      throw error;
    }
  }

  /**
   * Enforce retention policy for a schedule.
   *
   * - retention = 0: Keep all
   * - retention = N: Keep newest N sessions linked to this schedule_id,
   *   delete older ones
   *
   * Uses repository directly (bypasses auth).
   */
  private async enforceRetentionPolicy(schedule: Schedule): Promise<void> {
    if (schedule.retention === 0) return;

    try {
      // Indexed query, newest-first; slice past the keep-count for deletion.
      const mine = await this.withTenantDatabase(() =>
        this.sessionRepo.findByScheduleId(schedule.schedule_id, {
          orderByScheduledRunAt: 'desc',
        })
      );
      const sessionsToDelete = mine.slice(schedule.retention);

      if (sessionsToDelete.length > 0) {
        const sessionService = this.app.service('sessions');
        for (const session of sessionsToDelete) {
          await sessionService.remove(session.session_id, { provider: undefined });
        }

        console.log(
          `      🗑️  Deleted ${sessionsToDelete.length} old sessions on schedule ${schedule.name} (retention: ${schedule.retention})`
        );
      }
    } catch (error) {
      console.error(`      ❌ Failed to enforce retention policy:`, error);
      // Don't throw - retention failure shouldn't block scheduling
    }
  }
}
