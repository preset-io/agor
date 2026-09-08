# Session inventory SQL: count cost, not just page size

## Baselines and scope

- Initial clean branch and fetched `origin/main`:
  `33a428b95dc4a0f42a1ac8d551d533ce81ebd16d` (2026-09-07).
- The audit named `9326e8706a971fae6f45bc9ae38f998f10fe2d17`; that object
  was not present in this independent clone. No clone-diagnostics PR #2686 ref was fetched, cherry-picked, or modified.
  Its later arrival through merged main is recorded below.
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

## Shared-primitives review (follow-up)

The normalized policy predicate was already centralized before this PR. There
are deliberately different query shapes, not one universal authorization API:

| Use                                        | Existing owner                                                                                                   | Contract                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch/board inventory                     | `visibleBranchAccessCondition` / `visibleBoardAccessCondition`                                                   | Predicate on the current branch/board row; already at resource cardinality.                                                                   |
| Many rows referring to branches            | `inVisibleBranchSet`                                                                                             | Statement-local branch-ID membership, with optional exact branch, branch-set and board scopes. Holds policy evaluation at branch cardinality. |
| Exact branch reference / realtime audience | `visibleBranchReferenceAccessExists`                                                                             | Correlated exact-ID existence check; also accepts an outer user expression for viewer enumeration.                                            |
| Session/task/message references            | `visibleSessionReferenceAccessExists` and its task/message wrappers                                              | Follow the tenant-owned parent to its branch; do not confuse board visibility with branch visibility.                                         |
| Rich point authorization                   | `CapabilityPolicyRepository.resolveBranchAccess` (`BranchRepository.resolveUserAccess` compatibility projection) | Effective capabilities, filesystem access, owner/source/group explanation; checks principal existence.                                        |
| Task launch/heartbeat                      | `resolveSessionRuntimeBranchAccess`                                                                              | Bounded exact-session projection including prompting, filesystem access and session-sharing rules. Not an inventory visibility check.         |

The reusable branch-set primitive centralizes the optimization fence and scope
composition formerly embedded in `SessionRepository.findPage`. All four
session inventory readers now use it: `findPage`, `findAll`, `findByBoard` and
`findAccessibleSessions`. Residual service filters still run after authorized
candidate selection; this does not broaden SQL pushdown or discard predicates.

### Important usage boundaries

- These inventory SQL predicates take an **already authenticated, existing
  same-tenant principal** and run in the caller's existing trusted tenant DB
  scope. They are not authentication or a complete `canUserDoAnything` API.
  In particular the low-level list predicate does not independently check that
  an arbitrary supplied user ID exists; the rich point resolver does. Do not
  expose a caller-selected user ID as authority or use the list predicate as a
  replacement for that resolver.
- Tenant administrator bypass belongs to trusted service hooks, not to these
  user-ID predicates. Owner rights, view rights, prompting another user's
  session and filesystem access are different questions.
- Scope IDs only intersect the allowed branch set. Empty branch sets deny;
  branch and board filters combine, never override one another. The board
  scope is a location filter, **not** a grant from `board_access`.
- `inVisibleBranchSet` requires a fixed principal ID. Do not use it to enumerate
  principals; the existing correlated point/reference predicate owns that case.
- No allowed-ID array is cached or fetched into application memory. Each SQL
  statement reads current policy and membership under its existing DB scope.

### Other consumers reviewed, not mechanically rewritten

Branches and boards already apply their respective shared policy at their own
row cardinality. Replacing their predicates with another membership join adds
no demonstrated benefit. Messages/tasks use shared session-reference checks;
board comments, marketplace attachments and nested references reuse those
same helpers. Artifacts/board objects use branch-reference checks; cards and
board objects separately enforce board visibility. Schedules join branches
and could benefit from the new primitive if a many-schedules-per-branch
fixture establishes the same problem.

For messages/tasks, a branch-set rewrite must be measured separately for both
broad inventory and selective exact-session history. Forcing a full allowed
branch set for one exact session can do unnecessary work. This follow-up does
not claim their current plans are optimal, nor change all reference helpers
without reproductions. The remaining nested policy EXISTS clauses and the
separate rich/SQL role projections are unchanged; consolidation of those
semantics needs broader capability/terminal/owner parity evidence, not merely
similar-looking SQL. The new differential coverage compares visibility from
row predicates, exact-ID predicates, branch-set predicates, rich point checks,
and all session inventory readers on the same SQLite/PostgreSQL policies.

Follow-up started from `ff32e0dae72450723f97a5240cc05cb4293fb5d7`;
fetched main was still `74e96187b663cd533a1925a46d3ba5db72047890`.
A new regression failed before the extraction: actual `findAll` policy
SubPlans each ran 20,000 times, with 850,569 shared buffer hits and an observed
14,730.310 ms execution. The page path was already at 200 loops.

After extraction, the same isolated 200-branch/20,000-session fixture captured:

| Actual repository query       | Returned rows | Max policy loops | Shared hits | Execution ms |
| ----------------------------- | ------------: | ---------------: | ----------: | -----------: |
| `findAll`                     |        10,000 |              200 |       9,479 |      190.928 |
| `findByBoard`                 |        10,000 |              200 |       9,480 |      172.433 |
| `findAccessibleSessions`      |        10,000 |              200 |       9,480 |      287.931 |
| `findAll`, one visible branch |           100 |                1 |          58 |        1.490 |

Each reader executes one query. The new plan assertions enforce the 200/1
policy-loop bounds, one-query contract and exact returned cardinality. Timing
remains observational, not a test threshold or a production estimate. The
expanded isolated fixture's two tests passed; cross-tenant negative checks now
exercise the additional readers as well. Full follow-up validation and managed
smoke outcomes are recorded in the PR body.

## Message/task inventory review and guardrails

The next follow-up rebased normally onto current main
`8f8b3ec764a9c28ee658b4f2d5cedf95265c5e47`, which now contains the
merged #2686. No clone-diagnostics source was modified and no PR commit was
cherry-picked. The earlier PR commits became `a10a2fcf310fa53b5f9407f0dfd4133109d66e9d`
(implementation), `a71716eaaac5e6b03e36396e6d8c561efb44a8bd` (evidence), and
`1470af728e53400bf776307408ef6fe59926472d` (shared branch-set composition).

The message/task reproduction found **no analogous per-child policy scan**.
Their shared `visibleSessionReferenceAccessExists` uses an INNER JOIN, unlike
the expensive LEFT JOIN in the session reproduction. The inspected PostgreSQL
plans can filter branches first, join their sessions, and semi-join the child
inventory. For exact session/task/message IDs, the planner instead uses the
selective parent lookup. This difference is evidence against mechanically
replacing this helper with a fenced full-inventory set.

An initial isolated fixture with 200 branches, 2,000 sessions, and 20,000 rows
**in each** of tasks/messages returned 10,000 visible children per table.
Observed policy-loop bounds were already 200 for broad count/page queries,
1 for exact session/task/message queries, and 2 for a two-session scope
containing one denied and one visible session. Representative broad count
observations were 144.951 ms (tasks) and 146.700 ms (messages); exact-session
counts were 0.673/0.691 ms. These are existing-query fixture measurements, not
a before/after speedup or a production estimate.

`session-children.inventory.postgres.test.ts` now guards broad and selective
query shapes at three ratios: 1, 10, and 100 sessions per branch, respectively
100, 10, and 1 children per session. Every case has 200 branches and 20,000
rows in each child table. It captures actual `findAll` and `findPage` SQL,
checks query counts and returned cardinality/projection, and explains the
count/data statements. Assertions bound policy work at branches for broad
inventories and at 1/2 for selective scopes, without timing thresholds.
Session and child plan tests share small test-only capture/inspection helpers.

The existing cross-dialect policy fixture now also seeds a task and message
per session. It compares all/page/count/select/skip/status/role and mixed,
empty or contradictory session scopes against the same visible-session set,
including direct-user shadowing, groups/Others, owner/admin-ID distinctions,
archive/removal revocation and independent board/branch visibility. PostgreSQL
negative checks cover foreign session, task and message IDs and unmarked
count-only requests; a foreign tenant cannot contribute to totals.

**No message/task runtime SQL or authorization behavior was changed.** Keeping
an already efficient shared primitive, documenting why, and adding repeatable
regressions is the evidence-backed extension here. This does not establish
optimal plans for every possible filter, data distribution or database version.
Full validation and managed message/task smoke results are in the PR body.

## Canonical capability definitions and broader predicate parity (2026-09-08)

The next user-approved follow-up started at
`b2e6dce995af8591ea1bdfd695a8ad13268d5989`. A fresh fetch confirmed main
was still `8f8b3ec764a9c28ee658b4f2d5cedf95265c5e47`; no rebase or
clone-diagnostics edits were needed.

Review found a concrete maintainability hazard, not a reproduced authorization
bug: SQL kept independent board/branch capability-to-role tables alongside the
canonical role expansion used by policy writes and rich point resolution.
`capabilityPolicyPresetsGrantingCapability` now inverts that canonical expansion;
SQL derives its static allow-lists once from it. These are product definitions,
not cached user/resource decisions. Terminal's SQL still requires actual
filesystem grants, including role/file contributions from different groups.

`branchCapabilityCondition` is now a typed reusable row predicate, and
`boardCapabilityCondition` generalizes the existing board visibility predicate.
The existing visibility/admission wrappers use them without changing their SQL
policy precedence. Unsupported capability values fail closed, even for owners.
Both predicates require the resource table in the outer query and an existing
authenticated same-tenant principal in trusted tenant DB scope. They neither
implement admin bypass nor replace principal-existence checks or foreign-session
prompt authority. No new public service method, query operator or permission
was introduced.

The new persisted-policy matrix compares SQL against rich point resolution for
all four board and eight branch capabilities, all roles and valid filesystem
dimensions, across direct/group/Others grants. It exercises an owner, a member,
and an admin-ID principal; direct entries shadow stronger group grants and
matched groups suppress stronger Others grants. Both inherited and overridden
branches are checked. Split group role/filesystem grants, group archive and
membership removal cover terminal derivation and immediate revocation.
PostgreSQL repeats the matrix in isolated tenant scopes and checks foreign
board/branch IDs for every capability, including an attempted foreign-owner-ID
bypass. Existing inventory/count and cross-tenant regressions remain intact.

Before replacing the role tables, the initial SQLite matrix and capability tests
passed with the historical tables temporarily restored (13 tests). The expanded
matrix passes with canonical-derived tables. Explicit role-expansion assertions
preserve the historical allow-lists independently of the differential checks.
No authorization mismatch reproduced; this follow-up removes drift risk rather
than claiming a new access fix or speedup. Production inventory SQL composition,
query counts, pagination, residual filters, RLS and HA boundaries are unchanged.
The plan regressions remain the performance guardrail; nested-predicate rewrites
or a universal fenced query are not justified by this change.

Final validation totals and managed smoke results are recorded in the PR body.
