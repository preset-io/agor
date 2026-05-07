# Session drawer improvements — design proposal

**Status:** draft, awaiting Max sign-off before Phase 3 implementation
**Component:** `apps/agor-ui/src/components/WorktreeListDrawer/WorktreeListDrawer.tsx`
**Date:** 2026-05-06

> Note on naming: the file is `WorktreeListDrawer` but it actually renders a flat
> list of **sessions** filtered by the current board. Misnomer, presumably from
> an earlier worktree-centric refactor. Out of scope to rename here, but worth
> flagging.

---

## 1. Phase 1 findings (what's actually in the code today)

### Current row anatomy

```
┌────────────────────────────────────────────────────────┐
│ [⬢]  Session title or first prompt (2-line clamp)  ●   │   ← tool icon avatar (24px) | bold title | status Badge
│      claude-code · 3 tasks                             │   ← secondary, 12px (tool name redundant w/ avatar)
│      🌳 my-worktree-name                               │   ← secondary, 12px (worktree only — NO repo)
└────────────────────────────────────────────────────────┘
```

- Tool-brand icon is **already** present (avatar, via `<ToolIcon>`).
- Status indicator is **already** present (`<Badge>`), but only maps 3 cases:
  `running → processing`, `completed → success`, `failed → error`, *everything
  else → default*. The session model has 8 statuses (idle, running, stopping,
  awaiting_permission, awaiting_input, timed_out, completed, failed) — the
  drawer collapses 5 of them to a generic gray dot.
- Description line wastes space repeating `agentic_tool` (already shown as the
  avatar icon).

### Current sort

```ts
.sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime())
```

`Session.last_updated` maps to the DB column `sessions.updated_at` and is
bumped on **any session row mutation** — status changes, model_config edits,
metadata writes, etc. — not specifically on prompt. So "most recent" today
≈ "most recently mutated", not "most recently prompted".

### Worktree pill — pleasant surprise

The user's prompt assumed there's a monolithic worktree pill mixing
visualisation + action buttons that needs an `(a)` refactor or `(b)` extraction.
Reading `apps/agor-ui/src/components/Pill/Pill.tsx`:

- `RepoPill` (lines 910–943) already takes `repoName` + optional `worktreeName`,
  renders both with `BranchesOutlined` (repo) and `ApartmentOutlined` (worktree)
  inline, and is **already read-only** — `onClick` is optional, no action
  buttons attached.
- `WorktreePill` (lines 870–882) is a different thing entirely: just a
  "Managed"/"Worktree" status badge, no info.
- The action buttons the prompt referenced are on the **`WorktreeCard`** (board
  card), not on a pill. They never bled into the pill component.

**Verdict: neither (a) nor (b) is needed.** Just use the existing `RepoPill`
with both props in the drawer. Already used in `SessionMetadataCard.tsx:168` in
exactly this read-only form.

### Date helpers — already in repo

`apps/agor-ui/src/utils/time.ts` exports:

- `formatRelativeTime(ts)` → `'just now' | 'Nm ago' | 'Nh ago' | 'Nd ago' | 'Nw ago' | 'Nmo ago' | 'Ny ago'`
- `formatAbsoluteTime(ts)` → `'YYYY-MM-DD HH:mm:ss'`
- `formatTimestampWithRelative(ts)` → both, newline-separated, perfect for tooltip.

No new dep needed. (No `date-fns` / `dayjs` is currently in the UI app.)

### `last_prompted_at` field — does NOT exist on Session

Checked `packages/core/src/db/schema.{sqlite,postgres}.ts` and
`packages/core/src/types/session.ts`:

- `Session.last_updated` exists, but means "row mutated", not "user prompted".
- `last_message_at` exists only on `gateway_channels` and `thread_session_map`
  — nothing related to user prompts on sessions.
- `tasks.created_at` + `tasks.created_by` is the right ground truth: a *task*
  is the unit of "user prompt and its execution" per the glossary.
- The session API payload only attaches `tasks: TaskID[]` (just IDs) — task
  rows aren't hydrated, so we **cannot** derive last-prompted client-side.

**This is the surface-to-Max blocker** the prompt anticipated. See §3.

---

## 2. Proposed row anatomy

```
┌────────────────────────────────────────────────────────┐
│ ●  Session title or first prompt (2-line clamp)  [⬢]   │   ← status dot · title · tool-icon (right-aligned, smaller)
│    [repo/slug ⌂ worktree-name]              3m ago    │   ← RepoPill (repo+worktree) · relative timestamp (muted)
└────────────────────────────────────────────────────────┘
```

Two lines. Same height as today. Concretely:

- **Line 1**
  - Left: status dot (full 8-status mapping; see §5 below).
  - Middle: title with 2-line CSS clamp (existing
    `getSessionDisplayTitle` + `getSessionTitleStyles(2)`).
  - Right: tool icon, demoted from avatar to small inline icon (still glanceable
    but lower visual weight than the title; frees space for status dot on the
    left).

- **Line 2**
  - Left: `<RepoPill repoName={repo.slug} worktreeName={worktree.name} />`
    — replaces the `🌳 worktree` line and adds the missing repo info.
    Drops the redundant "claude-code · N tasks" line entirely.
  - Right: relative timestamp (`Typography.Text type="secondary"`, font 11–12px),
    `<Tooltip>` on hover with absolute time.

Open question (Q3 below): keep "N tasks" anywhere, or drop entirely? Inclined
to drop — task count is rarely actionable from the drawer; it lives in the
session detail.

---

## 3. Sort decision — needs Max's call

Per prompt: sort must be **per-user**. Two users on the same Agor instance see
different orderings based on what *they* most recently prompted.

Since the data field doesn't exist, here are the realistic options for the
backend lift, ordered cheapest → most aligned with intent:

| # | Approach | Per-user? | Backend cost | UX cost |
|---|----------|-----------|--------------|---------|
| **A** | Keep `last_updated`, change nothing | ❌ global "row mutated" | none | matches today's behavior — fails the brief |
| **B** | Add computed `last_task_at` to session payload (`MAX(tasks.created_at)`) | ❌ global "anyone prompted" | one subquery in `sessions` repo hydration; index `tasks(session_id, created_at desc)` if not present | other users' activity reorders my drawer — explicitly called out as confusing in the prompt |
| **C** | Add computed `last_task_by_me_at` (`MAX(tasks.created_at) WHERE tasks.created_by = :currentUserId`) | ✅ | one filtered subquery in hydration, parameterised on auth context; same index | matches intent. Edge case: sessions you never prompted (e.g. shared/observed) sort to the bottom — fall back to `last_updated` |
| **D** | Materialise `sessions.last_prompted_at` column, bump on task insert | ❌ global | column + migration + write hook on task create | same as B — global, not per-user |
| **E** | **B + C combined**: payload includes both fields; UI sorts by `last_task_by_me_at ?? last_task_at ?? created_at`, displays `last_task_at` in the row with tooltip "you prompted 3m ago, last activity 1m ago" if they differ | ✅ for sort | two subqueries, same index | best UX clarity for shared sessions |

**Recommendation: option C for v1.** It's the smallest lift that satisfies the
brief. E is nicer but doubles the cost for an edge case (shared sessions where
two people prompt the same session) that isn't core to the v1 ask. We can
upgrade C → E later without breaking changes (add a second field).

The implementation would live in the session repository hydration in
`packages/core/src/db/repositories/sessions.ts` (where the existing payload is
assembled — `last_updated: row.updated_at` mapping happens at line 71 / line
535). The `currentUserId` would need to flow in from the FeathersJS service
hook context — there's precedent for this in the daemon's auth middleware.

**This is the question I need Max's call on before writing any code.** If C is
green-lit, I proceed; if Max prefers a different option, replan.

---

## 4. Pill reuse decision

**Neither (a) nor (b) — use the existing `RepoPill` as-is.**

Reasoning above (§1, "Worktree pill — pleasant surprise"). `RepoPill` is
already a read-only presentational component with both repo+worktree info and
no action buttons. The premise of the prompt's (a)/(b) was based on a pill
shape that doesn't actually exist in this codebase.

The drawer just needs:

1. A `repoById: Map<RepoID, Repo>` prop (parent already has this — App.tsx:82).
2. `<RepoPill repoName={repo.slug} worktreeName={worktree.name} />` per row,
   guarded for the unusual case where the worktree's repo isn't in the map.

No refactor of `RepoPill` itself, no new component, no callsite changes
elsewhere.

---

## 5. "What else" brainstorm — verdicts

| Item | Verdict | Notes |
|------|---------|-------|
| **Status indicator** (8-state dot) | **YES** | Already a `<Badge>` but only colors 3 of 8 statuses. Expand mapping to cover `awaiting_permission`/`awaiting_input` (warning yellow), `timed_out` (orange), `stopping` (processing), `idle` (default). Cheap, high glance value, especially for orchestrating multiple agents. |
| **Tool icon** (Claude/Codex/Gemini) | **YES — already done** | `<ToolIcon>` in avatar today. Proposal demotes it to inline-right; could also keep as avatar — see Q1. |
| **Genealogy hint** (↳ for spawned) | **MAYBE — light touch** | If `session.parent_session_id` is set, prefix title with a small `↳` glyph (no indent, no extra row). 1 line of code. Drop it if it visually clutters. |
| **Unread / has-update marker** | **NO for v1** | Requires per-user "last viewed at session X" state. Real lift. Revisit after sort lands — once last-prompted-by-me is in place, "agent activity since I last prompted" becomes a natural follow-up. |
| **Cost / token usage** | **NO** | Lives on session detail. Drawer is for finding sessions, not auditing them. |
| **Last-message preview** | **NO** | Doubles row height, hurts scannability. |
| **Pinned / favorited** | **NO for v1** | Adds a header section + state. Defer. |

---

## 6. Open questions for Max

1. **Tool icon placement:** keep as 24px avatar (today), or demote to small
   inline icon on the right of line 1 (proposal)? Avatar is more glanceable;
   inline frees horizontal space for the title. I lean inline but happy either way.
2. **Sort approach:** option C (recommended), E (best UX, ~2x cost), or
   something else? This is the one that gates Phase 3.
3. **Drop "N tasks" line entirely?** Or fold it into the timestamp row as
   `3m ago · 5 tasks`? Inclined to drop.
4. **Genealogy `↳` glyph:** include in v1 or skip? If included, only for spawn
   relationships (`parent_session_id`), not forks (`forked_from_session_id`)?
5. **Multiplayer footnote:** the drawer footer reads "N of M sessions". If C is
   chosen, this still represents board sessions visible to the user. Is the
   "ranked by your activity" semantics confusing enough to need a tooltip on
   the footer? Probably no, but flagging.

---

## 7. Phase 3 plan (after sign-off)

Assuming option C + the verdicts above land, the implementation is roughly:

1. **Backend** (`packages/core/src/db/repositories/sessions.ts`): add a
   parameterised hydration step that computes `last_task_by_me_at` per session,
   thread `currentUserId` through the FeathersJS context. Return field as
   `last_prompted_by_me_at: string | null` in the API payload, and add it to
   the `Session` type in `packages/core/src/types/session.ts` as an optional
   computed field (consistent with how `worktree_board_id` and `url` are handled
   today — see session.ts:153/162).
2. **Drawer** (`WorktreeListDrawer.tsx`):
   - Accept `repoById` prop, thread from App.tsx (App.tsx already has it).
   - Sort by `last_prompted_by_me_at ?? last_updated`.
   - New row layout per §2.
   - Expanded status-color mapping per §5.
   - `formatRelativeTime` for the timestamp + `Tooltip` w/ `formatAbsoluteTime`.
3. **Tests/Storybook:** the drawer has no Storybook today; not adding one
   unless other comparable drawers do (per CLAUDE.md "don't add features
   beyond what was asked").
4. **Smoke test:** docker run + screenshot multi-state drawer, paste in PR.
5. **PR:** `feat(ui): improve session drawer (sort, timestamp, repo pill, status)`,
   draft until smoke-test passes.

---

_This doc lives at `context/explorations/session-drawer-improvements.md` per
the CLAUDE.md convention for active design docs referenced from code
discussions._
