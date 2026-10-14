# User-first, board-scoped hydration

Status: implemented (PR #2952); the plan and evidence live in the PR.
`UI` = `apps/agor-ui/src`, `core` = `packages/core/src`.

The browser never loads the whole workspace. It loads three layers:

1. **Global light data**, gated at first paint on every route: lean boards,
   users, repos, card types and **all board comments** (Home's comment rule
   scans them all). MCP servers, gateway channels, artifacts and tool
   settings load in the background (`runHydration`, skip-apply-on-race).
2. **The user scope** (`UI/store/userScope.ts`): everything Home and the
   teammate surfaces read, complete for the caller.
3. **Board partitions** (`UI/store/boardPartitions.ts`): one board's
   branches, sessions, board objects, cards and full record.

Everything else (search hits, deep links, genealogy, settings tables) is
read on demand and kept only while a view pins it.

## Invariants

- **I1. Presence is not completeness.** Only a coverage entry says a set is
  complete. Surfaces that infer from absence gate on
  `makeBoardReadySelector` or the user-scope selectors.
- **I2. A load never overwrites a live write** (per-id fence, below).
- **I3. No read widens RBAC.** Every new daemon read composes the existing
  visibility predicates with the tenant condition.
- **I4. Home's readiness means "the user scope is complete",** never "the
  workspace is loaded".
- **Every session list read is lean** (`UI/store/sessionListQuery.ts`).
  `sessionById` is never the source for the withheld `custom_context` keys;
  the open session reads them from `sessions.get`.

## User scope

| Piece         | Read                                                                                        | Coverage key                                 |
| ------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Gated (paint) | `sessions{created_by: me, archived:false, $sort:{updated_at:-1}, $limit:200, $count:false}` | `user:sessions` if < 200 rows and none raced |
| U1            | the same with `$limit: PAGINATION.MAX_LIMIT` (10,000), one read                             | `user:sessions`                              |
| U2            | `branches{created_by: me, archived:false}`                                                  | `user:branches`                              |
| U3            | `branches{teammate:true, archived:false, $limit: MAX_TEAMMATE_BRANCHES}`                    | `user:teammates`                             |
| U5            | `branches{branch_id:{$in}, archived:false}` for referenced ids still absent                 | `user:references`                            |

- U1 is one read, not offset pages: `findPage` has no keyset cursor, so an
  archive during a paged read would skip a row. On a session route only U1
  waits for the opened transcript; U2, U3 and U5 never do.
- **References** are the branches of my active sessions and of candidate
  comment threads (unresolved, board not archived, someone else spoke and I
  did not speak last). A store subscription installed before the first read
  ensures new references: debounced 100 ms, chunks of `MAX_ID_LIST`, at most
  3 reads in flight, run-owned retry with capped backoff. Ids the server does
  not return go into `absentBranchIds`; a branch arriving by any path clears
  its mark, and marks are revalidated at the start of every run.
- **Fork ancestors of other users are not fetched** (decision Q4). A clean
  run forked from someone else's session does not supersede a failure on
  Home. Documented at `startedByUserLineage` (`UI/store/homeSelectors.ts`).
- Selectors: `selectMySessionsLoaded`, `selectMySessionsTruncated` ("N+"
  counts, no "All caught up"), `selectHomeBranchesLoaded`,
  `selectTeammatesLoaded`, `selectTeammatesTruncated`. A failed piece stays
  unloaded (its surface keeps its loading state) until the next run.

## Scopes, coverage and membership (`UI/store/scopeMerge.ts`)

- `coverage: Map<ScopeKey, ScopeCoverage>` holds every scope: `board:<id>`
  and the four `user:*` pieces. An entry has a status, the load lifetime, a
  `generation` (only a new load changes it) and, once loaded, its committed
  `members` and `complete` (false for a capped read).
- **Membership** is the ids the read returned, corrected for rows realtime
  wrote while it was in flight (`settledMembers`), then kept live by
  realtime in the same store update as the row (`liveMembership`).
  `user:references` stores none; it derives them (`referenceMembers`).
- A board is ready only when its partition is `loaded` from a complete read.
  A branch arriving from an unloaded board marks the partition incomplete and
  requests a debounced reload (`requestBoardReload`).

## Applying reads

- **Per-id touched fence.** Every realtime write stamps the id with the
  revision it produced (`bumpRevision`). A load captures its start revisions
  before its first await (`beginPartitionLoad`) and skips every row touched
  since. A snapshot is never discarded for churn, so loads cannot starve.
- **`replaceScope`** (partitions, every reconnect, U1–U3 on reconnect):
  overwrites untouched rows from the snapshot and, for a complete read,
  removes untouched rows the scope claims that the snapshot omits, unless
  another scope's committed members or a pin hold them
  (`otherCommittedMembers`). A capped read removes nothing. Archived sessions
  (deep-link targets) are outside every list and are kept.
- **`applyEntityFill`** (first-run user scope, on-demand reads): inserts
  absent rows only. On-demand rows are admitted only while something holds
  them (`admitHeld`).
- Session↔MCP links load per session on first need
  (`UI/store/sessionMcpLinks.ts`), fenced per (session, server) pair; edits
  are refused until that session's links are loaded, because "not loaded" is
  not "none attached".

## Retention and pins

- A row stays while some scope or pin holds it (`UI/store/retention.ts`).
  Rows leave only at natural points: an LRU eviction, a pin release, the end
  of a reconnect resync. Never on a timer.
- **LRU.** `useBoardPartition` registers each mounted use. The LRU keeps the
  displayed board plus `RETAINED_BACKGROUND_PARTITIONS` (3) most recently
  used background partitions, mounted ones first, and never evicts a mounted
  or loading one. Eviction is `replaceScope` with an empty snapshot over the
  board's rows, counting stale-lifetime scopes as holders so a disconnect
  never frees my rows. Evicted sessions' MCP links go with them.
- **Pins** (`UI/store/rowPins.ts`): ref-counted ids of rows a mounted view
  displays — the open session and its branch, route targets, `useEnsureRows`
  ids, search results. A view pins new ids before releasing old ones; a
  release evicts what it unpinned that nothing else holds.
- **Entry rule.** A realtime write or on-demand fill inserts a row only if a
  pin or a current loading/loaded scope would hold it.
- **Foreground priority** (`UI/store/backgroundReads.ts`): the open
  transcript and the displayed board hold background partition reads (≤10 s).

## Load lifetime and reconnect

- Every async load captures a **load lifetime** (`UI/store/loadLifetime.ts`:
  authority scope + cancellation epoch) before its first await and checks it
  after every await. Unmount, authority change and logout bump the epoch.
  Each loader adds its own generation for supersession within a lifetime.
- **Authority change** (identity, role, auth generation): stops the user
  scope, resets session-MCP links and unloads every partition; an identity
  change also clears every map.
- **Reconnect resync** (`useAgorData` silent fetch): re-reads the light
  globals and comments, reconciles the displayed board in place, unloads
  every other partition, and re-runs the user scope as a replace. Once the
  user scope settles, rows of the unloaded boards and of scopes the resync
  did not replace are evicted unless something else holds them.

## Board write guard (`UI/store/boardMutationGuard.ts`)

An unloaded board is read-only: a write derived from stale rows could
restore a deleted zone or persist a wrong pin.

- A **ticket** is captured when work is queued or its dialog opens. It
  records the board, the partition `generation` (when the write needs one),
  the socket-auth generation and the owning guard.
- Every dispatch, including each one after an await, checks the ticket:
  owner mounted, connection usable (connected, not connecting, not out of
  sync), same auth generation, partition still loaded under the same
  generation. An unload/reload changes the generation, so an old ticket never
  matches again.
- `hasBoardWriteTicketEnded`: the ticket can never be current again (owner
  unmounted, reauthenticated, board unloaded), unlike a passing disconnect.

## Daemon reads and RBAC

All filters are SQL fast-path keys that `AND` with the caller's visibility
predicate and the tenant condition; none grants access.

| Read                                        | Visibility                                                     |
| ------------------------------------------- | -------------------------------------------------------------- |
| `sessions{created_by}`, `session_id: {$in}` | `inVisibleBranchSet` + tenant                                  |
| `branches{created_by}`, `branch_id: {$in}`  | `visibleBranchAccessCondition` + tenant                        |
| `branches{teammate: true}`                  | marker condition on `findPage`, composes; real `total`         |
| `sessions`/`branches{search}`               | visibility applied before the text is read (`searchCondition`) |
| `branch-counts.find()`                      | visible branches on visible boards; `scoped`, never published  |
| `session-counts.find({ group_by })`         | sessions on visible branches; `scoped`, never published        |

- `search` uses the shared `SEARCHABLE_FIELDS` and token rules
  (`core/search/searchable-fields.ts`), so server and client match the same
  rows. The haystack is built only for rows the caller can see, so hidden
  rows cost nothing (no timing oracle).
- `branch-counts` takes no filters (one sent is rejected) and is refetched,
  debounced, on branch events (`UI/hooks/useBranchCounts.ts`);
  `session-counts` takes only `group_by` (`branch_id` or `board_id`) and
  backs the settings tables' counts (`useSessionCounts`).
- Cross-tenant and capability-negative tests cover every key
  (`core/db/repositories/user-scope-reads.*`, `sessions.visibility-parity.*`).

## Caps

| Cap                                 | Value  | At the cap                                 |
| ----------------------------------- | ------ | ------------------------------------------ |
| Gated my-sessions page              | 200    | U1 runs                                    |
| U1 (`PAGINATION.MAX_LIMIT`)         | 10,000 | `mySessionsTruncated`; counts render "N+"  |
| `$in` ids (`MAX_ID_LIST`)           | 200    | validator rejects more; clients chunk      |
| Teammates (`MAX_TEAMMATE_BRANCHES`) | 1,000  | `teammatesTruncated`; lists are partial    |
| Search tokens (`MAX_SEARCH_TOKENS`) | 8      | rejected by the daemon; the client sends 8 |

## Accepted limitations

- Fork-retry supersede across owners (Q4, above).
- Grants appear only after a reconnect or reload.
- The client applies every realtime event it receives. Daemon-side per-board
  watch narrowing is a follow-up, modelled on `presence:subscribe-boards`.
- No mixed-version support: a new UI against an older daemon sees its new
  reads rejected like any failed read; first paint still completes and the
  affected surfaces stay in their loading state.
- Recent-board activity dots count only my sessions (decision Q1).
