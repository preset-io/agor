/**
 * Scheduler Service
 *
 * Manages cron-based scheduling for worktrees. Evaluates enabled schedules, spawns sessions, and enforces retention policies.
 *
 * **Architecture:**
 * - Runs on a configurable tick interval (default 30s)
 * - Evaluates all enabled schedules on each tick
 * - Spawns sessions when current time matches/exceeds next_run_at
 * - Updates schedule metadata (last_triggered_at, next_run_at)
 * - Enforces retention policy (deletes old scheduled sessions)
 *
 * **Smart Recovery:**
 * - If scheduler is down for extended period, only schedules LATEST missed run (no backfill)
 * - Grace period: 2 minutes (schedules within 2min of current time are considered "on time")
 *
 * **Deduplication:**
 * - Uses scheduled_run_at (rounded to minute) as unique run identifier
 * - Checks for existing session with same scheduled_run_at before spawning
 *
 * **Template Rendering:**
 * - Uses Handlebars to render prompt templates with worktree/board context
 * - Available context: {{ worktree.* }}, {{ board.* }}, {{ schedule.* }}
 */

import type { Database } from '@agor/core/db';
import { SessionRepository, UsersRepository, WorktreeRepository } from '@agor/core/db';
import type { PermissionMode, Session, User, Worktree } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import { getNextRunTime, getPrevRunTime } from '@agor/core/utils/cron';
import Handlebars from 'handlebars';
import type { Application } from '../declarations';

export interface SchedulerConfig {
  /** Tick interval in milliseconds (default: 30000 = 30s) */
  tickInterval?: number;
  /** Grace period for missed runs in milliseconds (default: 120000 = 2min) */
  gracePeriod?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Unix user mode for validation (default: 'simple') */
  unixUserMode?: UnixUserMode;
}

export class SchedulerService {
  private app: Application;
  private config: Required<SchedulerConfig>;
  private intervalHandle?: NodeJS.Timeout;
  private isRunning = false;
  private worktreeRepo: WorktreeRepository;
  private sessionRepo: SessionRepository;
  private userRepo: UsersRepository;

  constructor(db: Database, app: Application, config: SchedulerConfig = {}) {
    this.app = app;
    this.config = {
      tickInterval: config.tickInterval ?? 30000, // 30 seconds
      gracePeriod: config.gracePeriod ?? 120000, // 2 minutes
      debug: config.debug ?? false,
      unixUserMode: config.unixUserMode ?? 'simple',
    };
    this.worktreeRepo = new WorktreeRepository(db);
    this.sessionRepo = new SessionRepository(db);
    this.userRepo = new UsersRepository(db);
  }

  /**
   * Start the scheduler tick loop
   */
  start(): void {
    if (this.isRunning) {
      console.warn('⚠️  Scheduler already running');
      return;
    }

    console.log(`🔄 Starting scheduler (tick interval: ${this.config.tickInterval}ms)`);
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

    console.log('🛑 Stopping scheduler');
    this.isRunning = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /**
   * Execute one scheduler tick
   *
   * 1. Fetch all enabled schedules (schedule_enabled = true)
   * 2. For each schedule:
   *    - Check if next_run_at <= now (+ grace period)
   *    - Check deduplication (no existing session with same scheduled_run_at)
   *    - Spawn session with rendered prompt
   *    - Update schedule metadata (last_triggered_at, next_run_at)
   *    - Enforce retention policy
   */
  private async tick(): Promise<void> {
    const now = Date.now();

    try {
      // 1. Fetch enabled schedules
      const enabledWorktrees = await this.getEnabledSchedules();

      if (this.config.debug) {
        console.log(`🔄 Scheduler tick: Found ${enabledWorktrees.length} enabled schedules`);
      }

      // 2. Process each schedule
      for (const worktree of enabledWorktrees) {
        try {
          await this.processSchedule(worktree, now);
        } catch (error) {
          console.error(
            `❌ Failed to process schedule for worktree ${worktree.worktree_id}:`,
            error
          );
          // Continue processing other schedules
        }
      }
    } catch (error) {
      console.error('❌ Scheduler tick failed:', error);
      throw error;
    }
  }

  /**
   * Fetch all worktrees with enabled schedules
   *
   * Uses repository directly (bypasses FeathersJS service layer and auth hooks)
   */
  private async getEnabledSchedules(): Promise<Worktree[]> {
    // Fetch all worktrees using repository (no auth checks, we're in the same process)
    const allWorktrees = await this.worktreeRepo.findAll();

    // Filter to only enabled schedules
    const enabledSchedules = allWorktrees.filter((wt) => wt.schedule_enabled === true);

    return enabledSchedules;
  }

  /**
   * Process a single schedule
   *
   * Checks if schedule is due, spawns session if needed, updates metadata
   *
   * Strategy:
   * 1. Get the most recent scheduled time (prev) from cron
   * 2. If prev is within grace period and no session exists, spawn it
   * 3. Otherwise, check if we're close to the next scheduled time
   */
  private async processSchedule(worktree: Worktree, now: number): Promise<void> {
    if (!worktree.schedule_cron) {
      return;
    }

    // Get the most recent scheduled time from cron (the run that should have happened)
    const prevRunAt = getPrevRunTime(worktree.schedule_cron, new Date(now));
    const timeSincePrev = now - prevRunAt;

    // Check if the previous run is within grace period
    const isPrevDue = timeSincePrev >= 0 && timeSincePrev < this.config.gracePeriod;

    // Determine which scheduled time to use
    let scheduledRunAt: number;
    let isDue: boolean;

    if (isPrevDue) {
      // Most recent scheduled time is within grace period - use it
      scheduledRunAt = prevRunAt;
      isDue = true;
    } else {
      // Previous run is too old, check next run
      const nextRunAt = getNextRunTime(worktree.schedule_cron, new Date(now));
      const timeSinceNext = now - nextRunAt;
      scheduledRunAt = nextRunAt;
      isDue = timeSinceNext >= 0 && timeSinceNext < this.config.gracePeriod;
    }

    if (!isDue) {
      if (this.config.debug) {
        const nextRunAt = getNextRunTime(worktree.schedule_cron, new Date(now));
        const timeUntilNext = nextRunAt - now;
        console.log(
          `   ⏱️  ${worktree.name}: Not due yet (next run in ${Math.round(timeUntilNext / 1000)}s)`
        );
      }
      return;
    }

    // Schedule is due - spawn session
    console.log(`   ✅ ${worktree.name}: Schedule is due, spawning session...`);

    await this.spawnScheduledSession(worktree, scheduledRunAt, now);
  }

  /**
   * Resolve creator's unix_username for scheduled session execution
   *
   * Validates that the creator exists and has appropriate unix_username based on mode:
   * - simple: unix_username optional (no impersonation)
   * - insulated: unix_username optional (uses executor user)
   * - strict: unix_username required (throws if missing)
   *
   * @returns Object with creator and resolved unixUsername (may be null in non-strict modes)
   * @throws Error if creator not found or unix_username missing in strict mode
   */
  private async resolveCreatorUnixUsername(
    worktree: Worktree
  ): Promise<{ creator: User; unixUsername: string | null }> {
    const creator = await this.userRepo.findById(worktree.created_by);

    if (!creator) {
      console.error(`      ❌ Cannot spawn scheduled session: Worktree creator not found`, {
        worktree_id: worktree.worktree_id,
        worktree_name: worktree.name,
        created_by: worktree.created_by,
        unix_user_mode: this.config.unixUserMode,
      });
      throw new Error(
        `Worktree creator ${worktree.created_by} not found. Cannot spawn scheduled session.`
      );
    }

    const unixUsername = creator.unix_username || null;

    // Only require unix_username in strict mode
    if (!unixUsername && this.config.unixUserMode === 'strict') {
      console.error(
        `      ❌ Cannot spawn scheduled session: Creator has no unix_username (strict mode)`,
        {
          worktree_id: worktree.worktree_id,
          worktree_name: worktree.name,
          created_by: worktree.created_by,
          creator_email: creator.email,
          unix_user_mode: this.config.unixUserMode,
        }
      );
      throw new Error(
        `Worktree creator ${creator.email} has no unix_username set. Cannot spawn scheduled session in strict Unix user mode.`
      );
    }

    return { creator, unixUsername };
  }

  /**
   * Spawn a scheduled session for a worktree
   *
   * 1. Check deduplication (no existing session with same scheduled_run_at)
   * 2. Render prompt template with Handlebars
   * 3. Look up creator's unix_username for execution context
   * 4. Create session with schedule metadata
   * 5. Update worktree schedule metadata (last_triggered_at, next_run_at)
   * 6. Enforce retention policy
   *
   * @param worktree - The worktree to spawn a session for
   * @param scheduledRunAt - The scheduled run timestamp (may be recomputed from cron)
   * @param now - Current timestamp
   */
  private async spawnScheduledSession(
    worktree: Worktree,
    scheduledRunAt: number,
    now: number
  ): Promise<void> {
    if (!worktree.schedule || !worktree.schedule_cron) {
      console.error(`❌ Worktree ${worktree.worktree_id} missing schedule config`);
      return;
    }

    const schedule = worktree.schedule;

    // 1. Check deduplication using repository
    // Use repository to check for existing sessions (bypasses auth)
    const allSessions = await this.sessionRepo.findAll();
    const worktreeSessions = allSessions.filter((s) => s.worktree_id === worktree.worktree_id);
    const existingSession = worktreeSessions.find((s) => s.scheduled_run_at === scheduledRunAt);

    if (existingSession) {
      // Still update next_run_at to prevent repeated checks
      await this.updateScheduleMetadata(worktree, scheduledRunAt, now);
      return;
    }

    // 2. Render prompt template
    const renderedPrompt = this.renderPrompt(schedule.prompt_template, worktree);

    // 3. Get current run index (count of all scheduled sessions for this worktree)
    const scheduledSessions = worktreeSessions.filter((s) => s.scheduled_from_worktree === true);
    const runIndex = scheduledSessions.length + 1;

    try {
      // 4. Look up creator's unix_username for session execution context
      const { creator, unixUsername } = await this.resolveCreatorUnixUsername(worktree);

      // 5. Create session with schedule metadata
      const session: Partial<Session> = {
        worktree_id: worktree.worktree_id,
        agentic_tool: schedule.agentic_tool,
        status: SessionStatus.IDLE,
        created_by: worktree.created_by,
        unix_username: unixUsername, // Set unix_username for strict mode execution
        scheduled_run_at: scheduledRunAt,
        scheduled_from_worktree: true,
        title: `[Scheduled run - ${new Date(scheduledRunAt).toISOString()}]`,
        contextFiles: schedule.context_files ?? [],
        permission_config: schedule.permission_mode
          ? { mode: schedule.permission_mode as PermissionMode }
          : undefined,
        model_config:
          schedule.model_config?.mode === 'custom' && schedule.model_config.model
            ? {
                mode: 'exact',
                model: schedule.model_config.model,
                updated_at: new Date(now).toISOString(),
              }
            : undefined,
        custom_context: {
          scheduled_run: {
            rendered_prompt: renderedPrompt,
            run_index: runIndex,
            schedule_config_snapshot: {
              cron: worktree.schedule_cron,
              timezone: schedule.timezone,
              retention: schedule.retention,
            },
          },
        },
      };

      // Use service for session creation (triggers WebSocket events)
      // But still need to bypass auth - use the service with no params
      const sessionsService = this.app.service('sessions');
      const createdSession = await sessionsService.create(session);
      console.log(`      ✅ Spawned scheduled session for ${worktree.name} (run #${runIndex})`);

      // 6. Trigger prompt execution (creates task and starts agent)
      // IMPORTANT: Must pass provider: undefined to bypass auth (internal call)
      // AND pass user: creator so the executor's session token is generated for the correct user.
      // Without the user, the token defaults to 'anonymous' which doesn't exist in the database,
      // causing the executor to fail with "User not found: anonymous" error.
      const promptService = this.app.service('/sessions/:id/prompt');
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
        } as import('@agor/core/types').AuthenticatedParams & { route: { id: string } }
      );

      // TODO: Attach MCP servers if specified in schedule.mcp_server_ids

      // 7. Update schedule metadata
      await this.updateScheduleMetadata(worktree, scheduledRunAt, now);

      // 8. Enforce retention policy
      await this.enforceRetentionPolicy(worktree);
    } catch (error) {
      console.error(`      ❌ Failed to spawn session for ${worktree.name}:`, error);
      throw error;
    }
  }

  /**
   * Render Handlebars prompt template with worktree/board context
   */
  private renderPrompt(template: string, worktree: Worktree): string {
    try {
      const compiledTemplate = Handlebars.compile(template);

      // Build context for template rendering
      const context = {
        worktree: {
          name: worktree.name,
          ref: worktree.ref,
          path: worktree.path,
          issue_url: worktree.issue_url,
          pull_request_url: worktree.pull_request_url,
          notes: worktree.notes,
          custom_context: worktree.custom_context,
        },
        // TODO: Add board context if needed (requires fetching board data)
        schedule: worktree.schedule,
      };

      return compiledTemplate(context);
    } catch (error) {
      console.error(`❌ Failed to render prompt template:`, error);
      // Fallback to raw template if rendering fails
      return template;
    }
  }

  /**
   * Update worktree schedule metadata after spawning session
   *
   * - last_triggered_at = scheduledRunAt (not current time!)
   * - next_run_at = next occurrence from cron expression
   *
   * Uses repository directly (bypasses auth)
   */
  private async updateScheduleMetadata(
    worktree: Worktree,
    scheduledRunAt: number,
    now: number
  ): Promise<void> {
    if (!worktree.schedule_cron) {
      return;
    }

    try {
      // Compute next run time from cron expression
      const nextRunAt = getNextRunTime(worktree.schedule_cron, new Date(now));

      // Update worktree using repository (bypasses auth)
      await this.worktreeRepo.update(worktree.worktree_id, {
        schedule_last_triggered_at: scheduledRunAt, // Use scheduled time, not execution time
        schedule_next_run_at: nextRunAt,
      });
    } catch (error) {
      console.error(`      ❌ Failed to update schedule metadata:`, error);
      throw error;
    }
  }

  /**
   * Enforce retention policy for scheduled sessions
   *
   * - retention = 0: Keep all sessions
   * - retention = N: Keep last N sessions, delete older ones
   *
   * Uses repository directly (bypasses auth)
   */
  private async enforceRetentionPolicy(worktree: Worktree): Promise<void> {
    if (!worktree.schedule || worktree.schedule.retention === 0) {
      // retention = 0 means keep forever
      return;
    }

    const retention = worktree.schedule.retention;

    try {
      // Fetch all scheduled sessions for this worktree using repository
      const allSessions = await this.sessionRepo.findAll();
      const worktreeSessions = allSessions.filter((s) => s.worktree_id === worktree.worktree_id);
      const scheduledSessions = worktreeSessions.filter((s) => s.scheduled_from_worktree === true);

      // Sort by scheduled_run_at DESC (newest first)
      scheduledSessions.sort((a, b) => {
        const aTime = a.scheduled_run_at ?? 0;
        const bTime = b.scheduled_run_at ?? 0;
        return bTime - aTime; // Descending
      });

      // Keep first N sessions, delete the rest
      const sessionsToDelete = scheduledSessions.slice(retention);

      if (sessionsToDelete.length > 0) {
        // Use Feathers service to delete (triggers WebSocket events)
        const sessionService = this.app.service('sessions');
        for (const session of sessionsToDelete) {
          // Use provider: undefined to bypass auth (internal operation)
          await sessionService.remove(session.session_id, { provider: undefined });
        }

        console.log(
          `      🗑️  Deleted ${sessionsToDelete.length} old sessions (retention: ${retention})`
        );
      }
    } catch (error) {
      console.error(`      ❌ Failed to enforce retention policy:`, error);
      // Don't throw - retention failure shouldn't block scheduling
    }
  }
}
