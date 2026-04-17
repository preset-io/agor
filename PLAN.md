# Plan: "Execute Now" for scheduled worktree sessions (#999)

Design-only pass. No production code changes yet.

---

## 1. Current scheduling architecture

**Storage (per-worktree, no separate schedule table):**
- `packages/core/src/db/schema.sqlite.ts` (+ `schema.postgres.ts`): worktree columns
  `schedule_enabled`, `schedule_cron`, `schedule_last_triggered_at`,
  `schedule_next_run_at`, and a JSON `schedule` blob with `agentic_tool`,
  `prompt_template`, `retention`, `timezone`, `permission_mode`, `model_config`,
  `mcp_server_ids`, `context_files`.

**Scheduler worker:**
- `apps/agor-daemon/src/services/scheduler.ts` — `SchedulerService`, tick interval
  30s, grace period 2min.
- Flow: `tick()` → `getEnabledSchedules()` (repo-level, bypasses auth) →
  `processSchedule(worktree, now)` (due-check via `getPrevRunTime`) →
  `spawnScheduledSession(worktree, scheduledRunAt, now)`.
- `spawnScheduledSession` (lines 299–433): dedupes by `scheduled_run_at`,
  renders Handlebars prompt, resolves creator's `unix_username`, calls
  `app.service('sessions').create(...)` with `scheduled_from_worktree: true`,
  attaches MCP servers, then calls `/sessions/:id/prompt` with
  `provider: undefined, user: creator` to bypass auth and get a proper session
  token. Finally updates metadata and enforces retention.
- **No concurrency guard** — scheduler does not check whether a session is
  already running in the worktree; it spawns regardless.
- **Audit log:** stdout `console.log` only. Session create itself is the
  persistent record (row in `sessions` with `scheduled_from_worktree`).

**Schedule UI:**
- `apps/agor-ui/src/components/WorktreeModal/tabs/ScheduleTab.tsx` — a tab
  inside the WorktreeModal (not a standalone drawer). Enable toggle + cron
  picker + prompt template textarea + agent/permission/model/MCP selection.
  Submits via `onUpdate(worktreeId, { schedule_enabled, schedule_cron, schedule })`
  which PATCHes the worktree.

**Board card actions:**
- `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx` ~L820–895:
  header button row with Pin, Drag, Terminal (CodeOutlined), Edit
  (EditOutlined → opens settings modal), Archive (DeleteOutlined). Hover-
  revealed, `stopPropagation` + `className="nodrag"`. Session-level buttons
  live separately on `SessionItemWithActions`.

**RBAC on schedule edits:**
- `apps/agor-daemon/src/register-hooks.ts` L542–548: patching a worktree
  requires `ensureWorktreePermission('all', ...)` when RBAC is on.
  → Editing a schedule already requires tier `all`.
- Tiers: `none/view/session/prompt/all` with ranks -1/0/1/2/3
  (`apps/agor-daemon/src/utils/worktree-authorization.ts`).

**Session create endpoint:**
- `app.service('sessions').create(...)` is the canonical path (Feathers).
  Scheduler reuses it directly.

---

## 2. Recommended trigger placement — **B (WorktreeCard) with a small concession toward C**

**Recommendation:** Put the primary "Execute Now" button on **WorktreeCard's
header action row**, next to Edit/Archive. Also surface it in the
`ScheduleTab` footer as a secondary entry point (so users configuring the
schedule can dry-run it in place).

**Reasoning:**
1. The whole product is worktree-centric and spatial — the board is the
   primary interface, and `WorktreeCard` is where every other worktree-level
   action already lives (Terminal, Edit, Archive). That is the established
   pattern; a schedule run is a worktree-level action.
2. Placement A (inside the drawer next to the Enable toggle) is
   configuration-adjacent but requires two clicks to even see the button
   and encourages conflating "save config" with "fire now." The issue's
   intuition (next to the toggle) is reasonable but the drawer is the wrong
   home for a frequent action.
3. Placement C (both) is good for discoverability but adding the secondary
   entry in `ScheduleTab` is cheap — one button, same handler. I'd include
   it because users who just finished editing a cron will naturally want to
   test it without closing the drawer.
4. A global "scheduled jobs" view does not exist today — not worth
   introducing one for this feature.

**Visibility/enablement rules on the card button:**
- Only render when `worktree.schedule_enabled === true` **and**
  `worktree.schedule_cron` and `worktree.schedule.prompt_template` exist.
  If the schedule is disabled, don't render (keeps header uncluttered).
- Disabled + tooltip if user lacks `all` permission.
- Disabled + tooltip "A scheduled run is already starting…" while a request
  is in flight (local optimistic lock).
- Icon: `ThunderboltOutlined` or `PlayCircleOutlined` (a quick-fire symbol
  — distinct from the schedule/clock iconography).

---

## 3. Backend change — extract shared core, add one endpoint

**Endpoint:** `POST /worktrees/:worktree_id/execute-schedule-now`

Not `POST /sessions/:id/execute-now` — the issue's original shape is wrong:
a scheduled run creates a *new* session, it does not act on an existing
session. The resource is the worktree (which owns the schedule).

**Request body:** (all optional overrides; server falls back to schedule
config if omitted — keep the first cut minimal: no overrides)
```json
{}
```
Future-proof fields we might add later: `prompt_override`, `context`
overrides. Leave out of v1.

**Response (201):**
```json
{
  "session_id": "…",
  "worktree_id": "…",
  "scheduled_run_at": 1713398400000,
  "triggered_manually": true
}
```

**Auth:** require tier `all` — matches schedule-edit permission, so anyone
who could edit the schedule can fire it. This is stricter than `session`
(creating arbitrary sessions) but is the right match because this action
spawns a session using the *creator's* Unix identity via the scheduler
path, not the triggerer's.

**Implementation plan (reuse exactly one code path):**
1. Refactor `spawnScheduledSession` in `scheduler.ts`:
   - Extract a new public method `executeScheduleNow(worktreeId, { triggeredBy, manual: true })`.
   - Internally refactor the existing private body into a helper
     `runSchedule(worktree, { scheduledRunAt, manual, triggeredBy })` that
     both the tick path and the new endpoint call.
   - `scheduledRunAt` for manual runs is `Date.now()` rounded to the
     nearest minute (keeps dedup semantics consistent with cron runs).
2. New Feathers service `worktree-execute-now` (or add as a custom route on
   the worktrees service): thin wrapper that:
   - Loads worktree, runs `ensureWorktreePermission('all', ...)`.
   - Validates: `schedule_enabled === true`, `schedule_cron` set,
     `schedule.prompt_template` set — otherwise 400 with a clear error.
   - Calls `SchedulerService.executeScheduleNow(...)`.
   - Returns the created session's id.
3. Add the new endpoint to `register-routes.ts` and hooks to
   `register-hooks.ts`.
4. Emit a normal session `created` websocket event (happens automatically
   via `sessionsService.create`), which keeps the UI in sync with no
   extra plumbing.

---

## 4. Edge cases

| Case | Handling |
|---|---|
| Schedule disabled | Endpoint returns 400 `schedule_disabled`. Card button not rendered. |
| Cron/template missing | Endpoint returns 400 `schedule_incomplete`. Button disabled with tooltip. |
| Session already running in worktree | **Do NOT block.** Scheduler itself permits this today; blocking here would surprise users and diverge from scheduled behavior. Document it. (The issue's "no-op with tooltip" guidance is inconsistent with current scheduler semantics; recommend we raise this and align on allowing, matching the existing cron path.) |
| Rapid double-click | (a) Optimistic UI disables button for ~3s after click. (b) Server dedup: `scheduled_run_at` is minute-rounded, so two triggers within the same minute will hit the existing dedup branch in `spawnScheduledSession` and the second becomes a no-op returning the already-created session. |
| Concurrent manual + cron collision | Same minute-rounding dedup covers it. If cron fires at 09:00 and user clicks at 09:00:30, both map to `scheduled_run_at=09:00:00` and second call is a no-op. |
| Creator deleted or missing `unix_username` in strict mode | Scheduler already throws (`resolveCreatorUnixUsername`). Surface as 409 with the existing error message. |
| RBAC disabled | No permission check needed (same as PATCH behavior); only `requireMinimumRole(MEMBER)` applies. |
| Non-owner user triggers | Requires `all` tier — for a non-owner, `others_can` must be `all`, which is consistent with being able to edit schedule. |
| Retention enforcement | Already runs at end of `spawnScheduledSession`; will still run after a manual trigger. No change needed. |
| Audit | Add a structured `console.log` line including `triggered_manually: true, triggered_by: <userId>` so ops can grep. The session row already carries `scheduled_from_worktree: true`; add a `triggered_manually: true` marker on `custom_context.scheduled_run` (same JSON field already used for snapshot data) — no schema migration. |

---

## 5. UI change list

**New/modified components:**
1. `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx` — add
   `ThunderboltOutlined` button between Terminal and Edit, gated by
   `schedule_enabled && schedule_cron && prompt_template && canAll`. Hooks
   into a new prop `onExecuteScheduleNow(worktreeId)`.
2. `apps/agor-ui/src/components/WorktreeModal/tabs/ScheduleTab.tsx` — add a
   secondary "Run now" button next to the Save/Close footer, same handler.
   Show a small info callout: "Runs the schedule immediately using the
   current saved config."
3. New hook `apps/agor-ui/src/hooks/useExecuteScheduleNow.ts` — wraps the
   Feathers call, handles toast on success/error, and optimistic button
   lock (disable for 3s).
4. Wire `onExecuteScheduleNow` from whatever parent passes `onOpenSettings`
   to `WorktreeCard` (board view container) down to the card.

**No new types needed** — session payload already exists; the hook just
returns `{ session_id }` and we navigate/open the session panel on success
(reuse existing "focus session" behavior after session creation).

---

## 6. Test plan

**Backend unit tests** (`apps/agor-daemon/src/services/scheduler.test.ts` or
new `scheduler.execute-now.test.ts`):
- Happy path: enabled schedule → manual trigger → session created with
  `scheduled_from_worktree=true` and `custom_context.scheduled_run.triggered_manually=true`.
- Disabled schedule → 400.
- Missing cron / missing template → 400.
- Two rapid manual triggers in same minute → dedup, same session returned.
- Manual trigger + cron-due in same tick → dedup.
- Creator missing / no `unix_username` in strict mode → 409 with existing
  error.

**Authorization tests** (reuse `worktree-authorization.test.ts` pattern):
- `all` owner: allowed.
- `others_can=all` non-owner: allowed.
- `others_can=prompt` non-owner: denied.
- `others_can=session` non-owner: denied.
- RBAC disabled: only role check applies.

**UI tests** (Storybook or RTL component tests):
- Button hidden when `schedule_enabled=false`.
- Button disabled w/ tooltip when cron or template missing.
- Button disabled after click for 3s.
- Toast + navigation on success; toast on error.

**Manual QA:**
- Enable a cron that runs in 5 min, click Execute Now, verify a session
  spawns immediately AND the 5-min cron run still fires and is distinct.
- Click twice in the same minute → exactly one session.
- Flip RBAC modes (simple → insulated → strict) and re-verify.

---

## 7. Work breakdown

**PR 1 (this feature — single PR):**
- Scheduler refactor (extract `runSchedule` helper, add
  `executeScheduleNow` public method).
- New endpoint + hooks + RBAC check.
- Card button + ScheduleTab "Run now" button + hook.
- Tests above.

**Follow-ups (not in this PR):**
- (F1) Dedicated audit-log table for scheduler events (both manual and
  cron). Today it's stdout only; worth promoting once we have two triggers.
- (F2) Optional "running-now" indicator on the card if a
  `scheduled_from_worktree` session is active, so users get visual
  feedback without having to open the session panel.
- (F3) Optional `prompt_override` / `context_override` fields on the
  endpoint for ad-hoc runs. Defer until someone actually asks — YAGNI.
- (F4) Reconcile the "allow concurrent runs?" question across scheduler
  and execute-now. If product wants "one at a time," change it in the
  scheduler path too, so both paths agree.

---

## Summary for reviewer

- **Placement:** WorktreeCard header button (primary) + ScheduleTab footer
  button (secondary). Reject the issue's "only inside the drawer" framing.
- **Endpoint:** `POST /worktrees/:worktree_id/execute-schedule-now`, not
  session-scoped. Reuses the scheduler's exact code path via a shared
  helper so cron and manual triggers are indistinguishable downstream.
- **Auth:** tier `all` (matches schedule-edit).
- **Dedup:** minute-rounded `scheduled_run_at` already handles
  double-clicks and manual-vs-cron collisions.
- **Known product question:** the issue says "block if session already
  running"; scheduler does not block today. Recommend we keep behavior
  consistent (don't block) unless product wants both paths changed.
