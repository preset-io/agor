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
 * Multi-daemon occurrence ownership is enforced by the tenant-aware partial
 * unique index `sessions_schedule_run_unique`. A short schedule-row lock
 * serializes admission/concurrency checks. MCP attachment and initial Task
 * dispatch are reconciled after commit using stable identities and atomic
 * expected-state transitions; no transaction spans rendering or launching.
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

import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { analyticsLogger } from '@agor/core/analytics';
import {
  InvalidScheduleAgenticToolConfigError,
  isTenantAgenticToolEnabled,
  normalizePersistedScheduleAgenticToolConfig,
  unixUserModeRequiresUsername,
} from '@agor/core/config';
import {
  boundedBackoffDelay,
  type DistributedWorkIdentity,
  initialWorkOffset,
} from '@agor/core/coordination';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  BranchRepository,
  EntityNotFoundError,
  generateId,
  getCurrentTenantId,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionMCPServerRepository,
  SessionRepository,
  sanitizeDbError,
  shortId,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type {
  Branch,
  MCPServerID,
  PersistedScheduleAgenticToolConfig,
  Schedule,
  ScheduleID,
  Session,
  SessionID,
  Task,
  TenantID,
  User,
  UUID,
} from '@agor/core/types';
import { isAgenticToolName, SessionStatus, TaskStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import {
  getNextRunTime,
  getPrevRunTime,
  resolveScheduleTz,
  roundToMinute,
} from '@agor/core/utils/cron';
import Handlebars from 'handlebars';
import type { Application } from '../declarations';
import {
  materializedAgenticToolConfigurationToScheduleConfig,
  scheduleAgenticToolConfigToSource,
} from '../utils/agentic-configuration-sources.js';
import { buildSessionCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

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

const ACTIVE_TASK_STATUSES: ReadonlyArray<Task['status']> = [
  TaskStatus.CREATED,
  TaskStatus.QUEUED,
  TaskStatus.DISPATCHING,
  TaskStatus.RUNNING,
  TaskStatus.STOPPING,
  TaskStatus.AWAITING_PERMISSION,
  TaskStatus.AWAITING_INPUT,
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
  const e = err as { code?: string; cause?: unknown; message?: string };
  const code = e.code ?? '';
  if (code === '23505') return true; // postgres
  if (code.startsWith('SQLITE_CONSTRAINT')) return true; // libsql / sqlite
  const msg = (e.message ?? '').toLowerCase();
  if (msg.includes('unique constraint') || msg.includes('sqlite_constraint_unique')) return true;
  return e.cause !== err && isUniqueConstraintError(e.cause);
}

function isSQLiteBusyError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; cause?: unknown; message?: string };
  if (e.code === 'SQLITE_BUSY' || (e.message ?? '').includes('database is locked')) return true;
  return e.cause !== err && isSQLiteBusyError(e.cause);
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
  } catch {
    console.error(`❌ Failed to render prompt template`);
    return template;
  }
}

/** Resolve a persisted schedule source into session-ready configuration for one run. */
export async function materializeScheduleAgenticToolConfig(
  db: TenantScopeAwareDatabase,
  schedule: Pick<Schedule, 'agentic_tool_config' | 'created_by'>
): Promise<PersistedScheduleAgenticToolConfig> {
  return (await resolveScheduleAgenticToolConfig(db, schedule)).config;
}

async function resolveScheduleAgenticToolConfig(
  db: TenantScopeAwareDatabase,
  schedule: Pick<Schedule, 'agentic_tool_config' | 'created_by'>
) {
  const cfg = normalizePersistedScheduleAgenticToolConfig(schedule.agentic_tool_config);
  const materialized = await materializeAgenticToolConfiguration(db, {
    tool: cfg.agentic_tool,
    source: scheduleAgenticToolConfigToSource(cfg),
    executionOwnerId: schedule.created_by as import('@agor/core/types').UserID,
  });
  return {
    activeTool: cfg.agentic_tool,
    config: materializedAgenticToolConfigurationToScheduleConfig(cfg, materialized),
    sessionConfig: materialized,
  };
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
  public readonly code:
    | 'schedule_disabled'
    | 'schedule_incomplete'
    | 'schedule_agentic_tool_removed'
    | 'schedule_invalid_config';
  constructor(
    code:
      | 'schedule_disabled'
      | 'schedule_incomplete'
      | 'schedule_agentic_tool_removed'
      | 'schedule_invalid_config',
    message: string
  ) {
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
  /** Maximum due schedules read per scan (default: 25). */
  scanBatchSize?: number;
  /** Maximum idle delay before another scan (default: 60000). */
  maxIdleInterval?: number;
  /** Symmetric scan-delay jitter ratio (default: 0.2). */
  jitterRatio?: number;
  /** Injected for deterministic tests. */
  random?: () => number;
  /** Diagnostic daemon instance/process identity. */
  workIdentity?: DistributedWorkIdentity;
  /** Deterministic crash injection used only by kill-point tests. */
  testHooks?: SchedulerTestHooks;
}

export interface SchedulerTestHooks {
  afterSessionAdmission?(session: Session): Promise<void> | void;
  afterMcpAttachments?(session: Session): Promise<void> | void;
  afterPromptDispatch?(task: Task): Promise<void> | void;
  afterRetention?(session: Session): Promise<void> | void;
  afterMetadata?(session: Session): Promise<void> | void;
}

interface ResolvedSchedulerConfig {
  tickInterval: number;
  gracePeriod: number;
  debug: boolean;
  unixUserMode: UnixUserMode;
  tenantId?: TenantID | string;
  scanBatchSize: number;
  maxIdleInterval: number;
  jitterRatio: number;
  random: () => number;
  workIdentity: DistributedWorkIdentity;
  testHooks?: SchedulerTestHooks;
}

interface SchedulerTickStats {
  candidates: number;
  recoveryCandidates: number;
  dueCandidates: number;
  processed: number;
  failures: number;
}

export class SchedulerService {
  private app: Application;
  private db: TenantScopeAwareDatabase;
  private config: ResolvedSchedulerConfig;
  private timerHandle?: NodeJS.Timeout;
  private isRunning = false;
  private idleRounds = 0;
  private recoveryCursor?: { created_at: number; session_id: SessionID };
  private branchRepo: BranchRepository;
  private scheduleRepo: ScheduleRepository;
  private sessionRepo: SessionRepository;
  private userRepo: UsersRepository;
  private sessionMCPRepo: SessionMCPServerRepository;
  private taskRepo: TaskRepository;

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
      scanBatchSize: config.scanBatchSize ?? 25,
      maxIdleInterval: config.maxIdleInterval ?? 60_000,
      jitterRatio: config.jitterRatio ?? 0.2,
      random: config.random ?? Math.random,
      workIdentity:
        config.workIdentity ??
        ({
          instanceId: process.env.AGOR_DAEMON_INSTANCE_ID ?? process.env.HOSTNAME ?? 'daemon',
          bootId: generateId(),
        } satisfies DistributedWorkIdentity),
      testHooks: config.testHooks,
    };
    this.branchRepo = new BranchRepository(db);
    this.scheduleRepo = new ScheduleRepository(db);
    this.sessionRepo = new SessionRepository(db);
    this.userRepo = new UsersRepository(db);
    this.sessionMCPRepo = new SessionMCPServerRepository(db);
    this.taskRepo = new TaskRepository(db);

    if (
      !Number.isInteger(this.config.scanBatchSize) ||
      this.config.scanBatchSize <= 0 ||
      this.config.scanBatchSize > 1_000
    ) {
      throw new Error('Scheduler scanBatchSize must be between 1 and 1000');
    }
    if (this.config.tickInterval <= 0 || this.config.gracePeriod <= 0) {
      throw new Error('Scheduler intervals must be positive');
    }
    if (this.config.maxIdleInterval < this.config.tickInterval) {
      throw new Error('Scheduler maxIdleInterval must be >= tickInterval');
    }
    if (this.config.jitterRatio < 0 || this.config.jitterRatio > 1) {
      throw new Error('Scheduler jitterRatio must be between 0 and 1');
    }
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

    const initialDelay = initialWorkOffset(this.config.tickInterval, this.config.random());
    this.scheduleNextTick(initialDelay);
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

    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning) return;
    this.timerHandle = setTimeout(async () => {
      let stats: SchedulerTickStats = {
        candidates: 0,
        recoveryCandidates: 0,
        dueCandidates: 0,
        processed: 0,
        failures: 1,
      };
      try {
        stats = await this.tick();
      } catch (error) {
        console.error('❌ Scheduler tick failed:', sanitizeDbError(error));
      }
      if (!this.isRunning) return;
      this.idleRounds = stats.candidates === 0 ? this.idleRounds + 1 : 0;
      const saturated = stats.candidates >= this.config.scanBatchSize;
      const nextDelay = saturated
        ? Math.round(50 + this.config.random() * 200)
        : boundedBackoffDelay(
            this.idleRounds,
            {
              baseDelayMs: this.config.tickInterval,
              maxDelayMs: this.config.maxIdleInterval,
              jitterRatio: this.config.jitterRatio,
            },
            this.config.random()
          );
      this.scheduleNextTick(nextDelay);
    }, delayMs);
  }

  /**
   * Execute one scheduler tick.
   *
   * 1. Fetch a bounded batch of due schedules via the indexed
   *    `WHERE enabled = true AND next_run_at <= now` query.
   * 2. Re-enter the trusted tenant scope and process each occurrence.
   * 3. Database uniqueness/row locking owns correctness; jitter only reduces
   *    synchronized contention.
   */
  private async tick(): Promise<SchedulerTickStats> {
    const now = Date.now();
    const stats: SchedulerTickStats = {
      candidates: 0,
      recoveryCandidates: 0,
      dueCandidates: 0,
      processed: 0,
      failures: 0,
    };

    try {
      const recoveryRefs = await this.findIncompleteSessionRefs();
      const dueScheduleRefs = await this.findDueScheduleRefs(now);
      stats.recoveryCandidates = recoveryRefs.length;
      stats.dueCandidates = dueScheduleRefs.length;
      stats.candidates = recoveryRefs.length + dueScheduleRefs.length;

      if (this.config.debug) {
        console.log(
          `🔄 Scheduler tick: Found ${recoveryRefs.length} recoveries and ${dueScheduleRefs.length} due schedules`
        );
      }

      for (const ref of recoveryRefs) {
        if (!ref.tenantId) {
          stats.failures += 1;
          console.error(`❌ Skipping scheduler recovery ${shortId(ref.sessionId)}: missing tenant`);
          continue;
        }
        try {
          await runWithTenantContext(ref.tenantId, () =>
            this.recoverIncompleteSession(ref.sessionId, ref.scheduledRunAt, now)
          );
          stats.processed += 1;
        } catch (error) {
          stats.failures += 1;
          console.error(
            `❌ Failed to recover scheduled session ${shortId(ref.sessionId)}:`,
            sanitizeDbError(error)
          );
        }
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
            stats.processed += 1;
          });
        } catch (error) {
          stats.failures += 1;
          console.error(
            `❌ Failed to process schedule ${shortId(ref.scheduleId)}:`,
            sanitizeDbError(error)
          );
          // Continue processing other schedules
        }
      }
      console.info('[DistributedWork]', {
        component: 'scheduler',
        event: 'scan_complete',
        instance_id: this.config.workIdentity.instanceId,
        boot_id: this.config.workIdentity.bootId,
        ...stats,
      });
      return stats;
    } catch (error) {
      console.error('❌ Scheduler tick failed:', sanitizeDbError(error));
      throw error;
    }
  }

  private async findIncompleteSessionRefs(): Promise<
    Array<{
      sessionId: SessionID;
      scheduledRunAt: number;
      tenantId?: TenantID | string;
    }>
  > {
    const find = async (tenantId?: TenantID | string) => {
      const refs = await this.sessionRepo.findIncompleteScheduledRefs(
        this.config.scanBatchSize,
        this.recoveryCursor
      );
      if (refs.length === 0 && this.recoveryCursor) {
        // Wrap on the next tick. Advancing even past poison rows prevents one
        // bounded batch of bad configuration from starving newer recoveries;
        // the database marker remains the authority for what is unfinished.
        this.recoveryCursor = undefined;
      } else if (refs.length > 0) {
        const last = refs.at(-1)!;
        this.recoveryCursor = { created_at: last.created_at, session_id: last.session_id };
      }
      return refs.map((ref) => ({
        sessionId: ref.session_id,
        scheduledRunAt: ref.scheduled_run_at,
        tenantId: tenantId ?? ref.tenant_id,
      }));
    };
    if (this.config.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.config.tenantId, () =>
        find(this.config.tenantId)
      );
    }
    return runWithSystemDatabaseScope(
      this.db,
      'scheduler incomplete Session discovery',
      () => find(),
      { capability: 'scheduler_discovery' }
    );
  }

  private async findDueScheduleRefs(
    now: number
  ): Promise<Array<{ scheduleId: ScheduleID; tenantId?: TenantID | string }>> {
    const findDue = async (tenantId?: TenantID | string) => {
      const dueSchedules = await this.scheduleRepo.findDueRefs(
        now + this.config.gracePeriod,
        this.config.scanBatchSize
      );
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

    return runWithSystemDatabaseScope(
      this.db,
      'scheduler due schedule discovery',
      () => findDue(),
      {
        capability: 'scheduler_discovery',
      }
    );
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
   * Admission later uses a short PostgreSQL schedule-row lock. Cron parsing,
   * rendering, and executor launch never run while that lock is held.
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
          console.error(
            `Failed to advance next_run_at for ${schedule.schedule_id}:`,
            sanitizeDbError(err)
          )
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

    if (!unixUsername && unixUserModeRequiresUsername(this.config.unixUserMode)) {
      console.error(
        `      ❌ Cannot spawn scheduled session: Creator has no unix_username (${this.config.unixUserMode} mode)`,
        {
          schedule_id: schedule.schedule_id,
          schedule_name: schedule.name,
          created_by: schedule.created_by,
          creator_email: creator.email,
          unix_user_mode: this.config.unixUserMode,
        }
      );
      throw new Error(
        `Schedule creator ${creator.email} has no unix_username set. Cannot spawn scheduled session in ${this.config.unixUserMode} Unix user mode.`
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
   * 2. Dedup against the tenant-scoped occurrence identity
   *    `(schedule_id, scheduled_run_at)`.
   * 3. Enforce `allow_concurrent_runs` against any active session spawned
   *    by the SAME SCHEDULE. Different schedules on the same branch do not
   *    block one another.
   * 4. Render prompt template (Handlebars).
   * 5. Look up creator's unix_username for execution context.
   * 6. Create session with schedule metadata + `schedule_id` FK.
   *    PostgreSQL's partial unique index on
   *    (tenant_id, schedule_id, scheduled_run_at) acts as the DB-level
   *    race guard; SQLite uses its standalone two-column equivalent.
   * 7. Attach MCP servers and trigger prompt.
   * 8. Enforce retention, update schedule metadata, then mark scheduler
   *    initialization complete. The bounded incomplete-Session scan owns
   *    recovery independently of cron grace/cursor state.
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
      throw new ScheduleNotReadyError(
        'schedule_incomplete',
        `Schedule ${schedule.schedule_id} references missing branch ${schedule.branch_id}`
      );
    }
    // Prepare all configuration outside the admission transaction. The only
    // work performed while the schedule row is locked is existing/busy checks
    // and the session insert.
    const renderedPrompt = renderSchedulePrompt(schedule.prompt, branch, schedule, scheduledRunAt);
    const { creator, unixUsername } = await this.resolveCreatorUnixUsername(schedule);
    let resolvedConfig: Awaited<ReturnType<typeof resolveScheduleAgenticToolConfig>>;
    try {
      resolvedConfig = await this.withTenantDatabase(() =>
        resolveScheduleAgenticToolConfig(this.db, schedule)
      );
    } catch (error) {
      if (!(error instanceof InvalidScheduleAgenticToolConfigError)) throw error;
      const removedTool = !isAgenticToolName(schedule.agentic_tool_config.agentic_tool);
      if (!manual) await this.advanceScheduleCursor(schedule, now);
      throw new ScheduleNotReadyError(
        removedTool ? 'schedule_agentic_tool_removed' : 'schedule_invalid_config',
        removedTool
          ? 'This schedule uses the removed experimental Claude Code CLI integration. Choose a supported agentic tool before running it.'
          : error.message
      );
    }
    const cfg = resolvedConfig.config;
    if (
      !(await this.withTenantDatabase(() =>
        isTenantAgenticToolEnabled(resolvedConfig.activeTool, this.db)
      ))
    ) {
      throw new BadRequest(`${resolvedConfig.activeTool} is disabled for this workspace`);
    }
    const effectiveMcpIds =
      schedule.mcp_server_ids !== undefined
        ? schedule.mcp_server_ids
        : branch.mcp_server_ids && branch.mcp_server_ids.length > 0
          ? branch.mcp_server_ids
          : [];
    const candidateSessionId = generateId() as SessionID;
    const candidateTaskId = generateId() as import('@agor/core/types').TaskID;

    type Admission =
      | { outcome: 'created' | 'existing'; session: Session }
      | { outcome: 'busy'; session: null };

    let admission: Admission;
    try {
      admission = await this.withTenantDatabase(async () => {
        // PostgreSQL FOR UPDATE serializes the schedule-scoped concurrency
        // decision. On SQLite occurrence uniqueness remains the race guard.
        await this.scheduleRepo.lockForRunAdmission(schedule.schedule_id);

        const existing = await this.sessionRepo.findScheduleRun(
          schedule.schedule_id,
          scheduledRunAt
        );
        if (existing) return { outcome: 'existing', session: existing } as const;

        if (
          !schedule.allow_concurrent_runs &&
          (await this.sessionRepo.existsActiveOrInitializingInSchedule(
            schedule.schedule_id,
            ACTIVE_SESSION_STATUSES,
            ACTIVE_TASK_STATUSES
          ))
        ) {
          return { outcome: 'busy', session: null } as const;
        }

        const runIndex = (await this.sessionRepo.countByScheduleId(schedule.schedule_id)) + 1;
        const session: Partial<Session> = {
          session_id: candidateSessionId,
          branch_id: branch.branch_id,
          agentic_tool: resolvedConfig.activeTool,
          agentic_tool_preset_id:
            resolvedConfig.sessionConfig.agentic_tool_preset_id ?? undefined,
          status: SessionStatus.IDLE,
          created_by: schedule.created_by,
          unix_username: unixUsername,
          scheduled_run_at: scheduledRunAt,
          scheduled_from_branch: true,
          schedule_id: schedule.schedule_id,
          title: manual
            ? `${schedule.name} — manual @ ${new Date(scheduledRunAt).toISOString()}`
            : `${schedule.name} — ${new Date(scheduledRunAt).toISOString()}`,
          contextFiles: cfg.context_files ?? [],
          permission_config: resolvedConfig.sessionConfig.permission_config,
          model_config: resolvedConfig.sessionConfig.model_config,
          custom_context: {
            scheduled_run: {
              rendered_prompt: renderedPrompt,
              run_index: runIndex,
              initial_task_id: candidateTaskId,
              triggered_manually: manual,
              triggered_by: manual ? triggeredBy : undefined,
              schedule_config_snapshot: {
                schedule_id: schedule.schedule_id,
                cron: schedule.cron_expression,
                timezone: resolveScheduleTz(schedule.timezone_mode, schedule.timezone),
                retention: schedule.retention,
                allow_concurrent_runs: schedule.allow_concurrent_runs,
                mcp_server_ids: effectiveMcpIds,
              },
            },
          },
        };
        // This is an already-materialized internal occurrence admission, not a
        // public Session create. Keep the schedule lock around only the row
        // checks and repository insert; Feathers validation/hooks (including
        // Unix process launch side effects) belong outside this critical path.
        const created = await this.sessionRepo.create(session);
        return { outcome: 'created', session: created } as const;
      });
    } catch (error) {
      // SQLite has no row-level lock and may race between the lookup and insert.
      // PostgreSQL's corrected tenant-aware unique index is defense in depth.
      if (!isUniqueConstraintError(error)) throw error;
      const winner = await this.withTenantDatabase(() =>
        this.sessionRepo.findScheduleRun(schedule.schedule_id, scheduledRunAt)
      );
      if (!winner) throw error;
      admission = { outcome: 'existing', session: winner };
    }

    if (admission.outcome === 'created') {
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'created',
        data: admission.session,
        id: admission.session.session_id,
      });
      analyticsLogger.track(
        'session.created',
        buildSessionCreatedAnalyticsProperties(admission.session),
        { userId: admission.session.created_by }
      );
    }

    if (admission.outcome === 'busy') {
      console.info('[DistributedWork]', {
        component: 'scheduler',
        event: 'occurrence_skipped_busy',
        instance_id: this.config.workIdentity.instanceId,
        boot_id: this.config.workIdentity.bootId,
        tenant_id: getCurrentTenantId(),
        schedule_id: schedule.schedule_id,
        scheduled_run_at: scheduledRunAt,
        source,
      });
      if (manual) throw new ScheduleBusyError(schedule.name);
      await this.updateScheduleMetadata(schedule, scheduledRunAt, null, now);
      return null;
    }

    const recovering = admission.outcome === 'existing';
    console.info('[DistributedWork]', {
      component: 'scheduler',
      event: recovering ? 'occurrence_claim_lost_reconciling' : 'occurrence_claim_won',
      instance_id: this.config.workIdentity.instanceId,
      boot_id: this.config.workIdentity.bootId,
      tenant_id: getCurrentTenantId(),
      schedule_id: schedule.schedule_id,
      session_id: admission.session.session_id,
      scheduled_run_at: scheduledRunAt,
      source,
    });
    if (
      recovering &&
      (await this.withTenantDatabase(() =>
        this.sessionRepo.isScheduledInitializationComplete(admission.session.session_id)
      ))
    ) {
      return admission.session;
    }
    await this.config.testHooks?.afterSessionAdmission?.(admission.session);

    await this.initializeScheduledSession({
      scheduleId: schedule.schedule_id,
      session: admission.session,
      creator,
      fallbackPrompt: renderedPrompt,
      fallbackMcpIds: effectiveMcpIds,
      recovering,
    });

    await this.finalizeScheduledSession({
      schedule,
      scheduleId: schedule.schedule_id,
      session: admission.session,
      scheduledRunAt,
      now,
      runTestHooks: true,
    });
    return admission.session;
  }

  private async recoverIncompleteSession(
    sessionId: SessionID,
    scheduledRunAt: number,
    now: number
  ): Promise<void> {
    const session = await this.withTenantDatabase(() => this.sessionRepo.findById(sessionId));
    if (!session?.scheduled_from_branch || session.scheduled_run_at !== scheduledRunAt) {
      return;
    }
    if (
      await this.withTenantDatabase(() =>
        this.sessionRepo.isScheduledInitializationComplete(session.session_id)
      )
    ) {
      return;
    }
    const stored = session.custom_context?.scheduled_run;
    const scheduleId = (session.schedule_id ?? stored?.schedule_config_snapshot?.schedule_id) as
      | ScheduleID
      | undefined;
    if (!scheduleId) {
      throw new Error(
        `Scheduled Session ${session.session_id} has no live or snapshotted schedule identity`
      );
    }
    const schedule = await this.withTenantDatabase(() => this.scheduleRepo.findById(scheduleId));
    const creator = await this.withTenantDatabase(() => this.userRepo.findById(session.created_by));
    if (!creator) throw new Error(`Scheduled Session creator ${session.created_by} not found`);

    // Every occurrence admitted by the HA scheduler snapshots its rendered
    // prompt and effective MCP IDs before the Session insert. A live Schedule
    // is therefore optional during recovery: ON DELETE SET NULL must not turn
    // an admitted occurrence into permanently invisible work.
    let fallbackPrompt = stored?.rendered_prompt;
    let fallbackMcpIds = stored?.schedule_config_snapshot?.mcp_server_ids;
    if ((fallbackPrompt === undefined || fallbackMcpIds === undefined) && schedule) {
      const branch = await this.withTenantDatabase(() =>
        this.branchRepo.findById(session.branch_id)
      );
      if (!branch) return;
      fallbackPrompt ??= renderSchedulePrompt(schedule.prompt, branch, schedule, scheduledRunAt);
      fallbackMcpIds ??=
        schedule.mcp_server_ids !== undefined
          ? schedule.mcp_server_ids
          : branch.mcp_server_ids && branch.mcp_server_ids.length > 0
            ? branch.mcp_server_ids
            : [];
    }
    if (fallbackPrompt === undefined) {
      throw new Error(
        `Scheduled Session ${session.session_id} has no snapshotted prompt and its Schedule no longer exists`
      );
    }

    await this.initializeScheduledSession({
      scheduleId,
      session,
      creator,
      fallbackPrompt,
      fallbackMcpIds: fallbackMcpIds ?? [],
      recovering: true,
    });
    await this.finalizeScheduledSession({
      schedule,
      scheduleId,
      session,
      scheduledRunAt,
      now,
      runTestHooks: false,
    });
  }

  /**
   * Finalize one initialized occurrence without requiring its live Schedule.
   * Ordering is retention -> schedule cursor -> Session marker. If schedule
   * deletion wins a race during finalization, snapshot-backed initialization
   * is still complete and the FK-independent marker may safely be written.
   */
  private async finalizeScheduledSession(input: {
    schedule: Schedule | null;
    scheduleId: ScheduleID;
    session: Session;
    scheduledRunAt: number;
    now: number;
    runTestHooks: boolean;
  }): Promise<void> {
    const { schedule, scheduleId, session, scheduledRunAt, now, runTestHooks } = input;
    if (schedule) {
      try {
        await this.enforceRetentionPolicy(schedule);
        if (runTestHooks) await this.config.testHooks?.afterRetention?.(session);
        await this.updateScheduleMetadata(schedule, scheduledRunAt, session.session_id, now);
        if (runTestHooks) await this.config.testHooks?.afterMetadata?.(session);
      } catch (error) {
        const stillExists = await this.withTenantDatabase(() =>
          this.scheduleRepo.findById(scheduleId)
        );
        if (stillExists || !(error instanceof EntityNotFoundError)) throw error;
        this.logDeletedScheduleRecovery(scheduleId, session.session_id);
      }
    } else {
      this.logDeletedScheduleRecovery(scheduleId, session.session_id);
    }
    await this.withTenantDatabase(() =>
      this.sessionRepo.markScheduledInitializationComplete(session.session_id)
    );
  }

  private logDeletedScheduleRecovery(scheduleId: ScheduleID, sessionId: SessionID): void {
    console.info('[DistributedWork]', {
      component: 'scheduler',
      event: 'occurrence_recovered_after_schedule_delete',
      instance_id: this.config.workIdentity.instanceId,
      boot_id: this.config.workIdentity.bootId,
      tenant_id: getCurrentTenantId(),
      schedule_id: scheduleId,
      session_id: sessionId,
    });
  }

  private async initializeScheduledSession(input: {
    scheduleId: ScheduleID;
    session: Session;
    creator: User;
    fallbackPrompt: string;
    fallbackMcpIds: readonly string[];
    recovering: boolean;
  }): Promise<Task> {
    const { scheduleId, session, creator } = input;
    const stored = session.custom_context?.scheduled_run;
    const existingTasks = await this.withTenantDatabase(() =>
      this.taskRepo.findBySession(session.session_id)
    );
    const initialTaskId =
      stored?.initial_task_id ??
      existingTasks[0]?.task_id ??
      // Deterministic legacy fallback: table-local UUID identity may equal the
      // Session ID and is safe across every recovering daemon.
      (session.session_id as import('@agor/core/types').TaskID);
    const renderedPrompt = stored?.rendered_prompt ?? input.fallbackPrompt;
    const snapshotMcpIds = stored?.schedule_config_snapshot?.mcp_server_ids;
    const effectiveMcpIds = snapshotMcpIds ?? input.fallbackMcpIds;

    if (!stored?.initial_task_id) {
      await this.app.service('sessions').patch(
        session.session_id,
        {
          custom_context: {
            ...session.custom_context,
            scheduled_run: {
              ...stored,
              rendered_prompt: renderedPrompt,
              run_index: stored?.run_index ?? 1,
              initial_task_id: initialTaskId,
            },
          },
        },
        { provider: undefined }
      );
    }

    for (const serverId of effectiveMcpIds) {
      try {
        await this.withTenantDatabase(() =>
          this.sessionMCPRepo.addServer(session.session_id, serverId as MCPServerID)
        );
        emitServiceEvent(this.app, {
          path: 'session-mcp-servers',
          event: 'created',
          data: {
            session_id: session.session_id,
            mcp_server_id: serverId,
            enabled: true,
            added_at: new Date(),
          },
        });
      } catch (error) {
        // Preserve settled behavior for an optional server deleted between
        // schedule configuration and initialization. Transient database
        // failures must escape so this occurrence remains recoverable.
        if (!(error instanceof EntityNotFoundError)) throw error;
        console.warn('[DistributedWork]', {
          component: 'scheduler',
          event: 'mcp_attachment_missing',
          instance_id: this.config.workIdentity.instanceId,
          boot_id: this.config.workIdentity.bootId,
          tenant_id: getCurrentTenantId(),
          schedule_id: scheduleId,
          session_id: session.session_id,
          mcp_server_id: serverId,
        });
      }
    }
    await this.config.testHooks?.afterMcpAttachments?.(session);

    const tenantId = getCurrentTenantId();
    const task = (await this.app.service('/sessions/:id/prompt').create(
      {
        prompt: renderedPrompt,
        permissionMode: session.permission_config?.mode || 'acceptEdits',
        stream: true,
        idempotencyTaskId: initialTaskId,
      },
      {
        route: { id: session.session_id },
        provider: undefined,
        user: creator,
        ...(tenantId ? { tenant: { tenant_id: tenantId, source: 'explicit' as const } } : {}),
      } as import('@agor/core/types').AuthenticatedParams & { route: { id: string } }
    )) as Task;
    await this.config.testHooks?.afterPromptDispatch?.(task);

    console.info('[DistributedWork]', {
      component: 'scheduler',
      event: input.recovering ? 'occurrence_recovered' : 'occurrence_initialized',
      instance_id: this.config.workIdentity.instanceId,
      boot_id: this.config.workIdentity.bootId,
      tenant_id: tenantId,
      schedule_id: scheduleId,
      session_id: session.session_id,
      task_id: task.task_id,
      task_status: task.status,
    });
    return task;
  }

  /**
   * Update schedule metadata after a fire (or a deduped/skipped no-op
   * that still needs `next_run_at` to advance).
   */
  private async updateScheduleMetadata(
    schedule: Schedule,
    scheduledRunAt: number,
    lastRunSessionId: SessionID | null,
    now: number,
    attempt = 0
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
      if (isSQLiteBusyError(error) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        return this.updateScheduleMetadata(
          schedule,
          scheduledRunAt,
          lastRunSessionId,
          now,
          attempt + 1
        );
      }
      console.error(`      ❌ Failed to update schedule metadata:`, sanitizeDbError(error));
      throw error;
    }
  }

  /**
   * Advance a rejected cron schedule to its next real fire without pretending
   * a run occurred. This prevents an enabled historical/corrupt schedule from
   * being retried on every scheduler tick while preserving it for migration.
   */
  private async advanceScheduleCursor(schedule: Schedule, now: number): Promise<void> {
    const tz = resolveScheduleTz(schedule.timezone_mode, schedule.timezone);
    const nextRunAt = getNextRunTime(schedule.cron_expression, new Date(now), tz);
    await this.withTenantDatabase(() =>
      this.scheduleRepo.update(schedule.schedule_id, { next_run_at: nextRunAt })
    );
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

    // Indexed query, newest-first; slice past the keep-count for deletion.
    const mine = await this.withTenantDatabase(() =>
      this.sessionRepo.findByScheduleId(schedule.schedule_id, {
        orderByScheduledRunAt: 'desc',
      })
    );
    const overflow = mine.slice(schedule.retention);
    const sessionsToDelete: Session[] = [];
    for (const session of overflow) {
      const initializationComplete = await this.withTenantDatabase(() =>
        this.sessionRepo.isScheduledInitializationComplete(session.session_id)
      );
      const sessionTasks = await this.withTenantDatabase(() =>
        this.taskRepo.findBySession(session.session_id)
      );
      const active =
        ACTIVE_SESSION_STATUSES.includes(session.status) ||
        !initializationComplete ||
        sessionTasks.some((task) => ACTIVE_TASK_STATUSES.includes(task.status));
      if (active) {
        console.info('[DistributedWork]', {
          component: 'scheduler',
          event: 'retention_skipped_active_occurrence',
          instance_id: this.config.workIdentity.instanceId,
          boot_id: this.config.workIdentity.bootId,
          tenant_id: getCurrentTenantId(),
          schedule_id: schedule.schedule_id,
          session_id: session.session_id,
          session_status: session.status,
        });
        continue;
      }
      sessionsToDelete.push(session);
    }

    if (sessionsToDelete.length > 0) {
      const sessionService = this.app.service('sessions');
      for (const session of sessionsToDelete) {
        try {
          await sessionService.remove(session.session_id, { provider: undefined });
        } catch (error) {
          // Concurrent reconcilers may have deleted the same retained-out row.
          // Re-read once; absence is idempotent success, presence is a real
          // failure and keeps the schedule due for another bounded retry.
          const stillPresent = await this.withTenantDatabase(() =>
            this.sessionRepo.findById(session.session_id)
          );
          if (stillPresent) throw error;
        }
      }

      console.log(
        `      🗑️  Deleted ${sessionsToDelete.length} old sessions on schedule ${schedule.name} (retention: ${schedule.retention})`
      );
    }
  }
}
