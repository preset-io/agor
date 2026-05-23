# Global Search — Design Proposal

**Author:** Max (drafted by Claude)
**Date:** 2026-05-23
**Status:** Draft for review (no code in this PR)

---

## TL;DR

Add a single search input in the navbar that opens an instant dropdown showing recents on focus, then sectioned-by-type results as you type. V1 covers **worktrees, sessions (title/description), artifacts, and boards** — boards added because they are free. Backend: extend the existing per-entity Feathers list services with a `search` query param that runs an AND-joined `ILIKE` across a small static registry of "searchable fields" per entity. No new tables, no FTS engine, no unified `/search` endpoint yet. Recents are stored client-side in `localStorage`, extending the existing `useRecentBoards` pattern. Default scope is "everything I can see" (existing RBAC); a single chip toggles to "owned by me".

Cost ceiling: ship a feature flag-free V1 in one PR. V2 unlocks message search (needs real FTS), more entity types, and richer filters. V3+ contemplates semantic search and an MCP-callable search tool so agents can use it too.

---

## 1. Problem & Goals

### Problem
Finding anything in Agor today requires knowing which board it lives on, opening that board, and visually scanning. There is no cross-board entity lookup. The board switcher's filter (`apps/agor-ui/src/components/BoardSwitcher/BoardSwitcher.tsx:152-162`) only filters boards, and the only repository-layer search method is title-only LIKE on cards (`packages/core/src/db/repositories/cards.ts:236-259`). As users accumulate dozens of worktrees and hundreds of sessions, the "I know I have a session about X" problem becomes a daily papercut.

### Goals
- One affordance that becomes the answer to "where is my thing?"
- Sub-200ms perceived response on focus (recents) and on type (search).
- Honor existing RBAC without exposing a new permission surface.
- No new infrastructure: ride the existing repos/services + a thin client orchestrator.
- Path-forward to messages search and semantic search without backwards-incompatible API shape.

### Non-goals (see §10)
Redesigning navigation, building a full command palette, replacing the board switcher, adding backend activity logging.

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

Implication: we are designing against a **clean slate**. We do not need to be backwards-compatible with anything except short-ID prefix resolution at `packages/core/src/db/repositories/base.ts:100-121`.

### 2.2 Multi-DB (SQLite + Postgres) chosen at runtime
`packages/core/src/db/schema-factory.ts:63-94` resolves the dialect from `AGOR_DB_DIALECT`, `DATABASE_URL`, or `database.dialect` in config, defaulting to SQLite. The shared schema then delegates: `packages/core/src/db/schema.ts:19-20`:

```ts
const dialect = getDatabaseDialect();
const schema = dialect === 'postgresql' ? postgresSchema : sqliteSchema;
```

This rules out Postgres-only `tsvector` / GIN for V1 — any FTS strategy that doesn't degrade gracefully on SQLite needs a per-dialect adapter, which is meaningful additional work. Drizzle's `like()` operator works on both. (Postgres `ilike` is dialect-specific but Drizzle exposes it; SQLite's `like` is case-insensitive by default on ASCII, which is good enough for V1.)

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

Adding a `search: string` field is additive and risk-free.

### 2.4 The Drizzle adapter currently loads everything then filters in memory
`apps/agor-daemon/src/adapters/drizzle.ts:98-145` calls the repository's `findAll()` and then applies `$sort`/`$limit`/`$skip`/operator filtering in JS. Default pagination limit is 10,000 (`packages/core/src/config/constants.ts:110-125`). At current scale this is fine — but it means *any* `search` filter we add will only narrow client-facing payloads, not query cost. If/when we want sub-linear search we have to push filtering down into the repository.

**Implication for design:** V1 pushes `search` into the *repository*, not the adapter — `WorktreeRepository.findAll(filter)` already takes a typed filter object (`worktrees.ts:236-250`). We extend it to accept `search`. Same for sessions/artifacts/boards. The Feathers service forwards `params.query.search` to the repo.

### 2.5 Worktree RBAC is already a clean primitive
The canonical predicate lives at `packages/core/src/db/repositories/worktrees.ts:522-556`:

```ts
async findAccessibleWorktrees(userId: UUID, filter?: { archived?: boolean }): Promise<Worktree[]> {
  const conditions = [
    or(
      isNotNull(worktreeOwners.user_id),
      inArray(worktrees.others_can, WORKTREE_PERMISSION_LEVELS.filter((l) => l !== 'none'))
    ),
  ];
  ...
  .leftJoin(worktreeOwners, and(
    eq(worktreeOwners.worktree_id, worktrees.worktree_id),
    eq(worktreeOwners.user_id, userId)
  ))
  ...
```

V1 search rides this. Sessions and artifacts are worktree-scoped, so a join through worktree visibility gives us a single RBAC choke point.

When `worktree_rbac: false` (the default per `CLAUDE.md` "Mode 1: Open Access"), this predicate is bypassed entirely — search should respect the same toggle and skip the join.

### 2.6 Session ownership semantics on spawn/fork
`apps/agor-daemon/src/utils/worktree-authorization.ts:1516-1570` implements `determineSpawnIdentity`. Default behavior: child session is stamped to the **caller's** `user_id`, not the parent's. Cross-user inheritance only happens if `worktree.dangerously_allow_session_sharing === true`. Concretely, "sessions owned by me" = `sessions.created_by = me`, with no need to walk genealogy.

### 2.7 No "recently accessed" tracking exists server-side
Grep for `last_accessed_at`, `last_visited`, `recently_accessed`, activity log — nothing. Every entity has `created_at` / `updated_at`. The only client-side recents we track is boards, via `apps/agor-ui/src/hooks/useRecentBoards.ts` (10-item array in `localStorage` key `agor:recentBoardIds`). We extend that pattern; we do *not* build a backend activity log for V1.

### 2.8 Navbar has a clean slot
`apps/agor-ui/src/components/AppHeader/AppHeader.tsx:241-265` already inserts BoardSwitcher + RecentBoardPills between a vertical divider and the session-drawer button. A 320px search input slots in either after `RecentBoardPills` or absolutely-centered in the header. We do **not** need a layout rework.

### 2.9 No board-side "focus on entity" exists
SessionCanvas does not read a query param. There is no `?focus=<id>` handler. Worktree-card click navigation goes through `BoardSwitcher.handleBoardClick` (BoardSwitcher.tsx:54-60). To make search clicks satisfying ("land on the board, centered on the thing"), we must add `?focus=<entityId>&type=<entityType>` parsing to SessionCanvas. **This is a scope item, called out in §5.6.**

### 2.10 No command palette / `Cmd+K` infrastructure
Grep for `cmdk`, `kbar`, `useHotkeys`, `Cmd+K` — zero. We are free to choose `Cmd+K` (and `Ctrl+K` on non-Mac) without colliding.

### 2.11 Data-fetching is Feathers + WebSocket, no React Query
`apps/agor-ui/src/hooks/useAgorData.ts:253-262` calls `client.service('sessions').findAll({ query: { ... } })` and stores result in React context Maps with WebSocket patches. There is no list-query cache to reuse for search; the global-search dropdown will issue ad-hoc fetches. That is fine — and gives us natural debounce control.

---

## 3. UX proposal

### 3.1 Anatomy (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  [logo] Agor  [boards▾] [recents] │   [🔍 Search worktrees, sessions… ⌘K]   │  [users] [⚙]
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
              ┌──────────────────────┴───────────────────────────┐
              │  [×]  payments refactor                          │
              │       [ Owned by me ✓ ]  [ All types ▾ ]         │  ← filter chips
              ├──────────────────────────────────────────────────┤
              │  Worktrees · 2                          See all → │
              │   📁  payments-refactor                 main      │
              │       agor • Maxime B.                  3h ago   │
              │   📁  payments-stripe-migration         feature/… │
              │       agor • Maxime B.                  2d ago   │
              ├──────────────────────────────────────────────────┤
              │  Sessions · 5                           See all → │
              │   🤖  Refactor payments handler         claude    │
              │       payments-refactor • Maxime B.     20m ago  │
              │   🤖  …4 more                                     │
              ├──────────────────────────────────────────────────┤
              │  Artifacts · 1                                    │
              │   🧩  payments-decision.md              note      │
              │       payments-refactor                 1d ago   │
              ├──────────────────────────────────────────────────┤
              │  Boards · 1                                       │
              │   🗺️   Payments revamp                            │
              └──────────────────────────────────────────────────┘
```

On empty focus (no query) the same shell renders with one section: **Recent** (mixed types, last ~8 entities opened from search or directly visited).

### 3.2 Recents behavior

- **What counts as "recent":** entity was either (a) opened via this search dropdown, or (b) was the *destination* of a navigation that we already track (board visits). For V1 only (a) is automatic; we also seed from `useRecentBoards` so the dropdown is non-empty on first load.
- **Storage:** `localStorage` key `agor:recentEntities`, shape `{ type: EntityType, id: string, ts: number }[]`, MAX = 10, FIFO bumped to front on access. Identical pattern to `useRecentBoards.ts:5-37`.
- **Hydration:** entity bodies are looked up from the existing `useAgorData` Maps (`worktreeById`, `sessionById`, …). If a recent entity was deleted, silently skip.
- **TTL:** none. We cap at 10 entries; that is the TTL.
- **Cross-device sync:** no. Backend `last_accessed_at` would unlock this but is a V2 question (§9).

### 3.3 Search-as-you-type vs Enter-to-submit — **recommendation: type-ahead**

Type-ahead with **220ms debounce** on input change and **immediate dispatch** on `Enter`. Cancel in-flight requests via `AbortController` (the Feathers client supports it through fetch).

**Why type-ahead:** every adjacent tool (Linear, Notion, Slack, GitHub command-K, Raycast) is type-ahead; users will perceive Enter-to-submit as broken. Server cost is negligible at current data scale (in-memory drizzle adapter; tens of thousands of rows worst-case). If load becomes a real concern in V2, we can raise the debounce or add a min-length gate without breaking the contract.

**Why 220ms:** matches the median dwell time after which users expect feedback in dropdowns; longer than 250ms reads as laggy. Skip the request entirely if the trimmed query is shorter than 2 characters.

**Multi-keyword AND:** tokenize the query on whitespace; require **every** token to match somewhere in the entity's searchable-field set. So "payments refactor" matches a session titled "Refactor payments handler" because both tokens appear (in title or description or worktree.name pulled via join). Spec calls this out; this is the obvious answer.

### 3.4 Mixed vs sectioned results — **recommendation: sectioned**

Group by entity type, in fixed order: **Worktrees → Sessions → Artifacts → Boards** (descending by user-importance for V1 scope). Each section caps at 5 with a "See all →" link that opens a full results page (V2 — see §8).

**Why sectioned:** cross-type ranking requires a relevance score. With LIKE-based matching we don't *have* one — every result is a binary "matches all tokens." Flat-ranking by `updated_at DESC` across types would push freshly-edited messages to the top of a worktree search, which is wrong. Sectioning side-steps the question and matches how users mentally model the entities. We can revisit if/when we have FTS ranking (V2/V3).

**Empty section policy:** hide sections with zero results. Show a single "No results in *Worktrees, Sessions, Artifacts, Boards*" line if all sections are empty.

### 3.5 Filter chips & type picker

Two chips above the result list, in this order:

1. **Owned by me** (default: ON). Off = "everything I can see". The chip is a single toggle, not a popover.
2. **All types ▾** (default: all V1 types). Click opens a small menu with checkboxes; users can narrow to one or more types. When narrowed, the section headers reflect only selected types.

Both chips are mouse + keyboard accessible. No other filters in V1.

### 3.6 Result-row anatomy

```
┌─ row ─────────────────────────────────────────────────────┐
│  [icon 18px]  [bold title — match-highlighted]   [tag]    │
│               [secondary line: parent / owner / time]      │
└────────────────────────────────────────────────────────────┘
```

Borrows directly from `WorktreeCard` (`apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx:38-47`) and `SessionCard` (`apps/agor-ui/src/components/SessionCard/SessionCard.tsx:23-100`) typography. Match-highlighting wraps matched tokens in a `<mark>` with `token.colorWarningBg` (light teal).

- **Icon:** entity-type-specific (📁 worktree, 🤖 session, 🧩 artifact, 🗺️ board).
- **Title:** worktree.name / session.title (falls back to `getSessionDisplayTitle`) / artifact.name / board.name.
- **Tag (right-aligned):** branch ref for worktrees, agentic tool for sessions, artifact kind for artifacts.
- **Secondary line:** worktree.name (for sessions and artifacts that have one) · owner display name · relative time (`updated_at`).
- **Keyboard:** ↑/↓ to move, Enter to navigate, Esc to close, Tab to filter chips.

---

## 4. Click-through behavior matrix

| Entity   | On click — navigate to                                                                          | Post-navigation focus state                                                                  |
|----------|-------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Worktree | The board that hosts its card. Switch board if needed.                                          | `?focus=<worktree_id>&type=worktree` → SessionCanvas pans/zooms to center, ring-highlights.  |
| Session  | The board that hosts the parent worktree's card; opens the session drawer for that session.     | `?focus=<session_id>&type=session` → board centers on parent worktree, drawer opens to session. |
| Artifact | The board hosting the artifact node. (Artifacts are board-scoped per `artifacts.board_id`.)     | `?focus=<artifact_id>&type=artifact` → centers on ArtifactNode.                              |
| Board    | Switch to that board via `onBoardChange(boardId)` (reuses `BoardSwitcher.tsx:54-60`).           | No additional focus.                                                                          |
| (V2) MCP server | Open SettingsModal on `mcp` tab with the server's row scroll-into-view.                  | Modal pattern from `MCPServerEditModal.tsx`.                                                  |
| (V2) Repo       | Open SettingsModal on `repositories` tab.                                                | Reuse pattern from `ReposTable.tsx`.                                                          |
| (V2) User       | Admin-only: SettingsModal on `users` tab.                                                | Hidden from non-admin search results entirely.                                                |

**Required new wiring:** SessionCanvas must read `?focus=<id>&type=<entityType>` on mount + on URL change. This is V1's only board-level code change beyond the search components themselves.

---

## 5. Backend strategy

### 5.1 Per-entity endpoints, client fan-out — **recommendation: yes, V1**

**Decision:** keep V1 as N parallel `findAll({ query: { search, ownedByMe, $limit } })` calls from the client (one per entity type in scope). Do **not** introduce a unified `/search` endpoint yet.

**Why:**
- The Feathers list-services already exist, are real-time-aware, and have RBAC hooks in the right place.
- Cross-type relevance ranking is not needed (we are sectioning by type — §3.4).
- A unified endpoint becomes the right move *after* we have FTS + ranking + cross-type pagination. Building it now is design-for-imaginary-future.
- The client orchestrator is one ~80-line hook (`useGlobalSearch`) that issues parallel `findAll`s, applies `AbortController`, and merges results.

When to revisit: when V2 message search lands and we need ranking, *or* when we want a single MCP tool `agor_search` that an agent can call (V3) — then we expose `/search` as the canonical surface and have the UI hook switch to it.

### 5.2 Searchable-fields registry

A single static module that each repository imports:

```ts
// packages/core/src/search/searchable-fields.ts  (NEW, ~60 lines)
export const SEARCHABLE_FIELDS = {
  worktree: [
    { column: 'name', weight: 3 },
    { column: 'issue_url', weight: 1 },
    { column: 'pull_request_url', weight: 1 },
  ],
  session: [
    { column: 'title', weight: 3 },
    { column: 'description', weight: 2 },  // lives in data JSON; needs json_extract
  ],
  artifact: [
    { column: 'name', weight: 3 },
    { column: 'description', weight: 2 },
  ],
  board: [
    { column: 'name', weight: 3 },
  ],
} as const;
```

Weights are stored but unused in V1 (no ranking). They become live in V2.

**Why a static registry, not Drizzle/Zod augmentation:** type-system-driven approaches sound elegant but require every developer touching schema to know to update the augmentation. A 20-line file with an obvious name is something a code reviewer will catch when a field is added. The cost of "must remember to update searchable-fields.ts" is fine.

### 5.3 Where clause construction — **recommendation: AND-of-ORs**

For each token in the query, build `OR(ilike(col1, '%token%'), ilike(col2, '%token%'), ...)`. AND those per-token clauses together. So query `"payments refactor"` becomes:

```
WHERE
  (name ILIKE '%payments%' OR description ILIKE '%payments%' OR ...)
  AND
  (name ILIKE '%refactor%' OR description ILIKE '%refactor%' OR ...)
```

`ilike` is Drizzle-supported on Postgres; SQLite's `like` is case-insensitive for ASCII. We use `like` via the same helper, accepting a small loss of case-insensitivity for non-ASCII on SQLite — acceptable for V1.

**Escaping:** wrap each token in `%`s with literal `%` and `_` in the token escaped (`token.replace(/[\\%_]/g, '\\$&')`). Drizzle's `like` accepts an `escape` op.

**Cardinality safeguard:** add `$limit: 25` per entity type in the search query (cap from the client). Each section displays 5 with "See all →"; we fetch up to 25 so "See all" doesn't immediately require another round-trip.

### 5.4 RBAC: ride the existing predicate

For worktrees, the `search` filter param goes through `findAccessibleWorktrees(userId, filter)` (`worktrees.ts:522-556`). Sessions and artifacts join through worktree visibility — `WHERE session.worktree_id IN (SELECT worktree_id FROM ...accessible...)`. Boards are accessible-by-default per current behavior.

When `execution.worktree_rbac: false`, the existing bypass in service registration applies; search inherits it for free.

### 5.5 Ranking (V1 = none, V2 = weighted)

V1 orders results within each section by `updated_at DESC`. No relevance score.

V2 introduces a simple weighted score: number of tokens matched × column weight, broken by recency. This requires summing match counts; with LIKE that's expensive (re-evaluating predicates). The right time to do it is when we move to real FTS (§5.7).

### 5.6 Required new code beyond search itself

One unavoidable adjacent change: SessionCanvas must read a `?focus=<id>&type=<entityType>` query param and pan/zoom-and-ring-highlight the matching node. Without it, search clicks are anticlimactic (you land on the right board but have to scan for the thing). This is bounded — single component touch — and called out as in-scope for V1.

### 5.7 Migration path to real FTS (V2)

When we want message search and ranking, we add:

- **Postgres:** generated `tsvector` columns + GIN indexes per entity, populated from the same SEARCHABLE_FIELDS list, weighted with `setweight(to_tsvector('english', name), 'A')` etc.
- **SQLite:** FTS5 virtual tables shadowing the same fields. Sync via triggers or in-app on write.
- A `RepositoryFTS` mixin produces the right dialect-specific clause.
- The `searchable-fields.ts` registry stays the source of truth; only the query builder changes.

Critically, no API shape change is needed — the client still posts `?search=foo` and gets ranked results back. The lift is real (writes to all four entity types need to keep the index fresh) but isolated.

### 5.8 Server load and rate limiting

V1 risk is low (in-memory adapter + small datasets), but two safeguards land in V1:
- **Min query length:** 2 chars. Below that, return only recents.
- **AbortController** on the client cancels in-flight requests when the query changes.
- No explicit server-side rate limit in V1; revisit when FTS makes individual queries cost real time.

---

## 6. "Owned by me" filter semantics

The chip is ON by default, applies `owned-by-me` on top of RBAC visibility. Per-entity definitions:

| Entity   | "Owned by me" =                                                                          | Edge cases / notes                                                                                                |
|----------|------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Worktree | `worktrees.created_by = userId` OR `worktree_owners.user_id = userId`                    | Co-owners count. RBAC `others_can` does not count as ownership for this chip.                                     |
| Session  | `sessions.created_by = userId`                                                           | Per §2.6, `created_by` is the **caller** of the spawn unless `dangerously_allow_session_sharing` is on. Honest.   |
| Artifact | `artifacts.created_by = userId` (optional column; null = no one owns it)                 | If `created_by` is null, the artifact is *not* mine. Surfaces in "owned by me OFF" view.                          |
| Board    | `boards.created_by = userId`                                                              | Boards are intentionally creator-owned with no co-owner concept today. The chip just filters by creator.           |

**UX note:** ownership is shown via a small avatar at the right of each row. With "owned by me" ON, you see only your avatar; with it OFF, other people's avatars give a quick visual scope cue.

---

## 7. Sessions hierarchy: title vs messages

**Recommendation:** V1 searches `sessions.title` and `sessions.description` only. The dropdown's Sessions section shows those matches. Messages search is **explicitly V2**.

**Why two phases:**
- Title/description search is cheap and high-precision. Most users searching "payments" want a session about payments, not every session whose model said "payments" once.
- Message search at scale needs real FTS — LIKE on millions of message rows will be slow even with the current in-memory adapter (and worse once we push filtering into SQL). Punting it lets V1 ship without solving FTS.
- The dropdown shape doesn't change between V1 and V2: when message-search lands, the Sessions section gets a *sub-filter chip* "Also search messages" (default off; remembered in localStorage). Hits where the match is in messages render with a small message-snippet secondary line instead of the description.

We are not making this a hierarchy of *types* ("Session titles" + "Session messages" as two sections). One Sessions section with a toggle keeps the dropdown legible.

---

## 8. Phased rollout

### V1 — this proposal's implementation
- Navbar input + dropdown (recents + sectioned results).
- Entities: worktrees, sessions (title/description), artifacts, boards.
- "Owned by me" chip (default ON), "Type" multi-select chip.
- `Cmd+K` / `Ctrl+K` focus shortcut.
- localStorage recents (extends `useRecentBoards` pattern).
- SessionCanvas honors `?focus=<id>&type=<entityType>`.
- No feature flag. The feature is small enough to ship behind code review only; gating UX-only additions behind config flags is friction.

### V2
- Message search behind a Sessions sub-filter (needs FTS — see §5.7).
- Add cards and board comments as entity types.
- Add MCP servers, repos, users (admin-only) — these open modals instead of navigating to boards.
- "See all" full-results page (`/search?q=...`).
- Optional: replace per-entity fan-out with unified `/search` endpoint once FTS ranking lands.

### V3+
- Semantic search (embeddings on sessions / artifacts) — requires choosing an embedding store and a refresh strategy.
- Saved searches (named, shareable).
- Agent-callable `agor_search` MCP tool — agents in a session can search the workspace.
- Backend `last_accessed_at` for cross-device recents.

---

## 9. Open questions for Max

1. **Default scope of "owned by me":** is the proposed definition (creator + worktree_owners for worktrees; creator only for sessions/artifacts/boards) right, or do you want co-owner semantics extended to sessions/artifacts in V1?
2. **Boards in V1:** boards are nearly free (`packages/core/src/db/repositories/boards.ts:261-292` is a one-table scan, low cardinality) — proposing them as a V1 freebie. Confirm?
3. **`?focus=<id>` scope:** I'm calling SessionCanvas focus-on-id in-scope for V1 because search clicks otherwise feel half-baked. It's bounded (one component, one URL param) but is a board-side change. OK?
4. **Recents implementation:** localStorage-only for V1 (no backend tracking). Trade-off: no cross-device recents, no recents for users-on-mobile-then-laptop. Acceptable for V1?
5. **Boards/cards distinction:** cards as a V2 type include note-cards, markdown-cards, etc. Is searching note-card content (`cards.note` per `cards.ts` schema) something you want eventually, or are notes considered private?
6. **Keyboard shortcut:** `Cmd+K` / `Ctrl+K` is unclaimed but might collide with a planned command palette. Reserve for search, or save for palette?
7. **Per-entity weights:** I have weights in the static registry but unused in V1. Keep them as forward-looking metadata, or drop until V2 actually needs them?

---

## 10. Out of scope

The following are **not** part of this proposal:

- A command palette (`Cmd+K` opens search, not a command surface).
- Redesigning the navbar or boards sidebar.
- Replacing the BoardSwitcher.
- Backend activity log / `last_accessed_at` columns.
- Semantic search / embeddings (V3 territory).
- Server-side recents.
- A unified `/search` HTTP endpoint (deferred until V2 ranking arrives).
- Search analytics / telemetry.
- Saved / shareable searches.
- Searching across organizations or multi-instance federation.
- Searching message *content* (V2; needs FTS).
- Mobile-specific UX (Agor UI is desktop-first).

---

## Appendix — concrete file changes V1 will require (for reviewer's mental model only; not committing them here)

- `packages/core/src/search/searchable-fields.ts` — new.
- `packages/core/src/db/repositories/worktrees.ts` — extend `findAll` / `findAccessibleWorktrees` to accept `search` + `ownedByMe`.
- `packages/core/src/db/repositories/sessions.ts` — add `search` path (LIKE on title + description).
- `packages/core/src/db/repositories/artifacts.ts` — add `search`.
- `packages/core/src/db/repositories/boards.ts` — add `search`.
- `apps/agor-daemon/src/services/worktrees.ts` — extend `WorktreeParams` with `search?: string`, `owned_by_me?: boolean`.
- `apps/agor-daemon/src/services/sessions.ts` — same.
- `apps/agor-daemon/src/services/artifacts.ts` — same.
- `apps/agor-daemon/src/services/boards.ts` — same.
- `apps/agor-ui/src/components/GlobalSearch/` — new dir: `GlobalSearch.tsx`, `GlobalSearchDropdown.tsx`, `ResultRow.tsx`.
- `apps/agor-ui/src/hooks/useGlobalSearch.ts` — new orchestrator with debounce + AbortController.
- `apps/agor-ui/src/hooks/useRecentEntities.ts` — new, mirrors `useRecentBoards.ts`.
- `apps/agor-ui/src/components/AppHeader/AppHeader.tsx` — insert `<GlobalSearch />` after `RecentBoardPills`.
- `apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx` — read `?focus=<id>&type=<entityType>` from URL and pan/zoom.

No new database migrations. No new tables. No config flags. No new dependencies.
