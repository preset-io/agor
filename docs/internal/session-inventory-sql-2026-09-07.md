# Session inventory SQL: count cost, not just page size

## Baselines and scope

- Initial clean branch and fetched `origin/main`:
  `33a428b95dc4a0f42a1ac8d551d533ce81ebd16d` (2026-09-07).
- The audit named `9326e8706a971fae6f45bc9ae38f998f10fe2d17`; that object
  was not present in this independent clone. No commit from clone-diagnostics
  PR #2686 was fetched, cherry-picked, or modified.
- Both prior fixes are ancestors of the initial baseline:
  `5ff672d98646f97226bf14284dace87c672fff9b` (#2555) and
  `ac0861269cc40811b521e6c6765e59d363309665` (#2669).
- Main advanced during this work to
  `74e96187b663cd533a1925a46d3ba5db72047890` (#2687), following
  `7a5bbc95b905b73fe74c87f20ed71b0d07b85708` (#2682). This branch was
  rebased onto that exact main. #2687 independently fixed exact-status SQL
  paging; its implementation, validation and regression were retained rather
  than duplicated here. The count/projection issue remained.

Read the canonical session guide under `apps/agor-docs/content/guide/`
(the older `pages/guide/` pointer is stale), multitenancy, testing, and the
normalized-policy implementation guidance. Sessions, branches and policies are
tenant-owned; visibility/counts are derived tenant-owned information. Existing
trusted service markers and PostgreSQL tenant scopes/RLS remain authoritative.

## Supplied telemetry, with its limits

[The 17:12:20 UTC trace](https://app.datadoghq.com/apm/trace/6a9ef074000000007d3ed6f31f3dec4e?spanID=7779615651796564656)
records `sessions.find` at 6379.933594 ms, with an authorization-filtered count
at 3139.570801 ms. The next SQL span is labelled non-parsable (3038.710205 ms):
its query text, plan and row count are **unknown**, not established as a page
query. Another supplied Socket.IO find took 6495 ms; an MCP find took 31 ms.
These demonstrate access/query-shape sensitivity, not full-traffic rates.

This session's attached MCP server list and eligible-server catalog were both
empty. Datadog was not independently queried here. Retained spans are sampled;
their counts/p95 are not traffic-wide statistics. Inspected audit traces had
no deployment version/SHA, and the audit's log searches had no matching
service/host/trace logs. Neither deployment identity nor absence of errors can
be inferred from that.

## Reproduction and change

`sessions.inventory.postgres.test.ts` builds isolated synthetic tenant data:
200 branches, 100 sessions per branch, half private and half granting the
unmatched viewer access. Separate small policy fixtures in two other tenants
exercise negative isolation. Connections use the non-superuser, non-BYPASSRLS
application role. Statistics are analyzed **only in the disposable database**.

The baseline count joins sessions to branches, then applies the existing
owner/direct-user/group/Others predicate. PostgreSQL leaves that predicate on
the join: each of its six policy SubPlans executes 20,000 times. The query
returns 10,000 visible sessions.

The changed query applies the **same predicate** inside an uncorrelated
branch-ID set. `OFFSET 0` prevents flattening that set back into the outer
join; SQLite uses its equivalent unbounded `LIMIT -1 OFFSET 0` syntax. Board
and branch scopes also constrain the inner set. The set is statement-local,
not an application cache or persisted authorization snapshot. Both count and
page independently consult current authority inside their existing scope.

Representative rebased production-query captures (not production traffic):

| Query                    | Visible total / page rows | Max policy SubPlan loops | Shared buffer hits | Execution ms |
| ------------------------ | ------------------------: | -----------------------: | -----------------: | -----------: |
| Baseline count           |                10,000 / — |                   20,000 |            850,569 |   11,801.383 |
| Changed repository count |                10,000 / — |                      200 |              9,466 |      129.028 |
| Changed repository page  |               10,000 / 20 |                      200 |              9,485 |      154.571 |

Timings are illustrative observations, **not assertions or production speedup
estimates**. Tests capture the actual repository count/page SQL and run
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against it. Assertions cover equal
authorized counts, returned cardinality, policy-loop bounds and query count,
not wall-clock thresholds. `INVENTORY_PLAN` output retains repeatable full plans.

Other changes:

- Page projection retains every Session column (including hidden tenant
  mapping) but selects only `branches.board_id`, not the repeated branch blob.
- `$limit:0` executes just the count, not a second data query. A normal page
  still uses two queries; relationship enrichment remains separate.
- SQL pagination now respects the adapter's configured default and maximum.
  **Audit correction:** sessions explicitly configure **10,000**, not 1,000.
  The latter is the generic adapter's fallback. Valid `$limit:10000` remains
  supported. A regression configures a smaller adapter cap to prove it cannot
  be bypassed by SQL paging.
- Extra filters/operators and `$select` still take the full residual-filter
  path; no residual predicate is discarded to force a SQL page. Testing found
  that `$select:['title']` previously sent undefined IDs to relationship SQL.
  ID-less selections now skip that enrichment without adding unselected fields.

## Repeatable validation

```sh
pnpm i
pnpm check
pnpm --filter @agor/core exec vitest run \
  src/db/repositories/sessions.inventory.test.ts \
  src/db/repositories/sessions.test.ts \
  src/db/repositories/capability-policies.test.ts
pnpm --filter @agor/daemon exec vitest run \
  src/services/sessions.find.test.ts \
  src/utils/rbac-find-scoping.test.ts \
  src/utils/branch-authorization.test.ts \
  src/mcp/tools/sessions.test.ts
pnpm test:postgres:docker
```

The PostgreSQL runner provisions the reviewed pgvector image, verifies role
flags, creates a separate database per test file, and removes it afterward.
Do not point performance/ANALYZE tests at a live deployment database.

Coverage includes private/shared boards and independent branch visibility,
owner versus explicit admin-ID predicates, direct-user denial shadowing a
granting group, group denial suppressing Others, group-only grants, inherited
templates, archived groups and removed membership, archive/status filters,
branch/board/set scopes, stable continuation pages, skip/limit/count and
Session mapping. Cross-tenant requests include explicit foreign branch IDs and
foreign-board count-only requests, including the no-RBAC-marker path. Existing
service-hook suites cover trusted administrator/internal bypass distinctions.

Validation results and managed browser smoke are recorded in the PR body.

## Operational limits

No schema/index migration, policy rewrite, authorization cache, transaction
lifetime change, telemetry change, or deployment is required by this patch.
Large branch inventories still have policy-resolution costs, and exact counts
still inspect matching sessions. Unsupported query shapes still materialize
candidates. This is not a claim that all historical latency is fixed.

In particular, the supplied 09:03:43 trace
`6a9e7def0000000079cfe8b709b9bfe7` records a separate 49.49-second
`branches.get` failure with PostgreSQL `CONNECT_TIMEOUT`. Connection capacity
and timeout investigation remains distinct. Health-monitor outer transactions,
OAuth/gateway changes and board-query validation are outside this change.
