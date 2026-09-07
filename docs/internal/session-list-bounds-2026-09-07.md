# Session-list bounds: issue #2645

## Evidence and scope

Investigated `origin/main` at `bde5a0c0f406c161c589f6f5a1fb2fd353c62369`
(0.26.2), fetched and confirmed equal to the starting worktree HEAD on
2026-09-07. Main subsequently advanced to
`33a428b95dc4a0f42a1ac8d551d533ce81ebd16d` via unrelated Knowledge-memory PR
#2615; the fix branch is rebased onto that main. Its only two changed files are
`mcp/tools/knowledge.ts` and `knowledge-memory-append.test.ts`, not these list
paths. No production data or managed environment was mutated.

- [Issue #2645](https://github.com/preset-io/agor/issues/2645) reports a worktree
  list growing without bound with thousands of sessions. It was open, with no
  comments or linked/cross-referenced PRs in its GitHub timeline when checked.
- [Merged #2194](https://github.com/preset-io/agor/pull/2194) bounds MCP collection
  output; it does not virtualize branch trees or bound all query materialization.
- [Merged #2504](https://github.com/preset-io/agor/pull/2504) indexes recent-session
  pages. Its report explicitly distinguishes ordered-page cost from exact-count
  cost and full hydration. It does not fix rendering.
- [Open #1814](https://github.com/preset-io/agor/pull/1814), including its comment,
  addresses clipping in the separate board-wide session drawer (#1813), not the
  worktree genealogy tree. Neither its status nor an overflow scrollbar proves
  that rendered rows are bounded. The two merged PRs above had no comments/reviews.

## Root cause: real, but three different bounds

1. **Rendered rows:** `BranchSessionSections.tsx` serves both `BranchCard` and
   `BoardTeammatePanel`. Both manual and gateway trees use expanded genealogy
   by default. Previously Tree had no `height`, so its virtual list was inactive.
   Scheduled runs and search results used unrestricted `.map()` calls. All
   loaded records could mount their row, tooltip, and action components.
2. **Client materialization:** `useAgorData` initially fetches a recent global
   50-session page and displayed-board sessions, then hydrates all active
   accessible sessions. Silent reconnect/resync fetches the full active set.
   The branch modal `SessionsTab` already has a 20-row AntD table and 70vh
   wrapper, but uses `findAll({ $limit: 1000 })` for active and lazily archived
   records. `$limit` is a page size, not an aggregate cap. Prop seeding, realtime
   upserts, and archive results can also grow its local collection.
3. **Server work:** a bounded HTTP/MCP response is not necessarily a bounded
   database read. Several shapes fall back to loading candidates before sorting,
   filtering, selecting fields, and slicing. Requiring a branch still permits
   arbitrarily many sessions in that branch.

## Contract decision

**Do not require `branchId` on a list operation.** The required `Session.branch_id`
foreign key is a creation/ownership invariant, not a required query filter.
Branch, board, and workspace-wide inventories are all legitimate. Optional
filters must narrow by intersection, never expand authority; absence means all
authorized branches in the authenticated tenant, never all tenants. It must not
silently default to the MCP caller's current branch (external API-key MCP callers
may have no session at all).

The shipped correction bounds **rendering and MCP list candidate materialization**:

- Manual and gateway genealogy retain their structure, expansion state, actions,
  and ordering, with a 400px virtual Tree viewport. `nodrag nowheel` keeps local
  tree interaction from dragging/zooming the board. The deferred branch-card
  shell caps its manual-row estimate at that same shared viewport height, so
  initial board fitting cannot measure thousands of rows before hydration.
- Scheduled runs and search matches use 20-row pages in a max-400px scroll area.
  Filtering/search happens before paging, so later records remain searchable.
  Branch/query switches reset the page; realtime removals clamp an invalid page.
  The clamped page is retained if new sessions arrive afterward.
- MCP board filtering now goes through the service's branch/board SQL join;
  exact status filters join the SQL page path. MCP uses its single created-time
  sort plus the repository's ID tie-breaker instead of selecting the generic
  multi-sort fallback. Normal MCP list candidates are bounded by its requested
  limit (default 25, maximum 100).
- Derived `sessionType` filtering retains the existing 10,000-candidate scan
  ceiling, but errors if the scan is incomplete (including a server-clamped
  scan or a legacy bare-array response without completeness metadata), rather than reporting partial data as complete. Narrowing with branch,
  board, status, or archive filters is optional; callers may instead omit
  `sessionType` and page normally. Exact counts still cost a matching-row scan.
- Branch-scoped results retain their service total instead of replacing it with
  this page's length. Derived-type pages report the requested limit/offset, not
  the candidate scan's envelope. Out-of-scope rows or an oversized adapter page
  cause a useful error before any records are returned, rather than fabricated
  totals or disclosure of unexpected rows.
- No API/MCP input schema, database migration, authentication, retention, or list
  DTO changes. Small lists do not gain an artificial 400px minimum height.

## Security and tenant assessment

Sessions and branches are **tenant-owned**, with session access derived through
the branch. UI lists are derived read models, not authorization boundaries.
UI slicing consumes the same supplied collection and never fetches omitted
records through an unscoped fallback. MCP continues forwarding trusted
`baseServiceParams`; the exact-status SQL condition composes with the unchanged
branch visibility predicate and tenant-scoped repository. Tests check trusted
params propagation, reject out-of-scope adapter results, and prove that an
explicit hidden branch/status filter returns neither rows nor a count. Existing
MCP tenant-context negative suites are exercised. No new tenant identity source,
cache, or persisted resource is introduced.

Relevant existing enforcement owners:

- `register-hooks.ts`: sessions is in `TENANT_OWNED_SERVICE_PATHS`; the sessions
  hooks run `sessionQueryValidator`, `requireAuth`, and
  `scopeFindToAccessibleSessionsSql`.
- `utils/branch-authorization.ts`: trusted access decisions stamp the internal
  `_agorSqlSessionAccessUserId` marker. Internal/service-account and configured
  superadmin paths are explicit exceptions to user RBAC, **not** permission to
  discard tenant scope. Transport queries cannot supply this root params marker.
- `SessionsService.find/fetchData`: SQL fast path, board fallback, branch fallback,
  and global fallback all forward the marker to the repository.
- `SessionRepository.findPage/findAll/findByBoard`: branch visibility in SQL;
  pagination totals are computed under the same visibility predicate. Board
  membership is `sessions.branch_id -> branches.board_id`, not the legacy
  `sessions.board_id` field.
- MCP `server.ts` constructs authenticated `baseServiceParams` including tenant
  and provider; `mcp/tenant-scope.ts` preserves tenant operation context. List and
  ID resolver calls forward these params into the hooked services. Required-auth
  PostgreSQL scope/RLS, not a client-provided branch UUID, isolates tenant rows.
- Realtime delivery remains under existing tenant/RBAC publication controls.

## Caller inventory before any schema change

Production `sessions.find/findAll` call sites, including service aliases:

| Caller                                      | Scope / continuation / fallback                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI `hooks/useAgorData.ts`                   | Global recent-50 first paint; full displayed-board active list; global active background hydration and silent resync via `findAll`; direct archived/deep links repaired with `get`, not broadening the list |
| UI `BranchModal/tabs/SessionsTab.tsx`       | Exact branch active/archived `findAll`; prop seed on load failure; realtime created/patched/updated/removed and archive response caches                                                                     |
| UI `ScheduleRunsPanel.tsx`                  | `schedule_id`, active, limited recent runs; no branch required; retains prior state/logs on fetch error                                                                                                     |
| UI `utils/seedOnboardingTeammate.ts`        | Exact known session `get` first; branch-filtered `find` fallback, followed by an explicit branch match                                                                                                      |
| CLI `session/list.ts`                       | Global by default, optional board/status/tool filters and limit; one page                                                                                                                                   |
| CLI `board/add-session.ts`                  | Global `findAll` to resolve the chosen session by full/short ID before finding its branch                                                                                                                   |
| CLI `branch/list.ts`                        | Global `findAll` for per-branch counts; fetch failure leaves counts zero                                                                                                                                    |
| CLI `branch/{show,rm,archive,unarchive}.ts` | Exact branch `findAll`, sometimes archive-state filters; previews/counts, not just the first page                                                                                                           |
| MCP `tools/sessions.ts: agor_sessions_list` | Optional global/board/branch/status/archive/type scopes; details below                                                                                                                                      |
| MCP `agor_sessions_bulk_archive`            | Optional branch/status candidate pages of 200; global by default; board/type/age post-filter; dry-run preview or individually authorized patches                                                            |
| MCP `agor_sessions_get_current_context`     | Optional exact-branch sibling find, limit 11, excludes caller and returns 10; errors omit noncritical sibling section                                                                                       |
| Daemon `startup.ts`                         | Global status pages of 1,000 via `collectAllPages` for orphaned/idle-not-ready reconciliation; trusted startup params                                                                                       |
| Daemon `services/branches.ts`               | Exact-branch archive/unarchive cascade finds, `$limit:1000`, `paginate:false`; changing generic list semantics risks lifecycle truncation                                                                   |

Other sessions-service references (App, SDK repositories/executors, task/gateway/
scheduler services, session actions, MCP branch tools) use `get`, `create`,
`patch`, `remove`, custom routes, or realtime subscriptions, not collection finds.
Public TypeScript/API documentation also demonstrates unscoped session lists.
In-process repository methods are intentionally not interchangeable with public
list schemas. Global queries must remain usable by cleanup/reconciliation code.

Rendering consumers additionally include `BranchListDrawer/BoardSessionList`
(also mounted by the teammate panel), the branch modal, session peeks, and board
selectors. The board-wide drawer is a separate surface from this fix.

## API/MCP fallback findings and remaining work

Baseline findings, which must not be hidden behind a claim of end-to-end
bounded performance:

- Feathers `createQuerySchema` currently accepts integer `$limit` and `$skip`
  from 0 through 10,000; default session limit is the shared
  `PAGINATION.DEFAULT_LIMIT` (10,000). API names are snake_case; MCP uses camelCase.
  The shared validator removes additional fields. Making one filter required
  or globally rejecting unknown fields would affect existing callers, including
  internal residual filters, and is not a safe incidental schema edit.
- Baseline `shouldSqlPageSessionQuery` modeled archive, board/branch, pagination and a
  single `created_at` or `updated_at` sort. Other filters, operators, `$select`,
  and multiple sort keys take fallback paths. This PR adds exact status only. Board fallback scopes candidates
  via the branch join; branch fallback uses `findAll`; global fallback uses
  `super.find -> fetchData -> findAll`. They preserve RBAC but materialize more
  than one page. Exact counts and full session JSON also have nonconstant cost.
- MCP output defaults to 25 lean records, max requested limit 100; offsets are
  nonnegative integers. Nonempty supplied IDs are resolved through authorized
  entity gets. Branch/board response assertions now reject inconsistent scope.
- Baseline MCP requested 10,000 candidates for `boardId` or derived `sessionType`
  and filtered/paginated in memory. It could truncate logical results/counts
  above that candidate ceiling and spread the scan's `limit/skip` into the
  requested page's envelope. Branch post-filtering independently reset totals
  to page length, ending pagination after one page. Normal MCP listing sorted
  by two fields, missing the SQL fast path. **Fixed here** as described above.
  Derived-type scans still inspect up to 10,000 full candidate records per
  request; they are bounded, not cheap, and now fail explicitly on truncation.
- `findAll` is intentionally aggregate-unbounded. It checks stable totals,
  advancing offsets, nonempty continuation and the advertised row count, raising
  useful errors rather than claiming a partial walk is complete. Its current
  session offset walk also encounters the API's 10,000-offset ceiling for
  larger inventories. Silently lowering its page/aggregate limit is unsafe.

A subsequent query-contract change should push every supported narrowing filter
and stable order into SQL **before** pagination/count, reject unsupported or
malformed narrowing inputs with field-specific errors rather than silently
broadening, and define a cursor or explicit scan budget for derived filters.
An exceeded scan budget must return a useful error suggesting narrower filters,
not fabricated totals or `hasMore:false` (the MCP derived-type scan now does this). Global/board scope must remain valid.
Any new cursor/cache must be tenant- and authorization-bound. Full-hydration
replacement also requires honest counts/search and realtime/deep-link behavior;
do not replace it with a silent first-N snapshot. This deserves separate scoped
work rather than an API compatibility break bundled with rendering.

## Rollout

UI rendering works with the current daemon. MCP fixes require the updated
server code; existing clients keep the same optional filters and response
shape. No schema/version handshake or data migration. Correct totals now let
branch/board callers reach later pages. Previously truncated derived-type scans
now fail with narrowing guidance; inconsistent adapter results now fail rather
than silently returning a partial list. No sessions become inaccessible, deleted, or archived. Rendering
and mounted component cost are bounded per section; full hydration, search,
sorting and tree construction still scale with loaded sessions. Offset pages of
changing live data are not snapshot isolation. No merge, deployment, or issue
closure is part of this investigation.

## Validation

Browser coverage uses actual AntD Tree/virtual-list components, not the existing
genealogy test's Tree mock. It checks tail navigation in a 1,001-record expanded
tree, gateway descendants, 1,000 flat rows, paging, and broad search matches.

Baseline evidence:

- Restoring the main UI component and running the card-mode browser regression
  with only 101 fixture records failed: `expected 101 to be less than 40`.
  The initial 1,001-record baseline run exceeded the 90-second harness deadline
  and was terminated; this is not reported as a measured production latency.
- Restoring main's MCP tool and running the new `preserves totals` tests failed
  all four scope variants; branch-scoped totals became 2 instead of 53 and board
  queries requested 10,000 instead of the requested 2. The modified sources
  were restored after both checks.

Final focused validation:

```sh
pnpm --filter agor-ui exec vitest run --config vitest.browser.config.ts src/components/BranchCard/BranchSessionSections.bounds.browser.test.tsx
# 12 passed: desktop, phone, tablet, short-landscape Chromium projects
pnpm --filter agor-ui exec vitest run src/components/BranchCard/PagedSessions.test.tsx src/components/BranchCard/BranchSessionSections.test.tsx src/components/BranchCard/buildSessionTree.test.ts src/hooks/useAgorData.test.tsx
# 51 passed
pnpm --filter @agor/daemon exec vitest run src/services/sessions.find.test.ts src/mcp/tools/sessions.test.ts src/mcp/tenant-scope.test.ts src/utils/rbac-find-scoping.test.ts src/register-hooks.tenant-identity.test.ts
# 97 passed
pnpm --filter @agor/core exec vitest run src/db/repositories/sessions.test.ts src/lib/feathers-validation.test.ts src/api/index.test.ts
# 168 passed
pnpm --filter @agor/daemon exec tsc --noEmit --customConditions source --rootDir ../..
pnpm --filter @agor/core exec tsc --noEmit --customConditions source --rootDir ../..
pnpm --filter agor-ui exec tsc -p tsconfig.app.json --noEmit --customConditions source --erasableSyntaxOnly false
pnpm lint
# Biome plus 330 named frontend design-system fixture cases
pnpm check:multitenancy-boundaries
pnpm check:daemon-filesystem-boundaries
pnpm check:realtime-boundaries
pnpm check:shortid
```

The initial investigation used no package builds or daemon/UI background servers.
Source-condition no-emit typechecks avoid Turbo's `typecheck -> ^build` dependency. UI source-mode
checking needs `erasableSyntaxOnly:false` because imported core source contains
existing enums and constructor parameter properties; this does not disable
strict type checking. A temporary config extending the UI config with those
same two overrides, `exclude:[]`, and an include list containing its test setup
plus all five changed/new test files checks tests too. Existing test helper type
erasures were corrected to accept typed callbacks and actual Zod schemas; the
standalone SQLite service fixture now explicitly creates the scope-aware proxy
without a tenant hook, instead of passing an incorrectly branded raw database.

### Requested full-workspace validation follow-up

On 2026-09-07, the user explicitly requested dependency installation and the full
workspace check (including its builds). Both completed successfully:

```sh
pnpm i
# All 18 workspace projects; already up to date, no lockfile changes
pnpm check
# Standard workspace typecheck, lint, short-ID/multitenancy/filesystem/realtime
# boundary checks, then Turbo builds excluding @agor/docs; exit 0
```

All four focused Vitest commands above were rerun after the full check: browser
12, UI 51, daemon 97, and core 168 tests passed (**328 total**), each with exit 0.

No persistent daemon/UI dev servers, deployment, merge, or issue closure were
performed. The existing PR #2687 was attached to this worktree using
`agor_branches_update` with its `pullRequestUrl`.

No fresh PostgreSQL/RLS integration or production load benchmark was run. The
SQL status change is an additional shared Drizzle predicate under existing
visibility/tenant scope, with real SQLite hidden-branch/count negatives and
MCP tenant propagation/denied-resolution coverage. Further end-to-end data-fetch
and byte-budget performance work remains as described above.

### Codex review follow-up

The independent reviewer identified a real integration gap: the progressive-mount
shell still estimated 42px per manual session before the bounded tree mounted.
For 1,001 sessions this reserved 42,096px and could distort the initial board fit.
The estimate now caps the manual rows at the same domain-owned viewport constant
used by Tree and flat-list rendering. Small and collapsed shells keep their
existing estimates. No mount-scheduler or canvas-fitting redesign was needed.

The review also found that a removed page's number remained in React state, so
later collection growth jumped back to it. The component now stores the clamped
page immediately. Both findings were reproduced by new/extended regression tests
against the pre-fix implementation (two failures). The deferred-shell regression
mounts the actual BranchCard with only the progressive-mount readiness held false;
it checks small, 1,001-session, and persisted-collapsed shells. Pagination coverage
now includes growth after removal.

These changes only adjust derived UI layout and local navigation state over the
already supplied sessions. They introduce no fetching, tenant identity source,
shared persisted state, or authorization changes.

```sh
pnpm --filter agor-ui exec vitest run src/components/BranchCard/BranchCard.bounds.test.tsx src/components/BranchCard/BranchCard.drag.test.tsx src/components/BranchCard/PagedSessions.test.tsx src/components/BranchCard/BranchSessionSections.test.tsx src/components/BranchCard/buildSessionTree.test.ts src/hooks/useAgorData.test.tsx src/hooks/useProgressiveMount.test.tsx
# 61 passed
pnpm --filter agor-ui exec vitest run --config vitest.browser.config.ts src/components/BranchCard/BranchSessionSections.bounds.browser.test.tsx
# 12 passed across all four Chromium projects
pnpm check
# Full workspace typecheck, lint, all four boundary checks, builds: exit 0
```

A separate strict no-emit TypeScript check passed for the new deferred-card test
and extended pagination test, using a temporary config extending
`apps/agor-ui/tsconfig.app.json`, `exclude:[]`, and only those two tests plus
`src/test/setup.ts` as includes. This follow-up used built package declarations
without source-mode overrides. Both review findings were addressed; none skipped.
