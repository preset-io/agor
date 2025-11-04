# Scheduler System - Autonomous Worktree Automation

**Status:** 🚧 In Progress - Phase 1 & 2 Complete
**Author:** System Design (w/ Max)
**Date:** 2025-11-02
**Last Updated:** 2025-11-02
**Related:** [[worktrees]], [[architecture]], [[board-objects]], [[agent-integration]]

---

## Quick Reference - Libraries

**Backend:**

- `cron-parser` - Cron parsing, next/prev run calculation, timezone support
- `cronstrue` - Cron humanization ("At 09:00 AM, Monday through Friday")
- `handlebars` - Template rendering (already in use)
- `luxon` - Timezone-aware date math (already in use)

**Frontend:**

- `react-js-cron` - Visual cron builder component (Ant Design compatible)
- `cronstrue` - Cron humanization for display

**Schema:**

- 6 new columns (4 on `worktrees`, 2 on `sessions`)
- 5 new indexes (partial/composite for efficiency)
- No new tables or services

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Motivation & Use Cases](#motivation--use-cases)
3. [Architecture Overview](#architecture-overview)
4. [Data Model](#data-model)
5. [Scheduling Engine](#scheduling-engine)
6. [UI Design](#ui-design)
7. [API Design](#api-design)
8. [Implementation Plan](#implementation-plan)
9. [Open Questions](#open-questions)
10. [Future Enhancements](#future-enhancements)

---

## Executive Summary

The **Scheduler** enables time-based autonomous agent execution within Agor's worktree-centric architecture. It allows users to configure recurring or one-time tasks that automatically spawn sessions in worktrees based on cron schedules.

**Key Design Decisions:**

- **Worktree-scoped schedules:** Schedules belong to worktrees (not sessions), as worktrees are the persistent work contexts
- **Session creation pattern:** Each schedule run creates a new session in the target worktree
- **Template-driven prompts:** Uses Handlebars templates (like zones) with worktree/board context
- **Smart scheduling:** No backfill - only schedules the latest pending run (avoids flood after downtime)
- **Supervisor-friendly:** Agor's MCP self-awareness enables supervisory agent patterns

**Core Primitives:**

```
Worktree (with schedule config) → (many) Sessions (with scheduled_run_at)
```

**No separate tables** - Schedule config embedded in worktrees, runs tracked via sessions.

---

## Motivation & Use Cases

### Problem

Current Agor requires manual session creation. Users want:

1. **Periodic supervision** - Check PR status, remind about stale work
2. **Recurring maintenance** - Daily test runs, dependency updates
3. **Monitoring** - Health checks, error scanning, performance analysis
4. **Multi-agent workflows** - Orchestrate agent teams across worktrees

### Use Cases

**1. PR Status Monitor (Supervisory Agent)**

```yaml
schedule:
  cron: '0 */4 * * *' # Every 4 hours
  prompt: |
    Check the PR status for {{worktree.pull_request_url}}.
    If there are new comments or requested changes, summarize them.
    Update the worktree notes with current status.
  retention: 10 # Keep last 10 runs
```

**2. Daily Test Runner**

```yaml
schedule:
  cron: '0 9 * * 1-5' # 9am weekdays
  prompt: |
    Run the full test suite for {{worktree.name}}.
    If any tests fail, create a report and update {{worktree.issue_url}}.
  agenticTool: claude-code
  permissionMode: auto # Allow file writes and bash commands
```

**3. Dependency Update Bot**

```yaml
schedule:
  cron: '0 2 * * 1' # 2am every Monday
  prompt: |
    Check for outdated npm dependencies in {{worktree.name}}.
    Update to latest compatible versions and run tests.
    If tests pass, commit with message "chore: update dependencies".
```

**4. Board Health Monitor**

```yaml
schedule:
  cron: '0 */12 * * *' # Every 12 hours
  prompt: |
    Using the agor MCP tools, list all sessions on board {{board.name}}.
    Identify any sessions in 'failed' status or idle for >3 days.
    Generate a status report and update board custom context.
```

### Why Worktree-Scoped?

**Sessions are ephemeral, worktrees are persistent:**

- Worktrees outlive sessions (a worktree may have 10+ sessions over time)
- Worktrees have stable context (branch, issue, PR, environment)
- Schedules need persistent configuration (survives session lifecycle)
- Supervision naturally targets work units (worktrees), not conversations (sessions)

**Example workflow:**

```
Worktree: feat-auth
├─ Schedule: Daily test runner (9am)
├─ Session 1: Initial implementation (manual)
├─ Session 2: Scheduled run (9am Day 1) ← Created by scheduler
├─ Session 3: Bug fix (manual)
├─ Session 4: Scheduled run (9am Day 2) ← Created by scheduler
└─ Session 5: Final testing (manual)
```

---

## Architecture Overview

### System Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  UI Components (agor-ui)                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │ WorktreeCard   │  │ScheduleModal   │  │SchedulePanel  │  │
│  │ + SchedulePill │  │ (edit schedule)│  │ (upcoming/    │  │
│  └────────┬───────┘  └───────┬────────┘  │  recent runs) │  │
│           │                  │            └───────┬───────┘  │
└───────────┼──────────────────┼────────────────────┼──────────┘
            │                  │                    │
            │        WebSocket events (upcoming runs, completions)
            │                  │                    │
┌───────────┼──────────────────┼────────────────────┼──────────┐
│  Daemon (agor-daemon)        │                    │          │
│  ┌───────▼──────────────────▼────────────────────▼────────┐ │
│  │  FeathersJS Services                                    │ │
│  │  - SchedulesService (CRUD schedules)                    │ │
│  │  - ScheduleRunsService (CRUD run history)               │ │
│  │  - WorktreesService (existing)                          │ │
│  │  - SessionsService (spawn sessions)                     │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │  Scheduler Engine (New Background Service)              │ │
│  │  - Periodic tick (every 30s)                            │ │
│  │  - Cron evaluation (node-cron)                          │ │
│  │  - Run deduplication (prevent double-scheduling)        │ │
│  │  - Session spawning (via SessionsService)               │ │
│  │  - Retention cleanup                                     │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │  Drizzle ORM → LibSQL Database                          │ │
│  │  - schedules table                                       │ │
│  │  - schedule_runs table                                   │ │
│  │  - worktrees table (FK)                                  │ │
│  │  - sessions table (FK from runs)                         │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles

**1. Worktree-Centric**

- Schedules belong to worktrees (1:1 or 1:0 relationship)
- Worktree deletion cascades to schedule and runs
- Session references worktree via existing FK

**2. Service-Oriented**

- Follow existing FeathersJS service pattern
- All operations go through services (no direct ORM in scheduler)
- WebSocket events for real-time UI updates

**3. Idempotent Scheduling**

- Each schedule run tracked in `schedule_runs` table
- Scheduler checks `last_triggered_at` before creating new run
- No double-scheduling even if scheduler restarts mid-tick

**4. Smart Non-Backfill**

- If scheduler misses runs (system down), only schedule latest pending run
- Example: Job runs daily at 9am. System down Mon-Wed. On Thu startup, only schedules Wed's 9am run (not Mon/Tue)
- Prevents flood of stale sessions after downtime

**5. Retention-Based Cleanup**

- Each schedule configures retention (e.g., keep last 10 runs)
- Cleanup runs async (doesn't block scheduler tick)
- Deletes old `schedule_runs` rows, optionally cascades to sessions

---

## Data Model

**Design Decision:** Embed schedule config in existing tables instead of creating new ones. This reduces state synchronization complexity and follows Agor's hybrid materialization pattern.

### Worktrees Table - New Columns

#### Materialized Columns (Indexed)

```sql
-- Add schedule columns to worktrees table
ALTER TABLE worktrees ADD COLUMN schedule_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE worktrees ADD COLUMN schedule_cron TEXT;
ALTER TABLE worktrees ADD COLUMN schedule_last_triggered_at INTEGER;
ALTER TABLE worktrees ADD COLUMN schedule_next_run_at INTEGER;

-- Indexes for scheduler performance
CREATE INDEX worktrees_schedule_enabled_idx ON worktrees(schedule_enabled)
  WHERE schedule_enabled = TRUE;

CREATE INDEX worktrees_schedule_next_run_idx ON worktrees(schedule_next_run_at)
  WHERE schedule_enabled = TRUE AND schedule_next_run_at IS NOT NULL;

CREATE INDEX worktrees_board_schedule_idx ON worktrees(board_id, schedule_enabled);
```

**Why materialized:**

- `schedule_enabled`: Critical filter for scheduler tick (find enabled schedules)
- `schedule_cron`: Display in UI, debugging
- `schedule_last_triggered_at`: Deduplication, recovery, analytics
- `schedule_next_run_at`: UI display ("next run in 2h"), scheduler optimization

#### JSON Blob (Flexible Config)

```typescript
// worktrees.data.schedule (existing data column)
{
  schedule?: {
    timezone: string;                    // IANA timezone (default: 'UTC')
    prompt_template: string;             // Handlebars template
    agentic_tool: AgenticTool;           // 'claude-code' | 'codex' | 'gemini'
    retention: number;                   // How many sessions to keep
    permission_mode?: PermissionMode;    // 'auto' | 'ask' | 'default'
    model_config?: {
      mode: 'default' | 'custom';
      model?: string;                    // e.g., 'opus' for complex tasks
    };
    mcp_server_ids?: string[];           // MCP servers to attach (default: ['agor'])
    context_files?: string[];            // Additional context files
    created_at: number;                  // When schedule was created
    created_by: string;                  // User ID who created
  }
}
```

### Sessions Table - New Columns

#### Materialized Columns (Indexed)

```sql
-- Add schedule tracking columns to sessions table
ALTER TABLE sessions ADD COLUMN scheduled_run_at INTEGER;
ALTER TABLE sessions ADD COLUMN scheduled_from_worktree BOOLEAN DEFAULT FALSE;

-- Index for retention cleanup (sort by scheduled time)
CREATE INDEX sessions_scheduled_run_idx ON sessions(worktree_id, scheduled_run_at DESC)
  WHERE scheduled_from_worktree = TRUE;

-- Index for UI filtering (show clock icon)
CREATE INDEX sessions_scheduled_flag_idx ON sessions(scheduled_from_worktree);
```

**Key Insight:** `scheduled_run_at` is the **authoritative run ID**. It stores the exact scheduled time (rounded to the minute), NOT when the session was actually created.

**Example:**

```typescript
// Midnight run scheduled for 2025-11-03 00:00:00 UTC
// Even if triggered at 00:00:32, we store 00:00:00
scheduled_run_at = DateTime.fromObject(
  { year: 2025, month: 11, day: 3, hour: 0, minute: 0, second: 0 },
  { zone: 'UTC' }
).toMillis(); // 1730592000000

// This becomes the unique run identifier for deduplication
```

**Why materialized:**

- `scheduled_run_at`: **Run deduplication** (check if run exists), retention cleanup sorting
- `scheduled_from_worktree`: UI filtering (clock icon), analytics

#### JSON Blob (Execution Details)

```typescript
// sessions.custom_context.scheduled_run (existing custom_context column)
{
  custom_context?: {
    // ... existing fields ...
    scheduled_run?: {
      rendered_prompt: string;           // Template after Handlebars rendering
      run_index: number;                 // 1st, 2nd, 3rd run for this schedule
      schedule_config_snapshot?: {       // Config snapshot at run time
        cron: string;
        timezone: string;
        retention: number;
      };
    };
  }
}
```

### TypeScript Types

#### Updated `Worktree` Type

```typescript
// packages/core/src/types/worktree.ts

export interface Worktree {
  // Existing fields...
  worktree_id: WorktreeID;
  repo_id: RepoID;
  board_id?: BoardID;
  name: string;
  ref: string;
  path: string;
  issue_url?: string;
  pull_request_url?: string;
  notes?: string;
  created_at: string;
  updated_at?: string;
  created_by: string;

  // NEW: Materialized schedule fields
  schedule_enabled: boolean;
  schedule_cron?: string;
  schedule_last_triggered_at?: number; // Unix timestamp (ms)
  schedule_next_run_at?: number; // Unix timestamp (ms)

  // Full schedule config in JSON blob
  schedule?: {
    timezone: string;
    prompt_template: string;
    agentic_tool: AgenticTool;
    retention: number;
    permission_mode?: PermissionMode;
    model_config?: {
      mode: 'default' | 'custom';
      model?: string;
    };
    mcp_server_ids?: string[];
    context_files?: string[];
    created_at: number;
    created_by: string;
  };

  // ... rest of existing fields
}
```

#### Updated `Session` Type

```typescript
// packages/core/src/types/session.ts

export interface Session {
  // Existing fields...
  session_id: SessionID;
  worktree_id: WorktreeID;
  status: SessionStatus;
  agentic_tool: AgenticTool;
  created_at: string;
  updated_at?: string;

  // NEW: Materialized schedule fields
  scheduled_run_at?: number; // Unix timestamp (ms) - authoritative run ID
  scheduled_from_worktree: boolean; // True if created by scheduler

  // Schedule execution details in custom_context JSON blob
  custom_context?: {
    // ... existing custom_context fields ...
    scheduled_run?: {
      rendered_prompt: string;
      run_index: number;
      schedule_config_snapshot?: {
        cron: string;
        timezone: string;
        retention: number;
      };
    };
  };

  // ... rest of existing fields
}
```

### Relationships

```
Worktree (with schedule config) → (many) Sessions (with scheduled_run_at)
```

**Key constraints:**

- One schedule per worktree (at most one `schedule` object in `data`)
- Worktree deletion cascades to sessions (existing FK)
- `scheduled_run_at` serves as run identifier for deduplication
- No separate schedule/run tables to synchronize

---

## Scheduling Engine

### Service Architecture

#### `SchedulerService` (New Background Service)

**Location:** `apps/agor-daemon/src/services/scheduler.ts`

**Responsibilities:**

1. **Periodic Tick:** Runs every 30 seconds (configurable)
2. **Cron Evaluation:** Checks which schedules are due
3. **Run Creation:** Creates `schedule_runs` entries for due schedules
4. **Session Spawning:** Calls `SessionsService.create()` with rendered template
5. **Status Tracking:** Updates run status based on session lifecycle
6. **Retention Cleanup:** Deletes old runs beyond retention limit

**Not a FeathersJS service!** This is a background worker that:

- Starts when daemon starts
- Runs in setInterval loop
- Uses FeathersJS services internally
- Emits events via `app.service('schedule-runs')`

#### Implementation Pattern

```typescript
// apps/agor-daemon/src/services/scheduler.ts

import { Application } from '@feathersjs/feathers';
import cron from 'node-cron';
import { DateTime } from 'luxon';
import Handlebars from 'handlebars';

export class SchedulerService {
  private tickInterval: NodeJS.Timeout | null = null;
  private readonly TICK_INTERVAL_MS = 30_000; // 30 seconds

  constructor(private app: Application) {}

  start() {
    console.log('Scheduler starting...');
    this.tickInterval = setInterval(() => this.tick(), this.TICK_INTERVAL_MS);
    this.tick(); // Run immediately on start
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log('Scheduler stopped');
  }

  private async tick() {
    try {
      console.log('[Scheduler] Tick at', new DateTime.now().toISO());

      // 1. Get all enabled schedules
      const schedules = await this.app.service('schedules').find({
        query: { enabled: true, $limit: 1000 },
        paginate: false,
      });

      // 2. Check each schedule
      for (const schedule of schedules) {
        await this.evaluateSchedule(schedule);
      }

      // 3. Cleanup old runs (async, don't block)
      this.cleanupOldRuns().catch(err => {
        console.error('[Scheduler] Cleanup error:', err);
      });
    } catch (error) {
      console.error('[Scheduler] Tick error:', error);
    }
  }

  private async evaluateSchedule(schedule: Schedule) {
    const now = DateTime.now().setZone(schedule.timezone);

    // Parse cron expression
    const cronSchedule = cron.parseExpression(schedule.cron_expression, {
      currentDate: now.toJSDate(),
      tz: schedule.timezone,
    });

    // Get next scheduled time
    const nextRun = DateTime.fromJSDate(cronSchedule.next().toDate());
    const prevRun = DateTime.fromJSDate(cronSchedule.prev().toDate());

    // Check if we should trigger
    const shouldTrigger = this.shouldTriggerSchedule(schedule, now, prevRun);

    if (shouldTrigger) {
      await this.triggerSchedule(schedule, prevRun);
    }

    // Update next_run_at for UI
    await this.app.service('schedules').patch(schedule.schedule_id, {
      next_run_at: nextRun.toMillis(),
    });
  }

  private async shouldTriggerSchedule(
    worktree: Worktree,
    now: DateTime,
    scheduledTime: DateTime
  ): Promise<boolean> {
    // Round scheduled time to the minute (this becomes our run ID)
    const scheduledTimeRounded = scheduledTime.startOf('minute').toMillis();

    // Check if session already exists for this exact scheduled time
    const existingSession = await this.app.service('sessions').find({
      query: {
        worktree_id: worktree.worktree_id,
        scheduled_run_at: scheduledTimeRounded,
        scheduled_from_worktree: true,
        $limit: 1,
      },
    });

    if (existingSession.total > 0) {
      console.log(`[Scheduler] Run already exists for ${scheduledTime.toISO()}`);
      return false; // Already triggered - idempotent!
    }

    // Only trigger if scheduled time is in the past (but recent)
    const timeSinceScheduled = now.diff(scheduledTime, 'minutes').minutes;

    // Trigger if scheduled time was within last 2 minutes
    // (allows for some clock drift and processing delay)
    return timeSinceScheduled >= 0 && timeSinceScheduled < 2;
  }

  private async triggerSchedule(worktree: Worktree, scheduledTime: DateTime) {
    console.log(`[Scheduler] Triggering schedule for worktree ${worktree.worktree_id}`);

    // Round scheduled time to the minute (authoritative run ID)
    const scheduledTimeRounded = scheduledTime.startOf('minute').toMillis();

    try {
      // 1. Get board context for template rendering
      const board = worktree.board_id
        ? await this.app.service('boards').get(worktree.board_id)
        : null;

      // 2. Render prompt template with Handlebars
      const template = Handlebars.compile(worktree.schedule!.prompt_template);
      const renderedPrompt = template({
        worktree: {
          name: worktree.name,
          ref: worktree.ref,
          issue_url: worktree.issue_url,
          pull_request_url: worktree.pull_request_url,
          notes: worktree.notes,
          custom_context: worktree.custom_context,
        },
        board: board
          ? {
              name: board.name,
              description: board.description,
              custom_context: board.custom_context,
            }
          : null,
        schedule: {
          cron: worktree.schedule_cron,
          scheduled_time: scheduledTime.toISO(),
        },
      });

      // 3. Calculate run_index (count existing scheduled sessions + 1)
      const existingSessions = await this.app.service('sessions').find({
        query: {
          worktree_id: worktree.worktree_id,
          scheduled_from_worktree: true,
          $limit: 10000, // Should be plenty
        },
        paginate: false,
      });
      const runIndex = existingSessions.length + 1;

      // 4. Create session via SessionsService
      const session = await this.app.service('sessions').create({
        worktree_id: worktree.worktree_id,
        agentic_tool: worktree.schedule!.agentic_tool,
        permission_mode: worktree.schedule!.permission_mode || 'default',
        model_config: worktree.schedule!.model_config,
        mcp_server_ids: worktree.schedule!.mcp_server_ids || ['agor'], // Auto-attach Agor MCP
        context_files: worktree.schedule!.context_files || [],
        title: `Scheduled: ${scheduledTime.toFormat('yyyy-MM-dd HH:mm')}`,
        description: 'Scheduled session',
        created_by: worktree.schedule!.created_by,

        // NEW: Materialized schedule fields
        scheduled_run_at: scheduledTimeRounded, // Authoritative run ID!
        scheduled_from_worktree: true,

        // Execution details in custom_context
        custom_context: {
          scheduled_run: {
            rendered_prompt: renderedPrompt,
            run_index: runIndex,
            schedule_config_snapshot: {
              cron: worktree.schedule_cron!,
              timezone: worktree.schedule!.timezone,
              retention: worktree.schedule!.retention,
            },
          },
        },
      });

      // 5. Execute initial prompt (create task)
      await this.app.service('sessions').prompt(session.session_id, {
        prompt: renderedPrompt,
        mode: 'continue',
      });

      // 6. Update worktree's last_triggered_at
      await this.app.service('worktrees').patch(worktree.worktree_id, {
        schedule_last_triggered_at: scheduledTimeRounded,
      });

      console.log(
        `[Scheduler] Created session ${session.session_id} for run at ${scheduledTime.toISO()}`
      );
    } catch (error) {
      console.error(`[Scheduler] Failed to trigger schedule:`, error);
      // Note: No run tracking table, so we just log the error
      // Could optionally create a failed session with error in custom_context
    }
  }

  private async cleanupOldRuns() {
    // Get all worktrees with schedules
    const worktrees = await this.app.service('worktrees').find({
      query: {
        schedule_enabled: true,
        $limit: 1000,
      },
      paginate: false,
    });

    for (const worktree of worktrees) {
      if (!worktree.schedule) continue;

      // Get all scheduled sessions for this worktree, sorted by scheduled_run_at DESC
      const sessions = await this.app.service('sessions').find({
        query: {
          worktree_id: worktree.worktree_id,
          scheduled_from_worktree: true,
          $sort: { scheduled_run_at: -1 },
          $limit: 10000,
        },
        paginate: false,
      });

      // Keep only last N sessions (based on retention)
      const retention = worktree.schedule.retention;
      const toDelete = sessions.slice(retention);

      for (const session of toDelete) {
        await this.app.service('sessions').remove(session.session_id);
      }

      if (toDelete.length > 0) {
        console.log(
          `[Scheduler] Cleaned up ${toDelete.length} old sessions for worktree ${worktree.name} (retention: ${retention})`
        );
      }
    }
  }
}
```

### Cron Expression Handling

**Library:** `node-cron` or `cron-parser`

**Supported formats:**

```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday to Saturday)
│ │ │ │ │
│ │ │ │ │
* * * * *
```

**Examples:**

```cron
0 9 * * 1-5        # 9am weekdays
0 */4 * * *        # Every 4 hours
0 2 * * 1          # 2am every Monday
*/30 * * * *       # Every 30 minutes
0 0 1 * *          # 1st of every month at midnight
```

**Validation:** Validate cron expression when creating/updating schedule

**Timezone handling:** Store timezone per schedule (default: UTC)

### Smart Non-Backfill Algorithm

**Problem:** If scheduler is down for 3 days, should it create 72 sessions (daily schedule)?

**Solution:** No! Only schedule the **latest pending run** from each time window.

**Algorithm:**

```typescript
function shouldTriggerSchedule(
  schedule: Schedule,
  now: DateTime,
  scheduledTime: DateTime
): boolean {
  // Get last triggered time
  const lastTriggered = schedule.last_triggered_at
    ? DateTime.fromMillis(schedule.last_triggered_at)
    : DateTime.fromMillis(0); // Never triggered

  // Don't trigger if already done for this time window
  if (lastTriggered >= scheduledTime) {
    return false;
  }

  // Only trigger if scheduled time is recent (within 2 minutes)
  const timeSinceScheduled = now.diff(scheduledTime, 'minutes').minutes;

  // This ensures we only catch the "current" window, not old missed windows
  return timeSinceScheduled >= 0 && timeSinceScheduled < 2;
}
```

**Example scenario:**

```
Schedule: Daily at 9am
System down: Mon-Wed
System starts: Thursday 10am

Evaluation:
- Monday 9am run: timeSinceScheduled = 73 hours → skip (too old)
- Tuesday 9am run: timeSinceScheduled = 49 hours → skip (too old)
- Wednesday 9am run: timeSinceScheduled = 25 hours → skip (too old)
- Thursday 9am run: timeSinceScheduled = 1 hour → skip (too old)

Result: No runs scheduled (all missed). Next run: Friday 9am.
```

**Alternative (configurable):**

Add `backfill_policy` to schedule config:

```typescript
backfill_policy?: 'none' | 'latest' | 'all';

// 'none': Skip all missed runs (default)
// 'latest': Trigger the most recent missed run once
// 'all': Trigger all missed runs (dangerous!)
```

---

## UI Design

### 1. WorktreeCard - SchedulePill

**Location:** Integrated into `WorktreeCard` component

**Visual Design:**

```
┌──────────────────────────────────────┐
│ 🌿 feature/user-auth    [edit] [del] │
├──────────────────────────────────────┤
│ 👤 Max  #123  PR #456                │
│ 🕐 Every 4 hours ← NEW PILL          │ ← Shows cron in human-readable form
├──────────────────────────────────────┤
│ ▾ Sessions (3)                   [+] │
│   ├─ Initial implementation ✓        │
│   ├─ 🕐 Scheduled: 2025-11-02 09:00  │ ← Scheduled sessions show clock icon
│   └─ Fix OAuth flow ⟳               │
└──────────────────────────────────────┘
```

**Behavior:**

- **If scheduled:** Show `SchedulePill` with human-readable cron (e.g., "Every 4 hours", "Weekdays at 9am")
- **Click pill:** Opens `ScheduleModal` for editing
- **If not scheduled:** Show "+ Add Schedule" button (subtle, secondary style)
- **Scheduled sessions:** Mark with 🕐 clock icon to distinguish from manual sessions

**Cron humanization library:** `cronstrue`

```typescript
import cronstrue from 'cronstrue';

cronstrue.toString('0 9 * * 1-5'); // "At 09:00 AM, Monday through Friday"
cronstrue.toString('0 */4 * * *'); // "Every 4 hours"
```

### 2. ScheduleModal - Configuration UI

**Location:** `apps/agor-ui/src/components/ScheduleModal/ScheduleModal.tsx`

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ Configure Schedule - feature/user-auth                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Cron Expression: [0 */4 * * *               ]  ← Validated │
│ Human-readable: "Every 4 hours"              ← Real-time   │
│                                                             │
│ Timezone: [UTC ▼]                                          │
│                                                             │
│ ─── Cron Helper ───                                        │
│ [Every hour] [Every 4 hours] [Daily at 9am]  ← Presets   │
│ [Weekdays 9am] [Weekly Monday] [Monthly]                   │
│                                                             │
│ ─── Agent Configuration ───                                │
│                                                             │
│ Agent: [claude-code ▼] [codex] [gemini]                    │
│                                                             │
│ Permission Mode: [default ▼]                               │
│ Model: [default ▼] (or custom: opus, sonnet, etc.)        │
│                                                             │
│ ─── Prompt Template ───                                    │
│                                                             │
│ ┌─────────────────────────────────────────────────────┐   │
│ │ Check PR {{worktree.pull_request_url}}.             │   │
│ │ Summarize new comments and requested changes.       │   │
│ │                                                      │   │
│ │                                                      │   │
│ └─────────────────────────────────────────────────────┘   │
│                                                             │
│ Available variables:                                        │
│ • {{worktree.name}}, {{worktree.ref}}                      │
│ • {{worktree.issue_url}}, {{worktree.pull_request_url}}   │
│ • {{worktree.notes}}, {{worktree.custom_context.*}}       │
│ • {{board.name}}, {{board.custom_context.*}}              │
│ • {{schedule.scheduled_time}}                              │
│                                                             │
│ ─── Advanced ───                                           │
│                                                             │
│ Retention: [10 runs ▼]                                     │
│                                                             │
│ MCP Servers: [+ Add server]                                │
│ Context Files: [+ Add file]                                │
│                                                             │
│ ☐ Enabled (uncheck to pause without deleting)             │
│                                                             │
│ [Cancel]                                   [Save Schedule] │
└─────────────────────────────────────────────────────────────┘
```

**Features:**

- **Cron expression editor:** Text input with real-time validation and humanization
- **Cron presets:** Quick buttons for common patterns
- **Timezone selector:** IANA timezone dropdown (Ant Design `Select`)
- **Prompt template:** Textarea with Handlebars syntax highlighting (Monaco editor lite?)
- **Template preview:** Show rendered template with current worktree context
- **Validation:** Validate cron expression, check required fields
- **Enable/disable toggle:** Pause schedule without deleting

### 3. SchedulePanel - Upcoming & Recent Runs

**Location:** Bottom-left overlay on board (similar to presence indicators)

**Visual Design:**

```
┌──────────────────────────────────────────────────┐
│ ⏰ Scheduled Jobs                           [✕]  │
├──────────────────────────────────────────────────┤
│ ▾ Upcoming (Next 5)                              │
│   ┌────────────────────────────────────────────┐ │
│   │ 🌿 feat-auth     🕐 in 2h 15m              │ │
│   │ 🤖 claude-code   ⏰ 2:00pm                 │ │
│   └────────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────────┐ │
│   │ 🌿 fix-cors      🕐 in 4h 30m              │ │
│   │ 🤖 claude-code   ⏰ 4:15pm                 │ │
│   └────────────────────────────────────────────┘ │
│                                                  │
│ ▾ Recent Runs (Last 10)                         │
│   ┌────────────────────────────────────────────┐ │
│   │ 🌿 feat-auth     ✓ Completed   2m ago      │ │
│   │ 🤖 claude-code   ⏱ 45s         [View →]   │ │
│   └────────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────────┐ │
│   │ 🌿 fix-cors      ✗ Failed      1h ago      │ │
│   │ 🤖 claude-code   ⏱ 12s         [View →]   │ │
│   │ Error: API timeout                         │ │
│   └────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Behavior:**

- **Toggle visibility:** Click icon in bottom-left to show/hide
- **Upcoming runs:** Show next 5 scheduled runs across all worktrees on board
- **Recent runs:** Show last 10 completed/failed runs on board
- **Click run:** Navigate to session (if created) or show error details
- **Real-time updates:** WebSocket events update panel live

**Implementation:**

```typescript
// apps/agor-ui/src/components/SchedulePanel/SchedulePanel.tsx

export function SchedulePanel({ boardId }: { boardId: BoardID }) {
  const [upcomingRuns, setUpcomingRuns] = useState<UpcomingRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<ScheduleRun[]>([]);

  useEffect(() => {
    // Fetch upcoming runs (computed from schedules)
    async function fetchUpcoming() {
      const worktrees = await client.service('worktrees').find({
        query: { board_id: boardId },
      });

      const schedules = await Promise.all(
        worktrees.data.map(wt =>
          client.service('schedules').find({
            query: { worktree_id: wt.worktree_id },
          })
        )
      );

      // Compute next run times for each schedule
      // Sort by next_run_at
      // Take top 5
    }

    // Fetch recent runs
    async function fetchRecent() {
      const runs = await client.service('schedule-runs').find({
        query: {
          // Filter by board somehow (join through worktree)
          $sort: { completed_at: -1 },
          $limit: 10,
        },
      });
      setRecentRuns(runs.data);
    }

    fetchUpcoming();
    fetchRecent();

    // Listen for real-time updates
    const runsService = client.service('schedule-runs');
    runsService.on('created', fetchRecent);
    runsService.on('patched', fetchRecent);

    return () => {
      runsService.removeListener('created', fetchRecent);
      runsService.removeListener('patched', fetchRecent);
    };
  }, [boardId]);

  return (
    <Card className="schedule-panel">
      {/* Render upcoming and recent runs */}
    </Card>
  );
}
```

### 4. Session Icon Indicator

**For scheduled sessions:** Show 🕐 clock icon in session card/drawer

**Implementation:**

```typescript
// In SessionCard or SessionDrawer
{session.custom_context?.scheduled && (
  <Tooltip title={`Scheduled run from ${schedule.cron_expression}`}>
    <ClockCircleOutlined style={{ marginRight: 8 }} />
  </Tooltip>
)}
```

---

## API Design

**No New Services!** Schedule management goes through existing `WorktreesService` and `SessionsService`.

### Worktrees Service - New Query Patterns

**Get worktrees with schedules:**

```typescript
// Get all enabled schedules
GET /worktrees?schedule_enabled=true

// Get schedules on specific board
GET /worktrees?board_id=019a...&schedule_enabled=true

// Get schedules due soon
GET /worktrees?schedule_enabled=true&schedule_next_run_at[$lt]=1698768000000
```

**Create/Update schedule:**

```typescript
// Create schedule for worktree
PATCH /worktrees/:id
{
  schedule_enabled: true,
  schedule_cron: "0 9 * * 1-5",
  schedule: {
    timezone: "America/New_York",
    prompt_template: "Run tests for {{worktree.name}}",
    agentic_tool: "claude-code",
    retention: 10,
    // ... other config
  }
}

// Disable schedule (pause without deleting)
PATCH /worktrees/:id
{
  schedule_enabled: false
}

// Delete schedule entirely
PATCH /worktrees/:id
{
  schedule_enabled: false,
  schedule_cron: null,
  schedule: null,
  schedule_last_triggered_at: null,
  schedule_next_run_at: null
}
```

**Hooks to add:**

- **Before patch:** If `schedule_cron` changed, recompute `schedule_next_run_at`
- **Before patch:** Validate cron expression if provided
- **After patch:** Emit WebSocket event for UI updates (existing)

### Sessions Service - New Query Patterns

**Get scheduled sessions:**

```typescript
// Get all scheduled sessions for a worktree
GET /sessions?worktree_id=019a...&scheduled_from_worktree=true&$sort[scheduled_run_at]=-1

// Get specific scheduled run (deduplication check)
GET /sessions?worktree_id=019a...&scheduled_run_at=1730592000000&scheduled_from_worktree=true&$limit=1

// Get all scheduled sessions on a board (via worktree join)
// (Requires multi-table query or client-side filtering)
```

**No new endpoints** - Use existing session CRUD

---

## Implementation Plan

### Phase 1: Data Model & Validation ✅ COMPLETE

**Tasks:**

1. **Schema Migrations**
   - [x] Add 4 columns to `worktrees` table (schedule_enabled, schedule_cron, schedule_last_triggered_at, schedule_next_run_at)
   - [x] Add 2 columns to `sessions` table (scheduled_run_at, scheduled_from_worktree)
   - [x] Create 5 indexes (3 on worktrees, 2 on sessions)
   - [x] Run migrations on dev DB - `drizzle/0001_complex_the_call.sql` applied

2. **TypeScript Types**
   - [x] Update `Worktree` type with schedule fields - `packages/core/src/types/worktree.ts`
   - [x] Update `Session` type with schedule fields - `packages/core/src/types/session.ts`
   - [x] Add schedule config interface for `worktree.data.schedule` - `WorktreeScheduleConfig`
   - [x] Add scheduled_run interface for `session.custom_context.scheduled_run` - `ScheduledRunMetadata`

3. **Cron Libraries**
   - [x] Install `cron-parser@5.4.0` backend library
   - [x] Install `cronstrue@3.9.0` for humanization
   - [x] Install `react-js-cron` frontend component
   - [x] Create cron validation utility - `packages/core/src/utils/cron.ts`
   - [x] Create cron humanization utility - `humanizeCron()`, `CRON_PRESETS`
   - [x] Export `@agor/core/utils/cron` in package.json

4. **Worktrees Service Updates**
   - [x] Add validation hook for `schedule_cron` - validates with `CronExpressionParser.parse()`
   - [x] Add hook to compute `schedule_next_run_at` - calls `getNextRunTime()` automatically
   - [x] Update TypeScript types in service - uses types from `@agor/core/types`

5. **Testing**
   - [ ] Test cron validation (valid/invalid expressions)
   - [ ] Test next_run_at computation
   - [ ] Test retention=0 (infinite retention) edge case
   - [ ] Test worktree cascade delete (sessions deleted)

**Deliverable:** ✅ Can store schedule config on worktrees via API, validation works

**Files Changed:**

- `packages/core/drizzle/0001_complex_the_call.sql` (migration)
- `packages/core/src/db/schema.ts` (schema)
- `packages/core/src/types/worktree.ts` (types)
- `packages/core/src/types/session.ts` (types)
- `packages/core/src/utils/cron.ts` (new utilities)
- `packages/core/src/db/repositories/sessions.ts` (repository)
- `packages/core/src/db/repositories/worktrees.ts` (repository)
- `apps/agor-daemon/src/services/worktrees.ts` (validation hooks)
- `packages/core/package.json` (exports)
- `packages/core/tsup.config.ts` (build config)

### Phase 2: Scheduler Engine ✅ COMPLETE

**Tasks:**

1. **Scheduler Service**
   - [x] Create `SchedulerService` class - `apps/agor-daemon/src/services/scheduler.ts`
   - [x] Implement tick loop (setInterval with 30s default) - `start()`, `stop()`, `tick()`
   - [x] Implement schedule evaluation - `processSchedule()`, grace period (2min)
   - [x] Implement deduplication - queries for existing `scheduled_run_at` before spawning
   - [x] Implement session spawning - `spawnScheduledSession()` with full metadata
   - [x] Smart recovery - only schedules latest missed run (no backfill)

2. **Handlebars Template Rendering**
   - [x] Context builder (worktree, board, schedule metadata) - `renderPrompt()`
   - [x] Template rendering with error handling - fallback to raw template on error
   - [ ] Template preview helper (for UI)

3. **Retention Cleanup**
   - [x] Implement `enforceRetentionPolicy()` - queries sessions ordered by `scheduled_run_at`
   - [x] Handle `retention: 0` (infinite, skip cleanup)
   - [x] Run cleanup after session spawn (non-blocking)

4. **Smart Recovery**
   - [x] Check time since scheduled run (grace period: 2min)
   - [x] Only trigger latest missed run (no backfill)
   - [x] Idempotent - checks for existing session before creating

5. **Daemon Integration**
   - [ ] Start scheduler in `apps/agor-daemon/src/index.ts`
   - [ ] Graceful shutdown on SIGTERM
   - [ ] Configurable tick interval (env var or config)
   - [ ] Error handling and logging

6. **MCP Auto-Attachment**
   - [ ] Ensure 'agor' MCP always included in `mcp_server_ids`
   - [ ] Merge with user-selected MCP servers

7. **Testing**
   - [ ] Integration tests for scheduler tick
   - [ ] Test cron evaluation (mocked time)
   - [ ] Test session spawning with `scheduled_run_at`
   - [ ] Test retention cleanup (including retention=0)
   - [ ] Test smart recovery (missed run detection)
   - [ ] Test deduplication (duplicate run prevention)

**Deliverable:** ✅ Core scheduler logic complete - ready for daemon integration

**Files Changed:**

- `apps/agor-daemon/src/services/scheduler.ts` (new SchedulerService)

### Phase 3: UI Components (Week 3)

**Tasks:**

1. **Cron UI Component Integration**
   - [ ] Install `react-js-cron` (chosen library)
   - [ ] Test with Ant Design form integration
   - [ ] Style with Ant Design tokens (colorPrimary, borderRadius, etc.)
   - [ ] Create wrapper component for consistent styling

2. **SchedulePill Component**
   - [ ] Humanize cron with `cronstrue`
   - [ ] Click opens ScheduleModal
   - [ ] Show "+ Add Schedule" if not scheduled
   - [ ] Integrate into WorktreeCard

3. **ScheduleModal Component**
   - [ ] Visual cron builder (using chosen React cron component)
   - [ ] Cron string input fallback (for advanced users)
   - [ ] Real-time humanization ("At 09:00 AM, Monday through Friday")
   - [ ] Prompt template textarea with Handlebars syntax help
   - [ ] Template preview (render with current worktree context)
   - [ ] Agent/model/permission config (reuse existing form)
   - [ ] Retention input (with "0 = keep forever" help text)
   - [ ] Enable/disable toggle
   - [ ] Form validation + submission

4. **SchedulePanel Component**
   - [ ] Fetch upcoming runs (query worktrees with schedule_next_run_at)
   - [ ] Fetch recent scheduled sessions (query sessions with scheduled_from_worktree)
   - [ ] Real-time WebSocket updates
   - [ ] Collapsible sections
   - [ ] Click session → navigate to session drawer
   - [ ] Position as bottom-left overlay (or Settings → Scheduler tab)

5. **Session Icon Indicator**
   - [ ] Show 🕐 clock icon for scheduled sessions (`scheduled_from_worktree: true`)
   - [ ] Tooltip with schedule info (run_index, scheduled_time)
   - [ ] Integrate into SessionCard and SessionDrawer header

6. **Testing**
   - [ ] Storybook stories for all components
   - [ ] Manual testing with real schedules
   - [ ] Test UTC display (ensure times shown correctly)

**Deliverable:** Full UI for creating, editing, viewing schedules

### Phase 4: Polish & Documentation (Week 4)

**Tasks:**

1. **Error Handling**
   - [ ] Graceful failure when session creation fails
   - [ ] Retry logic (optional)
   - [ ] Error notifications in UI

2. **Performance**
   - [ ] Benchmark scheduler tick with 100+ schedules
   - [ ] Optimize queries (indexes)
   - [ ] Consider batching session creation

3. **Documentation**
   - [ ] Update CLAUDE.md with scheduler overview
   - [ ] Write user guide (how to create schedules)
   - [ ] Write developer guide (how scheduler works)
   - [ ] Add examples to docs

4. **Testing**
   - [ ] End-to-end tests
   - [ ] Load testing (many schedules)
   - [ ] Edge case testing (timezone changes, DST, leap seconds)

**Deliverable:** Production-ready scheduler feature

---

## Decisions Made

### 1. MCP Auto-Attachment ✅

**Decision:** YES - Agor's internal MCP server is auto-attached to ALL sessions (not just scheduled ones).

- Scheduled sessions get `mcp_server_ids: ['agor', ...userSelected]`
- Enables supervisory patterns out of the box
- Users can add additional MCP servers via existing UI

### 2. Session Deletion on Retention Cleanup ✅

**Decision:** YES - Delete old sessions when retention limit exceeded.

- `retention: 10` → keep last 10 sessions, delete older ones
- `retention: 0` → **keep forever** (infinite retention)
- Clean automatic cleanup, users control via retention setting

### 3. Failed Run Tracking ✅

**Decision:** Create failed session with error in `custom_context`.

- If session creation fails, catch error and log (no retry)
- Optionally create session with `status: 'failed'` and error details
- No complex retry logic or "don't run if previous failed" for MVP

### 4. Cron Validation ✅

**Decision:** Use frontend + backend libraries to prevent malformed strings.

**Frontend:** `react-js-cron` (chosen)

- 100K+ weekly downloads, most battle-tested
- Ant Design compatible (uses classnames, can style with Ant tokens)
- Visual cron builder with validation
- Fallback text input for advanced users

**Humanization:** `cronstrue`

- Converts cron to human-readable ("At 09:00 AM, Monday through Friday")
- Used in UI displays (SchedulePill, tooltips)

**Backend:** `cron-parser`

- 2M+ weekly downloads, most popular
- Parse cron, get next/prev run, timezone support
- Used for scheduler tick evaluation and `next_run_at` computation

```typescript
import { parseExpression } from 'cron-parser';

const interval = parseExpression('0 9 * * 1-5', {
  currentDate: new Date(),
  tz: 'UTC',
});

const next = interval.next(); // Next run
const prev = interval.prev(); // Previous run
```

### 5. Timezone ✅

**Decision:** Everything in UTC.

- All timestamps stored as UTC milliseconds
- Cron expressions evaluated in UTC
- UI can display in user's local timezone but store UTC
- Simplifies DST handling and multi-user scenarios

### 6. Scheduler Tick Interval ✅

**Decision:** Configurable, default 30 seconds.

- Start with hardcoded 30s for MVP
- Future: Settings → Scheduler tab with tick interval config
- KISS for now, add UI later if needed

### 7. Recovery After Crash ✅

**Decision:** YES - Smart recovery on startup/tick.

**Algorithm:**

- On each tick, for each enabled schedule:
  - Calculate "previous run window" (based on cron)
  - Check if session exists for that exact `scheduled_run_at`
  - If missing AND within 2-minute grace period, trigger it
  - Only triggers **one latest missed run**, not backfill

**Example:**

```
Hourly job: 0 * * * *
Scheduler down: 12:00 - 18:00
Scheduler starts: 18:03

Tick at 18:03:
- Previous window: 18:00 (3 minutes ago)
- Check: session exists for scheduled_run_at = 18:00:00?
- No → Trigger 18:00 run
- Yes → Skip

Next tick at 18:03:30: (same behavior, idempotent)
Next real trigger: 19:00
```

This gives us automatic recovery without backfill flood!

---

## Open Questions (Archive)

### 1. Session Deletion Cascade (RESOLVED)

**Question:** When retention cleanup deletes old `schedule_runs`, should it also delete the associated sessions?

**Options:**

A. **Nullify FK only** (`ON DELETE SET NULL`)

- Run deleted, session persists
- Pro: Preserves work history
- Con: Sessions accumulate indefinitely

B. **Cascade delete sessions**

- Run deleted → session deleted
- Pro: Automatic cleanup
- Con: Loses valuable debugging data

**Recommendation:** **Option A** (nullify). Let users manually delete sessions or implement separate session retention policy.

**Implementation:** FK constraint `ON DELETE SET NULL` (already in schema)

### 2. Scheduler Reliability

**Question:** What happens if daemon crashes mid-tick?

**Scenarios:**

A. **Daemon crashes after creating `schedule_run` but before creating session**

- Run status: `scheduled`
- Session: NULL
- Next tick: Re-check, see run exists → skip (already attempted)
- Result: Missed run (acceptable for supervisory tasks)

B. **Daemon crashes after creating session but before updating run**

- Run status: `running`
- Session: Created but orphaned
- Next tick: Scheduler doesn't retry (assumes in progress)
- Result: Orphaned session, run never marked complete

**Mitigation:**

- Add timeout check: If run in `running` status for >10 minutes, mark as `failed`
- Add recovery logic: On startup, check for stale `running` runs

**Implementation:**

```typescript
async recoverStaleRuns() {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

  const staleRuns = await this.app.service('schedule-runs').find({
    query: {
      status: 'running',
      started_at: { $lt: tenMinutesAgo },
    },
  });

  for (const run of staleRuns) {
    await this.app.service('schedule-runs').patch(run.run_id, {
      status: 'failed',
      completed_at: Date.now(),
      error_message: 'Stale run (timed out)',
    });
  }
}
```

### 3. Timezone Complexity

**Question:** How to handle daylight saving time (DST) transitions?

**Problem:** Cron expression "9am daily" means different UTC times across DST boundary.

**Solution:** Use timezone-aware cron library (`cron-parser` with `tz` option).

**Example:**

```typescript
const schedule = cron.parseExpression('0 9 * * *', {
  currentDate: new Date(),
  tz: 'America/New_York', // Handles DST automatically
});

schedule.next(); // Returns next 9am in NY time, accounting for DST
```

**Trade-off:** Requires timezone DB in daemon (Luxon includes IANA timezone data).

### 4. MCP Tool Integration

**Question:** Should scheduled sessions have access to Agor's MCP server by default?

**Context:** Agor's internal MCP server enables self-awareness (list sessions, spawn subsessions).

**Options:**

A. **Auto-attach MCP server**

- Scheduled sessions get `agor` MCP server automatically
- Pro: Enables supervisory patterns (check board status, spawn work)
- Con: Requires session tokens for MCP auth

B. **Manual opt-in**

- User must explicitly add `agor` to `mcp_server_ids`
- Pro: More explicit control
- Con: Extra configuration step

**Recommendation:** **Option A** (auto-attach). Supervisory use case is primary motivation for scheduler.

**Implementation:** In `triggerSchedule()`, always include `agor` in `mcp_server_ids`.

### 5. Concurrency Limits

**Question:** Should we limit concurrent scheduled sessions?

**Context:** If 10 schedules trigger at same time, 10 sessions spawn simultaneously.

**Options:**

A. **No limits**

- Simple implementation
- Risk: Resource exhaustion (API rate limits, memory)

B. **Queue with concurrency limit**

- Max N concurrent sessions (e.g., 3)
- Queue remaining in `scheduled` status
- Pro: Prevents resource exhaustion
- Con: Adds complexity (job queue)

**Recommendation:** **Start with Option A** (no limits). Add queue if needed (Phase 2+).

**Future enhancement:** Integrate with job queue (BullMQ, see `context/explorations/async-jobs.md`).

### 6. Schedule Conflicts

**Question:** Can a worktree have multiple schedules?

**Current design:** One schedule per worktree (UNIQUE constraint).

**Justification:**

- Simpler UX (one SchedulePill per worktree)
- Avoids scheduling conflicts (two sessions spawning simultaneously)
- User can always chain tasks via MCP (first session spawns second)

**Alternative:** Allow multiple schedules per worktree with priority/ordering.

**Recommendation:** Start with one schedule per worktree. Revisit if needed.

### 7. Schedule Inheritance

**Question:** Should worktrees inherit schedules from board?

**Use case:** "All worktrees on 'Production' board run health checks daily."

**Options:**

A. **Board-level schedules**

- Schedule belongs to board, runs on all worktrees
- Pro: DRY (define once)
- Con: Adds complexity

B. **Manual per-worktree schedules**

- User creates schedule for each worktree
- Pro: Explicit control
- Con: Repetitive

**Recommendation:** **Start with Option B** (per-worktree). Add board-level schedules as future enhancement.

---

## Future Enhancements

### 1. Manual Trigger

**Feature:** "Run now" button to trigger schedule immediately (outside cron window).

**Use case:** Test schedule without waiting for next cron window.

**API:**

```typescript
POST /schedules/:id/trigger
```

**Implementation:** Call `triggerSchedule()` directly with current time.

### 2. Schedule History Dashboard

**Feature:** Dedicated page showing all runs across all worktrees.

**UI:**

- Table with columns: Worktree, Scheduled Time, Status, Duration, Session
- Filters: Status, worktree, date range
- Charts: Success rate, avg duration

### 3. Conditional Schedules

**Feature:** Only trigger if condition met (e.g., "only if PR has new comments").

**Implementation:**

- Add `condition` field to schedule (Handlebars boolean expression)
- Evaluate before creating session
- Skip if condition false

**Example:**

```typescript
condition: '{{worktree.pull_request_url}} !== null';
```

### 4. Schedule Templates

**Feature:** Pre-built schedule templates for common patterns.

**Examples:**

- "PR Status Monitor"
- "Daily Test Runner"
- "Dependency Update Bot"
- "Stale Issue Reminder"

**Implementation:** Library of schedule configs, user selects and customizes.

### 5. Multi-Worktree Schedules

**Feature:** Single schedule runs on multiple worktrees.

**Use case:** "Run tests on all worktrees in 'Backend' board."

**Implementation:**

- `worktree_id` becomes array (`worktree_ids`)
- Scheduler creates one session per worktree

### 6. Chained Schedules

**Feature:** Schedule triggers another schedule (DAG execution).

**Use case:** "After tests pass, deploy to staging."

**Implementation:**

- `on_complete` field with schedule ID or worktree pattern
- Scheduler checks dependencies before triggering

### 7. Notifications

**Feature:** Notify user when schedule fails or completes.

**Channels:**

- In-app notification
- Email (future)
- Slack webhook (future)

**Implementation:** Hook into schedule run lifecycle, emit notifications.

### 8. Schedule Analytics

**Feature:** Track metrics per schedule.

**Metrics:**

- Success rate (% completed vs failed)
- Average duration
- Token usage
- Cost (API calls)

**UI:** Charts on schedule detail page.

---

## Implementation Checklist

### Phase 1: Data Model & Services

- [ ] Create `schedules` table migration
- [ ] Create `schedule_runs` table migration
- [ ] Define TypeScript types (`Schedule`, `ScheduleRun`)
- [ ] Implement `SchedulesRepository`
- [ ] Implement `ScheduleRunsRepository`
- [ ] Implement `SchedulesService` (FeathersJS)
- [ ] Implement `ScheduleRunsService` (FeathersJS)
- [ ] Add validation hooks (cron validation)
- [ ] Write unit tests for repositories
- [ ] Write integration tests for services

### Phase 2: Scheduler Engine

- [ ] Implement `SchedulerService` class
- [ ] Implement tick loop with cron evaluation
- [ ] Implement smart non-backfill logic
- [ ] Implement session spawning via `SessionsService`
- [ ] Implement Handlebars template rendering
- [ ] Implement retention cleanup
- [ ] Integrate scheduler into daemon startup
- [ ] Add graceful shutdown handling
- [ ] Write integration tests for scheduler
- [ ] Test timezone handling and DST

### Phase 3: UI Components

- [ ] Create `SchedulePill` component
- [ ] Create `ScheduleModal` component with cron editor
- [ ] Create `SchedulePanel` component (upcoming/recent runs)
- [ ] Add schedule indicator to `WorktreeCard`
- [ ] Add clock icon to scheduled sessions
- [ ] Integrate WebSocket events for real-time updates
- [ ] Write Storybook stories
- [ ] Manual UI testing

### Phase 4: Polish & Documentation

- [ ] Error handling and recovery logic
- [ ] Performance testing (100+ schedules)
- [ ] Update CLAUDE.md
- [ ] Write user guide
- [ ] Write developer guide
- [ ] End-to-end tests
- [ ] Load testing

---

## Implementation Status (2025-11-02)

### ✅ Phase 1 & 2 Complete (Backend Core)

**What's Working:**

- ✅ Database schema with 6 new columns + 5 indexes
- ✅ TypeScript types for `Worktree` and `Session` schedule fields
- ✅ Cron utilities: validation, humanization, next/prev run calculation
- ✅ WorktreesService validation hooks (auto-compute `next_run_at`)
- ✅ Repository updates for schedule fields
- ✅ SchedulerService with tick loop, smart recovery, retention cleanup
- ✅ Handlebars template rendering with context
- ✅ Deduplication via `scheduled_run_at`
- ✅ Package exports for `@agor/core/utils/cron`

**Next Up (Immediate):**

1. Integrate SchedulerService into daemon startup
2. Test end-to-end schedule creation and triggering
3. Begin UI components (SchedulePill, ScheduleModal)

**Implementation Files:**

- `packages/core/drizzle/0001_complex_the_call.sql` - Schema migration
- `packages/core/src/utils/cron.ts` - Cron utilities (9 functions + presets)
- `apps/agor-daemon/src/services/scheduler.ts` - Scheduler engine (430 lines)
- `apps/agor-daemon/src/services/worktrees.ts` - Validation hooks
- `packages/core/src/types/worktree.ts` - WorktreeScheduleConfig interface
- `packages/core/src/types/session.ts` - ScheduledRunMetadata interface

---

## Conclusion

The Scheduler transforms Agor from a manual agent orchestration tool into an **autonomous agent platform**. By anchoring schedules to worktrees (persistent work contexts) and leveraging Agor's MCP self-awareness, it enables powerful supervisory patterns while maintaining simplicity.

**Key Design Principles:**

1. **Embedded architecture:** No new tables - schedule config on worktrees, runs tracked via sessions
2. **Worktree-centric:** Schedules belong to work contexts, not ephemeral conversations
3. **Template-driven:** Handlebars templates enable dynamic, context-aware prompts
4. **Smart scheduling:** No backfill - only latest missed run (prevents flood after downtime)
5. **Idempotent execution:** `scheduled_run_at` as authoritative run ID prevents duplicates
6. **UTC-first:** All timestamps in UTC, simplifies DST and multi-user scenarios
7. **MCP-enabled:** Auto-attach Agor MCP for self-awareness and supervisory patterns

**Key Decisions Made:**

✅ **Embedded columns approach** - 6 new columns (4 worktrees, 2 sessions), no separate tables
✅ **`scheduled_run_at` as run ID** - Exact scheduled time (rounded to minute) for deduplication
✅ **Retention cleanup** - Delete old sessions, `retention: 0` means keep forever
✅ **MCP auto-attachment** - Always include 'agor' MCP in scheduled sessions
✅ **UTC everywhere** - Cron evaluation, timestamps, storage all in UTC
✅ **Smart recovery** - Trigger latest missed run on startup, no backfill
✅ **Cron libraries** - `cron-parser` backend, `react-js-cron` frontend, `cronstrue` humanization

**Schema Impact:**

- **6 new columns** (4 on worktrees, 2 on sessions)
- **5 new indexes** (all partial/composite for efficiency)
- **~158 KB overhead** for 1000 worktrees + 10K sessions
- **No new tables or services** - minimal complexity

**Next Steps:**

1. ✅ All design decisions finalized
2. Begin Phase 1: Schema migrations + TypeScript types
3. Phase 2: Scheduler engine with smart recovery
4. Phase 3: UI with visual cron builder
5. Phase 4: Polish and documentation

**Estimated effort:** 3-4 weeks for MVP (simplified due to embedded approach).

---

## Related Documentation

- [[worktrees]] - Worktree-centric architecture
- [[board-objects]] - Zone triggers with Handlebars
- [[agent-integration]] - Agent SDK integration patterns
- [[architecture]] - System architecture and service patterns
- [[models]] - Data model conventions

---

_This is an exploration document. Design decisions are subject to change based on implementation learnings and user feedback._
