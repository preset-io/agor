# Heartbeat authority revalidation

This note records the contained design and hot-path cost for runtime authority
revalidation. Code remains authoritative.

## Decision

Keep the executor's existing `reportRuntimeTelemetry` call and existing Task
response. Before its atomic liveness write, the repository checks:

1. the locked Task's immutable creator and Session;
2. that Session's Branch and effective inherited/override permission config;
3. current principal existence, Branch prompt capability, and the workspace /
   Branch shared-session gates and branch-home scope when the Task creator
   differs from the Session owner;
4. current effective `none | read | write` access against the immutable launch
   floor; and
5. in PostgreSQL, the current exact task-token fingerprint and its tenant,
   user, Task, Session, Branch, expiry, and revocation predicates. The
   authenticated runtime-scope guard separately requires the task purpose.

Launch writes `executor_launch_fs_access_floor` into the existing Task JSON
inside the Task lock, before credential issuance. It is private repository data
and is stripped from Task DTOs. A launch retry may reuse the same floor, but
cannot lower it. No new table, endpoint, runtime-authority module, epoch,
cache, Redis protocol, response envelope, remount path, or watchdog was added.

Explicit denial returns a closed internal repository result. The service then
uses `beginExecutorTermination` with the single cause
`authorization_revoked`; the executor already consumes the returned
`stopping` Task through heartbeat `onTask`, aborts the provider, acknowledges
quiescence, and exits normally. Scope mismatch throws without stopping another
runtime. Store/query uncertainty rolls back and leaves liveness unchanged, so
the existing stale-heartbeat supervisor supplies the configured bound.

## Query shape and indexes

Full UUID Task IDs bypass short-ID lookup. Excluding transaction setup/RLS
`SET LOCAL` performed at the request boundary, one successful repository
heartbeat executes:

| Dialect    | Statements | Shape                                                                                                                                      |
| ---------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SQLite     |          3 | Task PK read; one runtime-access projection; Task PK update. The local token fingerprint is one process-map lookup.                        |
| PostgreSQL |          5 | Task PK `FOR UPDATE`; Task PK read; one runtime-access projection (also returns database time); token-fingerprint PK read; Task PK update. |

The previous PostgreSQL path used four statements: lock, Task read, a separate
database-time read, and update. The access projection replaces the time read
and the token check adds one statement, so the steady-state net is **one SQL
statement per 10-second heartbeat**. Denial omits the final update. No policy
list is materialized and there is no N+1 query.

The PostgreSQL service runs those five statements in one short fresh tenant
write transaction. This is deliberate rather than a second authority path:
the normal tenant-owned request transaction remains open until the service
returns, while an authorization denial must commit the repository's Task row
lock before the existing termination coordinator claims that same row in its
own transaction. Besides the five domain statements, PostgreSQL therefore sees
bounded transaction/RLS scaffolding (`BEGIN`, tenant `set_config`, the constant
tenant write-gate point read, a repository savepoint, and `COMMIT`). Request
authentication contributes one current-user PK read. The outer tenant-owned
request scope contributes a second current-user PK read and one constant
write-gate point read; the fresh unit contributes one more write-gate point
read. SQLite has no outer transaction and keeps its existing single repository
mutation transaction.

The access projection is one statement with a constant number of indexed
point/correlated probes:

- `sessions` and `branches` primary keys;
- `branch_permission_configs_branch_unique` or
  `branch_permission_configs_board_unique` for the effective binding;
- `users` primary key;
- `branch_permission_entries_config_user_unique` for a direct shadow and
  `branch_permission_entries_config_idx` plus membership/group keys for
  additive groups;
- `app_variables` tenant/namespace/key unique index for the workspace sharing
  gate. The Branch sharing switch comes from the already joined effective
  permission config, and the immutable SDK-home scope comes from the Session
  PK row; neither requires another probe.

The token read starts from the 64-hex `token_fingerprint` primary key and then
checks the exact tenant/resource/principal tuple. Policy/group work is bounded
by entries in one effective Branch configuration, never tenant-wide users or
Branches. PostgreSQL RLS and tenant-qualified predicates remain defense in
depth.

On 2026-08-28, a local file-backed LibSQL focused run of 100 sequential
successful repository heartbeats took **1.219 s total (12.2 ms/heartbeat)** on
the development container, excluding fixture creation and migrations. This is
not a production latency claim; it is a reproducible order-of-magnitude check
that includes transaction and three-statement overhead.

On 2026-08-30, a live PostgreSQL/RLS executor run captured the successful
heartbeat's five domain statement execution times as **0.025 ms** (Task lock),
**0.016 ms** (Task read), **0.057 ms** (access projection), **0.011 ms** (exact
token authority), and **0.162 ms** (Task update): **0.271 ms total database
execution time** before transaction scaffolding. The fresh transaction commit
took 1.086 ms on that local container. Parse/bind/network/application time is
not included, so this is evidence of query shape and order of magnitude, not a
production latency promise.

The same live run revoked a write grant during a 90-second command. The next
scheduled heartbeat began about 1.28 seconds after revocation, omitted the
token read and liveness update after access denial, committed its short
authority unit, and claimed termination without waiting on its own Task lock.
The Task reached its sanitized failed state 1.41 seconds after revocation; its
last durable heartbeat remained the pre-revocation value and the executor
exited with code 0 through the existing fenced path. The environment had no
Redis service, so PostgreSQL alone supplied the decision.

## Correctness and residual boundary

PostgreSQL is sufficient authority. Two independent session-token services and
database clients prove peer validation/revocation, and a Task repository test
revokes without notification before the next peer heartbeat. Redis fanout can
shorten the window by disconnecting a socket but is not in the correctness
chain.

Current user lifecycle represents deactivation/offboarding as principal
absence. When persisted active state lands, its active predicate must be added
to this point projection together with the other capability-policy predicates.

A runtime launched by an older daemon has no trustworthy launch floor. Its
next new-daemon heartbeat therefore fails closed as `launch_authority_missing`
instead of inventing a possibly lower floor. This is therefore a coordinated,
non-rolling daemon contract change: operators must first quiesce prompt/Task
admission, drain active Tasks, stop or replace **all** old daemon replicas, and
only then reopen admission on the new cohort. Draining alone is insufficient:
an old replica could otherwise launch a floor-less Task or accept heartbeats
without revalidation during the mixed-version window. No schema backfill can
reconstruct already-projected mounts safely. A future zero-downtime rollout
would require an explicit version/admission fence or bridge release rather
than weakening the missing-floor denial.

Web terminals have launch-time admission/mount projection but no Task
heartbeat. Dynamic terminal authority parity is intentionally outside this
contained change and should be tracked as a separate focused lifecycle issue.

## Complexity accounting

New concepts are limited to:

- one private field in existing Task JSON (the minimum durable launch floor);
- one closed runtime-access projection beside existing capability SQL;
- one exact current-token repository method; and
- one new termination cause consumed by the existing coordinator.

The PostgreSQL service also reuses the existing `withFreshTenantWrite` helper
to make the heartbeat decision's commit precede a denied termination claim. It
adds no module, protocol, state, or watchdog; it only makes the row-lock
ownership boundary explicit.

The launch path no longer separately asks `BranchRepository.resolveUserAccess`
or trusts request-user identity for token/mount/template inputs. Standalone
token storage was simplified from raw bearers to fingerprint keys. The change
therefore centralizes duplicate authority reads and adds no parallel lifecycle
or distributed invalidation state.
