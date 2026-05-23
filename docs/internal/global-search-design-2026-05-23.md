# Global Search — Design Proposal

**Author:** Max (drafted by Claude)
**Date:** 2026-05-23
**Status:** Draft for review (no code in this PR)
**Last revised:** 2026-05-23 — incorporating Max's feedback (see git history of this file)

---

## TL;DR

Add a single search input in the navbar (`Cmd+K`) that opens an instant dropdown showing recents on focus, then sectioned-by-type results as you type. V1 is **broad and shallow**: title-only search across **Sessions, Worktrees, Assistants, Artifacts, Boards, and MCP servers**, with type-filter chips at the top (`All | Session | Worktree | Assistant | Artifact | Board | MCP`). V2 is **deep on Sessions**: when you narrow to Session, you unlock message-content search (needs real FTS) and richer filters. Backend rides existing per-entity Feathers list services with a `search` query param; one new static `searchable-fields.ts` registry declares what's indexable per entity. No new tables, no FTS engine in V1, no unified `/search` endpoint yet. Recents come from the **backend** by querying `created_by = me, $sort: { updated_at: -1 }` per type — no localStorage, no new tracking infrastructure. Default scope chip is **"Created by me"** (ON by default).

This proposal **does not** ship `?focus=<id>` navigation to SessionCanvas; that capability is expected to land in a sibling PR and we depend on its primitive.

---

## 1. Problem & Goals

### Problem
Finding anything in Agor today requires knowing which board it lives on, opening that board, and visually scanning. The board-switcher's filter (`apps/agor-ui/src/components/BoardSwitcher/BoardSwitcher.tsx:152-162`) only filters boards; the only repository-layer `search` method is title-only LIKE on cards (`packages/core/src/db/repositories/cards.ts:236-259`). The hard real-world version of this problem is **"I remember a session where I worked on X"** — sessions accumulate fast, titles aren't always descriptive, and the genuinely useful answer often lives in the session's messages, not its title. V1 picks the easy wins first; V2 attacks the hard one.

### Goals
- One affordance that becomes the answer to "where is my thing?"
- Sub-200ms perceived response on focus (recents) and on type (search).
- Honor existing RBAC without exposing a new permission surface.
- No new infrastructure in V1: ride the existing repos/services + a thin client orchestrator.
- Path-forward to message search (V2) and semantic search (V3) without backwards-incompatible API shape.

### Non-goals (see §10)
Redesigning navigation, building a full command palette, replacing the board switcher, adding backend activity logging, server-side recents.

---

## 2. Investigation findings

Every claim below is anchored to current code on `design-global-search`.

### 2.1 No full-text-search anywhere in the backend
A keyword sweep for `tsvector`, `to_tsvector`, `FTS5`, `MATCH`, `setweight`, `plainto_tsquery`, `GIN`, `using('fts5')`, `virtual table` returned **zero hits** across `packages/core/src/db/`. The only repository with a method literally named `search` is cards, and it is title-only LIKE:

```ts
// packages/core/src/db/repositories/cards.ts:236-247
async search(
  query: string,
  options?: { boardId?: BoardID; archived?: boolean; limit?: number; offset?: number }
): Promise<Card[]> {
  try {
    const conditions = [like(cards.title, `%${query}%`)];
    if (options?.boardId) conditions.push(eq(cards.board_id, options.boardId));
    if (options?.archived !== undefined) conditions.push(eq(cards.archived, options.archived));
    ...
```

Implication: we are designing against a **clean slate**.

### 2.2 Multi-DB (SQLite + Postgres) chosen at runtime
`packages/core/src/db/schema-factory.ts:63-94` resolves the dialect from `AGOR_DB_DIALECT`, `DATABASE_URL`, or `database.dialect` in config, defaulting to SQLite. The shared schema then delegates: `packages/core/src/db/schema.ts:19-20`:

```ts
const dialect = getDatabaseDialect();
const schema = dialect === 'postgresql' ? postgresSchema : sqliteSchema;
```

This rules out Postgres-only `tsvector` / GIN for V1 — any FTS strategy that doesn't degrade gracefully on SQLite needs a per-dialect adapter, which is a V2 effort. Drizzle's `like()` works on both. (Postgres `ilike` is dialect-specific but Drizzle exposes it; SQLite's `like` is case-insensitive by default on ASCII, which is good enough for V1.)

### 2.3 Feathers services have no `search` param today
Worktrees and sessions both accept structured filters only:

```ts
// apps/agor-daemon/src/services/worktrees.ts:42-53
export type WorktreeParams = QueryParams<{
  repo_id?: UUID;
  name?: string;       // exact-match, not search
  ref?: string;
  include_sessions?: boolean | 'true' | 'false';
  ...
}>;
```

```ts
// apps/agor-daemon/src/services/sessions.ts:74-85
export type SessionParams = QueryParams<{
  status?: Session['status'];
  agentic_tool?: Session['agentic_tool'];
  board_id?: string;
  include_last_message?: boolean | 'true' | 'false';
  last_message_truncation_length?: number;
}>;
```

Adding a `search: string` field per service is additive and risk-free.

### 2.4 Drizzle adapter loads then filters in memory
`apps/agor-daemon/src/adapters/drizzle.ts:98-145` calls the repository's `findAll()` and then applies `$sort`/`$limit`/`$skip`/operator filtering in JS. Default pagination limit is 10,000 (`packages/core/src/config/constants.ts:110-125`). At current scale this is fine — but it means *any* `search` filter we add will only narrow client-facing payloads, not query cost. V1 pushes `search` into the *repository* layer, not the adapter, so the WHERE clause actually runs in SQL.

### 2.5 RBAC primitive (and the simpler thing we'll actually use)
The canonical predicate lives at `packages/core/src/db/repositories/worktrees.ts:522-556` and combines `worktree_owners` co-ownership with `worktrees.others_can`:

```ts
// packages/core/src/db/repositories/worktrees.ts:526-533
const conditions = [
  or(
    isNotNull(worktreeOwners.user_id),
    inArray(worktrees.others_can, WORKTREE_PERMISSION_LEVELS.filter((l) => l !== 'none'))
  ),
];
```

That's the *visibility* filter — search rides it for free on all worktree-derived entities (sessions, artifacts).

For the "Created by me" chip, we **do not** join `worktree_owners`. We just check `created_by = userId`. That's a per-entity column (worktrees, sessions, artifacts, boards, MCP servers all have `created_by` per the entity inventory in §2.10). Co-owners do not count as creators. Simpler, easier to explain, easier to implement.

When `execution.worktree_rbac: false` (default per `CLAUDE.md` "Mode 1: Open Access"), the visibility predicate is bypassed entirely — search inherits that for free.

### 2.6 Session ownership on spawn/fork
`apps/agor-daemon/src/utils/worktree-authorization.ts:1516-1570` (`determineSpawnIdentity`) stamps the child's `created_by` to **the caller** by default. Cross-user inheritance only happens if `worktree.dangerously_allow_session_sharing === true`. So "sessions I created" = `sessions.created_by = me`, full stop, no genealogy walk.

### 2.7 No "recently accessed" tracking exists — use `updated_at` instead
Grep for `last_accessed_at`, `last_visited`, `recently_accessed`, activity log — nothing. Every entity has `created_at` / `updated_at`. We do **not** build new tracking. Recents = "entities I created, ordered by `updated_at` DESC, limit 10" — backend-driven, free.

Sessions are the highest-churn surface (`sessions.updated_at` bumps on every task, every status flip), so `sessions` make the most natural recents source. Worktrees and assistants come second.

### 2.8 Navbar has a clean slot
`apps/agor-ui/src/components/AppHeader/AppHeader.tsx:241-265` already inserts BoardSwitcher + RecentBoardPills between a vertical divider and the session-drawer button. A 320px search input slots in after `RecentBoardPills`. No layout rework.

### 2.9 SessionCanvas focus-on-entity is a sibling concern
SessionCanvas does not read a query param today (verified — `useSearchParams` / `focus` / `selectedId` returns no hits in that file). Search clicks need a "navigate to this worktree and center the canvas on it" primitive. **This is not part of this proposal.** A sibling PR is expected to introduce that primitive (Max: "that PR will probably merge before, we'll need a nav-to-worktree method for sure"). We design assuming an API like `navigateToWorktree(worktreeId)` will be available; if not landed yet at implementation time, V1 ships with the dropdown still functional and clicks falling back to "switch to the worktree's board" via the existing `BoardSwitcher.handleBoardClick` (`BoardSwitcher.tsx:54-60`).

### 2.10 Entity inventory for V1 chips
The chip row exposes seven targets; here's the table-level mapping:

| Chip       | Backed by                                                        | Searchable fields (V1)                                   |
|------------|------------------------------------------------------------------|----------------------------------------------------------|
| Session    | `sessions` table                                                 | `title`, `description` (in `data` JSON)                  |
| Worktree   | `worktrees` table where `data.custom_context.assistant` IS NULL  | `name`, `issue_url`, `pull_request_url`                  |
| Assistant  | `worktrees` table where `data.custom_context.assistant` IS NOT NULL  *(Assistants are a worktree variant — see `packages/core/src/types/worktree.ts:792-805`)* | `name`, plus `displayName` from the assistant config in `data` JSON |
| Artifact   | `artifacts` table                                                | `name`, `description`                                    |
| Board      | `boards` table                                                   | `name`                                                   |
| MCP        | `mcpServers` table                                               | `name`, `display_name` (in `data` JSON), `description`   |

**Note on Assistants:** Per the survey, Assistants are not a separate table — they're worktrees flagged via `data.custom_context.assistant` config (defined at `packages/core/src/types/worktree.ts:792-805`). The chip filter materializes by predicating on that JSON field. From a user perspective they're a distinct type; from the schema's perspective they're a worktree sub-kind.

---

## 3. UX proposal

### 3.1 Anatomy (ASCII)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [logo] Agor  [boards▾] [recents] │  [🔍 Search…  ⌘K]  │   [users] [⚙]
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┴────────────────────────────────────┐
        │  payments refactor                                         [×]    │
        │  [All] [Session] [Worktree] [Assistant] [Artifact] [Board] [MCP]  │   ← type chips
        │  [✓ Created by me]                                                │   ← scope chip
        ├───────────────────────────────────────────────────────────────────┤
        │  Sessions · 5                                       See all →     │
        │   🤖  Refactor payments handler              claude     20m ago   │
        │       in payments-refactor                                        │
        │   🤖  Stripe webhook retry investigation     claude     2h ago    │
        │       in payments-stripe-migration                                │
        │   🤖  …3 more                                                     │
        ├───────────────────────────────────────────────────────────────────┤
        │  Worktrees · 2                                      See all →     │
        │   📁  payments-refactor                      main       3h ago    │
        │       agor                                                        │
        │   📁  payments-stripe-migration              feature/…  2d ago    │
        │       agor                                                        │
        ├───────────────────────────────────────────────────────────────────┤
        │  Artifacts · 1                                                    │
        │   🧩  payments-decision.md                   note       1d ago    │
        │       in payments-refactor                                        │
        ├───────────────────────────────────────────────────────────────────┤
        │  Boards · 1                                                       │
        │   🗺️   Payments revamp                                            │
        └───────────────────────────────────────────────────────────────────┘
```

On empty focus (no query), the dropdown shows a single **Recent** section instead — mixed-type, ordered by `updated_at` DESC, 8 entries from the backend (see §3.2).

### 3.2 Recents behavior

- **What it is:** "stuff I created, most-recently-updated first."
- **Backend-driven** (per Max: "backend-only, use the easiest modified-type field that exists, pretty sure session has it all"). The dropdown's recents section fires three parallel `findAll`s on focus:
  - `sessions` where `created_by = me`, `$sort: { updated_at: -1 }`, `$limit: 5`
  - `worktrees` where `created_by = me`, `$sort: { updated_at: -1 }`, `$limit: 3`
  - `artifacts` where `created_by = me`, `$sort: { updated_at: -1 }`, `$limit: 2`
  - (Caps chosen to favor sessions, since they're the highest-churn surface and most likely what the user is looking for.)
- **Why backend, not localStorage:** every entity already has `updated_at`; we have a multi-device story for free; and Max's call ("the easiest modified-type field that exists") points us at the lowest-cost path. Survey confirmed: no schema changes needed (§2.7).
- **What it is NOT:** "recently *viewed*". We don't have view-tracking and we're not building it. If you opened a session and read it but didn't touch it, it won't appear in recents. That's an acceptable V1 simplification — `updated_at` already proxies for "the session I last did something in."
- **What it is NOT, part two:** "recently *interacted with via search*." That would require localStorage tracking (the previous draft's approach) and is unnecessary if `updated_at`-based recents are good enough — which we expect them to be.

### 3.3 Search-as-you-type vs Enter-to-submit — **recommendation: type-ahead**

Type-ahead with **220ms debounce** on input change, **immediate dispatch** on `Enter`, **AbortController** cancels in-flight requests when the query changes. Skip the request entirely if trimmed query is shorter than 2 characters (show recents instead).

**Why type-ahead:** every adjacent tool (Linear, Notion, Slack, GitHub command-K, Raycast) does it; users will perceive Enter-to-submit as broken. Server cost is negligible at current scale (in-memory drizzle adapter; tens of thousands of rows worst-case).

**Multi-keyword AND:** tokenize the query on whitespace; require **every** token to match somewhere in the entity's searchable-field set. So `"payments refactor"` matches a session titled "Refactor payments handler" because both tokens appear (in title or description).

### 3.4 Mixed vs sectioned — **recommendation: SECTIONED (resolved)**

Section by entity type, in fixed order: **Sessions → Worktrees → Assistants → Artifacts → Boards → MCP**. Each section caps at **5** with a "See all →" link (V2 — opens a full results page; V1 link can either be hidden or navigate to a placeholder).

**Why sectioned, in one line:** mixed assumes cross-type ranking we don't have. With LIKE-based matching every result is a binary "matches all tokens" — there is no score. Mixed-by-recency would push a freshly-edited boring session above a perfectly-titled worktree, which is wrong. Sectioned side-steps the question entirely and matches users' mental model.

**Empty section policy:** hide sections with zero results. Show a single "No matches for *payments refactor*" line if all sections are empty.

### 3.5 Filter chips

Two chip rows, both above the result list:

**Type chips (single-select):**
```
[All] [Session] [Worktree] [Assistant] [Artifact] [Board] [MCP]
```
- Default: **All**. Picking any other chip collapses the dropdown to one section.
- When a single type is picked, that section can show more rows (V1: up to 15; V2: paginated full-page results).
- Picking **Session** is the gateway to V2's deeper session-content search (see §7).

**Scope chip (toggle):**
```
[✓ Created by me]
```
- Default: **ON** (per Max: "focus on created-by, not owned by, easier").
- ON: results filtered to `created_by = current_user_id`.
- OFF: results limited only by RBAC visibility (the broader "everything I can see").

No other chips in V1. No date filters, no board filters, no status filters. Keep the surface tight.

### 3.6 Result-row anatomy (`<SearchResult />` component)

Each row is one component, structurally:

```
┌─ row ─────────────────────────────────────────────────────────────┐
│  [icon 18]  [bold title — match-highlighted]   [tag]   [time]     │
│             [secondary: context line]                              │
└────────────────────────────────────────────────────────────────────┘
```

- **Icon (18px, left):** entity-type-specific. 🤖 session · 📁 worktree · 🤖✨ assistant (or its configured `emoji`) · 🧩 artifact · 🗺️ board · 🔌 MCP.
- **Title (bold, primary color):** entity-specific. Sessions: `getSessionDisplayTitle(session)` (existing helper). Worktrees / Assistants: `name`. Artifacts: `name`. Boards: `name`. MCP: `display_name ?? name`. Matched tokens wrapped in `<mark>` styled with `token.colorWarningBg`.
- **Tag (right, before time):** entity-specific. Sessions: agentic tool (`claude` / `codex` / `gemini`). Worktrees: `ref` (branch). Artifacts: `kind`. Boards: zone count or omitted. MCP: `auth_type` or omitted.
- **Time (rightmost):** relative `updated_at` ("20m ago"). Right-aligned, muted.
- **Secondary line (small, muted, single line):** the contextual parent. Sessions: `in <worktree.name>` with the worktree name as a soft pill. Worktrees / Assistants: `repo.name`. Artifacts: `in <worktree.name>` if worktree-scoped, else `on <board.name>`. Boards: omitted (title carries it). MCP: `transport` or omitted.
- **No inline action buttons.** Hover row → subtle background change. Click or Enter → navigate (see §4). The decision: actions clutter the row and the only useful action ("open this") is already the default click behavior. Reconsider in V2 if "pin to recents" / "copy link" feel necessary.
- **Keyboard:** ↑/↓ move selection, `Enter` navigates, `Esc` closes, `Tab`/`Shift+Tab` between chips and result list, number keys `1`–`9` jump to that row position (Raycast-style).

**Component sketch (for grounding only — not shipping in this PR):**

```tsx
// apps/agor-ui/src/components/GlobalSearch/SearchResult.tsx
interface SearchResultProps {
  entity: SearchResultEntity;     // discriminated union by `type`
  query: string;                  // for match-highlighting
  selected: boolean;              // keyboard cursor
  onClick: (entity: SearchResultEntity) => void;
}

export type SearchResultEntity =
  | { type: 'session';   item: Session;   parent?: Worktree }
  | { type: 'worktree';  item: Worktree;  parent?: Repo }
  | { type: 'assistant'; item: Worktree;  parent?: Repo }
  | { type: 'artifact';  item: Artifact;  parent?: Worktree | Board }
  | { type: 'board';     item: Board }
  | { type: 'mcp';       item: MCPServer };
```

The discriminated union lets the component switch on `entity.type` to render the right icon, tag, secondary line. Parent entities are passed in pre-resolved (from `useAgorData` Maps) to avoid per-row fetches.

---

## 4. Click-through behavior matrix

| Entity     | On click — navigate to                                                                              |
|------------|-----------------------------------------------------------------------------------------------------|
| Session    | The session's worktree (via the sibling-PR `navigateToWorktree` primitive); session drawer opens to this session. Fallback if primitive unavailable: switch to worktree's board via `BoardSwitcher.tsx:54-60`. |
| Worktree   | `navigateToWorktree(worktreeId)`. Fallback: switch to worktree's board.                             |
| Assistant  | Same as Worktree (Assistants are worktrees underneath). Visual treatment differs (assistant emoji). |
| Artifact   | Worktree-scoped artifact → `navigateToWorktree(worktreeId)` with the artifact's worktree. Board-scoped → switch to the artifact's board. (V1 does not pan-to-artifact; that's a sibling-PR concern.) |
| Board      | `onBoardChange(boardId)` (existing primitive in `BoardSwitcher.tsx:54-60`).                          |
| MCP        | Open SettingsModal on the MCP-servers tab, scroll the matched server into view. Reuses the modal pattern at `apps/agor-ui/src/components/MCPServer/MCPServerEditModal.tsx`. |

**Hard dependency:** `navigateToWorktree(id)` from the sibling PR. If that PR doesn't land first, V1 still ships — clicks fall back to "switch to the worktree's board" via the existing board switcher primitive, which is OK but not the final experience.

---

## 5. Backend strategy

### 5.1 Per-entity endpoints, client fan-out — **recommendation: yes, V1**

Keep V1 as N parallel `findAll({ query: { search, created_by_me, $limit } })` calls from the client (one per entity type in scope). Do **not** introduce a unified `/search` endpoint yet.

**Why:**
- The Feathers list services already exist, are real-time-aware, and have RBAC hooks in the right place.
- Sectioning by type (§3.4) means we don't need cross-type ranking.
- A unified endpoint becomes the right move *after* we have FTS + ranking + cross-type pagination (V2/V3).
- The client orchestrator is one ~100-line hook (`useGlobalSearch`) that issues parallel `findAll`s, applies `AbortController`, and merges results.

When the unified endpoint becomes worth building: as soon as V2 message search lands and we need ranking — *or* when we want a single MCP tool `agor_search` that an agent can call (V3).

### 5.2 Searchable-fields registry

One new static module imported by every repository:

```ts
// packages/core/src/search/searchable-fields.ts  (NEW, ~80 lines)
export const SEARCHABLE_FIELDS = {
  session: [
    { column: 'title',       weight: 3 },
    { column: 'description', weight: 2, jsonPath: 'data.description' },
  ],
  worktree: [
    { column: 'name',              weight: 3 },
    { column: 'issue_url',         weight: 1 },
    { column: 'pull_request_url',  weight: 1 },
  ],
  assistant: [   // same table as worktree, predicated on data.custom_context.assistant
    { column: 'name',                                weight: 3 },
    { column: 'displayName', jsonPath: 'data.custom_context.assistant.displayName', weight: 3 },
  ],
  artifact: [
    { column: 'name',        weight: 3 },
    { column: 'description', weight: 2 },
  ],
  board: [
    { column: 'name', weight: 3 },
  ],
  mcp: [
    { column: 'name',         weight: 3 },
    { column: 'display_name', weight: 3, jsonPath: 'data.display_name' },
    { column: 'description',  weight: 2, jsonPath: 'data.description' },
  ],
} as const;
```

Weights are stored but unused in V1 (we don't rank within a section beyond `updated_at` DESC). They become live in V2 when ranking matters.

**Why a static registry, not Drizzle/Zod augmentation:** type-system-driven approaches sound elegant but require every developer touching schema to know to update the augmentation. A 20-line file with an obvious name is something a code reviewer will catch when a field is added.

### 5.3 Where clause construction — AND-of-ORs

For each token: `OR(like(col1, '%token%'), like(col2, '%token%'), ...)`. AND those per-token clauses together. So `"payments refactor"` becomes:

```
WHERE
  (title LIKE '%payments%' OR description LIKE '%payments%')
  AND
  (title LIKE '%refactor%' OR description LIKE '%refactor%')
```

Use Drizzle's `like` (case-insensitive for ASCII on SQLite; Postgres uses `ilike` via the same Drizzle abstraction). Escape `%` and `_` in tokens (`token.replace(/[\\%_]/g, '\\$&')`) with Drizzle's `escape` op.

**Per-section cardinality safeguard:** `$limit: 25` per entity type in the search query (capped from the client). The dropdown shows 5 per section with "See all →"; we fetch 25 so a "See all" expansion doesn't need an additional round-trip.

### 5.4 RBAC: ride the existing predicate, add `created_by` filter on top

For worktrees, the visibility filter routes through `findAccessibleWorktrees(userId, ...)` (`worktrees.ts:522-556`). Sessions, artifacts, and Assistants (which are worktrees) join through worktree visibility. Boards and MCP servers are accessible-by-default.

The "Created by me" chip adds **one** extra WHERE condition per entity: `eq(table.created_by, userId)`. No `worktree_owners` join; that's an explicit simplification from the previous draft and matches Max's call.

When `worktree_rbac: false`, the visibility predicate is bypassed entirely (existing behavior); the `created_by` filter still applies when the chip is ON.

### 5.5 Ranking (V1 = none, V2 = weighted)

V1 orders results within each section by `updated_at DESC`. No relevance score.

V2 introduces a simple weighted score: matched-token count × column weight, broken by recency. The right moment to do it is when we move to real FTS (§5.7), so we get the score from the engine instead of computing it ourselves.

### 5.6 Server load and rate limiting

V1 risk is low (in-memory adapter + small datasets), but two safeguards land in V1:
- **Min query length:** 2 chars. Below that, return only recents.
- **AbortController** on the client cancels in-flight requests when the query changes.
- No explicit server-side rate limit in V1; revisit when FTS makes individual queries cost real time.

### 5.7 Migration path to real FTS (V2, for Sessions)

When V2 adds message-content search on Sessions:

- **Postgres:** generated `tsvector` columns on `messages` and `sessions` + GIN indexes, populated using SEARCHABLE_FIELDS as the weight source. `setweight(to_tsvector('english', title), 'A')`, etc.
- **SQLite:** FTS5 virtual tables shadowing the same fields, kept in sync via triggers (or in-app on write).
- A `RepositoryFTS` mixin produces the right dialect-specific query.
- The `searchable-fields.ts` registry stays the source of truth; only the query builder changes.

Critically, no API shape change is needed — the client still posts `?search=foo` and gets ranked results back. The lift is real (writes to sessions and messages need to keep the index fresh) but isolated.

---

## 6. "Created by me" — semantics

The chip is ON by default, applies `created_by = userId` per entity:

| Entity     | "Created by me" =                                                                            | Notes                                                                                                          |
|------------|----------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| Session    | `sessions.created_by = userId`                                                               | Per §2.6, this stamps to the caller on spawn/fork. Honest — no genealogy walk needed.                          |
| Worktree   | `worktrees.created_by = userId`                                                              | Co-owners do not count. Simpler model.                                                                          |
| Assistant  | `worktrees.created_by = userId AND data.custom_context.assistant IS NOT NULL`                | Same column as worktrees, plus the assistant flag.                                                              |
| Artifact   | `artifacts.created_by = userId`                                                              | Column is optional in the schema; rows with null `created_by` are excluded when chip is ON.                     |
| Board      | `boards.created_by = userId`                                                                 | Boards are intentionally creator-owned (no co-owner concept today).                                             |
| MCP        | `mcpServers.owner_user_id = userId`                                                          | MCP uses `owner_user_id` instead of `created_by`; we treat the two equivalently for the chip.                   |

**UI hint:** when "Created by me" is OFF, each row shows a small creator avatar at the right (after the time stamp) to indicate scope at a glance. When ON, that column is omitted (it'd always be you).

---

## 7. Sessions hierarchy: title vs messages

This is the key design tension Max flagged: object search is easy, *session* search is the hard real problem because the answer often lives in messages, not titles. The proposal splits it cleanly:

- **V1:** the **Session** chip searches `sessions.title` + `sessions.description` only. Same shape as every other chip — fast, LIKE-based, no FTS needed. This is the "broad and shallow" V1.
- **V2:** when you pick the Session chip, an additional sub-toggle appears: **`[✓ Also search messages]`** (default OFF; remembered in localStorage). Turning it on widens the query to `messages.content` for the user's sessions. Hits where the match is in a message body render with a different secondary line — a snippet of the matching message — instead of the description.
- **V3+:** semantic search on session content (embeddings) becomes the natural extension once V2 lands.

This explicitly stages the work: V1 is N entities wide and 1 field deep; V2 is 1 entity (sessions) wide and N fields deep. We don't try to do both at once.

We are **not** making the dropdown a hierarchy of types ("Session titles" + "Session messages" as two sections). One Sessions section with a deepening sub-toggle keeps the dropdown legible.

---

## 8. Phased rollout

### V1 — this proposal's implementation
- Navbar input + dropdown (recents + sectioned results).
- Chip row: `All | Session | Worktree | Assistant | Artifact | Board | MCP` (single-select; default `All`).
- Scope chip: `✓ Created by me` (default ON).
- Title-only search per type, AND-joined LIKE across each entity's SEARCHABLE_FIELDS.
- `Cmd+K` / `Ctrl+K` focus shortcut.
- Backend-driven recents (no localStorage, no new tables).
- Click → navigates via the sibling PR's `navigateToWorktree`, or falls back to board switch.
- No feature flag.

### V2 — Sessions deep dive
- **`Also search messages`** sub-toggle under the Session chip.
- Postgres FTS (`tsvector` + GIN) and SQLite FTS5 indexes on `messages.content`, `sessions.title`, `sessions.description`.
- Within-section ranking using SEARCHABLE_FIELDS weights.
- "See all →" opens a full results page (`/search?q=...&type=session`).
- Optional: replace per-entity fan-out with unified `/search` endpoint.

### V3+ — stretch
- Semantic search (embeddings on session content + artifacts) — requires choosing an embedding store and a refresh strategy.
- Saved searches (named, shareable).
- Agent-callable `agor_search` MCP tool — agents in a session can search the workspace.
- Backend `last_accessed_at` tracking (would unlock "recently viewed" recents, not just "recently updated").
- Boards-mode worktree filter ("only this board") — for users who think board-first.

---

## 9. Open questions for Max

Resolved by Max's review of v1 draft (kept here as the decision log):
- ~~Owned-by vs created-by~~ → **created-by** (simpler).
- ~~Boards in V1?~~ → **chip is exposed in V1**; boards aren't the focus, but search across them is free.
- ~~Focus-on-id wiring~~ → **out of this proposal**; expected from a sibling PR (`navigateToWorktree`).
- ~~Recents in localStorage vs backend?~~ → **backend**, via `updated_at` per entity.
- ~~Cmd+K?~~ → **yes**.
- ~~Sessions title vs messages?~~ → **V1 title-only; V2 unlocks messages under the Session chip.**
- ~~Mixed vs sectioned?~~ → **sectioned**, 5 per section, fixed type order.

Still open:
1. **Per-section row cap** — proposed **5** with "See all" stub. Comfortable, or want 3 to keep the dropdown tighter / 7 if vertical space is fine?
2. **MCP chip in V1** — included for completeness in the chip row, but it's a low-frequency target and clicking it opens a settings modal (different UX from canvas navigation). Keep in V1 chips or hide until V2?
3. **Match-highlighting** — `<mark>` over the matched tokens is the proposed behavior. With LIKE-only (no FTS), highlighting is straightforward but adds DOM. Worth it in V1, or wait for V2?
4. **"See all →" in V1** — does it open a placeholder full-results page, or is it hidden until V2 builds one?
5. **Recent-section composition caps** — proposed 5 sessions / 3 worktrees / 2 artifacts when in recents mode. Adjust the mix?
6. **Match attribution** — when the Session match is on `description` (not `title`), should the secondary line surface that, or just stay as "in <worktree>"? Leans toward keeping secondary line stable for V1 visual consistency.
7. **Empty-state copy** — "No matches for *X*." is the placeholder. Want a more helpful empty state (e.g. "Try a broader query" or links to recents)?

---

## 10. Out of scope

The following are **not** part of this proposal:

- A command palette (`Cmd+K` opens search, not a command surface).
- Redesigning the navbar or boards sidebar.
- Replacing the BoardSwitcher.
- Backend activity log / `last_accessed_at` columns.
- The `?focus=<id>` / `navigateToWorktree` primitive itself — sibling PR (we just call it).
- localStorage recents.
- Server-side recents-tracking infrastructure beyond `updated_at`.
- Semantic search / embeddings (V3 territory).
- A unified `/search` HTTP endpoint (deferred until V2 ranking arrives).
- Searching message *content* (V2; needs FTS).
- Search analytics / telemetry.
- Saved / shareable searches.
- Searching across organizations or multi-instance federation.
- Mobile-specific UX (Agor UI is desktop-first).
- Row-level action buttons (pin, copy-link). Reconsider in V2.

---

## Appendix — concrete file changes V1 will require (for reviewer's mental model only; not in this PR)

- `packages/core/src/search/searchable-fields.ts` — new (~80 lines).
- `packages/core/src/db/repositories/worktrees.ts` — extend `findAll` / `findAccessibleWorktrees` to accept `search` + `createdByMe` + `assistantOnly`.
- `packages/core/src/db/repositories/sessions.ts` — add `search` path (LIKE on title + JSON-extracted description).
- `packages/core/src/db/repositories/artifacts.ts` — add `search`.
- `packages/core/src/db/repositories/boards.ts` — add `search`.
- `packages/core/src/db/repositories/mcp-servers.ts` — add `search`.
- `apps/agor-daemon/src/services/{worktrees,sessions,artifacts,boards,mcp-servers}.ts` — extend each `*Params` with `search?: string`, `created_by_me?: boolean` (and `assistant_only?: boolean` on worktrees).
- `apps/agor-ui/src/components/GlobalSearch/` — new dir:
  - `GlobalSearch.tsx` — navbar input
  - `GlobalSearchDropdown.tsx` — sections + chips + keyboard handling
  - `SearchResult.tsx` — single result row (discriminated union; see §3.6)
  - `SearchChipRow.tsx` — type & scope chips
- `apps/agor-ui/src/hooks/useGlobalSearch.ts` — new orchestrator with debounce + AbortController.
- `apps/agor-ui/src/hooks/useRecents.ts` — new; backend-driven recents query (no localStorage).
- `apps/agor-ui/src/components/AppHeader/AppHeader.tsx` — insert `<GlobalSearch />` after `RecentBoardPills`.
- *(Optional, if `Cmd+K` global hotkey isn't already plumbed)* small `useHotkey('cmd+k')` setup in `App.tsx`.

No new database migrations. No new tables. No new dependencies. Pending `navigateToWorktree` primitive lands from the sibling PR for the best click-through UX.
