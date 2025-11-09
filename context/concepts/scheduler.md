# Worktree Scheduler

**Status:** ✅ Phase 1-2 Implemented (Nov 2025)
**Related:** [[worktrees]], [[boards]], [[agent-integration]]

---

## Overview

The scheduler lets users automate recurring or one-off agent runs per worktree. Config lives on the worktree itself (no extra table) and drives session creation using cron syntax + Handlebars prompts.

### What You Can Configure

- `enabled` – master toggle per worktree
- `cron` expression + timezone
- `prompt` template (access to worktree + board context)
- Agent/model/permission overrides
- Retention count for historical scheduled sessions

## Flow

1. Scheduler service polls for due runs using `cron-parser` + `luxon`.
2. When a run is due, a new session is created with `scheduled_run_at` metadata.
3. The prompt executes automatically; UI tags the session with a clock badge.
4. Sessions appear on the same board + worktree card, keeping genealogy intact.

## Implementation

- Data: Extra columns on `worktrees` + `sessions` defined in `packages/core/src/db/schema.ts`
- Service: `apps/agor-daemon/src/services/scheduler.ts` with polling + locking
- UI: Scheduler panel inside `WorktreeModal` and badges on cards/drawers

_For full rationale and diagrams, see `context/archives/scheduler.md`._
