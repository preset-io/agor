// src/types/schedule.ts
import type { AgenticToolName, CodexApprovalPolicy, CodexSandboxMode } from './agentic-tool';
import type { BranchID, SessionID, UUID } from './id';
import type { PermissionMode } from './session';
import type { DefaultModelConfig } from './user';

/**
 * Schedule identifier
 *
 * Uniquely identifies a first-class schedule. UUIDv7.
 *
 * @example
 * const scheduleId: ScheduleID = "0193g1h2-3i4j-7k5l-a8f3-9d2e1c4b5a6f";
 */
export type ScheduleID = UUID;

/**
 * How a schedule's cron expression is evaluated.
 *
 * - `local`: cron is evaluated against the schedule's IANA `timezone`.
 *   Best for "fire at 9am my time, even across DST."
 * - `utc`: cron is evaluated against UTC. Best for "fire at the same
 *   wall-clock time globally" or "I don't want to think about DST."
 *
 * Backfilled schedules (from the pre-first-class `branches.schedule_*`
 * blob) get `utc` to preserve today's hardcoded-UTC behavior. New
 * schedules default to `local`.
 */
export type TimezoneMode = 'local' | 'utc';

/**
 * Agentic-tool configuration for a scheduled session.
 *
 * Mirrors the pre-first-class `BranchScheduleConfig` minus the fields
 * that were promoted to dedicated columns (cron, timezone, prompt,
 * retention, allow_concurrent_runs, audit). These five fields move
 * together: model_config selection affects permission_mode, MCP attach,
 * etc. — they're treated as a unit in the modal and stored as one
 * jsonb blob.
 */
export interface ScheduleAgenticToolConfig {
  /** Agent to spawn for this schedule's runs. */
  agentic_tool: AgenticToolName;
  /** Live preset reference. Remaining runtime fields are ignored when present. */
  preset_id?: import('./agentic-tool-preset').AgenticToolPresetID;

  /** Permission mode for spawned sessions (e.g., 'auto', 'ask', 'default'). */
  permission_mode?: PermissionMode;

  /**
   * Inline model configuration for spawned sessions. Ignored when preset_id is set.
   *
   * Reuses the canonical {@link DefaultModelConfig} shape so the UI form
   * helpers (`getFormValuesFromConfig` / `buildConfigFromFormValues`)
   * round-trip cleanly between defaults, sessions, and schedules without
   * dialect adapters. Omit entirely (or pass `{ model: undefined }`) to
   * inherit the agent's defaults.
   */
  model_config?: DefaultModelConfig;

  /** Additional context files to load into the spawned session. */
  context_files?: string[];

  /** Codex-specific: sandbox mode (where Codex can write). */
  codex_sandbox_mode?: CodexSandboxMode;

  /** Codex-specific: approval policy (whether Codex asks before executing). */
  codex_approval_policy?: CodexApprovalPolicy;

  /** Codex-specific: network access (outbound HTTP/HTTPS). */
  codex_network_access?: boolean;
}

/**
 * First-class schedule entity.
 *
 * Owns its own cron, timezone-mode, prompt, agentic-tool config, and
 * enabled flag. Bound to exactly one branch (FK). Multiple schedules
 * per branch are allowed (e.g. "hourly heartbeat" + "daily summary").
 *
 * Replaces the four `branches.schedule_*` columns and the
 * `branches.data.schedule` jsonb blob that existed pre-#1253.
 * Runs are sessions, linked back via `sessions.schedule_id`.
 *
 * See `docs/internal/schedules-first-class-design-2026-05-24.md`.
 */
export interface Schedule {
  // ===== Identity =====

  /** Unique schedule identifier (UUIDv7). */
  schedule_id: ScheduleID;

  /** Branch this schedule belongs to. Required (a schedule needs a working dir). */
  branch_id: BranchID;

  // ===== Labels =====

  /** User-facing name, e.g. "Hourly heartbeat". Used in the list view + cards. */
  name: string;

  /** Optional freeform description ("what this schedule is supposed to do"). */
  description?: string;

  // ===== When =====

  /**
   * Cron expression.
   *
   * 5- or 6-field cron format. Validated via `isValidCron` (cron-parser).
   * Standard examples:
   * - `0 9 * * 1-5` — 9am weekdays
   * - `0 *\/4 * * *` — every 4 hours
   * - `0 2 * * 1` — 2am every Monday
   */
  cron_expression: string;

  /**
   * How the cron is evaluated. See `TimezoneMode`.
   *
   * Default for new schedules: `'local'`.
   * Backfilled rows: `'utc'` (preserves today's behavior).
   */
  timezone_mode: TimezoneMode;

  /**
   * IANA timezone (e.g. `'America/Los_Angeles'`).
   *
   * Required when `timezone_mode === 'local'`. Ignored otherwise.
   * Validated at the app layer (rejected if not a recognized IANA name).
   */
  timezone?: string;

  // ===== What =====

  /**
   * Handlebars prompt template.
   *
   * Rendered at fire time and persisted on the spawned session as
   * `custom_context.scheduled_run.rendered_prompt`.
   *
   * Available variables: `{{branch.*}}`,
   * `{{schedule.cron}}`, `{{schedule.scheduled_time}}`, etc.
   */
  prompt: string;

  /**
   * Agentic-tool configuration selection. Preset references resolve live for each run.
   * See `ScheduleAgenticToolConfig`.
   */
  agentic_tool_config: ScheduleAgenticToolConfig;

  /** MCP servers attached independently of the agentic-tool configuration. */
  mcp_server_ids?: string[];

  // ===== Flags =====

  /**
   * Whether the schedule is active. Disabled schedules are skipped by
   * the scheduler tick and don't appear as "due" in the hot-path query.
   */
  enabled: boolean;

  /**
   * When `false` (default), the scheduler skips a fire if this schedule
   * already has an active run (cron = silent skip; manual `run_now` =
   * 409 ScheduleBusyError). Sibling schedules on the same branch are
   * independent and do not block each other.
   *
   * Active = status in RUNNING / STOPPING / AWAITING_PERMISSION /
   * AWAITING_INPUT. IDLE / COMPLETED / FAILED / TIMED_OUT don't count.
   */
  allow_concurrent_runs: boolean;

  /**
   * How many run sessions to keep. 0 = keep all. Retention cleanup
   * runs after each successful spawn.
   */
  retention: number;

  // ===== Materialized for scheduler hot path =====

  /**
   * Most recent fire time (Unix timestamp in ms, minute-rounded).
   * Stored as the *scheduled* time (not the spawn time) to keep dedup
   * semantics aligned with `sessions.scheduled_run_at`.
   */
  last_run_at?: number;

  /**
   * Session ID of the most recent run. Lets the UI render
   * "last run" as a clickable link without joining. `ON DELETE SET NULL`
   * so retention-deleted sessions don't dangle.
   */
  last_run_session_id?: SessionID;

  /**
   * Next scheduled fire time (Unix timestamp in ms). Computed via
   * `getNextRunTime(cron, now, timezone_mode/timezone)` after each
   * fire and on enable / config change. Drives the scheduler hot-path
   * `WHERE enabled = true AND next_run_at <= ?` query.
   */
  next_run_at?: number;

  // ===== Audit =====

  /** Creation timestamp (ISO 8601). */
  created_at: string;

  /** Last-update timestamp (ISO 8601). */
  updated_at: string;

  /**
   * User who created the schedule. The scheduler uses this user's
   * `unix_username` for spawned-session impersonation (same path as
   * today, just keyed off `schedules.created_by` instead of
   * `branches.created_by`).
   */
  created_by: UUID;
}
