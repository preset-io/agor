# Schedules as First-Class CRUD — Design Doc

**Status:** Open questions resolved 2026-05-24 — ready for implementation
**Author:** Max (proposal) + Claude (write-up)
**Date:** 2026-05-24
**Related PRs:** #1246 (global search), #1251 (reconnection), #1252 (daemon HA)

---

## 1. TL;DR

Promote schedules from a one-per-branch blob of columns on `branches` into a first-class `schedules` table with full CRUD, a list-of-runs view, and a per-schedule timezone mode (`local` / `utc`). The current design forces agents to write artifact-checking logic to fake "hourly + daily" coexistence, and bakes UTC-only semantics into a JSON `timezone` field that is _stored but never honored_. The proposed model is:

- **`schedules`** table — UUIDv7 PK, FK to `branches(branch_id) ON DELETE CASCADE`, plus `name`, `cron_expression`, `timezone_mode` (`local`/`utc`), `timezone` (IANA, when mode=local), `prompt`, `agentic_tool_config` (jsonb), `enabled`, `last_run_at`, `last_run_session_id`, `next_run_at`, audit columns.
- **Runs = sessions** — no separate `runs` table. Sessions already carry `scheduled_run_at` + `scheduled_from_branch`. Rename the marker FK to `schedule_id` (nullable; null for ad-hoc sessions) and we keep one canonical "open the run" path.
- **Scheduler** keeps the 30s ticker + 2min grace window — but the hot-path query becomes a real indexed `WHERE enabled = true AND next_run_at <= ?` over `schedules`, replacing today's "load every branch, filter in memory" scan ([`scheduler.ts:214`](../../apps/agor-daemon/src/services/scheduler.ts#L214)).
- **Migration** is a single PR: add `schedules`, backfill existing enabled schedules with `timezone_mode='utc'`, ship UI, and drop the four `schedule_*` columns + `data.schedule` JSON blob from `branches` in the same migration. (Per Max — no PR stacking.)
- **Modal** rewrite — **prompt textarea up top**, compact agent picker, advanced settings collapsed. Add IANA tz dropdown only when `mode=local`.
- **RBAC:** the schedules service reuses the branch-tier helpers that sessions already uses (`ensureBranchPermission`, `loadBranch`, `injectCreatedBy`, etc. — see §4.4). Tier requirements mirror sessions: `view` to list/get, `session` to create, `session`-for-own / `all`-for-others to patch, `all` to delete, `prompt`-or-own-`session` to `run_now`. Same `config.execution.branch_rbac` feature flag. One new helper: `scopeScheduleQuery` (SQL-JOIN find filter).
- **Cross-cutting:** HA design ([#1252](https://github.com/preset-io/agor/pull/1252)) wants Postgres advisory locks around the tick — first-class schedules makes the locked region per-schedule instead of per-tick, which is the right scaling shape anyway.

Recommended data-model shape (one paragraph): a `schedules` row owns its own cron, timezone-mode, prompt, agentic-tool config, and enabled flag; `(enabled, next_run_at)` index drives the scheduler; sessions get a nullable `schedule_id` FK so "click a run, open the session" is one join; multiple schedules per branch fall out for free.

---

## 2. The current pain (concrete)

### 2a. One schedule per branch forces artifact-juggling

Today `branches.schedule_*` columns ([`schema.sqlite.ts:586-589`](../../packages/core/src/db/schema.sqlite.ts#L586-L589)) hold a single cron expression and a single `schedule` JSON config ([`schema.sqlite.ts:689-709`](../../packages/core/src/db/schema.sqlite.ts#L689-L709)). If a user wants "hourly status check + daily summary + weekly retrospective" on the same branch, the only solution is one cron that fires every hour and an agent that reads file timestamps to decide which mode it's in. That's the kind of glue that makes a scheduler feel half-built.

### 2b. The `timezone` field is a lie

`BranchScheduleConfig.timezone` is defined ([`branch.ts:473-566`](../../packages/core/src/types/branch.ts#L473-L566)) and the UI shows a timezone-related caveat, but the actual cron parsing is hardcoded to UTC in every callsite — six of them ([`cron.ts:21,39,85,105,130,158`](../../packages/core/src/utils/cron.ts#L21)). The UI writes `timezone: 'UTC'` on save ([`ScheduleTab.tsx:122`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L122)) and warns "All cron expressions are evaluated in UTC" ([`ScheduleTab.tsx:195`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L195)). So the stored field is dead code that pretends to be configuration — confusing to anyone who finds it.

### 2c. Modal field ordering buries the most important field

Current order ([`ScheduleTab.tsx:163-388`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L163-L388)):

1. Enable switch
2. Cron picker (huge react-js-cron widget)
3. Agent selection grid
4. Advanced agent settings (collapsed)
5. **Prompt template** ← the thing that actually decides what the agent does
6. Retention
7. Concurrency

Prompt belongs near the top; the cron + agent config are configuration _of_ the prompt's invocation.

### 2d. Scheduler hot path is O(N) per tick over all branches

`getEnabledSchedules()` calls `branchRepo.findAll({ includeArchived: false })` and filters in JS ([`scheduler.ts:212-220`](../../apps/agor-daemon/src/services/scheduler.ts#L212-L220)). Deduplication and retention each call `sessionRepo.findAll()` and filter in JS too ([`scheduler.ts:439-441,675-677`](../../apps/agor-daemon/src/services/scheduler.ts#L439-L441)). On a single-user instance this is fine; on a shared deployment with 1000 branches and 50K sessions this is three full table scans every 30 seconds. Indexes exist on `branches.schedule_enabled` ([`schema.sqlite.ts:723`](../../packages/core/src/db/schema.sqlite.ts#L723)) but they're not actually consulted by the in-memory filter path.

### 2e. The "schedule" config lives inside `branches.data` JSON

The 11-field schedule object is a key in the `branches.data` JSON blob ([`schema.sqlite.ts:689-709`](../../packages/core/src/db/schema.sqlite.ts#L689-L709)). To read schedule config the scheduler loads the entire branch row. To migrate it out we need `json_extract` on SQLite / `->'schedule'` on Postgres — backfill is non-trivial but tractable. Called out in §5.

### 2f. No CRUD surface

There is no `/schedules` REST endpoint, no `agor_schedules_*` MCP tool, no CLI command. All schedule lifecycle is performed via `PATCH /branches/:id` with the four columns + nested JSON. The only schedule-shaped affordance is `POST /branches/:id/execute-schedule-now` ([`register-routes.ts:2866`](../../apps/agor-daemon/src/register-routes.ts#L2866)) which is a "fire the (single) schedule" verb, not CRUD.

### 2g. Critical review of what works

Not everything is wrong — keep these:

- **Sessions-as-runs** is right. Don't introduce a runs table; sessions already carry the marker fields ([`session.ts:362,370`](../../packages/core/src/types/session.ts#L362)) and the UI already filters by `scheduled_from_branch` ([`BranchCard.tsx:301`](../../apps/agor-ui/src/components/BranchCard/BranchCard.tsx#L301)).
- **`scheduled_run_at` as minute-rounded dedup key** ([`scheduler.ts:318`](../../apps/agor-daemon/src/services/scheduler.ts#L318), [`cron.ts:214`](../../packages/core/src/utils/cron.ts#L214)) is clean. Keep the rule.
- **`allow_concurrent_runs` with cron=silent-skip, manual=409** ([`scheduler.ts:449-470`](../../apps/agor-daemon/src/services/scheduler.ts#L449-L470)) is right; promote the field to a column.
- **Smart recovery (no catchup, 2min grace window)** ([`scheduler.ts:114, 232-258`](../../apps/agor-daemon/src/services/scheduler.ts#L114)) is the right default. Document it.
- **`humanizeCron` + `CRON_PRESETS`** already exist ([`cron.ts:60, 178-203`](../../packages/core/src/utils/cron.ts#L60)). Reuse.

---

## 3. Investigation findings

All file:line cites point to the head of `main` at `2ed5cefd` (this branch's base, post the Worktree→Branch rename in #1250). Throughout this doc, the user-facing concept is **Branch**, the table is `branches`, the FK is `branch_id`. Schedule column names themselves are unchanged by the rename — they live on `branches.schedule_*`.

### 3.1 Schema columns on `branches`

| Column                       | Type (SQLite)                | Type (Postgres)                  | Source                                                                                                                                                      |
| ---------------------------- | ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule_enabled`           | `int NOT NULL DEFAULT false` | `boolean NOT NULL DEFAULT false` | [`schema.sqlite.ts:586`](../../packages/core/src/db/schema.sqlite.ts#L586) / [`schema.postgres.ts:580`](../../packages/core/src/db/schema.postgres.ts#L580) |
| `schedule_cron`              | `text NULL`                  | `text NULL`                      | `:587` / `:581`                                                                                                                                             |
| `schedule_last_triggered_at` | `integer NULL` (ms)          | `bigint NULL` (ms)               | `:588` / `:582`                                                                                                                                             |
| `schedule_next_run_at`       | `integer NULL` (ms)          | `bigint NULL` (ms)               | `:589` / `:583`                                                                                                                                             |

Plus indexes [`schema.sqlite.ts:723-726`](../../packages/core/src/db/schema.sqlite.ts#L723-L726):

```ts
scheduleEnabledIdx: index('branches_schedule_enabled_idx').on(table.schedule_enabled),
boardScheduleIdx:   index('branches_board_schedule_idx').on(table.board_id, table.schedule_enabled),
```

Plus the JSON `schedule` blob nested inside `branches.data` ([`schema.sqlite.ts:689-709`](../../packages/core/src/db/schema.sqlite.ts#L689-L709)):

```ts
schedule?: {
  timezone: string;                  // STORED BUT IGNORED — see 2b
  prompt_template: string;
  agentic_tool: 'claude-code'|'claude-code-cli'|'codex'|'gemini'|'opencode'|'copilot';
  retention: number;
  permission_mode?: string;
  model_config?: { mode: 'default'|'custom'; model?: string };
  mcp_server_ids?: string[];
  context_files?: string[];
  created_at: number;
  created_by: string;
  allow_concurrent_runs?: boolean;   // branch.ts:524 only — schema doesn't restate
};
```

### 3.2 Scheduler implementation

[`apps/agor-daemon/src/services/scheduler.ts`](../../apps/agor-daemon/src/services/scheduler.ts) — single file, ~700 lines.

| Concern             | Where                                                                       | Notes                                                                                                               |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Tick interval       | [`:113`](../../apps/agor-daemon/src/services/scheduler.ts#L113)             | `30_000ms`, configurable                                                                                            |
| Grace window        | [`:114`](../../apps/agor-daemon/src/services/scheduler.ts#L114)             | `120_000ms`; "fire most recent missed run, no backfill"                                                             |
| `setInterval` start | [`:142`](../../apps/agor-daemon/src/services/scheduler.ts#L142)             | This is the line [#1252 §HA](https://github.com/preset-io/agor/pull/1252) wants wrapped in a Postgres advisory lock |
| Due query           | [`:212-220`](../../apps/agor-daemon/src/services/scheduler.ts#L212-L220)    | `findAll().filter(enabled)` — in-memory                                                                             |
| Cron parser         | [`cron.ts:8`](../../packages/core/src/utils/cron.ts#L8)                     | `cron-parser` v5                                                                                                    |
| Cron tz             | [`cron.ts:21,39,85,105,130,158`](../../packages/core/src/utils/cron.ts#L21) | Hardcoded `'UTC'` everywhere                                                                                        |
| Dedup               | [`:439-441`](../../apps/agor-daemon/src/services/scheduler.ts#L439-L441)    | `findAll()` then `.find(scheduled_run_at === ...)`                                                                  |
| Concurrency guard   | [`:449-470`](../../apps/agor-daemon/src/services/scheduler.ts#L449-L470)    | Cron = silent skip; manual = `ScheduleBusyError` → 409                                                              |
| Spawn               | [`:483-526`](../../apps/agor-daemon/src/services/scheduler.ts#L483-L526)    | Normal `sessions.create()` with markers                                                                             |
| Metadata write-back | [`:644-649`](../../apps/agor-daemon/src/services/scheduler.ts#L644-L649)    | Updates `schedule_last_triggered_at`, `schedule_next_run_at`                                                        |
| Retention           | [`:665-705`](../../apps/agor-daemon/src/services/scheduler.ts#L665-L705)    | `findAll()` then sort DESC by `scheduled_run_at`, slice(N) → delete                                                 |

### 3.3 Session-as-run encoding

Sessions carry two materialized columns ([`schema.sqlite.ts:93-94`](../../packages/core/src/db/schema.sqlite.ts#L93-L94), [`schema.postgres.ts:105-106`](../../packages/core/src/db/schema.postgres.ts#L105-L106)):

- `scheduled_run_at: integer NULL` — minute-rounded ms timestamp, dedup key
- `scheduled_from_branch: int NOT NULL DEFAULT false`

Plus the run metadata blob inside `sessions.data.custom_context.scheduled_run` ([`schema.sqlite.ts:158-167`](../../packages/core/src/db/schema.sqlite.ts#L158-L167)):

```ts
scheduled_run?: {
  rendered_prompt: string;
  run_index: number;
  schedule_config_snapshot?: { cron, timezone, retention };
  // + triggered_manually, triggered_by — set in code, not in schema type
}
```

UI consumes these at:

- [`BranchCard.tsx:301-302`](../../apps/agor-ui/src/components/BranchCard/BranchCard.tsx#L301-L302) — filter + sort scheduled sessions
- [`SessionPanelContent.tsx:305-306`](../../apps/agor-ui/src/components/SessionPanel/SessionPanelContent.tsx#L305-L306) and [`SessionPage.tsx:125-126`](../../apps/agor-ui/src/components/mobile/SessionPage.tsx#L125-L126) — show clock pill

### 3.4 UI

[`apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx) — 388 lines, one component, one form. Field order at `:168-339` (see §2c).

Reusable components:

- `AgentSelectionGrid` with `columns={2}` ([`ScheduleTab.tsx:253-259`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L253-L259)) — this is the "compact agentic tool picker" Max referenced.
- `AgenticToolConfigForm` (collapsed by default at `:264-280`)
- `Cron` from `react-js-cron` ([`ScheduleTab.tsx:24`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L24)) + `cronstrue` for humanization ([`:106`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L106))

### 3.5 Time-zone handling

- All cron evaluation in UTC — see 3.2.
- User-side timezone known **only client-side** (`Intl.DateTimeFormat().resolvedOptions().timeZone` would be the way). No `users.timezone` column.
- The current `BranchScheduleConfig.timezone` field is dead.

### 3.6 Migrations doc

[`context/guides/creating-database-migrations.md`](../../context/guides/creating-database-migrations.md). Procedure (quoted from §Workflow):

1. Edit both `schema.sqlite.ts` and `schema.postgres.ts` in lockstep (rule of thumb at lines 28, 102-109).
2. `pnpm db:generate:sqlite && pnpm db:generate:postgres` from `packages/core` ([`:48-50`](../../context/guides/creating-database-migrations.md#L48-L50)).
3. Review the generated SQL files ([`:52-54`](../../context/guides/creating-database-migrations.md#L52-L54)).
4. `pnpm agor db migrate` against the local DB ([`:56-57`](../../context/guides/creating-database-migrations.md#L56-L57)).
5. Commit schemas + new SQL + `meta/_journal.json` ([`:64-66`](../../context/guides/creating-database-migrations.md#L64-L66)).

Gotchas to honor:

- **Monotonic journal `when`** ([`:88-94`](../../context/guides/creating-database-migrations.md#L88-L94)) — strictly greater than every prior entry, tracked per dialect.
- **No CHECK on enum columns** ([`:96-100`](../../context/guides/creating-database-migrations.md#L96-L100)) — validate at app layer. The `timezone_mode` enum in our proposed schema follows this rule (Drizzle-only enum, no DB CHECK).

Next migration numbers: **`0046`** for SQLite (last is [`0045_rename_worktree_to_branch.sql`](../../packages/core/drizzle/sqlite/0045_rename_worktree_to_branch.sql)), **`0037`** for Postgres (last is [`0036_rename_worktree_to_branch.sql`](../../packages/core/drizzle/postgres/0036_rename_worktree_to_branch.sql)). Existing migrations show the project's style — short SQL files, design-doc reference in the SQL header comment, app-layer enum validation, no DB CHECK constraints.

### 3.7 Backwards-compat surface

Schedule-bearing rows today are extremely few (one per branch, opt-in). Estimating production count requires DB access we don't have here, but the **upper bound** is `SELECT COUNT(*) FROM branches WHERE schedule_enabled = true` — typically a handful per instance. Backfill is small.

Field mapping (current → proposed):

| Current (on `branches`)                                                                                | Proposed (on `schedules`)                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `schedule_enabled`                                                                                     | `enabled`                                                              |
| `schedule_cron`                                                                                        | `cron_expression`                                                      |
| `schedule_last_triggered_at`                                                                           | `last_run_at`                                                          |
| `schedule_next_run_at`                                                                                 | `next_run_at`                                                          |
| `data.schedule.prompt_template`                                                                        | `prompt`                                                               |
| `data.schedule.agentic_tool` + `permission_mode` + `model_config` + `mcp_server_ids` + `context_files` | `agentic_tool_config` (jsonb)                                          |
| `data.schedule.timezone` (was unused)                                                                  | dropped (we'll set `timezone_mode='utc'` to preserve current behavior) |
| `data.schedule.retention`                                                                              | `retention`                                                            |
| `data.schedule.allow_concurrent_runs`                                                                  | `allow_concurrent_runs`                                                |
| `data.schedule.created_at` / `created_by`                                                              | standard audit columns                                                 |

---

## 4. Data model proposal

### 4.1 The table

```sql
-- SQLite dialect (Postgres mirror in §5)
CREATE TABLE schedules (
  schedule_id           text PRIMARY KEY,                              -- UUIDv7
  branch_id             text NOT NULL REFERENCES branches(branch_id) ON DELETE CASCADE,

  name                  text NOT NULL,                                 -- "hourly heartbeat"
  description           text,                                          -- nullable, freeform

  cron_expression       text NOT NULL,
  timezone_mode         text NOT NULL DEFAULT 'local',                 -- enum: 'local' | 'utc' (app-validated)
  timezone              text,                                          -- IANA, required when mode='local'

  prompt                text NOT NULL,                                 -- Handlebars template

  agentic_tool_config   text NOT NULL,                                 -- jsonb on PG; see §4.2

  enabled               int NOT NULL DEFAULT 1,                        -- boolean
  allow_concurrent_runs int NOT NULL DEFAULT 0,                        -- boolean
  retention             int NOT NULL DEFAULT 5,                        -- 0 = keep all

  last_run_at           integer,                                       -- ms; updated by scheduler
  last_run_session_id   text REFERENCES sessions(session_id) ON DELETE SET NULL,
  next_run_at           integer,                                       -- ms; denormalized for scheduler

  created_at            integer NOT NULL,
  updated_at            integer NOT NULL,
  created_by            text NOT NULL REFERENCES users(user_id),

  -- Indexes
  -- scheduler hot path: WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at
  CHECK (1)             -- placeholder; real indexes below
);

CREATE INDEX schedules_enabled_next_run_idx ON schedules(enabled, next_run_at);
CREATE INDEX schedules_branch_idx          ON schedules(branch_id);
CREATE INDEX schedules_created_by_idx      ON schedules(created_by);
```

Plus one column on `sessions` to backlink runs:

```sql
ALTER TABLE sessions ADD COLUMN schedule_id text REFERENCES schedules(schedule_id) ON DELETE SET NULL;
-- Partial unique index: covering for the scheduler's dedup lookup AND
-- the DB-level guard against check-then-create races inside spawn.
-- Predicate requires BOTH columns non-null — the logical dedup key is
-- only meaningful when both are present; ad-hoc sessions (NULL
-- schedule_id) must coexist freely.
CREATE UNIQUE INDEX sessions_schedule_run_unique ON sessions(schedule_id, scheduled_run_at)
  WHERE schedule_id IS NOT NULL AND scheduled_run_at IS NOT NULL;
```

### 4.2 Field-by-field defense

**`schedule_id`** — UUIDv7 to match every other primary key in the project ([`schema.sqlite.ts`](../../packages/core/src/db/schema.sqlite.ts)). Short-ID resolution at the API boundary uses the existing `resolveShortId` hook (CLAUDE.md glossary).

**`branch_id`** — required FK. A schedule without a branch is meaningless (it needs a working directory, env, and creator). `ON DELETE CASCADE` because archiving the branch (the existing `archived: bool` flag at [`schema.sqlite.ts:597`](../../packages/core/src/db/schema.sqlite.ts#L597)) and tombstone-deleting it should take its schedules with it.

**`name`** + **`description`** — user-facing labels. The list view (§6a) sorts by name. Description is freeform notes for "what this schedule is supposed to do."

**`cron_expression`** — required. We considered making it optional ("disabled draft") but Drizzle/Zod can enforce non-null + `isValidCron` ([`cron.ts:17`](../../packages/core/src/utils/cron.ts#L17)) at the app layer. Drafts can use `enabled=false`.

**`timezone_mode`** — `local` | `utc`. Enum validated at app layer (no DB CHECK, per §3.6 gotcha). Default **`local`** (confirmed with Max) because users think in their own time. Existing schedules backfill to `'utc'` to preserve current scheduler behavior — see §5.

**`timezone`** — IANA, e.g. `'America/Los_Angeles'`. Required when `mode='local'`, ignored when `mode='utc'`. App-layer validation rejects an unknown IANA name. We do **not** add `users.timezone` in this PR — the modal seeds with `Intl.DateTimeFormat().resolvedOptions().timeZone` and the user can change it. Adding a user preference is a future increment that doesn't block this design.

**`prompt`** — the Handlebars template. Required. Moved to its own column (out of jsonb) because it's the primary field, the largest free-text input, and the thing users edit most.

**`agentic_tool_config`** — jsonb (Postgres) / text (SQLite). Mirrors the current `BranchScheduleConfig` minus the fields we promoted to columns: `{ agentic_tool, permission_mode?, model_config?, mcp_server_ids?, context_files? }`. Justification: these change together (the model picker affects the permission picker affects MCP attach behavior), they're a unit, and they don't drive any query.

**`enabled`** — boolean. Default `true` (new schedules are typically created on intent). The `(enabled, next_run_at)` index makes "find due schedules" indexed.

**`allow_concurrent_runs`** — promoted from the JSON blob ([`branch.ts:524`](../../packages/core/src/types/branch.ts#L524)). Default `false` (block). Behavior unchanged from today ([`scheduler.ts:449-470`](../../apps/agor-daemon/src/services/scheduler.ts#L449-L470)) — cron silently skips, manual returns 409.

**`retention`** — number of run sessions to keep. `0 = keep all`. Same semantics as today ([`scheduler.ts:665-705`](../../apps/agor-daemon/src/services/scheduler.ts#L665-L705)) but per-schedule, not per-branch.

**`last_run_at` / `last_run_session_id`** — denormalized so the list view doesn't need a subquery per row. `last_run_session_id` lets the UI render "last run" as a clickable link without joining. `ON DELETE SET NULL` so retention-deleted sessions don't dangle.

**`next_run_at`** — denormalized so the scheduler's hot path is a single indexed query. Computed via `getNextRunTime()` after each fire (mirrors today's [`scheduler.ts:644`](../../apps/agor-daemon/src/services/scheduler.ts#L644)) and on enable / config change.

**Audit columns** — `created_at`, `updated_at`, `created_by`. `created_by` is the schedule's owner; the scheduler resolves their `unix_username` for execution (same path as today's [`scheduler.ts:349-386`](../../apps/agor-daemon/src/services/scheduler.ts#L349-L386), keyed on the schedule's owner instead of the branch's).

### 4.3 Open decisions, recommended

**Q: Should runs be a separate `schedule_runs` table?**
**Recommended: No.** Use `sessions` with a nullable `schedule_id` FK.

Reasoning: A "run" today already _is_ a session — it has messages, status, env, an executor, MCP servers, the whole apparatus. The marker columns already exist ([`session.ts:362,370`](../../packages/core/src/types/session.ts#L362-L370)) and the UI already filters by them ([`BranchCard.tsx:301`](../../apps/agor-ui/src/components/BranchCard/BranchCard.tsx#L301)). A separate runs table would either (a) duplicate everything, or (b) be a join table that adds nothing the FK doesn't. Adding `sessions.schedule_id` is one column and gives us cheap "runs of this schedule" via index. Keep `scheduled_from_branch`/`scheduled_run_at` for dedup and back-compat; `schedule_id` is the new canonical link.

Alternatives considered:

1. Dedicated `schedule_runs` table that pairs `(schedule_id, session_id, scheduled_for, dedup_key)` — pure relational, but doubles the write path and gives us nothing the FK doesn't.
2. JSON array on `schedules` of `{session_id, scheduled_at}` — terrible for retention queries, ignore.

**Q: Concurrency — if a previous run is still going, do we skip / queue / kill / parallel?**
**Recommended: Skip (current behavior), opt-in to parallel via `allow_concurrent_runs`.**

Reasoning: Today's behavior is correct ([`scheduler.ts:449-470`](../../apps/agor-daemon/src/services/scheduler.ts#L449-L470)) — agents touching the same branch can step on each other. Queueing is Temporal-shaped and complex; killing is destructive; parallel is the opt-in escape hatch that already exists. No change.

Alternatives:

1. Add `'queue'` as a third mode — schedule advances `next_run_at`, the missed firing goes onto the existing per-session task queue ([`task-queueing.md`](../../context/concepts/task-queueing.md)). Reasonable V2 if users ask.
2. Add `'kill_previous'` for "always run the latest" semantics. Probably too sharp; V2 at earliest.

**Q: Catchup — if the daemon was down and missed N firings, fire them all on restart?**
**Recommended: No (preserve current behavior), document explicitly.**

Reasoning: The current scheduler ([`scheduler.ts:232-258`](../../apps/agor-daemon/src/services/scheduler.ts#L232-L258)) intentionally fires only the most recent missed run within the 2min grace window. That's the right default — agents doing real work shouldn't get a flood of identical prompts because the daemon was down for a deploy. Airflow's `catchup=False` is the same default and the consensus right one. Make it explicit in the docs + schedule modal copy.

Alternative: per-schedule `catchup_policy: 'latest_only' | 'none'`. **Don't add yet** — `latest_only` matches today and is the safe default; adding the field invites confusion before we have a single user asking for the alternative.

**Q: MCP tool surface — discrete CRUD verbs or upsert?**
**Decided: standard CRUD, six tools.**

```
agor_schedules_list      (branchId? boardId? createdBy? enabled?)
agor_schedules_get       (scheduleId)
agor_schedules_create    (branchId, name, cron_expression, timezone_mode, timezone?, prompt, agentic_tool_config, ...)
agor_schedules_patch     (scheduleId, partial updates)
agor_schedules_delete    (scheduleId)
agor_schedules_run_now   (scheduleId) → returns session_id
```

Reasoning: every other domain follows this shape (`agor_branches_*`, `agor_sessions_*`, `agor_boards_*`, `agor_cards_*`). The discoverability story is "find the entity, then `_list` / `_get` / `_create` / `_patch` / `_delete`" — `_upsert` is a one-off that breaks the muscle memory. `run_now` is the domain-specific verb that doesn't fit CRUD, same way `agor_sessions_spawn` is a domain-specific verb.

The REST layer follows the same shape automatically because Feathers services give us `/schedules` (list/create), `/schedules/:id` (get/patch/delete), and `/schedules/:id/run-now` (custom verb, mirrors today's `/branches/:id/execute-schedule-now` at [`register-routes.ts:2866`](../../apps/agor-daemon/src/register-routes.ts#L2866)).

**Q: On-failure behavior — retry, pause, mark broken?**
**Recommended: None of the above in V1 — fail loud, surface in the UI, keep scheduling.**

Reasoning: An agent session "failing" is a fuzzy concept (did it error out? finish quickly? return a vague answer?). Auto-retry an agent prompt is a bad default — agents have side effects. Auto-pausing after N consecutive failures is interesting but needs a "failure" definition we don't have. V1: surface the last-run status in the list view (the session's existing `status` column tells us what we need) and let the user disable broken schedules manually. V2 can layer `auto_pause_after_n_failures` if real users ask.

---

### 4.4 RBAC — reuse the branch-tier helpers

The schedules service inherits its access control from the parent branch's RBAC tier (same model as sessions). No new permission system — we wire the **existing** helpers, gated by the same `config.execution.branch_rbac` flag ([`index.ts:567`](../../apps/agor-daemon/src/index.ts#L567), passed through as `branchRbacEnabled`) that gates sessions / tasks.

#### Helpers to reuse

| Helper                                                                       | Source                                                                                                  | What it does                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRANCH_PERMISSION_LEVELS`, `BranchPermissionLevel`                          | [`branch.ts:460,465`](../../packages/core/src/types/branch.ts#L460-L465)                                | Tier enum: `none / view / session / prompt / all`                                                                                            |
| `PERMISSION_RANK`                                                            | [`branch-authorization.ts:38-40`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L38-L40)     | Rank map `-1 / 0 / 1 / 2 / 3`                                                                                                                |
| `hasBranchPermission(branch, userId, isOwner, tier, role?, allowSuperadmin)` | [`branch-authorization.ts:59-83`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L59-L83)     | Bool: does user meet the tier? Owners and superadmins → always `all`.                                                                        |
| `resolveBranchPermission(...)`                                               | [`branch-authorization.ts:96-111`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L96-L111)   | Returns effective tier for display                                                                                                           |
| `ensureBranchPermission(tier, action?, opts)`                                | [`branch-authorization.ts:194-242`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L194-L242) | Feathers hook; throws `Forbidden`                                                                                                            |
| `loadBranch(repo, idField='branch_id')`                                      | [`branch-authorization.ts:125-180`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L125-L180) | Caches `params.branch` + `params.isBranchOwner` (confirmed against `register-hooks.ts:1679-1680`). Must run before `ensureBranchPermission`. |
| `scopeSessionQuery(sessionRepo, opts)`                                       | [`branch-authorization.ts:380-447`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L380-L447) | SQL-JOIN `find()` filter for sessions; we'll write the schedules analog (see below)                                                          |
| `BranchRepository.isOwner(id, userId)`                                       | [`branches.ts:414-427`](../../packages/core/src/db/repositories/branches.ts#L414-L427)                  | Owner check                                                                                                                                  |
| `injectCreatedBy()`                                                          | [`inject-created-by.ts:24-56`](../../apps/agor-daemon/src/utils/inject-created-by.ts#L24-L56)           | Stamps `created_by` from authenticated user                                                                                                  |
| `requireMinimumRole(role, action?)`                                          | [`authorization.ts:46-51`](../../apps/agor-daemon/src/utils/authorization.ts#L46-L51)                   | Global-role gate (`ROLES.MEMBER` etc.)                                                                                                       |

#### One new helper to add

The existing `scopeSessionQuery` ([`branch-authorization.ts:380-447`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L380-L447)) does a SQL JOIN against `sessions`. We add the same shape for `schedules` — a `scopeScheduleQuery(scheduleRepo, opts)` that calls a new `ScheduleRepository.findAccessibleSchedules(userId)` returning only schedules whose parent branch the user can `view`. The query shape mirrors `SessionRepository.findAccessibleSessions`. Co-locate the new hook in `branch-authorization.ts` next to its siblings.

Reuses existing tables: joins `schedules` → `branches` → checks `branches.created_by = ?` OR `branch_owners.user_id = ?` OR `branches.others_can != 'none'`. Single round-trip.

#### Per-verb tier requirements

Pick the tier that mirrors the **session** equivalent (the schedule represents the intent to spawn a session; same surface area, same risk):

| Schedule verb       | Branch tier                                   | Global role | Rationale                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find` / `list`     | `view` (via `scopeScheduleQuery`)             | (any)       | Same as `sessions.find` ([`register-hooks.ts:1645`](../../apps/agor-daemon/src/register-hooks.ts#L1645)) — read-only list, filtered to what you can see                                                                                                                                                                                                             |
| `get`               | `view`                                        | (any)       | Same as `sessions.get`                                                                                                                                                                                                                                                                                                                                              |
| `create`            | `session`                                     | `MEMBER`    | Creating a schedule _is_ creating a recurring session-creation intent. Matches `sessions.create` at tier `session` via `ensureCanCreateSession` ([`register-hooks.ts:1656-1690`](../../apps/agor-daemon/src/register-hooks.ts#L1656-L1690), helper at [`branch-authorization.ts:1081-1083`](../../apps/agor-daemon/src/utils/branch-authorization.ts#L1081-L1083)). |
| `patch`             | `session` for own schedule, `all` for others' | `MEMBER`    | Same branch logic as sessions ([`register-hooks.ts:1765-1791`](../../apps/agor-daemon/src/register-hooks.ts#L1765-L1791)): "own" check via `schedule.created_by === userId`.                                                                                                                                                                                        |
| `delete` / `remove` | `all`                                         | `MEMBER`    | Destructive; matches `sessions.remove` ([`register-hooks.ts:1810-1817`](../../apps/agor-daemon/src/register-hooks.ts#L1810-L1817)).                                                                                                                                                                                                                                 |
| `run_now`           | `all`                                         | `MEMBER`    | Preserves today's behavior (`execute-schedule-now` requires `'all'` at [`register-routes.ts:2928`](../../apps/agor-daemon/src/register-routes.ts#L2928)). Max chose to keep this restrictive — running a schedule on-demand has the same blast radius as editing it, so the bar matches the bar to delete it. Revisit in V2 if users hit the friction.              |

RBAC tier requirements are now identical to today (no behavior change vs current `/branches/:id/execute-schedule-now`).

#### Hook wiring (sketch)

```ts
// register-hooks.ts — analogous to sessions block at :1640-1819
app.service('schedules').hooks({
  before: {
    find: [
      requireAuth,
      ...(branchRbacEnabled ? [scopeScheduleQuery(scheduleRepo, superadminOpts)] : []),
    ],
    get: [
      requireAuth,
      ...(branchRbacEnabled
        ? [
            loadBranchFromSchedule(scheduleRepo, branchRepo),
            ensureBranchPermission('view', 'view schedule'),
          ]
        : []),
    ],
    create: [
      requireAuth,
      requireMinimumRole(ROLES.MEMBER, 'create schedules'),
      ...(branchRbacEnabled
        ? [
            loadBranch(branchRepo, 'branch_id'), // reads context.data.branch_id
            ensureBranchPermission('session', 'create schedules', superadminOpts),
          ]
        : []),
      injectCreatedBy(),
      validateScheduleConfig(), // cron valid, prompt non-empty, IANA tz valid
    ],
    patch: [
      requireAuth,
      requireMinimumRole(ROLES.MEMBER),
      ...(branchRbacEnabled
        ? [
            loadScheduleAndBranch(scheduleRepo, branchRepo),
            ensureCanModifySchedule(superadminOpts), // session-tier for own, all-tier for others'
          ]
        : []),
      validateScheduleConfig(),
    ],
    remove: [
      requireAuth,
      requireMinimumRole(ROLES.MEMBER),
      ...(branchRbacEnabled
        ? [
            loadScheduleAndBranch(scheduleRepo, branchRepo),
            ensureBranchPermission('all', 'delete schedule', superadminOpts),
          ]
        : []),
    ],
  },
});

// Custom verb (mirrors /branches/:id/execute-schedule-now at register-routes.ts:2866)
app.use('/schedules/:id/run-now', {
  /* ... */
});
app.service('/schedules/:id/run-now').hooks({
  before: {
    create: [
      requireAuth,
      requireMinimumRole(ROLES.MEMBER, 'run schedule'),
      ...(branchRbacEnabled
        ? [
            loadScheduleAndBranch(scheduleRepo, branchRepo),
            ensureBranchPermission('all', 'run schedule', superadminOpts), // matches today's execute-schedule-now
          ]
        : []),
    ],
  },
});
```

#### Execution identity (carry-over)

The scheduler currently runs scheduled sessions as the **branch's `created_by` user** ([`scheduler.ts:349-386`](../../apps/agor-daemon/src/services/scheduler.ts#L349-L386), via `resolveCreatorUnixUsername`). With first-class schedules, the source of truth becomes `schedules.created_by`. Same `unix_username` resolution logic, just keyed off the new column. No new security flag needed — this matches how the legacy `dangerously_allow_session_sharing` story already works for spawned sessions ([`schema.sqlite.ts:682`](../../packages/core/src/db/schema.sqlite.ts#L682)).

---

## 5. Migration plan

Single PR (Max: no PR stacking). One SQLite migration, one Postgres migration: create `schedules`, backfill from `branches`, drop the four old columns + the `data.schedule` blob in the same file. SQLite gets one table recreation for `branches` (Drizzle's `__new_branches` dance); Postgres gets four `DROP COLUMN`s. Net schema delta on `branches`: -4 cols + a smaller `data` JSON. Net schema delta on `sessions`: +1 col (`schedule_id`).

### 5.1 SQLite migration

**`packages/core/drizzle/sqlite/0046_schedules_table.sql`:**

```sql
-- First-class schedules table. Design doc:
-- docs/internal/schedules-first-class-design-2026-05-24.md
--
-- No CHECK constraint on timezone_mode per
-- context/guides/creating-database-migrations.md §"Avoid CHECK constraints
-- for enum-like columns on SQLite". Enum validated at app layer.

CREATE TABLE `schedules` (
  `schedule_id`           text PRIMARY KEY NOT NULL,
  `branch_id`             text NOT NULL,
  `name`                  text NOT NULL,
  `description`           text,
  `cron_expression`       text NOT NULL,
  `timezone_mode`         text NOT NULL DEFAULT 'local',
  `timezone`              text,
  `prompt`                text NOT NULL,
  `agentic_tool_config`   text NOT NULL,
  `enabled`               integer NOT NULL DEFAULT 1,
  `allow_concurrent_runs` integer NOT NULL DEFAULT 0,
  `retention`             integer NOT NULL DEFAULT 5,
  `last_run_at`           integer,
  `last_run_session_id`   text,
  `next_run_at`           integer,
  `created_at`            integer NOT NULL,
  `updated_at`            integer NOT NULL,
  `created_by`            text NOT NULL,
  FOREIGN KEY (`branch_id`)           REFERENCES `branches`(`branch_id`)   ON DELETE CASCADE,
  FOREIGN KEY (`last_run_session_id`) REFERENCES `sessions`(`session_id`)   ON DELETE SET NULL,
  FOREIGN KEY (`created_by`)          REFERENCES `users`(`user_id`)
);--> statement-breakpoint

CREATE INDEX `schedules_enabled_next_run_idx` ON `schedules`(`enabled`, `next_run_at`);--> statement-breakpoint
CREATE INDEX `schedules_branch_idx`           ON `schedules`(`branch_id`);--> statement-breakpoint
CREATE INDEX `schedules_created_by_idx`       ON `schedules`(`created_by`);--> statement-breakpoint

ALTER TABLE `sessions` ADD COLUMN `schedule_id` text REFERENCES `schedules`(`schedule_id`) ON DELETE SET NULL;--> statement-breakpoint
-- Partial unique index: dedup lookup + DB-level race guard.
CREATE UNIQUE INDEX `sessions_schedule_run_unique` ON `sessions`(`schedule_id`, `scheduled_run_at`)
WHERE `schedule_id` IS NOT NULL AND `scheduled_run_at` IS NOT NULL;--> statement-breakpoint

-- Backfill: one row per branch with an enabled+configured schedule.
-- Skip rows where the cron or the data.schedule blob is missing
-- (these are 'half-configured' states that never fire today — see §5b).
-- timezone_mode='utc' preserves current behavior.
INSERT INTO schedules (
  schedule_id, branch_id, name, cron_expression,
  timezone_mode, timezone, prompt, agentic_tool_config,
  enabled, allow_concurrent_runs, retention,
  last_run_at, next_run_at,
  created_at, updated_at, created_by
)
SELECT
  -- UUIDv7 deterministic-ish from branch_id; alternative: app-side backfill script
  lower(hex(randomblob(16))),
  b.branch_id,
  'Default',
  b.schedule_cron,
  'utc',
  NULL,
  json_extract(b.data, '$.schedule.prompt_template'),
  json_object(
    'agentic_tool',     json_extract(b.data, '$.schedule.agentic_tool'),
    'permission_mode',  json_extract(b.data, '$.schedule.permission_mode'),
    'model_config',     json_extract(b.data, '$.schedule.model_config'),
    'mcp_server_ids',   json_extract(b.data, '$.schedule.mcp_server_ids'),
    'context_files',    json_extract(b.data, '$.schedule.context_files')
  ),
  b.schedule_enabled,
  COALESCE(json_extract(b.data, '$.schedule.allow_concurrent_runs'), 0),
  COALESCE(json_extract(b.data, '$.schedule.retention'), 5),
  b.schedule_last_triggered_at,
  b.schedule_next_run_at,
  COALESCE(json_extract(b.data, '$.schedule.created_at'), b.created_at),
  b.updated_at,
  COALESCE(json_extract(b.data, '$.schedule.created_by'), b.created_by)
FROM branches b
WHERE b.schedule_cron IS NOT NULL
  AND json_extract(b.data, '$.schedule.prompt_template') IS NOT NULL;--> statement-breakpoint

-- Backfill: link existing scheduled sessions to their schedule.
-- Each branch has at most one schedule today, so the mapping is unambiguous.
UPDATE sessions
SET schedule_id = (
  SELECT s.schedule_id FROM schedules s WHERE s.branch_id = sessions.branch_id
)
WHERE sessions.scheduled_from_branch = 1
  AND sessions.branch_id IN (SELECT branch_id FROM schedules);--> statement-breakpoint

-- Drop the old materialized columns from `branches`. SQLite recreates the
-- table (the `__new_branches` dance) — review the generated INSERT carefully
-- per context/guides/creating-database-migrations.md §"Removing columns".
--
-- Drizzle generates this automatically when the schema.sqlite.ts file removes
-- the four columns. Shown here for documentation; do not hand-write.
ALTER TABLE `branches` DROP COLUMN `schedule_enabled`;--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `schedule_cron`;--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `schedule_last_triggered_at`;--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `schedule_next_run_at`;--> statement-breakpoint
DROP INDEX `branches_schedule_enabled_idx`;--> statement-breakpoint
DROP INDEX `branches_board_schedule_idx`;--> statement-breakpoint

-- Remove the schedule key from the data JSON. SQLite 3.38+ supports json_remove.
UPDATE branches SET data = json_remove(data, '$.schedule') WHERE json_extract(data, '$.schedule') IS NOT NULL;
```

### 5.2 Postgres migration

**`packages/core/drizzle/postgres/0037_schedules_table.sql`:**

```sql
-- (Same header comment.)

CREATE TABLE "schedules" (
  "schedule_id"           text PRIMARY KEY NOT NULL,
  "branch_id"             text NOT NULL REFERENCES "branches"("branch_id") ON DELETE CASCADE,
  "name"                  text NOT NULL,
  "description"           text,
  "cron_expression"       text NOT NULL,
  "timezone_mode"         text NOT NULL DEFAULT 'local',
  "timezone"              text,
  "prompt"                text NOT NULL,
  "agentic_tool_config"   jsonb NOT NULL,
  "enabled"               boolean NOT NULL DEFAULT true,
  "allow_concurrent_runs" boolean NOT NULL DEFAULT false,
  "retention"             integer NOT NULL DEFAULT 5,
  "last_run_at"           bigint,
  "last_run_session_id"   text REFERENCES "sessions"("session_id") ON DELETE SET NULL,
  "next_run_at"           bigint,
  "created_at"            bigint NOT NULL,
  "updated_at"            bigint NOT NULL,
  "created_by"            text NOT NULL REFERENCES "users"("user_id")
);--> statement-breakpoint

CREATE INDEX "schedules_enabled_next_run_idx" ON "schedules"("enabled", "next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_branch_idx"           ON "schedules"("branch_id");--> statement-breakpoint
CREATE INDEX "schedules_created_by_idx"       ON "schedules"("created_by");--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "schedule_id" text REFERENCES "schedules"("schedule_id") ON DELETE SET NULL;--> statement-breakpoint
-- Partial unique index: dedup lookup + DB-level race guard.
CREATE UNIQUE INDEX "sessions_schedule_run_unique" ON "sessions"("schedule_id", "scheduled_run_at")
WHERE "schedule_id" IS NOT NULL AND "scheduled_run_at" IS NOT NULL;--> statement-breakpoint

-- Backfill (Postgres uses ->/->> for JSON access; the data column is jsonb).
INSERT INTO schedules (
  schedule_id, branch_id, name, cron_expression,
  timezone_mode, timezone, prompt, agentic_tool_config,
  enabled, allow_concurrent_runs, retention,
  last_run_at, next_run_at,
  created_at, updated_at, created_by
)
SELECT
  gen_random_uuid()::text,                           -- PG13+ built-in; UUIDv4 acceptable for backfill
  b.branch_id,
  'Default',
  b.schedule_cron,
  'utc',
  NULL,
  b.data->'schedule'->>'prompt_template',
  jsonb_build_object(
    'agentic_tool',    b.data->'schedule'->>'agentic_tool',
    'permission_mode', b.data->'schedule'->>'permission_mode',
    'model_config',    b.data->'schedule'->'model_config',
    'mcp_server_ids',  b.data->'schedule'->'mcp_server_ids',
    'context_files',   b.data->'schedule'->'context_files'
  ),
  b.schedule_enabled,
  COALESCE((b.data->'schedule'->>'allow_concurrent_runs')::boolean, false),
  COALESCE((b.data->'schedule'->>'retention')::int, 5),
  b.schedule_last_triggered_at,
  b.schedule_next_run_at,
  COALESCE((b.data->'schedule'->>'created_at')::bigint, b.created_at),
  b.updated_at,
  COALESCE(b.data->'schedule'->>'created_by', b.created_by)
FROM branches b
WHERE b.schedule_cron IS NOT NULL
  AND b.data->'schedule'->>'prompt_template' IS NOT NULL;--> statement-breakpoint

UPDATE sessions
SET schedule_id = s.schedule_id
FROM schedules s
WHERE sessions.scheduled_from_branch = true
  AND sessions.branch_id = s.branch_id;--> statement-breakpoint

-- Drop the old materialized columns + indexes.
DROP INDEX IF EXISTS "branches_schedule_enabled_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "branches_board_schedule_idx";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_enabled";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_cron";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_last_triggered_at";--> statement-breakpoint
ALTER TABLE "branches" DROP COLUMN "schedule_next_run_at";--> statement-breakpoint

-- Remove the schedule key from the data jsonb.
UPDATE branches SET data = data - 'schedule' WHERE data ? 'schedule';
```

### 5.3 Single-PR vs split — why this is OK

The migrations doc ([`:79`](../../context/guides/creating-database-migrations.md#L79)) flags column-drops as the riskiest case ("review the recreation SQL carefully"). The risk in a one-shot migration is that backfill failure leaves the old columns gone with no data in the new table. We handle this with:

1. **Backfill INSERT runs before the DROP COLUMN.** If the INSERT fails, the migration aborts before any drop — no data loss.
2. **The migration is wrapped in a transaction** (Drizzle's default for both SQLite and Postgres). All-or-nothing.
3. **Rollback path is the prior commit on `main`** — `pnpm agor db migrate` is forward-only, so if a bug ships we revert the _code_ (which still reads from the new table because we've removed the old paths). Production schema rollback would need a separate "restore from columns" migration written by hand if it ever came to that, but that's true of every destructive migration in the project.

### 5.4 Backfill ambiguity

The current schema allows three "half-configured" states:

| `schedule_enabled` | `schedule_cron` | `data.schedule` | Today's behavior                                                                                                                                        |
| ------------------ | --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`            | any             | any             | Schedule doesn't fire. UI shows current config.                                                                                                         |
| `true`             | `NULL`          | any             | Scheduler short-circuits at [`scheduler.ts:233`](../../apps/agor-daemon/src/services/scheduler.ts#L233); doesn't fire. UI would default to `0 0 * * *`. |
| `true`             | non-null        | `NULL`          | Scheduler throws at `spawnScheduledSession` ([`scheduler.ts:425-431`](../../apps/agor-daemon/src/services/scheduler.ts#L425-L431)) on first tick.       |

**Backfill rule (confirmed with Max):** create a `schedules` row only when both `schedule_cron IS NOT NULL` AND `data.schedule.prompt_template IS NOT NULL`. Half-configured rows are dropped silently — they weren't firing anyway. Disabled-but-configured rows DO backfill (with `enabled=false`) so users don't lose their setup.

Encoded in the WHERE clauses above.

**Going forward**, the API/UI prevents creating an invalid schedule in the first place. Both `cron_expression` and `prompt` are `NOT NULL` at the DB layer; Zod / service hooks reject empty strings and invalid cron expressions (`isValidCron` at [`cron.ts:17`](../../packages/core/src/utils/cron.ts#L17)). The "Save" button stays disabled until both are valid. No new half-configured rows can ever exist post-migration.

### 5.5 Indexes

The hot path is the scheduler tick:

```sql
SELECT schedule_id, branch_id, cron_expression, timezone_mode, timezone,
       prompt, agentic_tool_config, allow_concurrent_runs, retention,
       last_run_at, next_run_at, created_by
FROM schedules
WHERE enabled = true AND (next_run_at IS NULL OR next_run_at <= ?);
```

Index: `schedules_enabled_next_run_idx ON (enabled, next_run_at)`. This replaces today's "load every branch" approach ([`scheduler.ts:212-220`](../../apps/agor-daemon/src/services/scheduler.ts#L212-L220)) with an indexed range scan touching only due schedules.

Secondary: `sessions_schedule_run_unique ON (schedule_id, scheduled_run_at) WHERE schedule_id IS NOT NULL AND scheduled_run_at IS NOT NULL` for two queries — dedup ("does a session already exist for this schedule + scheduled_run_at?") and runs-list ("most recent N sessions for this schedule"). Partial-UNIQUE rather than plain index so the dedup invariant is enforced at the DB layer (closes a check-then-create race in `spawnScheduledSession`).

---

## 6. UX proposal

### 6a. Schedules CRUD list (replaces the Schedule tab)

```
┌─ Schedules ──────────────────────────────────────────[ + New ]┐
│                                                                │
│  Name              │ When         │ Tz │ ● │ Last run     │ Next  │ ⋯ │
│ ───────────────────┼──────────────┼────┼───┼──────────────┼───────┼───│
│  Hourly heartbeat  │ Every hour…  │ LA │ ● │ 14:00 ✓      │ 15:00 │ ⋮ │
│  Daily summary     │ Daily 09:00  │ UT │ ● │ 09:00 ⚠ err  │ 09:00 │ ⋮ │
│  Weekly retro      │ Mon 02:00    │ LA │ ○ │ —            │ —     │ ⋮ │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

- **Header**: title + `+ New` button.
- **Rows**: name | humanized cron (from `humanizeCron` at [`cron.ts:60`](../../packages/core/src/utils/cron.ts#L60)) | tz abbreviation pill | enable toggle (●/○) | last run (clickable → opens session via `last_run_session_id`) | next run | overflow menu (edit / delete / run-now).
- **Empty state**: "No schedules yet. Schedule a prompt to fire on a cadence — hourly heartbeats, daily summaries, weekly retros. `+ New`"
- **Click a row** → opens the runs side panel (§6c).

### 6b. Schedule modal (create/edit)

Order, top to bottom (this is what Max called out):

```
┌─ New schedule ─────────────────────────────────────────────[×]┐
│                                                                │
│  Name *           [ Hourly heartbeat                        ]  │
│  Description      [ optional                                ]  │
│                                                                │
│  ── Prompt ─────────────────────────────────────────────────  │
│  Prompt *                                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Review the current state of {{branch.name}} and post  │  │
│  │ a status update.                                         │  │
│  │                                                          │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│  Handlebars: {{branch.*}}, {{board.*}}, {{schedule.*}}      │
│                                                                │
│  ── When ───────────────────────────────────────────────────  │
│  Cron *           [ 0 * * * *                  ] ⓘ Every hour │
│  Timezone         (●) Local time   ( ) UTC                    │
│                   [ America/Los_Angeles ▼ ]                   │
│                                                                │
│  ── Agent ──────────────────────────────────────────────────  │
│  [ Claude Code ] [ Codex ] [ Gemini ]  ← compact picker       │
│  ▸ Advanced agent settings (permission, model, MCPs, files)  │
│                                                                │
│  ── Advanced ───────────────────────────────────────────────  │
│  ☑ Enabled                                                    │
│  Retention        [ 5  ] sessions  (0 = keep all)             │
│  Concurrency      ( ) Allow concurrent runs  (●) Block        │
│                                                                │
│              [ Cancel ]              [ Save ] [ Save & run ]  │
└────────────────────────────────────────────────────────────────┘
```

Key changes:

1. **Prompt is the top field after the name/description.** Cron and agent are configuration _of_ the prompt invocation.
2. **Cron section is collapsed by default to a single text input + humanized preview.** The full `react-js-cron` widget appears on click of an "edit visually" affordance — it's enormous and takes over the modal. Power users can stay in the text input; new users can expand the picker.
3. **Timezone mode is a radio (`Local` / `UTC`) with the IANA dropdown shown only when `Local`.** The dropdown seeds with `Intl.DateTimeFormat().resolvedOptions().timeZone`. UTC stays available as the unambiguous option for "I want this to fire at the same wall-clock time everywhere."
4. **Agent picker uses the existing 2-column `AgentSelectionGrid`** ([`AgentSelectionGrid`](../../apps/agor-ui/src/components/AgentSelectionGrid)). Advanced agent settings stay collapsed in an `<Collapse>` like today ([`ScheduleTab.tsx:264-280`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L264-L280)).
5. **Advanced** holds the rarely-touched bits: enabled, retention, concurrency. These don't change between sessions — they're set once.
6. **`Save & run`** combines the current two-step "save then click Run now" flow into one button.

### 6c. Runs view (click a schedule row)

Opens a side panel from the right. Shows the last N=20 sessions for the schedule (ordered by `scheduled_run_at` DESC):

```
┌─ Hourly heartbeat — runs ─────────────────────────────────[×]┐
│                                                              │
│  Scheduled       │ Started   │ Status   │ Duration │ ↗      │
│ ─────────────────┼───────────┼──────────┼──────────┼─────── │
│  Today 14:00     │ 14:00:32  │ ● done   │ 1m 12s   │ Open   │
│  Today 13:00     │ 13:00:18  │ ● done   │ 0m 48s   │ Open   │
│  Today 12:00     │ —         │ ⏭ skipped│ —        │ —      │
│  Today 11:00     │ 11:00:08  │ ⚠ error  │ 0m 03s   │ Open   │
│  ...                                                         │
│                                                              │
│             [ View all runs in canvas ]                      │
└──────────────────────────────────────────────────────────────┘
```

"Open" jumps to the session in the canvas — reuses the existing focus pattern that #1246's `?focus=<session_id>` is also building toward (one more reason to land that first or together).

---

## 7. Scheduler efficiency

### 7a. Hot-path query

Today: `findAll() → filter()` in JS for every tick ([`scheduler.ts:212-220`](../../apps/agor-daemon/src/services/scheduler.ts#L212-L220)).
Proposed: `SELECT … FROM schedules WHERE enabled = true AND (next_run_at IS NULL OR next_run_at <= ?)` indexed by `schedules_enabled_next_run_idx`. Touches O(due_schedules), not O(all_branches).

### 7b. Tick interval

Keep 30s — it's the right granularity (cron's minimum is 1min so 30s gives 2 ticks per minute, lets us hit a 2min grace window twice). Configurable via `SchedulerConfig.tickInterval` already ([`scheduler.ts:113`](../../apps/agor-daemon/src/services/scheduler.ts#L113)).

### 7c. Dedup query

Today: `sessionRepo.findAll() → .filter(branch_id) → .find(scheduled_run_at)` ([`scheduler.ts:439-441`](../../apps/agor-daemon/src/services/scheduler.ts#L439-L441)).
Proposed: `SELECT 1 FROM sessions WHERE schedule_id = ? AND scheduled_run_at = ? LIMIT 1` using `sessions_schedule_run_unique`. Indexed lookup.

### 7d. HA / lock semantics (cross-ref #1252)

[#1252](https://github.com/preset-io/agor/pull/1252) §T2 calls for a Postgres advisory lock around the scheduler tick ([`scheduler.ts:142`](../../apps/agor-daemon/src/services/scheduler.ts#L142)). With first-class schedules the right shape is **per-schedule** locking, not per-tick — and we're shipping that in V1.

```ts
// pseudocode — runs once per due schedule, inside the tick loop
const lockKey = hashScheduleId(schedule.schedule_id); // stable bigint
const acquired = await db.execute(sql`SELECT pg_try_advisory_xact_lock(${lockKey})`);
if (!acquired) continue; // another holder is handling this schedule
// spawn session, advance metadata...
// transaction commit auto-releases the lock
```

**Important V1 scope note: Agor is single-daemon today.** The per-schedule lock guards _same-schedule_ duplicate work — useful as forward-positioning if multi-daemon ever lands — but on its own it does NOT preserve the branch-wide `allow_concurrent_runs=false` invariant across daemons. Two daemons could lock two different schedules on the same branch and both pass the branch-level concurrency check. Branch-scoped advisory locking (or a fully serialized scheduler leader) is deferred until multi-daemon is actually supported.

What V1 _does_ protect — even forward into multi-daemon — is duplicate same-schedule runs: a partial unique index `sessions_schedule_run_unique ON (schedule_id, scheduled_run_at) WHERE schedule_id IS NOT NULL AND scheduled_run_at IS NOT NULL` causes the second `(schedule_id, scheduled_run_at)` insert to fail at the DB layer; the scheduler catches the unique-violation as a dedup hit. This guard is dialect-neutral.

**SQLite path:** the advisory-lock attempt is a no-op (`tryAdvisoryXactLock` short-circuits via `isPostgresDatabase`). SQLite is single-node by definition; the unique index alone protects against intra-process check-then-create races between the cron tick and manual run-now paths.

**Coordination with #1252:** that PR's recommended advisory-lock helper lives in `packages/core/src/db/database-wrapper.ts` (`tryAdvisoryXactLock`, `advisoryLockKeyForUuid`) — we built it as part of this work.

---

## 8. Local vs UTC handling

Rules, stated as plainly as possible:

1. **Every schedule has a `timezone_mode` and (when `local`) a `timezone`.**
2. **`mode='utc'`** — cron is evaluated against UTC. `next_run_at` is computed via `getNextRunTime(cron, now, 'UTC')`. Identical to today's behavior. Best for "fire at the same wall-clock time globally" or "I don't want to think about DST."
3. **`mode='local'`** — cron is evaluated against the schedule's IANA timezone via `cron-parser`'s `tz` option ([`cron.ts:83`](../../packages/core/src/utils/cron.ts#L83) — already supports this; just stop hardcoding `'UTC'`). `getNextRunTime` is called with the schedule's `timezone` instead of `'UTC'`. Best for "fire at 9am my time, even across DST."
4. **`next_run_at` is always stored as a UTC Unix-ms timestamp.** The mode/tz only affects how cron is _evaluated_, not how the timestamp is stored. Display layer is responsible for re-rendering in the user's tz.
5. **Display defaults to the viewing user's tz** — UI shows "Today 14:00 PT" not "21:00 UTC" unless the user explicitly sets `mode='utc'`, in which case "21:00 UTC" is correct (that's what they asked for).
6. **Default for new schedules: `local` with the user's browser tz.** Existing schedules backfill to `utc` (preserves behavior).
7. **DST**: cron-parser handles DST correctly when given a real IANA tz. `0 9 * * *` in `America/Los_Angeles` will fire at 9am PT regardless of whether that's UTC-7 or UTC-8. If a daily "9am" falls on the DST jump (the missing 02:00-03:00 hour twice a year), cron-parser skips it forward. Don't try to be cleverer.

Implementation work (out of scope for this doc, listed for clarity):

- Drop the hardcoded `tz: 'UTC'` in [`cron.ts`](../../packages/core/src/utils/cron.ts) and accept a tz argument.
- Scheduler reads `schedules.timezone_mode` + `schedules.timezone`, passes to `getNextRunTime`.
- Modal seeds local-mode tz from `Intl.DateTimeFormat().resolvedOptions().timeZone`.

---

## 9. Comparisons — what we borrow vs not

### Claude Code loops

The `/loop` skill (visible in this session's available-skills list) is the closest analog. Worth borrowing:

- **`/loop 5m /foo`** — interval-based, not cron-based, but the principle is "a prompt fires on a cadence." Agor's cron is more flexible.
- **Self-pacing** ("omit the interval to let the model self-pace") — interesting future feature but adds complexity; **not borrowing for V1.**
- **Sentinel-passing for autonomous loops** (`<<autonomous-loop-dynamic>>`) — Agor's equivalent is the Handlebars template re-rendering each fire. Same idea, different mechanism. **Already have it.**

### Airflow

Max wrote it. Concepts that translate:

- **`catchup=False` as the default** — adopted ([§4.3](#43-open-decisions-recommended)). Airflow's experience is the right argument here.
- **`max_active_runs=1` as the default** — adopted, called `allow_concurrent_runs=false`. Same idea.
- **DAGs / task dependencies / sensors / SLAs** — **not borrowing.** A schedule is a single prompt; no dependencies between schedules in V1. Sensors (poll an external signal) are interesting for V3+ but not needed.
- **Pools** (concurrency caps across schedules) — V3 if anyone asks. Branch boundaries are already a natural pool.

### Temporal

- **Workflow-style retries with exponential backoff** — **not borrowing.** Agent prompts have side effects (commits, comments, deploys); blind retries are dangerous.
- **Schedule API shape (`Schedule.create(spec={cron|interval|calendar})`)** — interesting. Agor sticks to cron for V1 because the field is universally understood; could add `interval` as a sugar in V2.

### Plain cron / systemd timers

- **Cron expressions** — keep using them. `cron-parser` handles 5- and 6-field formats. Users know how to read them.
- **`@hourly`, `@daily`, `@weekly` shortcuts** — already supported by `react-js-cron` ([`ScheduleTab.tsx:221`](../../apps/agor-ui/src/components/BranchModal/tabs/ScheduleTab.tsx#L221)).

### Dagster sensors

- **External-event-driven schedules** — interesting (e.g. "fire on Slack message" / "fire on GitHub webhook"). **Out of scope for this design** but worth pointing out as a V3+ direction; the `schedules` table would just grow a `trigger_type` column.

### Explicitly NOT borrowing (V1)

- DAG of schedules with dependencies
- Sensors / event-driven triggers
- Retries with exponential backoff
- Per-failure auto-pause
- Pools / concurrency groups across schedules
- Schedule "calendars" (Temporal-style date specs)

---

## 10. Phased rollout

**V1 (this PR — one PR, one merge)**

- `schedules` table + `sessions.schedule_id` FK + indexes
- Backfill from `branches.schedule_*` and `data.schedule`
- **Drop** the four `branches.schedule_*` columns + `data.schedule` blob in the same migration (§5.3)
- Schedules CRUD service (Feathers + REST + WebSocket events)
- Branch-tier RBAC wired via existing helpers, gated by `execution.branch_rbac` (§4.4)
- Scheduler reads from `schedules`, honors `timezone_mode`, takes per-schedule `pg_try_advisory_xact_lock` (§7d)
- New modal with prompt-on-top, local-mode default, IANA tz dropdown
- Runs side panel
- 6 MCP tools (§4.3): `agor_schedules_{list,get,create,patch,delete,run_now}`

**V2 (later, if asked)**

- `auto_pause_after_n_failures` if real users hit the foot-gun
- `interval` as a cron alternative for "every 5 minutes"-style schedules
- Optional `users.timezone` preference + UI (modal seeds from browser today; this is a nice-to-have)
- Queue-on-busy as a third concurrency mode

**V3+**

- Trigger types beyond cron (webhooks, file changes, agent-completion events)
- Pools / cross-schedule concurrency caps
- Schedule run history beyond `retention` (separate audit table)

---

## 11. Resolved decisions (from Max)

1. ✅ **Backfill ambiguity** — skip silently AND prevent saving invalid/misconfigured schedules going forward. Encoded as `NOT NULL` on `cron_expression` + `prompt`, plus Zod / service-hook validation. See §5.4.
2. ✅ **Default `timezone_mode = 'local'`.** Backfilled rows get `'utc'` to preserve current behavior. See §4.2.
3. ✅ **Single PR** — no stacking. `schedules` create + backfill + old-column drop all in one migration per dialect, transaction-wrapped. See §5.3.
4. ✅ **MCP tool surface — standard CRUD.** Six tools: `agor_schedules_list`, `agor_schedules_get`, `agor_schedules_create`, `agor_schedules_patch`, `agor_schedules_delete`, `agor_schedules_run_now`. Mirrors `agor_branches_*` / `agor_sessions_*` / `agor_boards_*` conventions. See §4.3.
5. ✅ **Per-schedule Postgres advisory lock in V1.** Cheap (`pg_try_advisory_xact_lock(hash(schedule_id))` per row) and forward-compatible with #1252 HA. SQLite single-node tick stays lock-free. See §7d.

### All RBAC questions resolved (from Max, 2026-05-24)

6. ✅ **`run_now` tier = `'all'`** (matches today's `/branches/:id/execute-schedule-now`). No behavior change vs current. Revisit only if users complain.

Non-blocking follow-ups, called out where they live:

- §6b — the modal mockup uses a wall-of-text wireframe; final visual will land in the implementation PR (no design-level decision pending).
- §12 — the existing `custom_context.scheduled_run.schedule_config_snapshot` blob on sessions should add `schedule_id` to its payload; bookkeeping, not a design question.

---

## 12. Out of scope

- **Multi-branch schedules.** A schedule is bound to exactly one branch (FK). "Fire across all branches on this board" is a different feature.
- **Schedule chaining / dependencies.** No "schedule B fires after schedule A completes" in V1.
- **Run-history beyond retention.** When retention deletes a session, it's gone. Future audit table is a separate design.
- **`users.timezone` user preference.** Modal seeds from the browser; user picks per-schedule. Adding a user pref is an obvious follow-up but isn't load-bearing for this design.
- **Backfill of in-flight scheduled sessions across the migration boundary.** The PR 1 backfill links existing scheduled sessions to their backfilled schedule via `branch_id` (one-to-one today). If any session is mid-flight when the migration runs, it inherits the `schedule_id` correctly.
- **Renaming of the JSON `custom_context.scheduled_run.schedule_config_snapshot`** ([`schema.sqlite.ts:158-167`](../../packages/core/src/db/schema.sqlite.ts#L158-L167)) — left as-is for now; the snapshot semantics still apply but should add `schedule_id` to the snapshot. Bookkeeping for the implementation PR.

---

## Cross-references

- **[#1246 — global search design](https://github.com/preset-io/agor/pull/1246)** — schedules should be a searchable entity in V1 (name + description). Same pattern as branches/sessions/boards in #1246's static registry. Also: that PR's `?focus=<id>` work on SessionCanvas is what "Open in canvas" in the runs view (§6c) would use.
- **[#1251 — reconnection & state refresh](https://github.com/preset-io/agor/pull/1251)** — minor: when the daemon reconnects after a long drop, the schedules list should be in the rehydrate set. No structural overlap.
- **[#1252 — daemon HA](https://github.com/preset-io/agor/pull/1252)** — direct overlap. The recommended Postgres advisory lock around the scheduler tick ([`scheduler.ts:142`](../../apps/agor-daemon/src/services/scheduler.ts#L142)) is per-tick today; first-class schedules unlocks per-schedule locking, which is the right HA shape. See §7d. Coordinate ordering with that work.
