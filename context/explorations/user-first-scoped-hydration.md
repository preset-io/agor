# User-first, board-scoped hydration

Status: design, revision 3 (2026-10-01), with Kamil's decisions applied (see below).

> **r3 decisions, 2026-10-01** (Kamil; they override any recommendation below that disagrees):
>
> - **Q1 — activity dots:** recent-board activity dots show only **my** running and needs-you sessions (`makeOwnBoardActivitySelector`).
> - **Q2 — branch-count badges are kept** (board switcher and mobile nav tree). Add **one** minimal RBAC-scoped aggregate: the count of active (non-archived) branches per board visible to the caller. It composes `visibleBranchAccessCondition` and the visible-board predicates with the tenant condition, is classified `scoped`, is never published, and has cross-tenant and capability-negative tests. Daemon part in **1.3**; client use in **3.2** (until then the badges may keep deriving from loaded branches). The client refetches it, debounced, on branch create/archive/move/remove events.
> - **Q3 — power users:** all of my active sessions load in **one** lean read (U1), capped at 10,000; at the cap `mySessionsTruncated` is set and counts render as "N+".
> - **Q4 — fork ancestors are not fetched.** U4 and its tests/scenario are dropped. A retry forked from **someone else's** session no longer clears a failure; this is an accepted, documented limitation (§3.3, and a code comment near `startedByUserLineage`). `mySessionsLoaded` is set after U1.
> - **Lean dependency:** PR #2887 replaces #2946 (abandoned). §11 is rewritten for #2887.

- **Base:** `main`, which now contains the agent-first Home stack (#2905 → #2906 → #2901 → #2907) and lean PR #2887. The analysis below was done on the stack tip `6f8f538b`.
- **Delivery:** one branch and one PR, reviewable commit by commit.
- **Implementation status:** Steps 1 (1.1–1.5) and 2 (2.1–2.2) are implemented on this branch, which is based on `main`. Session list reads go through `sessionListQuery` and are lean. The previous revision's 1.3 (edits to the old Home sections) is abandoned.
- **Step 1 review fixes (2026-10-01):** contracts that changed after review, in the code:
  - Every load (first paint, user scope, partitions) is fenced by a **load lifetime** (`store/loadLifetime.ts`: authority + cancellation epoch, captured before the first await). The user scope and partition records carry the starting load's lifetime.
  - The first-paint/resync wholesale apply keeps every id touched by a live event during the load; a gated page that raced my own sessions never skips U1.
  - Partition entries are owned by their load and released on cancellation; no fill-only load applies across a wholesale replacement (a retryable error instead).
  - References: subscription before the first read, early pass for every gated page, at most 3 `$in` reads in flight, a run-owned retry queue, absent marks revalidated per run.
  - Older daemon: rejected (400) or ignored keys put the scope in a terminal degraded state (`userScopeDegraded`); until 3.3 the global snapshots complete the flags (§10.2).
  - Caps are visible: `mySessionsTruncated` renders "N+" and suppresses "All caught up"; the teammate read reports its real `total` and sets `teammatesTruncated`.
  - On `/s/`, only U1 waits for the opened transcript.
- **Step 2 (2026-10-02):** implemented. Contracts that differ from §4.3–§4.5 and §6 as written:
  - Two shared reducers in `store/scopeMerge.ts`, both per-id fenced: `fillScope` (insert absent rows only) and `replaceScope` (also overwrite present rows and remove rows the scope claims that the snapshot omits). A row is removed only when no other loading/loaded scope claims it (`otherLoadedScopes`: board partitions, the user scope, and until 3.3 the global session/branch sets). Membership is a predicate on the current store row, not a per-load record.
  - Partition loads fill branches and sessions (the global sets own them until 3.3) and reconcile board objects, cards and the full board record, so reopening an unloaded board drops stale rows.
  - A reconnect reconciles the displayed board in place (board objects and cards read by `board_id`, one `boards.get`, a lean boards list) and unloads every other board. Home reads no board objects, cards or full boards. A board is ready only when its partition is loaded.
  - Session↔MCP links: the touched fence is per (session, server) pair for `created`/`removed` and per session for a `patched` complete selection. `updateSessionMcpServers` refuses a session whose links are not loaded; a reconnect or authority change marks every session unloaded.
  - Settings → Cards reads its own set when opened (all cards, card placements, `boards.get` for zone names). The mobile board page gates its empty states on `boardReady`.

Paths are repo-relative: `UI` = `apps/agor-ui/src`, `D` = `apps/agor-daemon/src`, `core` = `packages/core/src`. `UI` line numbers refer to the stack tip. Daemon and core line numbers refer to `main`; the stack changes only `core/types/user.ts` there.

## 0. Summary

Today the UI paints a slice of data first, then pulls in the whole workspace in the background ("global hydration"). The new Home relies on that background pass for its counts, its teammate lists and its "missing branch means archived" rule. The pass is slow and starves under agent streaming.

This design loads three layers instead:

1. **Global light data, loaded eagerly.**
   - Lean boards, users, repos and card types.
   - **All board comments.** They are small, and Needs you's comment rule scans them all.
   - The small workspace collections that already load in the background.
2. **User scope: everything Home and the teammates surfaces read, loaded in full for the caller.**
   - All of the caller's active sessions. The 200 newest are gated; the rest load right after paint.
   - The caller's branches, all visible teammate branches, and every branch the caller's sessions or comment threads point at.
3. **Board partitions, loaded when the board opens.** A partition is one board's branches, sessions, board objects, cards and full board record.

Realtime keeps applying every event; presence in the store never implies completeness. Loads use a fill-only merge with a per-ID touched fence, so they never discard a snapshot and never starve. The stack's `sessionsHydrated`/`branchesHydrated` flags are replaced by flags that mean exactly "this user-scoped set is complete".

**One small server aggregate.** The board grid, stats bar and activity feed that needed a summary are gone with #2901. Board emoji come from `board.icon`, and every teammate branch is now loaded. Branch-count badges are the only thing that still needs one; per decision Q2 they are kept, backed by one RBAC-scoped per-board count of active branches (§7).

**Delivery.** One PR in 3 steps and 11 commits: additive first, removals last, no migration, no feature flag. Land it after the stack and after lean PR #2887 (§11).

| Step                                         | Commits | State if the branch stopped here                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. User-first**                            | 1.1–1.5 | Kamil's three symptoms fixed. Home rows and the recent-boards fallback appear at first paint after a localStorage clear. Counts and teammates are ready within about 2 round trips after paint instead of after the global quiet window. Opening a board fills its partition in one fetch. Global hydration still runs (heap about 121 MB). |
| **2. Annotations and session-MCP on demand** | 2.1–2.2 | Board objects, cards and full board records load per board; session↔MCP links load per session. Heap about −11 MB; network about −10 MB+.                                                                                                                                                                                                   |
| **3. Sessions and branches on demand**       | 3.1–3.4 | Search moves to the server and the global session and branch hydration is removed. Home heap about 32–40 MB; network about −24 MB more.                                                                                                                                                                                                     |

## 1. Diagnosis on the stack (verified at `6f8f538b`)

| Symptom                                                                                                               | Root cause on the stack                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. After a localStorage clear on a busy workspace, Needs you and My work are empty or partial, and counts arrive late | The buckets scan `sessionById` for `created_by === me` and not archived. First paint holds only the **global** 50 most recent sessions, so the caller's sessions are often absent. The counts wait for `sessionsHydrated && branchesHydrated`, which are set only when the global hydrations apply. Those discard whole snapshots on any concurrent write. | `UI/store/homeSelectors.ts:272-273`; `UI/hooks/useAgorData.ts:106`, `:628`, `:1025-1027`, `:1044-1046`; `UI/components/HomePage/HomePage.tsx:118`; `UI/store/agorHydration.ts:256-286` |
| 2. Recent boards are missing or wrong                                                                                 | Visit history is per-user localStorage, which was cleared. The fallback is `buckets.boardIds` (boards of the caller's latest sessions), so it has the same absence problem as symptom 1.                                                                                                                                                                   | `UI/hooks/useRecentBoards.ts:15-16`; `HomePage.tsx:272-283`, `:473`; `homeSelectors.ts:275-278`                                                                                        |
| 3. The board drawer has no sessions for a few seconds                                                                 | Switching boards fetches nothing, and the drawer waits for the global hydration. Also, a teammate branch that simply isn't loaded yet reads as "inaccessible".                                                                                                                                                                                             | Fixed by the existing commit 1.2 (§4). `UI/components/App/App.tsx:1195` still reads `primaryTeammateId && !primaryTeammateBranch` on the stack.                                        |

New dependencies on global data introduced by the stack:

- **Teammates.** `makeTeammatesSelector` scans **all** branches (`homeSelectors.ts:517-538`). The rail (`HomeTeammates.tsx:37`), the directory (`TeammatesDirectory.tsx:40`) and the ask box (`HomeAskBox.tsx:64-73`) depend on it. The first two wait on `branchesHydrated`.
- **Comments for you.**
  - `makeCommentsForYouSelector` scans **all** comments (`homeSelectors.ts:380-484`).
  - It treats "branch missing and `branchesHydrated`" as "archived or gone" (`:432`).
  - It also needs the branch owner (`:456`) and whether a thread's session is the caller's (`:396`).
- **Supersede rule.** The supersede rule walks fork ancestors through `sessionById` (`startedByUserLineage`, `:159-180`). Ancestors can belong to other users, and a missing ancestor counts as "not user-started".
- **My work filter.** It matches branch and board names (`:142-152`), so it needs the branches of the caller's sessions.
- **Recent-board activity dots.** They read board objects plus session buckets, and count **anyone's** running or ready session (`HomeRecentBoards.tsx:17-21` → `UI/store/selectors.ts:199-222`).
- **Search "recents".** These list the caller's own branches (`GlobalSearch/useRecents.ts:47`).
- **Branch-count badges.** The board switcher and the mobile nav tree count branches across all boards (`BoardSwitcher/BoardSwitcher.tsx:83-92`; `mobile/MobileNavTree.tsx:68-104`, `:156`).
- **Not dependencies:**
  - Board emoji: Home calls `getBoardEmoji(board)` without branches; boards carry their own icon (`BoardTile.tsx:11-26`).
  - Withheld lean fields: no Home selector reads them.

Facts from the previous revision that still hold:

- **Sessions SQL fast path.** It models only `archived, status, board_id, branch_id, $sort, $limit, $count, $skip` (`D/services/sessions.ts:221-268`). Commit 1.1 adds `created_by`.
- **`$in` on IDs.** The validator declares `session_id` and `branch_id` as scalars, so `$in` on them is rejected (`core/lib/feathers-validation.ts:134-157`, `:324-335`).
- **RBAC composes.** RBAC is a SQL predicate on every list (`core/db/repositories/branch-access.ts:578-602`), so new filters compose with it by `AND`.
- **Teammate query exists but isn't exposed.** The daemon can already list teammate branches with RBAC: `BranchRepository.findTeammateBranches` (`core/db/repositories/branches.ts:579-626`; `visibleBranchAccessCondition` or `sessionBranchAccessCondition`). It is not reachable from `branches.find` (keys in `D/services/branches.ts:174-220`).
  - Its marker set is a superset of the client's: it also returns branches with an enabled schedule. The client keeps filtering with `getTeammateConfig`.
- **Rows and patches.**
  - Session rows carry `branch_board_id` (`core/db/repositories/sessions.ts:182`).
  - Realtime patches insert missing rows (`UI/store/agorMaps.ts:300-302`).
  - The canvas derives board membership from board objects (`UI/store/selectors.ts:117-131`).
- **Rollback constraint.** A daemon refuses to start when the database is ahead of its binary (`D/setup/database.ts:90-94`). This design therefore adds no migration (§10.3).

## 2. Target data model

| Collection                                                      | Stack tip                                                            | Target                                                                                                                                           | Step                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| boards (lean), users, repos, card-types                         | global, gated                                                        | unchanged                                                                                                                                        | none                    |
| board full record                                               | displayed board gated; all boards in background                      | per board (partition)                                                                                                                            | 2                       |
| **board-comments**                                              | board-scoped on board routes, global on Home; full set in background | **global and gated on every route**; not part of partitions                                                                                      | 1                       |
| sessions                                                        | global 50 most recent gated, full set in background                  | **my 200 newest (gated)**, **all of mine** after paint, **partition** on open, **by ID** on demand                                               | 1 (mine), 3 (rest)      |
| branches                                                        | displayed board's, or `[]` on Home; full set in background           | **mine** + **all visible teammates** + **referenced by my sessions or comment threads** (user scope), **partition** on open, **by ID** on demand | 1 (scope), 3 (rest)     |
| board-objects, cards                                            | board-scoped, or global on Home, gated; full set in background       | partition                                                                                                                                        | 1 (out of Home gate), 2 |
| session-mcp-servers                                             | global, background                                                   | per session (§6)                                                                                                                                 | 2                       |
| agentic-tool-settings, mcp-servers, gateway-channels, artifacts | global, background                                                   | unchanged                                                                                                                                        | none                    |

Invariants:

- **I1. Presence is not completeness.** Only an explicit flag says a set is complete: a partition status, or a user-scope flag.
- **I2. A load never overwrites a live row.** The fill-only merge with the touched fence applies to every load except the Step 3 reconnect replace (§3.8).
- **I3. No new data path widens RBAC.** Every new read composes the existing visibility predicates and the tenant condition.
- **I4. Home's readiness means "the user scope is complete".** It never means "the workspace is loaded".

## 3. User scope (new)

### 3.1 What loads before and after paint

| When                                 | Read                                                                                                                                    | Purpose                                                                                                             | Completes                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Gated** (light batch, every route) | lean boards, users, repos, card-types                                                                                                   | as today                                                                                                            | none                                                             |
| **Gated**                            | `board-comments` (global)                                                                                                               | Needs you comment rule, mobile bell, board badges                                                                   | always loaded at paint                                           |
| **Gated**                            | `sessions{created_by: me, archived:false, $sort:{updated_at:-1}, $limit:200, $count:false, lean:true}`                                  | Needs you and My work rows, running, recent-boards fallback **at first paint**. Replaces the global 50 most recent. | `mySessionsLoaded` immediately if it returns fewer than 200 rows |
| After paint (U1)                     | the same query with `$limit: 10000`                                                                                                     | complete set for exact counts and old unread results                                                                | `mySessionsLoaded` (`mySessionsTruncated` at 10,000 rows)        |
| After paint (U2)                     | `branches{created_by: me, archived:false}` (new key)                                                                                    | pills, search recents                                                                                               | none                                                             |
| After paint (U3)                     | `branches{teammate: true, archived:false, $limit:1000}` (new key → `findTeammateBranches`)                                              | rail, directory, ask-box switcher, board teammate picker, emoji fallback                                            | `teammatesLoaded`                                                |
| After U1, U2 and comments (U5)       | `branches{branch_id:{$in}, archived:false}` for branch IDs referenced by my sessions or candidate comment threads that are still absent | pills, My work filter, comment rules; IDs not returned go into `absentBranchIds`                                    | `homeBranchesLoaded`                                             |

- U1, U2 and U3 run in parallel. U5 follows U1 (and U2, U3 and comments). U4 (fork ancestors) is dropped by decision Q4.
- All of them apply with the fill-only merge and touched fence (§4.3), under the current authority scope.
- **On every route, not only Home.** Mobile's bell badge (`MobileApp.tsx:250`), global search "owned by me", and Home's instant render all depend on this scope.

### 3.2 Why load all of the caller's active sessions

| Home rule (`homeSelectors.ts`)                                                                                       | Sessions it needs                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Needs you: permission                                                                                                | mine with `AWAITING_PERMISSION` (few)                                                                  |
| Needs you: failed                                                                                                    | mine failed or timed out within 7 days (`:34`, `:300`), plus clean runs on the same branches           |
| Needs you: finished                                                                                                  | mine with `ready_for_prompt` that aren't failures. **No age window**, so old unread results count too. |
| My work: recent, running, and **exact** `recentCount` / `runningMatchCount` under the text and started-by-me filters | **every** active session of mine                                                                       |
| Mark all as read (`HomePage.tsx:381-383`)                                                                            | all of my unread results                                                                               |

**Server-side alternative, rejected.** Server queries per bucket would mean re-implementing the stack's supersede, grouping and lineage rules in SQL and keeping two implementations in sync.

**One read, not offset pages.**

- `findPage` has no keyset cursor. With offset paging, an archive during the read shifts later rows up, which skips a row and makes counts wrong.
- A single read avoids that.
- If U1 returns exactly 10,000 rows, `mySessionsTruncated` is set and counts render as "N+". This is not expected; measure first (Q3).

**Size.** About 0.87 KB per lean row (#2946's measurement): 1,000 own sessions ≈ 0.9 MB, 5,000 ≈ 4.3 MB. For comparison, today's global set is 20 MB.

### 3.3 Fork ancestors (supersede rule) — not fetched (decision Q4)

- **Rule:** `startedByUserLineage` walks fork ancestors through `sessionById`; a missing ancestor counts as "not user-started".
- **Decision:** the user scope does **not** fetch other users' fork ancestors (the former U4 is dropped). Ancestors the caller created are loaded by U1 anyway.
- **Accepted limitation:** a clean run forked from **someone else's** session no longer supersedes (clears) a failure on Home once global hydration is gone (Step 3). Until then global hydration may still load the ancestor. The limitation is documented in a code comment near `startedByUserLineage`.
- **Readiness:** `mySessionsLoaded` is set after U1.

### 3.4 Branch references and `absentBranchIds`

- **Which IDs:**
  - the `branch_id` of each of my active sessions;
  - the `branch_id` of each **candidate** comment thread: unresolved, on a board that isn't archived, with a reply by someone else after the caller's last word.
- **What U5 records:** any ID missing from `branchById` after U2 and U3 is read with `$in`, in chunks of 200. IDs not returned are recorded in `absentBranchIds` (archived, deleted or invisible). This is the precise version of the stack's "missing after `branchesHydrated` ⇒ archived or gone".
- **Clearing:** a branch row arriving by any path (event, partition, ensure) clears its absent mark.

### 3.5 Teammates

- **Query:** U3 exposes the existing RBAC-aware `findTeammateBranches` as `branches.find({ teammate: true })`. `minimumPermission: 'view'` matches `branches.find`'s visibility.
- **Client semantics:** unchanged. The client keeps `makeTeammatesSelector`'s `getTeammateConfig` filter, and superadmin board-policy filtering (`useBoardSharing`) is unchanged.
- **Side effects of loading every visible teammate branch:**
  - `primaryTeammateBranch` resolves before the board partition does;
  - `getBoardEmoji`'s teammate fallback works for any board;
  - the board-level teammate picker (`BoardTeammatePanel.tsx:200-222`) stays complete after Step 3.

### 3.6 Flags: replacing `sessionsHydrated` / `branchesHydrated`

New store meta, reset by `resetMaps` on an identity change:

- `mySessionsLoaded`: all of the caller's active sessions (set after U1; fork ancestors are not fetched, §3.3).
- `homeBranchesLoaded`: every referenced branch is present or in `absentBranchIds`.
- `teammatesLoaded`: every visible active teammate branch is present.
- `absentBranchIds`: the set described in §3.4.
- `mySessionsTruncated`: set only if U1 hits its cap.

| Stack item                                                                                     | Tip                                                                                  | Change (commit 1.5)                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgorMeta.sessionsHydrated`, `branchesHydrated` (`agorStore.ts:42-59`, `:171-172`, `:194-195`) | set by global hydration                                                              | **removed**                                                                                                                                           |
| `useAgorData` `markHydrated` calls (`:952-957`, `:1025-1027`, `:1044-1046`)                    |                                                                                      | removed                                                                                                                                               |
| `HomePage.selectHydrated` (`HomePage.tsx:118`)                                                 | `sessionsHydrated && branchesHydrated`                                               | `mySessionsLoaded && homeBranchesLoaded`                                                                                                              |
| `makeCommentsForYouSelector` (`homeSelectors.ts:397-432`)                                      | memo inputs include both flags; skip if the branch is missing and `branchesHydrated` | inputs `commentById, branchById, boardById, absentBranchIds`; skip if the branch is archived or `absentBranchIds.has(id)`                             |
| `makeHomeBucketsSelector` board lookup (`:275`, `:144`), `HomeMyWork.tsx:121-122`              | `branch_board_id ?? branch.board_id`                                                 | shared `boardIdForSession` (live branch first, as `mobile/sessionBoardId.ts:4-15` does). Fixes a stale board after a branch move.                     |
| `makeTeammatesSelector`                                                                        | global `branchById`                                                                  | code unchanged; its precondition is now `teammatesLoaded`                                                                                             |
| `HomeTeammates.tsx:37`, `TeammatesDirectory.tsx:40`                                            | `branchesHydrated`                                                                   | `teammatesLoaded`                                                                                                                                     |
| `HomeRecentBoards.tsx:17-21`                                                                   | `makeBoardSessionActivitySelector` (board objects, anyone's sessions)                | new `makeOwnBoardActivitySelector(userId)` over my sessions keyed by `boardIdForSession` (Q1). The favicon keeps the old selector for the open board. |
| `makeLatestOwnSessionSelector`, `MobileApp.tsx:238-245` running badge                          | my sessions                                                                          | unchanged; complete once `mySessionsLoaded`                                                                                                           |

The stack's contracts are preserved: counts wait, rows render immediately, teammates show loading, onboarding waits.

### 3.7 Keeping the scope complete under realtime

- **Covered by events:**
  - My session created, patched or archived: events are applied globally (§5).
  - A teammate created, marked or archived: branch events.
  - A new comment: global comments.
- **Not covered by events:** new **references**, such as a new session of mine or a new comment thread on a branch that isn't loaded.
  - A store subscription in `store/userScope.ts`, outside React, diffs referenced branch IDs against `branchById ∪ absentBranchIds ∪ pending`.
  - It calls the batched `ensureBranches` (debounced about 100 ms, chunks of 200).
- **Grants:** a branch that becomes visible through a grant has no realtime event, so it appears after the next reconnect or reload. Global hydration has the same limit today.

### 3.8 Reconnect

- **Steps 1–2:** the global silent resync stays the authoritative backstop. The user-scope reads re-run (fill-only) and the flags stay true, so nothing flickers.
- **Step 3:** reconnect runs a **scope replace** for the user scope and the displayed partition. For rows in scope (for example `created_by = me` and active, or the teammate marker):
  - untouched present rows are overwritten from the snapshot, through lean's guarded reconciliation (§11);
  - untouched rows missing from the snapshot are removed;
  - touched rows keep their live value.
- **Other partitions** are unloaded (§4.5).

## 4. Board partitions (commit 1.2, adjusted)

### 4.1 State

```ts
boardPartitions: Map<BoardID, { status: 'loading' | 'loaded' | 'error'; authorityScope: string; error?: string }>;
// Steps 1 only: global collections that have applied once (comments excluded — always global).
globallyHydrated: Set<'sessions' | 'branches' | 'boardObjects' | 'cards' | 'boards'>;
selectBoardReady(boardId) = status === 'loaded' || all five in globallyHydrated;  // shortcut removed in 2.2
```

### 4.2 Trigger

- `useBoardPartition(client, boardId, …)` is mounted in `components/App/App.tsx` and `MobileApp.tsx`.
- Loads are deduplicated per board.
- The authority scope is captured from `realtimeBatch`, then checked again before apply.
- A partition runs five queries:
  - `branches{board_id, archived:false}`
  - `sessions{board_id, archived:false, lean:true}`
  - `board-objects{board_id}` (members only)
  - `cards{board_id}`
  - `boards.get(board_id)`
- **Comments are no longer part of a partition.** They are global; commit 1.4 removes them from the 1.2 implementation.

### 4.3 Fill-only merge with a per-ID touched fence

- **Stamps:** `bumpRevision(collection, id?)` and `touchedSince(collection, id, rev)` stamp IDs in `agorRealtimeActions.ts`, in `realtimeBatch.enqueueSessionPatch` at enqueue time, and in the store cascades.
- **Insert rule:** a snapshot row is inserted only if its ID is absent and untouched since the load started.
- **Removed branches:** rows whose branch was touched and is now absent are skipped.
- **Never overwrites:** present rows are left alone.
- **Board record:** the full record replaces the lean one unless the board was touched.
- **No starvation:** a snapshot is never discarded. The same merge serves the user-scope reads and the `ensure*` loaders.

### 4.4 UI states

- `primaryTeammateInaccessible` requires `boardReady`.
- `BoardTeammatePanel` and `SessionCanvas` show loading states.
- An error state offers retry.

### 4.5 Caching and reconnect

- No eviction.
- **Step 2:** a reconnect refetches board objects and cards for the displayed board only.
- **Step 3:** a reconnect replaces the displayed partition and the user scope (§3.8). Other partitions are marked unloaded and their non-scope rows dropped.
- Add an LRU only if the S11 measurements call for it.

## 5. Realtime

- **The daemon is unchanged.** Board-scoped events reach every connection whose user can view the branch or board (`D/utils/realtime-publish.ts:935-1173`). HA re-runs delivery on each daemon (`:1247-1289`). This PR changes no channel or publish code.
- **The client applies every event.** Change is bounded by activity; history is what we stop loading. Filtering on the client would save no wire cost and would reopen load-versus-drop races.
- **Board lookups** use `boardIdForSession` (live branch first).
- **A branch moving onto a ready board** gets its sessions filled (Step 3).
- **Follow-up, not in this PR:** daemon-side per-board watch narrowing. Model it on `presence:subscribe-boards` (`D/setup/socketio.ts:1223-1298`), narrowing only after RBAC.

## 6. `session-mcp-servers` (commit 2.1)

- **Change:** remove the global fetch. `useSessionMcpServerIds(sessionId)` reads `session-mcp-servers.find({ session_id })` on first need. The read uses the fence, records the session in `sessionMcpLoaded`, and realtime events still apply.
- **Readers:** they are all single-session (`App.tsx` → `SessionPanel`, `SessionMcpFooterControl`, `SessionSettingsModal`, `mobile/SessionPage`).
- **Edit controls** stay disabled until the session is loaded, because the update diff (`UI/utils/sessionMcpServers.ts:4-30`) treats "not loaded" as "none attached".

## 7. Features that assume the store is complete, and their replacements

The commit that delivers each replacement is in brackets.

- **Home: Needs you, My work, greeting counts, recent-boards fallback, onboarding gate.** User scope [1.4, 1.5].
- **Home ask box and teammate switcher, rail, `/teammates` directory, board teammate picker.** `teammatesLoaded` [1.4, 1.5].
- **Comments for you** (Home, mobile bell, phone Needs you landing). Global comments plus `absentBranchIds` [1.4, 1.5].
- **Recent-board activity dots.** Built from my sessions [1.5]. Q1 asks whether to keep them team-wide instead.
- **Board-emoji fallback.** `board.icon`, or loaded teammate branches. No change needed.
- **Branch-count badges** (`BoardSwitcher.tsx:83-92`, `MobileNavTree.tsx:156`). **Kept** (decision Q2), backed by this design's only aggregate: an RBAC-scoped count of active branches per board visible to the caller [daemon 1.3, client 3.2]. Until 3.2 the badges keep deriving from loaded branches. The client refetches the counts, debounced, on branch create/archive/move/remove events. The mobile tree's comment counts stay (comments are global).
- **GlobalSearch.**
  - New `search.find({ q, types:['sessions','branches'], owned_by_me, $limit })` [3.1]. It applies the shared `SEARCHABLE_FIELDS` and `matchSearchTokens` (`core/search/searchable-fields.ts:34-73`) to rows already narrowed by the visibility predicates.
  - Local hits show first; server hits merge after a 250 ms debounce [3.2].
  - Recents (my sessions and branches) come from the user scope.
- **Session genealogy.** Fork and spawn trees are per branch. Cross-board remote-create targets use `ensureSessions` (`$in`); callback and parent titles use a lazy `get` [3.2].
- **Deep links.**
  - `/s/`: use `boardIdForSession`, and recenter once the board is ready [1.5].
  - `/w/`: on-demand `branches.get` after load [3.2].
  - Short ID not found or ambiguous: fall back to a server `get` [3.2].
  - `/b/` and `/a/`: unchanged.
- **Mobile.**
  - The shared Home and the bell come from the user scope.
  - Nav tree: branches and sessions load per expanded board through `useBoardPartition` [3.2].
  - Assistant tab: `sessions{branch_id: teammate}` [3.2].
- **Settings tables.**
  - Cards: fetch on open, plus `boards.get` for the zone names they reference [2.2].
  - Branches, Teammates and gateway `BranchSelect`: server-paginated fetch on open [3.2].
- **Unchanged:** facepiles (presence), schedules (server), branch-removal comment rehydrate (comments stay global).

## 8. Implementation sequence (one branch, one PR)

Rules for every commit:

- **Green and usable.** Typecheck, lint and tests pass. The app works on `sqlite` and `rich`.
- **Tests travel with the code.** Each commit's tests ship in the same commit.
- **Order.** Replacements land before removals. The removal commits (2.2 and 3.3) touch nothing else.
- **Commit messages.** Each body states its "after" invariant.

### Step 1: user-first

**1.1 `feat(sessions): SQL fast path for created_by`** _(exists)_

- `created_by` joins the sessions fast-path keys, and `findPage` gets `createdBy`.

**1.2 `feat(ui): board partition loads with per-ID touched fence`** _(exists; rebasing)_

- §4 as built. Commit 1.4 takes comments out of the partition.

**1.3 `feat(daemon): ID-list reads and user-scope branch keys`**

- **Sessions:** `session_id: {$in}` in the validator and in `findPage.sessionIds`.
- **Branches:**
  - `branch_id: {$in}` in the validator (the fast path already supports it).
  - New fast-path keys `created_by` and `teammate: true`. `teammate` routes to `findTeammateBranches` with the RBAC user ID.
- **Branch counts (decision Q2):** one RBAC-scoped read returning the number of active branches per board visible to the caller (`visibleBranchAccessCondition` + visible-board predicate + tenant condition). Classified `scoped`, never published.
- **Caps:** 200 IDs per `$in`; at most 1,000 teammate rows.
- **Lean:** every new key composes with `lean` (§11).
- _After:_ additive API.

**1.4 `feat(ui): user-scoped bootstrap`**

- New `store/userScope.ts`:
  - batched `ensureBranches` and `ensureSessions` loaders (fill-only, authority-fenced);
  - U1–U5 (§3.1);
  - the new flags and `absentBranchIds`;
  - the reference subscription (§3.7);
  - a re-run on silent reconnect.
- `useAgorData`:
  - the gated my-200 read replaces the global 50 most recent;
  - comments become global and gated on every route (removed from the heavy batch, the background loop and the partition);
  - on Home, board objects and cards leave the gate and become background global loops until 2.2.
- The old flags are untouched.
- _After:_ the user scope is complete in the store; Home still reads the old flags.

**1.5 `feat(home): Home and teammates read the user scope`**

- The §3.6 table, including removing `sessionsHydrated`/`branchesHydrated` and their writers.
- Shared `boardIdForSession` helper; `/s/` fix; own-board activity dots (Q1).
- Stack tests updated (§9.4).
- _After:_ Kamil's symptoms 1 and 2 are fixed, and Home no longer depends on global hydration. **Step 1 is shippable.**

### Step 2: annotations and session-MCP on demand

**2.1 `feat(ui): load session↔MCP links per session`** (§6).

**2.2 `refactor(ui): board objects, cards and full boards load per board`**

- Delete the global loops and the global boards backfill.
- Scoped reconnect for these collections.
- Remove the readiness shortcut.
- CardsTable fetches on open.
- Drop the unused `boardObjectByBranchId` and `boardObjectByCardId`.

### Step 3: sessions and branches on demand

**3.1 `feat(daemon): search service`**

- Classified `scoped`, not published, shared matcher.
- Uses visibility predicates and the tenant condition.

**3.2 `feat(ui): server-backed replacements for workspace-wide reads`**

- Search merge; genealogy targets; `/w/` and short-ID fallback.
- Mobile nav tree and assistant tab.
- Settings tables.
- Branch-count badges read the per-board count aggregate (decision Q2), refetched debounced on branch create/archive/move/remove events.
- Fill the sessions of a branch that moves onto a ready board.
- Everything here works with or without global data.

**3.3 `refactor(ui): stop global session and branch hydration`**

- Delete `useAgorData`'s sessions and branches loops.
- Reconnect runs the scope replace (§3.8) through lean's reconciliation.

**3.4 `docs: describe user-scoped and board-scoped loading`**

- `apps/agor-docs/content/guide/architecture.mdx` (Real-Time Multiplayer).
- Mark this doc implemented.
- Evidence goes in the PR, not the repo.

`useAgorData.ts` is touched by 1.2 (one line), 1.4, 1.5 (flag writers), 2.1, 2.2 and 3.3.

## 9. Consolidated test plan

### 9.1 Matrix

| Layer                                                                  | SQLite   | PostgreSQL                                         | `rich` (Postgres + RBAC, Alice/Bob) | `ha` (2 daemons + Redis)                    |
| ---------------------------------------------------------------------- | -------- | -------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| Daemon/core unit                                                       | ✓        | `*.postgres.test.ts` (`pnpm test:postgres:docker`) | fixtures in Postgres suites         | none                                        |
| UI unit and browser (`pnpm --filter agor-ui test`, `test:browser`)     | n/a      | n/a                                                | n/a                                 | n/a                                         |
| E2E: scripted Playwright against `.agor.yml` variants with `SEED=true` | `sqlite` | via `rich`                                         | ✓                                   | ✓ (reconnect and relay; channels unchanged) |

There is no committed Playwright suite; only `vitest.browser.config.ts` runs in CI. E2E results go in the PR.

### 9.2 Daemon/core unit (SQLite + Postgres)

**Sessions `findPage`** [1.1, 1.3]

- `createdBy` and `sessionIds` AND with the RBAC user and the tenant condition.
- Results are ordered; a 201-ID `$in` is rejected.
- A regular user's query takes the SQL path, including with `lean` (§11).

**Branches** [1.3]

- `created_by` and `teammate` respect `visibleBranchAccessCondition`: Alice gets neither Bob's private branch nor his private teammate.
- `teammate` returns the superset with enabled schedules, so the client filter is needed.

**Branch counts per board** [1.3]

- Counts only active branches the caller can see: Alice's count excludes Bob's private branch; Bob's includes it; a board the caller cannot see is omitted.
- Superadmin/service behaviour matches `branches.find`.
- `archived:false` and `$in` caps hold.

**Search** [3.1]

- Results are identical to the client matcher on the same rows.
- Never returns invisible rows; `owned_by_me` and limits work.

**Cross-tenant negatives**

- `created_by`, `session_id $in`, `branch_id $in`, `teammate`, branch counts and `search`: the same IDs from another tenant return nothing (counts: no rows for the other tenant's boards).

**Boundary checks**

- Classification boot assertion; `search` is not published.
- `pnpm check:multitenancy-boundaries`.

### 9.3 UI unit and browser (new)

**Fence and partition** [1.2]

- Inserts absent rows; never overwrites; skips touched rows and rows on removed branches.
- Board record is replaced unless touched.
- Authority drop; deduplication; a patch queued during the load wins; no comments in the partition [1.4].

**User scope** [1.4]

- The gated page sets `mySessionsLoaded` when it returns fewer than 200 rows.
- U1 is one read; a full 10,000-row result sets truncated.
- U5 chunks at 200 and records absent IDs; an arriving branch clears its absent mark.
- The reference subscription ensures new references once, with batching.
- An identity change resets the flags; a silent resync keeps them true.
- The fill-only merge never strips a full row.

**`useAgorData`** [1.4, 2.2, 3.3]

- The gate per route: Home has no board-objects or cards; comments are global everywhere.
- A viewer makes no board-objects request.
- After 3.3, no global `findAll` for sessions or branches; reconnect runs the scope replace.

**Components**

- `BoardTeammatePanel` readiness; `SessionCanvas` loading state.
- Own-board dots; the `/s/` and `/w/` fixes.
- GlobalSearch merge; session-MCP gating; mobile nav tree lazy expansion.

### 9.4 Stack suites to update (same commits)

| Suite                                                                                             | Change                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/HomePage/testUtils.tsx`                                                               | `hydrated` sets `mySessionsLoaded`, `homeBranchesLoaded`, `teammatesLoaded` [1.5]                                                                                                                                  |
| `HomePage.test.tsx`                                                                               | counters wait on the new flags; **rows render from the gated page before counts**; recent-boards fallback at first paint with empty localStorage                                                                   |
| `HomePage.teammates.test.tsx`, `TeammatesDirectory.test.tsx`, `MobileApp.home.test.tsx:206`       | loading driven by `teammatesLoaded`                                                                                                                                                                                |
| `HomePage.rerender.test.tsx`                                                                      | a background user-scope apply doesn't re-render unrelated rows                                                                                                                                                     |
| `HomePage.overflow.browser.test.tsx`, `App.homeSurface.test.tsx`, `MobileApp.home.test.tsx:83-84` | flag names                                                                                                                                                                                                         |
| `store/selectors.homeBuckets.test.ts`                                                             | the comment rule (`:636-638`) moves from `branchesHydrated` to `absentBranchIds`; buckets use `boardIdForSession`; lineage: a fork of another user's (unloaded) session does not supersede a failure (decision Q4) |
| `store/selectors.homeBuckets.perf.test.ts`                                                        | flag names; thresholds unchanged                                                                                                                                                                                   |
| `hooks/useAgorData.test.tsx:1290-1330`                                                            | "flags recover after an identity change and silent resync" becomes the same test for the user-scope flags                                                                                                          |
| Older suites (skip-apply-on-race, lean boards and objects hydration, bulk-write revisions)        | retarget them to collections that stay global, or to the partition and scope replace [2.2, 3.3]                                                                                                                    |

### 9.5 E2E scenarios

| ID  | Scenario                                                                                                                                                                                                                                                                                    | Variants         | First valid after |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| S1  | Seed Bob with more than 60 sessions newer than Alice's. Clear localStorage and log in as Alice. At first paint, Needs you and My work rows and the recent-boards fallback are present, with no empty-state flash. Counts appear within about 2 round trips, independent of Bob's streaming. | sqlite, rich     | 1.5               |
| S1b | Power user with about 3,000 own active sessions: first-paint and count timings, heap, and exact counts.                                                                                                                                                                                     | sqlite           | 1.5               |
| S2  | Home → board while a session on it is patched every 100 ms: the drawer lists sessions in under 1 s, with no "teammate unavailable".                                                                                                                                                         | sqlite, rich     | 1.2               |
| S3  | Deep links, cold and warm: `/b/`, `/s/` (other board), `/w/` (other board), `/a/`, `/m/*`, `/teammates`.                                                                                                                                                                                    | sqlite           | 1.5 / 3.2         |
| S4  | RBAC on a shared board where Bob has a private branch and a private teammate. Alice's My work, comments for you, teammates (rail, directory, switcher), search and partitions never show them; Bob sees them.                                                                               | rich             | 1.3–1.5 / 3.1     |
| S5  | Realtime. A new session of Alice's on an unloaded board appears in My work with its branch pill. A new comment thread on an unloaded branch appears in Needs you. A teammate Bob shares appears in the rail. (The fork-retry supersede part is dropped by decision Q4.)                     | sqlite, rich, ha | 1.5               |
| S6  | Reconnect: drop Alice's socket (on `ha`, restart her daemon) while Bob archives one of Alice-visible sessions and deletes a card. After resync, the store matches the server.                                                                                                               | sqlite, ha       | 2.2 / 3.3         |
| S7  | Session-MCP attach and detach (desktop, settings, mobile): controls gated until loaded.                                                                                                                                                                                                     | sqlite           | 2.1               |
| S8  | Search finds a session on a never-opened board, respecting RBAC.                                                                                                                                                                                                                            | sqlite, rich     | 3.2               |
| S9  | Mobile: shared Home, bell badge, nav tree lazy expansion, assistant tab.                                                                                                                                                                                                                    | sqlite           | 1.5 / 3.2         |
| S10 | A global viewer gets Home and Marketplace without 403s and makes no board-objects requests.                                                                                                                                                                                                 | rich             | 1.4               |
| S11 | Scale fixture (about 5k sessions, 20 boards): network, `__AGOR_INITIAL_LOAD_TIMINGS__`, heap after GC, each step.                                                                                                                                                                           | sqlite, rich     | each step         |
| S12 | New UI against the previous daemon: degraded but no fatal error (§10.2).                                                                                                                                                                                                                    | sqlite           | 1.4 / 3.2         |

### 9.6 Expected results

Sandbox baselines: heap 121 MB after GC (340 MB pre-GC); blocking global sessions → 60 MB; blocking everything plus session-MCP → 30 MB.

| After     | Home heap (post-GC)                                                                                        | Home gate                                                               | Home counts and teammates ready                       | Board open after Home                |
| --------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| stack tip | ~121 MB                                                                                                    | ≥6.4 MB (global 50 most recent, board objects 2.8, cards 3.5, comments) | after the global quiet window (unbounded under churn) | after the global quiet window        |
| Step 1    | ~121 MB (user scope duplicates rows the global hydration also loads)                                       | lean globals + comments + ≤200 own lean sessions (~0.2 MB)              | about 2 round trips after paint                       | one partition fetch                  |
| Step 2    | ~110 MB                                                                                                    | same                                                                    | same                                                  | partition includes objects and cards |
| Step 3    | ~32–40 MB (30 MB floor + user scope: about 1–5 MB for 1k–5k own sessions lean, plus branches and comments) | same                                                                    | same                                                  | same                                 |

## 10. Rollout, rollback and risk

### 10.1 What could break

| Area              | Failure                                                           | Commit        | Guard                                                         |
| ----------------- | ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| Home completeness | Counts or rows missing items                                      | 1.4, 1.5      | §9.3 user-scope tests; S1, S5                                 |
| Supersede rule    | A failure isn't cleared by a fork retry of another user's session | 1.4           | Accepted limitation (Q4); comment near `startedByUserLineage` |
| Comment rule      | A thread on an unloaded branch is hidden or shown wrongly         | 1.5           | `absentBranchIds` tests; S5                                   |
| Teammates         | Rail or directory incomplete or leaking                           | 1.3, 1.5      | S4; directory suite                                           |
| Power users       | A large U1 read is slow or heavy                                  | 1.4           | S1b; cap and "N+"                                             |
| Comments growth   | The global gated comments read grows                              | 1.4           | Measure in S11; move to a candidates query later if needed    |
| Board view        | Empty or partial board                                            | 1.2, 2.2, 3.3 | S2, S9                                                        |
| Missed deletes    | Ghost rows after a reconnect                                      | 2.2, 3.3      | S6 on `ha`                                                    |
| Session-MCP       | Detaching servers on an edit before load                          | 2.1           | S7                                                            |
| Mixed versions    | New UI against an old daemon                                      | all           | §10.2; S12                                                    |
| Stack churn       | The stack changes while we rebase                                 | all           | Land after the stack; §9.4 lists every touched suite          |

### 10.2 Mixed-version window

- **Why it happens:** the daemon serves the UI bundle (`D/index.ts:614-641`), so a rolling HA deploy or a stale tab can pair a new UI with an old daemon.
- **What breaks:** an old daemon rejects `created_by` with `$count:false` (400), `$in`, and the `teammate`/`created_by` branch keys, and has no `search`.
- **Requirement:** every new read is non-fatal.
  - The gated my-sessions read falls back to the global recent slice.
  - An unsupported user-scope read (400, or rows that violate its filter) degrades the scope; the global snapshots then complete its flags (Steps 1–2 only). Other failures retry (references) or wait for the global snapshots too.
  - Teammates fall back to the teammates found in loaded branches.
  - Search falls back to local hits.
  - None of these may fail the first-paint gate.

### 10.3 Rollback

- **Full revert:** clean. There is no migration, and the server changes are additive.
- **Partial revert:** revert 3.3 (and then 2.2) to restore global hydration while keeping the server reads and replacements.
- **Steps 1.4–1.5 have no partial revert of their own.** Reverting them reverts the stack-flag swap, which brings back the stack's original behaviour.

### 10.4 No feature flag

- **A flag doubles the riskiest path.** It would keep the deleted global hydration path alive and tested in both modes, along with its starvation bug.
- **Rollback is already cheap.** Revert points exist (§10.3), and the existing `agor.debug.initialLoad` covers diagnosis.
- **Revisit** only if Kamil wants exposure to one tenant first: a temporary per-tenant skip of 3.3 only.

### 10.5 How reviewers should verify

- **CI on every commit.**
- **Focus reading on:**
  - the fence (1.2);
  - the user-scope reads and flags (1.4);
  - the stack-flag swap and comment rule (1.5);
  - the two deletions (2.2, 3.3);
  - search RBAC (3.1).
- **Run it:**
  - `sqlite` with `SEED=true`: clear localStorage, then Home → board → deep links, with the network tab open.
  - `rich` as Alice and as Bob.
  - `ha` reconnect.
- **Attach** timings, heap and network totals, plus the S1–S12 log.

## 11. Interaction with lean PR #2887 (and neighbours)

**Status (2026-10-01):** #2946 is abandoned. #2887 is merged and this branch is rebased onto it. The gated my-200, U1 and partition reads send `lean: true` through `sessionListQuery`. On `/s/`, #2887's barrier still holds the global sets until the opened transcript is ready; the user scope is started outside it, after first paint, so Home and the teammate surfaces never wait for a transcript (implication 4).

**What #2887 does** (verified against `pull/2887/head` @ `08ecacba`)

- `sessions.find({ lean: true })` withholds `custom_context.scheduled_run`, `slash_commands` and `skills` (`LEAN_SESSION_LIST_OMITTED_CONTEXT_KEYS`, `toLeanSessionListRow` in `core/types/session.ts`). There is **no** omitted-fields marker, fingerprint or timestamp merge helper.
- The daemon strips `lean` from the query **before** the existing `find` body runs (`SessionsService.find` → `findRows`), so `shouldSqlPageSessionQuery` never sees it: `lean` composes with every fast-path key (`created_by`, `session_id $in`, …) without further change. `lean` is also declared in the session query validator.
- **Contract:** every session list read that feeds the store is lean, and `sessionById` is never the source for the withheld keys. The open session's composer reads the reactive full session (`sessions.get`, kept current by realtime patches); the settings modal seeds its editable `custom_context` from `get` and sends it only when edited.
- It also adds WebSocket permessage-deflate compression and defers global hydration on `/s/` routes behind the opened transcript.

**Implications for this design**

1. **Every session list read** this design adds or keeps should send `lean: true` once #2887 is in the base: the gated my-200, U1, partitions, `ensureSessions` and search hits. Until the rebase they must not send it (an older daemon rejects the unknown key), so the reads go through one shared query helper where adding `lean: true` is a one-line change.
2. **Overwrite paths need no reconciliation.** Under #2887's contract a lean row may replace a full row anywhere (wholesale first-paint apply, global loops until 3.3, the Step 3 scope replace); consumers of the withheld keys read the full record from `get`. Fill-only applies never overwrite anyway. What must hold is the contract itself: no new store consumer may read the withheld keys from `sessionById`.
3. **One reconnect path.** The Step 3 scope replace (§3.8) is built once in 3.3; there is no separate lean reconciliation to share.
4. **Deferred hydration on `/s/`.** #2887's transcript-first deferral of the global sets is deleted together with the global loops in 3.3.
5. **Landing order:** stack → #2887 → this PR. Steps 1–2 are fill-only and can be reviewed before #2887 merges; the rebase onto it is mechanical apart from the `lean` flag in the shared session-query helper and the `useAgorData` hydration blocks both PRs touch.
6. **Neighbours.** **#2896** (draft) does versioned reconnect resync. It complements 3.3: the scope replace can use its `$sync` reads for the user scope and the displayed partition.

## 12. Multi-tenancy assessment

| Change                                                   | Resource class                                 | Handling                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions `created_by`, `session_id $in` (1.1, 1.3)       | Tenant-owned                                   | Filters, not access grants. They compose with the tenant condition and `inVisibleBranchSet`. Cross-tenant negatives.                             |
| Branches `created_by`, `teammate`, `branch_id $in` (1.3) | Tenant-owned                                   | Same predicates as `branches.find` (`visibleBranchAccessCondition`). Cross-tenant and capability negatives.                                      |
| Branch counts per board (1.3)                            | Derived (aggregate over tenant-owned branches) | Classified `scoped`, never published. `visibleBranchAccessCondition` + visible boards + tenant condition. Cross-tenant and capability negatives. |
| `search` (3.1)                                           | Tenant-owned                                   | Classified `scoped`, not published. SQL narrowing before matching.                                                                               |
| Client user scope and partitions                         | Existing RBAC-scoped reads                     | Authority-fenced; reset on identity change. Superadmin teammate filtering is unchanged (`useBoardSharing`).                                      |
| Realtime                                                 | Unchanged                                      | Narrowing is a separate follow-up.                                                                                                               |

## 13. Open questions for Kamil

1. **Recent-board activity dots.** Show only _my_ running and needs-you sessions (recommended)? That matches the "N need you · N running" greeting and needs no board data. Or keep them team-wide, which needs a per-board activity read for boards that aren't loaded?
   - **Decided (2026-10-01): mine only** (`makeOwnBoardActivitySelector`).
2. **Branch-count badges** in the board switcher and the mobile nav tree. Remove them (recommended)? Or keep them with one small RBAC-scoped "active branches per board" count endpoint, the only aggregate this design would add?
   - **Decided (2026-10-01): keep them,** with the aggregate (daemon 1.3, client 3.2).
3. **Power users.** Load all of a user's active sessions in one read (lean, about 0.9 KB/row, capped at 10,000 with "N+" counts)?
   - Before 1.4, measure the top per-user active-session counts on the sandbox.
   - If anyone exceeds about 5k, decide between a raised payload and per-bucket server reads.
   - **Decided (2026-10-01): one lean read (U1), cap 10,000, "N+" via `mySessionsTruncated`.**
4. **Fork-retry supersede across owners.** Keep today's behaviour by fetching other users' active fork ancestors (recommended; a few small reads)? Or accept that a retry forked from someone else's session no longer clears a failure?
   - **Decided (2026-10-01): don't fetch ancestors** (U4 dropped); accepted limitation (§3.3).

**Earlier answers:** they stand. Questions about the removed Home sections (My Sessions definition, Boards default, Team activity, server-saved visits) are moot.

## 14. Revision history

- **r1:** four phased PRs from `main`.
- **r2:** one PR with additive-first steps, no migration, no flag, and a lean-first landing order.
- **r3 (this):** rebased on the agent-first Home stack.
  - Home edits and `home-summary` dropped.
  - User scope and replacement flags added.
  - Comments are global.
  - The `$in` reads and branch keys moved into Step 1.
  - Three steps instead of four.
  - Lean fingerprint reconciliation.
- **r3 decisions, 2026-10-01:** Q1 own-session activity dots; Q2 keep branch-count badges with one per-board count aggregate (daemon 1.3, client 3.2); Q3 one lean U1 read capped at 10,000; Q4 no fork-ancestor fetching (U4 dropped, limitation documented); lean dependency switched from #2946 to #2887 (§11 rewritten).
