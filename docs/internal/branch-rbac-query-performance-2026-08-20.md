# Branch/resource RBAC query performance analysis

**Date:** 2026-08-20  
**Scope:** Branch-scoped application RBAC and PostgreSQL RLS/query shape only  
**Input:** Early Agor Cloud Datadog screenshot of mean
`feathers.request.duration_ms`, without sample counts or percentiles

## Executive result

The Datadog means do **not** measure SQL or RBAC in isolation. They time the
entire outer Feathers service invocation. Several multi-second observations in
the screenshot are services with no branch visibility predicate, which is a
useful negative control: the screenshot cannot support a claim that branch
RBAC caused the deployment-wide latency. Database capacity, pool wait, result
work, and provider work remain possible contributors and require their own
telemetry.

The controlled PostgreSQL reproduction did identify one material RBAC query
shape defect in `boards.find` and the private-board `boards.get` authorization
path. Board visibility expanded the complete branch visibility predicate twice:
once for a branch whose `board_id` is the board and once for the board's
`primary_teammate_id`. PostgreSQL planned two copies of every grant and
board-inheritance subplan. Its estimated cost crossed the default JIT threshold
and compiled 546 functions.

Factoring the two branch-to-board references into one logically equivalent
`EXISTS` reduced the member plan cost from **148,740.19 to 87,499.29**, avoided
JIT, and reduced warm-cache execution from a seven-run median of **415.808 ms
to 31.921 ms (13.0x)**. One additional JIT-disabled comparison observed
**34.903 ms before and 17.040 ms after**. That single pair is directional
evidence that reducing duplicated physical work matters beyond the JIT cliff,
not a stable estimate of the JIT-independent speedup. The result set remained
exactly 830 boards.

No index or cache change is justified by these plans. The implemented change is
code-only, has no migration lock/rollout cost, and preserves SQLite semantics.

## What the Datadog metric measures

`createFeathersMetricsHook` in
`apps/agor-daemon/src/metrics/feathers.ts` is an application-level `around`
hook registered in `apps/agor-daemon/src/register-routes.ts`. It starts
`performance.now()` immediately before `next()` and records in `finally` after
`next()` settles.

For a tenant-owned PostgreSQL service, the measured interval is therefore:

1. the external, top-level Feathers invocation;
2. the service's tenant `around` hook;
3. transaction acquisition/begin and
   `SELECT set_config('agor.tenant_id', ..., true)`;
4. authentication, role, and resource authorization before-hooks;
5. service and repository work, including all SQL and count queries;
6. service-specific result construction and after-hooks;
7. transaction commit and synchronous post-commit callbacks; and
8. return through the outer metric hook.

The request-local `AsyncLocalStorage` guard suppresses nested service metrics,
so nested fan-out is charged to the outer service label rather than emitted as
a second duration. The metric does not isolate pool wait, SQL execution, RLS,
RBAC, enrichment, or outbound calls. It also does not include Socket.IO client
round-trip time after the Feathers method has settled.

This boundary explains why the production observation must not be read as a
query benchmark. In particular, `repos.find`, `card-types.find`, and several
other multi-second observations do not compose branch/resource RBAC SQL at all.
That is evidence against a universal RBAC explanation, not proof of any one
alternative cause.

## Representative RBAC flows

### `boards.find`

`scopeFindToAccessibleBoardsSql` marks external non-superadmin finds with
`_agorSqlBoardAccessUserId`. `BoardsService.fetchData` passes that user to
`BoardRepository.findAll`, which applies `visibleBoardAccessCondition` in SQL.
The adapter then performs its normal filtering/pagination against the already
authorized rows. There is no separate board count query in this path.

### `boards.get`

`ensureCanViewBoard` resolves the board and calls `BoardRepository.canView`.
Shared boards short-circuit. For a private board, `canView` calls
`findVisibleBoardIds`, so the same board visibility query had been computed for
all tenant boards. The hook/service path also repeats board record reads. The
implemented predicate improvement removes the dominant reproduced cost of the
all-visible query; consolidating point reads remains a separate, smaller
architectural opportunity that was not changed without a service-level
benchmark.

### `sessions.find`

`scopeFindToAccessibleSessionsSql` marks the request.
`SessionsService.find` uses `SessionRepository.findPage` for the supported
first-paint query. `findPage` executes a count and a data query; both join
`sessions -> branches`, left join the caller's direct `branch_owners` row, and
apply the same full branch visibility predicate. Duplicating the predicate is
necessary in the current two-query pagination design to preserve `total`.
Changing pagination/count construction is outside this RBAC-only fix.

The generic session path uses `SessionRepository.findAll` with the same SQL
visibility predicate and performs no per-session permission calls.

### `branches.find` and branch-referenced resources

`branches.find` marks the caller and calls `BranchRepository.findAll`, which
uses one left owner join plus the branch visibility predicate. `artifacts.find`
uses a correlated `visibleBranchReferenceAccessExists`; tasks and messages
navigate through session-to-branch reference predicates. PostgreSQL decorrelated
and hashed the reusable membership/grant subplans in the tested shapes; these
finds did not execute application-level per-row permission checks.

PostgreSQL RLS remains active underneath every query. The benchmark role was
`NOSUPERUSER NOBYPASSRLS`, the tables use forced tenant RLS, and every plan was
captured inside a transaction with a transaction-local `agor.tenant_id`.

## Canonical predicate and call-site inventory

The canonical set-based helpers are in
`packages/core/src/db/repositories/branch-access.ts`:

| Helper                                | SQL meaning                                                                                       | Direct consumers                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `activeGroupGrantAccessExists`        | Active group membership plus a non-`none` direct branch grant                                     | `visibleBranchAccessCondition`                           |
| `activeBoardOwnerAccessExists`        | Explicit owner of the branch's aligned board                                                      | `visibleBranchAccessCondition`                           |
| `activeBoardGroupGrantAccessExists`   | Active membership plus a non-`none` grant on a shared aligned board                               | `visibleBranchAccessCondition`                           |
| `alignedBoardDefaultVisible`          | Shared aligned board with non-`none` default                                                      | `visibleBranchAccessCondition`                           |
| `visibleBranchAccessCondition`        | Direct owner, direct group, board owner/group/default, or override fallback                       | branch, session, schedule, board, and reference helpers  |
| `visibleBoardAccessCondition`         | Creator, explicit board owner, shared board, visible branch on board, or visible primary teammate | board lists and board references                         |
| `visibleBoardReferenceAccessExists`   | Board FK resolves to a visible board                                                              | board objects/comments                                   |
| `visibleBranchReferenceAccessExists`  | Branch FK resolves to a visible branch                                                            | artifacts/comments                                       |
| `visibleSessionReferenceAccessExists` | Session FK resolves through its branch                                                            | messages, tasks, MCP message reads, service registration |
| `visibleTaskReferenceAccessExists`    | Task FK resolves through session and branch                                                       | board comments                                           |
| `visibleMessageReferenceAccessExists` | Message FK resolves through session and branch                                                    | board comments                                           |

Repository call sites:

- `BranchRepository.findAll`, `findAccessibleBranches`, and teammate discovery;
- `SessionRepository.findAll`, `findByBoard`, `findPage`, and
  `findAccessibleSessions`;
- `BoardRepository.findAll` and `findVisibleBoardIds`;
- `ScheduleRepository.findAccessibleSchedules`;
- `ArtifactRepository.findAll`;
- board object, board comment, task, and message repository find/page methods;
- MCP/service message visibility reads.

Reusable Feathers scoping helpers are in
`apps/agor-daemon/src/utils/branch-authorization.ts`:

- current SQL markers:
  `scopeFindToAccessibleBranchesSql`,
  `scopeFindToAccessibleSessionsSql`, and
  `scopeFindToAccessibleBoardsSql`;
- older ID-preload helpers:
  `scopeFindToAccessibleBranches`,
  `scopeFindToAccessibleSessions`, and
  `scopeFindToAccessibleBoards` (still used by `cards.find`);
- older custom-query/after-filter helpers:
  `scopeBranchQuery`, `scopeSessionQuery`, `scopeScheduleQuery`, and
  `filterBranchesByPermission`.

The registered branch/session/board/artifact/resource list paths use SQL
markers, not the deprecated per-row after-filter. `cards.find` still preloads
visible board IDs, but it benefits from the same canonical board predicate.

## Exact repeated work found

The branch visibility predicate is an OR of:

1. the user-specific left-joined `branch_owners` row;
2. branch grant -> membership -> active group;
3. aligned-board owner;
4. aligned-board grant -> membership -> active group -> shared board;
5. aligned shared board default; and
6. override `others_can IN ('view','session','prompt','all')`.

Before the change, board visibility contained two full copies:

```sql
EXISTS (visible branch WHERE branch.board_id = board.board_id)
OR EXISTS (visible branch WHERE branch.branch_id = board.primary_teammate_id)
```

The member plan materialized two 6,900-row visible-branch hash subplans. Each
copy separately evaluated 1,950 matching direct grant rows, 25 board-owner
rows, 145 board-grant rows, and 600 aligned-board-default rows. The two copies
appeared as `SubPlan 20` and `SubPlan 38`. This duplication produced 546 JIT
functions at the default `jit_above_cost = 100000`.

After the change:

```sql
EXISTS (
  visible branch
  WHERE branch.board_id = board.board_id
     OR branch.branch_id = board.primary_teammate_id
)
```

PostgreSQL uses one correlated subplan and a `BitmapOr` over the existing
`branches_board_idx` and branch primary-key index. In the measured member plan,
that subplan ran only for the 225 outer boards not already accepted as shared,
created, or explicitly owned. The grant/membership subplans were planned once.

This transformation preserves the identity
`EXISTS(P AND A) OR EXISTS(Q AND A) = EXISTS((P OR Q) AND A)` and does not
multiply outer rows.

### Point-check duplication (not changed)

Several point authorization callers first call `BranchRepository.isOwner` and
then `resolveUserPermission`. The latter calls `resolveUserAccess`, which runs
the owner lookup again before resolving group/board inheritance. Examples
include the request RBAC cache loader, terminal/gateway checks, permission
delivery, and some custom routes. This is one redundant indexed owner lookup
per point check, not an N+1 in the current list paths. Consolidation should use
one typed access result while retaining the distinction between a direct branch
owner and an inherited board owner; that wider refactor was documented rather
than mixed into the measured board-list fix.

## PostgreSQL reproduction

### Environment and method

- PostgreSQL 16 (`pgvector/pgvector:pg16`) in a disposable local container;
- application role `agor_app` with `NOSUPERUSER` and `NOBYPASSRLS`;
- all repository PostgreSQL migrations applied;
- two tenants, followed by `ANALYZE`;
- warm-cache `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`;
- each plan wrapped in `BEGIN`,
  `SET LOCAL agor.tenant_id = 'tenant-a'`, and `ROLLBACK`;
- default JIT settings: `jit=on`, `jit_above_cost=100000`;
- board before/after variants alternated for seven member runs and five each
  for admin and outsider; other current-shape queries ran five times.

This is a controlled SQL reproduction, not a Feathers end-to-end or production
capacity benchmark. All reported plans had zero shared reads after warm-up.

### Fixture shape (per tenant)

| Resource      |                                                 Count / distribution |
| ------------- | -------------------------------------------------------------------: |
| users         |                        5: owner, member, outsider, admin, superadmin |
| repos         |                                                                  100 |
| boards        |        1,000: 750 shared, 250 private; defaults cycle all five tiers |
| branches      | 10,000: half board-aligned, half override; tiers cycle; 103 archived |
| sessions      |                                              50,000: five per branch |
| artifacts     |                                               20,000: two per branch |
| groups        |                                                    200: six archived |
| memberships   |              70: member in 50 groups, outsider in 20 disjoint groups |
| branch grants |                            10,000: one per branch, all tiers cycling |
| board grants  |                              1,000: one per board, all tiers cycling |
| branch owners |                         10,200: owner on every branch, member on 200 |
| board owners  |                            1,025: owner on every board, member on 25 |

The second tenant has the same counts and disjoint IDs. The PostgreSQL
regression test additionally creates private/shared, direct/group/fallback,
board-aligned ownership, moved-primary, and cross-tenant cases through
repositories under live RLS.

### Current representative plans

Five-run warm medians for the member:

| Query                                            |   Rows returned | Plan cost | Planning median |     Execution median (range) | Shared hits |
| ------------------------------------------------ | --------------: | --------: | --------------: | ---------------------------: | ----------: |
| tenant board scan, superadmin pass-through shape |           1,000 |     55.78 |        0.651 ms |       0.346 ms (0.324-0.485) |          29 |
| branches + branch visibility                     |           6,900 |  1,584.16 |        5.223 ms |    17.704 ms (17.081-21.248) |       4,044 |
| sessions count + branch visibility               | 1 aggregate row |  6,801.08 |        5.696 ms |    70.692 ms (67.164-72.662) |       5,515 |
| sessions page + branch visibility, 50 rows       |              50 | 14,044.62 |        5.717 ms | 146.039 ms (145.328-148.872) |     104,719 |
| artifacts + branch reference visibility          |          13,800 |  2,779.65 |        5.491 ms |    27.438 ms (26.915-31.534) |       4,549 |

The branch/group subplans were hashed once in each query, not executed once per
outer branch/session/artifact. The plan did reveal that the user-specific
branch-owner input scanned the tenant's 10,200 owner rows and filtered 10,000,
but this took only 1.176-1.229 ms in these plans. That is insufficient evidence
for a production index migration.

### Board predicate before/after

Seven alternating member runs, JIT at defaults:

| Shape                               | Rows |  Plan cost | Planning median |     Execution median (range) | Shared hits | JIT functions / median JIT time |
| ----------------------------------- | ---: | ---------: | --------------: | ---------------------------: | ----------: | ------------------------------: |
| two full branch `EXISTS` predicates |  830 | 148,740.19 |       22.876 ms | 415.808 ms (295.188-560.015) |       8,120 |                546 / 332.162 ms |
| one factored branch `EXISTS`        |  830 |  87,499.29 |        8.318 ms |    31.921 ms (16.904-40.598) |       9,276 |                        0 / 0 ms |

One earlier cold capture of the old shape took 786.541 ms; it is not included
in the seven-run median. A separate single-execution comparison with JIT
disabled observed 34.903 ms before and 17.040 ms after; unlike the alternating
default-JIT runs, that pair should not be treated as a benchmark distribution.
The new shape does somewhat more indexed buffer work, but avoids two full
visible-branch materializations and, at default settings, the much larger
compilation cliff.

Abbreviated actual plan trees from the member captures (rows and loops are
PostgreSQL's `Actual Rows` / `Actual Loops`) make the structural change explicit:

```text
BEFORE  Index Scan boards_tenant_id_idx                 rows=830 loops=1
          hashed SubPlan 2: board_owners_user_idx       rows=25  loops=1
          hashed SubPlan 20: Hash Left Join             rows=6900 loops=1
            branches tenant Bitmap Heap Scan            rows=10000 loops=1
            branch_owners_tenant_id_idx                 rows=200 loops=1
            SubPlan 13 direct group grants              rows=1950 loops=1
            SubPlan 15 board owners                     rows=25 loops=1
            SubPlan 17 shared board group grants        rows=145 loops=1
            SubPlan 19 shared board defaults            rows=600 loops=1
          hashed SubPlan 38: Hash Left Join             rows=6900 loops=1
            [second copy of the same branch/grant/board subplans]
```

```text
AFTER   Index Scan boards_tenant_id_idx                 rows=830 loops=1
          hashed SubPlan 2: board_owners_user_idx       rows=25 loops=1
          SubPlan 11: Nested Loop                       loops=225
            branches Bitmap Heap Scan                   rows=8 loops=225
              BitmapOr
                branches_board_idx                      rows=10 loops=225
                branches_pkey                           rows=0 loops=225
            branch_owners_branch_id_user_id_pk          loops=1755
            SubPlan 4 direct group grants               rows=1950 loops=1
            SubPlan 6 board owners                      rows=25 loops=1
            SubPlan 8 shared board group grants         rows=145 loops=1
            SubPlan 10 shared board defaults            rows=600 loops=1
```

`Actual Rows` is a per-loop average and is rounded to an integer, explaining
zeroes on sparse index probes. RLS also contributed the tenant conditions (and
the existing narrowly gated environment-health discovery policy on branches)
to both plans; no RLS policy changed.

Role-shaped checks matched the same semantics:

| Caller                                          | Old execution median | New execution median |  Rows |
| ----------------------------------------------- | -------------------: | -------------------: | ----: |
| member                                          |           415.808 ms |            31.921 ms |   830 |
| admin (application RBAC still applies to finds) |           267.067 ms |            17.297 ms |   825 |
| outsider                                        |           273.282 ms |            17.175 ms |   825 |
| superadmin pass-through                         |                  n/a | 0.346 ms tenant scan | 1,000 |

Superadmin pass-through remains controlled by the existing
`allowSuperadmin` hook option. No role logic changed.

## Findings and disposition

| Priority | Class                | Finding                                                                                                                                                             | Evidence                                                                                                               | Disposition                                                                                                                                    |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Query shape          | Board visibility duplicated the entire branch RBAC predicate and crossed PostgreSQL's JIT threshold.                                                                | Duplicate hashed subplans, 546 JIT functions, 13.0x median improvement with identical rows.                            | **Implemented:** one factored `EXISTS`.                                                                                                        |
| P1       | Deployment/DB sizing | Multi-second Feathers means also appear on services without branch RBAC; sample counts, percentiles, DB CPU, pool wait, and cache state are absent.                 | Screenshot negative controls; controlled branch/session queries were tens to 146 ms, not seconds.                      | Do not attribute deployment-wide latency to RBAC. Correlate production DB/pool telemetry separately.                                           |
| P2       | Query architecture   | Session pagination evaluates the same visibility predicate in count and data queries.                                                                               | 70.692 ms count plus 146.039 ms page in the fixture.                                                                   | Preserve totals; do not guess at a window/count rewrite in this RBAC-only change.                                                              |
| P2       | Point checks         | Multiple callers repeat the direct owner lookup before central access resolution. Private `boards.get` also repeats board reads and resolves all visible board IDs. | Static call-site trace; indexed point operations, not list N+1.                                                        | Document for a separately measured consolidation. The board predicate fix already makes the all-visible step much cheaper.                     |
| P3       | Index candidate      | Set-based direct-owner input lacks a user-leading composite index.                                                                                                  | 10,000 rows removed, but only about 1.2 ms; all other grant/owner joins used existing indexes or chose tiny seq scans. | No migration: benefit is not material in this fixture. Re-test at larger owner cardinality before proposing `(tenant_id, user_id, branch_id)`. |
| P3       | OR/index shape       | Visibility is necessarily an OR across owner, group, board inheritance, and fallback.                                                                               | PostgreSQL hashed the membership/grant branches once; existing board and PK indexes support the new correlated lookup. | Preserve semantics; no partial/expression index supported by current evidence.                                                                 |

## Security and semantic invariants

The change preserves all of the following:

- direct owners and board owners retain effective `all` access;
- active group membership and archived-group exclusion are unchanged;
- only non-`none` permission tiers make a branch visible;
- board-aligned defaults and board group grants retain shared/private behavior;
- override branch fallback remains independent of board defaults;
- a private board remains visible through either an accessible branch currently
  on it or an accessible primary teammate that has moved to another board;
- the outer board row is never multiplied;
- PostgreSQL tenant RLS and `FORCE ROW LEVEL SECURITY` remain unchanged;
- cross-tenant rows remain invisible even when the foreign board is shared;
- unauthenticated fail-closed behavior, service-account behavior, admin/member
  treatment, and configurable superadmin bypass remain in the hooks;
- pagination totals are untouched; and
- SQLite receives the same portable `EXISTS`/`OR` semantics.

No permission cache, denormalized entitlement state, RLS exception, or
authorization relaxation was introduced.

## Tests and rollout

Added `branch-access.postgres.test.ts`, which runs through repositories under
real forced RLS and asserts:

- fallback `view`, direct owner, active group grant, and board-aligned board
  owner visibility;
- private hidden branch/board exclusion;
- moved-primary board visibility through both reference paths;
- exclusion of a shared board belonging to a second tenant;
- and PostgreSQL session page data and `total` equality over the same
  representative access paths.

Existing SQLite group/board suites cover all grant tiers, archived groups,
`none`, board alignment, and the moved-primary behavior. The focused run passed
495 related SQLite repository tests; the new PostgreSQL RLS test passed in its
live PostgreSQL lane. A local core-only isolated-database lane passed 15 files
with one pre-existing skipped test. The required PR workflow subsequently
passed **128 tests with zero skips across 26 isolated core and daemon files**.

This is a code-only rollout. There is no schema migration, index build, table
lock, backfill, or SQLite/PostgreSQL version skew. A staged deployment should
compare board find/get sample counts and p50/p95/p99, confirm the production
plan remains below its JIT threshold, and retain the old code as the ordinary
application rollback.

## Residual risks

- Production cardinalities, PostgreSQL settings, hardware, pool contention,
  and cache state were not supplied. The absolute synthetic timings should not
  be projected onto Agor Cloud.
- Agor's PostgreSQL client sets `prepare: false`, so generic/custom prepared-plan
  selection is not expected on the repository path. Different production
  cardinalities and PostgreSQL settings can still select a different ad hoc
  plan. Confirm that no alternate/proxy path prepares the statement and capture
  the production SQL plan with tenant/user values protected before declaring
  the incident closed.
- A member with access to almost every private board may cause more loops in
  the new indexed correlated subplan. The single JIT-disabled comparison and
  existing indexes still favor the new shape in this fixture, but production
  percentiles matter.
- Point authorization still has redundant indexed reads. Removing those safely
  requires a typed distinction between direct branch ownership and inherited
  board ownership plus service-level query-count benchmarks.
- The Datadog screenshot contains means only. Low sample counts or a few slow
  calls can dominate a mean, so follow-up dashboards must include counts and
  percentiles before prioritizing additional RBAC work.
