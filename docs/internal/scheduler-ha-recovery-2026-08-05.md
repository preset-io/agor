# Scheduler HA and recoverable occurrence initialization (2026-08-05)

## Decision

The first daemon-HA scheduler slice uses the existing scheduled `Session` plus its
initial `Task` as the durable occurrence/recovery record. It does **not** add a
`schedule_runs` table.

That choice is deliberate:

- `sessions(tenant_id, schedule_id, scheduled_run_at)` already represents exactly
  one accepted occurrence and is already the product-visible run history.
- the Session is inserted before MCP attachment or prompt work and snapshots the
  rendered prompt, effective MCP IDs, runtime configuration, and a stable
  `initial_task_id`;
- a stable Task insert plus an atomic `CREATED|QUEUED -> DISPATCHING` transition
  makes prompt recovery idempotent and fences stale starters;
- an internal, nullable `sessions.scheduler_init_completed_at` marker is written
  only after initialization, retention, and schedule metadata are durable. A
  bounded scan of NULL markers recovers both cron and manual occurrences without
  depending on the cron grace window.

A new run ledger would duplicate Session/Task state, introduce reconciliation and
retention questions for a second history, and make “manual run is in progress but
has no Session yet” a new product-visible semantic. None of that is needed for this
failure window. Revisit a separate ledger only if a future requirement must persist
skipped/rejected occurrences as first-class history or coordinate work before a
Session can exist.

## Current-state audit before this change

The old flow was:

1. every 30 seconds, discover every enabled schedule whose `next_run_at` was due;
2. derive the latest cron occurrence (two-minute grace, no backfill) or minute-round
   `run-now`;
3. look for an existing `(schedule_id, scheduled_run_at)` Session;
4. check active Sessions when `allow_concurrent_runs=false`;
5. render the prompt and materialize user/preset defaults;
6. insert an IDLE Session; the partial unique index resolved only same-occurrence
   insert races;
7. attach configured MCP servers;
8. call `/sessions/:id/prompt`, which created a Task and moved it to DISPATCHING;
9. advance schedule metadata;
10. attempt retention best-effort.

Cron and manual triggers in the same minute intentionally share the same occurrence
identity. A repeated manual click returns the existing Session. A cron concurrency
collision is skipped and advances the cursor; a manual collision returns
`schedule_busy`. `allow_concurrent_runs` is schedule-scoped, not branch-scoped.

Three audit corrections mattered:

- comments claimed a per-schedule advisory lock existed, but the scheduler never
  called the advisory-lock helper;
- source schema defined PostgreSQL `sessions_schedule_run_unique` as
  `(tenant_id, schedule_id, scheduled_run_at)`, while migrated databases still had
  the historical `(schedule_id, scheduled_run_at)` index; migration 0071 repairs
  that mismatch;
- `session_mcp_servers_pk` was only a non-unique index in both dialects, so concurrent
  recovery could duplicate attachments. The new migrations deduplicate legacy rows
  and make it a real dialect-appropriate unique index.

## Kill-point audit and settled recovery behavior

| Kill point                                              | Old result                                                                              | New result                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before Session insert                                   | Due cursor remains; later tick retries                                                  | Same                                                                                                                                                                  |
| During/after Session insert                             | Insert may win, but later schedulers returned it and permanently skipped initialization | Unique Session is the durable occurrence; later scheduler reconciles it                                                                                               |
| Schedule deleted after Session insert                   | FK became NULL and the occurrence disappeared from recovery                             | Discovery does not require the live FK; the Session snapshot finishes prompt/MCP initialization, then skips deleted-schedule metadata/retention                       |
| During MCP attachment                                   | Partial attachment set, never repaired                                                  | Effective MCP IDs are snapshotted; attachment is insert-on-conflict idempotent and retried                                                                            |
| Before initial Task insert                              | Prompt permanently lost                                                                 | Stable `initial_task_id` is already in Session; retry creates that Task                                                                                               |
| After Task insert while CREATED                         | CREATED was outside scheduler recovery/startup orphan handling                          | Retry reuses the same Task and atomically claims DISPATCHING plus its Session RUNNING/task-list projection                                                            |
| Two daemons starting the Task                           | Process-local session lock did not cross daemon boundaries                              | row-locked expected-state transition has one winner; losers return durable state                                                                                      |
| After DISPATCHING, before transcript/service projection | SQLite could leave an IDLE Session without its Task/message projection                  | Task claim + Session projection are one dialect-native transaction; the stable initial message ID lets recovery repair the transcript idempotently                    |
| After durable DISPATCHING projection                    | Runtime supervision owns the durable launch intent                                      | Scheduler repairs the stable transcript projection and finalizes initialization without replaying work or re-running mutable creator/tool/preset launch admission     |
| After prompt dispatch, before metadata                  | Existing Session caused metadata advance, but initialization was not checked            | Task state is reconciled, then retention and metadata run                                                                                                             |
| During retention                                        | failure was swallowed after metadata, so cleanup could be missed indefinitely           | retention precedes metadata; active/incomplete overflow runs are deferred, absence after a concurrent delete is idempotent, and other failures leave the schedule due |
| After metadata, before completion marker                | occurrence was usually treated complete because the cursor had advanced                 | bounded incomplete-Session discovery reconciles once more, then writes the marker                                                                                     |
| After completion marker                                 | occurrence is complete                                                                  | Same; every prior required step is already durable                                                                                                                    |

A process kill cannot be represented by a thrown JavaScript exception, so scheduler
tests inject crashes immediately after Session admission, MCP attachment, prompt
dispatch, retention, and metadata. Repository tests separately cover the Task-create
and Task-dispatch boundaries.

## Coordination and transaction model

All daemons scan. There is no fleet leader and no external lock service.

Occurrence admission is one short tenant transaction:

1. `SELECT` the schedule row `FOR UPDATE` on PostgreSQL;
2. re-check the occurrence unique key;
3. when concurrency is disabled, check for an active Session **or** its initialization
   window (no Task / nonterminal Task);
4. insert the Session;
5. commit.

Rendering, configuration resolution, MCP attachment, prompt dispatch, retention, and
executor launch are not performed while that row lock is held. Admission uses the
already-materialized Session repository path rather than the public Feathers create
pipeline. Realtime/analytics and Unix-access synchronization run after admission;
the shared Unix side effect is now a deferred `sessions.created` event consumer so
ordinary and scheduled Session creation cannot launch a process while holding a
tenant transaction. SQLite keeps its
standalone behavior; same-occurrence uniqueness is its race guard and bounded
`SQLITE_BUSY` retry protects concurrent final metadata updates.

No scheduler claim survives a transaction, so there is intentionally no expiring
lease, owner token, or generation column in this slice. Durable transition state is
the fence:

- the Session unique key elects the occurrence;
- the stable Task primary key elects prompt creation;
- Task status conditionally moving to DISPATCHING elects the launcher and
  atomically projects RUNNING/task membership onto the Session in both dialects;
- the existing heartbeat/runtime supervisor owns work after DISPATCHING.

Once the stable initial Task is no longer CREATED/QUEUED, recovery is deliberately
a projection-only path. It verifies the Task identity and snapshotted prompt, repairs
the deterministic initial message if needed, and returns before tool enablement,
preset materialization, or creator lookup. Disabling a tool, deleting a preset, or
removing the creator after durable dispatch therefore cannot strand the scheduler
completion marker. Those checks still apply while the Task is absent or pending,
because crossing DISPATCHING would launch new work.

Adding an expiring scheduler lease would create a dangerous pause-after-expiry window
around executor launch unless every side effect were independently fenced. The
idempotent state transitions already provide the stronger and smaller design.

### Diagnostic identity lifecycle

The daemon composition root creates exactly one immutable `DistributedWorkIdentity`
when it creates the Feathers application, stores that object on the application, and
injects the same object into SchedulerService. Future background consumers should read
that app-owned identity rather than creating worker-local identities.

`instanceId` precedence is `AGOR_DAEMON_INSTANCE_ID`, then `HOSTNAME`, then the safe
`daemon` fallback. Whitespace-only candidates are ignored and selected values are
trimmed. The platform should supply a stable value when diagnostics must correlate one
daemon instance across restarts; the fallback is intentionally only a label. A dedicated
YAML `deployment.instance_id` may be added later with the HA configuration contract;
no existing unrelated configuration field is reused for this identity.
`bootId` is generated exactly once at application initialization and identifies that
one process incarnation.

Both fields are diagnostic log correlation only. Neither is an authorization,
fencing, lease, liveness, ownership, or correctness boundary. External-launch assertion
binding remains a separate security concern and is not read or changed by this identity.

## Scanning, recovery bound, and diagnostics

Defaults:

- due-schedule and incomplete-Session scans are independently limited to 25 rows;
- incomplete discovery uses a `(created_at, session_id)` keyset cursor and wraps;
  the cursor advances regardless of per-row success so one poison batch cannot
  permanently starve newer recoveries. It is only scan fairness state—the NULL
  database marker remains the durable authority and every wrap retries failures;
- a full batch drains again after 50–250 ms;
- startup waits a uniform 0–30 seconds;
- empty scans back off to at most 60 seconds with +/-20% jitter;
- therefore an already-running replacement notices an incomplete occurrence in
  the current recovery page within at most **72 seconds** of scan delay, and a
  newly started replacement within **30 seconds**, plus database/application
  work time. With a recovery backlog, add at most one 50–250 ms saturated-drain
  delay plus processing time for each preceding 25-row page. This is independent
  of cron grace and does not require another manual `run-now` request.

The 72-second cap remains below the two-minute cron grace. Jitter only reduces herd
contention; uniqueness and atomic transitions own correctness. Clock/random samples
are injectable or pure for deterministic tests.

Bounded `[distributed-work.<component>]` `key=value` logs include event, daemon
instance ID, boot ID, trusted tenant/schedule/session/task IDs, occurrence time,
source, Task status, and activity-scan candidate/processed/failure counts. Idle scans
are omitted. Events distinguish occurrence admission wins, losses/reconciliation,
busy skips, initialization, and recovery. Prompt text, schedule names, user identity,
MCP credentials, task tokens, raw errors, and other secrets are not logged. Lease
expiration is not reported because the scheduler has no lease.

## Tenant boundary

System discovery has one narrow `scheduler_discovery` RLS capability. It can select
only enabled schedule routing rows and scheduled Sessions whose internal completion
marker is NULL, including an incomplete Session whose live schedule FK was nulled by
schedule deletion. The repository queries project only routing IDs, occurrence time,
and `tenant_id`, with predicates and batch limits; prompts/configuration are not
visible in system scope. The capability is transaction-local. Each candidate is then
reloaded and processed under its trusted tenant context; Session, Task, MCP, schedule
metadata, retention, and realtime events remain in that scope. PostgreSQL integration
coverage checks system routing, tenant reload isolation (including the deleted-schedule
case), concurrent admission, and Task fencing.

## Thin reusable foundation and non-goals

Reusable pieces introduced by this slice are intentionally low-level:

- a pure `DistributedWorkIdentity` factory for app-owned instance/boot diagnostics;
- pure bounded backoff, jitter, and startup-offset helpers with injected randomness;
- repository-level stable-ID pending Task creation;
- repository-level atomic expected-state dispatch claim.

There is no `DistributedWorkController`, generic state-machine runner, universal lease
table, consensus abstraction, leader election, or automatic retry framework.
Scheduler still owns its occurrence state machine.

## PostgreSQL basis

The design follows PostgreSQL's documented behavior:

- row locks are held until transaction end, so admission transactions must remain
  short: <https://www.postgresql.org/docs/17/explicit-locking.html>;
- under READ COMMITTED, each statement receives a fresh snapshot, and the row-lock
  wait is followed by re-checking durable state:
  <https://www.postgresql.org/docs/16/transaction-iso.html>;
- `SKIP LOCKED` is appropriate for queue-like consumers but provides an inconsistent
  view, so this slice does not use it for schedule correctness:
  <https://www.postgresql.org/docs/18/sql-select.html>;
- transaction-scoped advisory locks exist, but a durable schedule row is available
  and clearer here: <https://www.postgresql.org/docs/current/functions-admin.html>.

## Follow-on candidates

1. Session queue draining now benefits from the cross-daemon Task dispatch fence, but
   its queue-position selection and session readiness decision still need a complete
   HA audit before claiming multi-daemon safety.
2. Gateway listeners and other background consumers should reuse identity/delay
   helpers only; their owner-specific state machines should remain local.
3. Work that must hold ownership across external calls should add database-time lease
   expiry plus an opaque generation/token and require every state transition to match
   that generation. Do this only for a concrete second/third consumer.
4. Task DISPATCHING supervision and process ownership are the next daemon-HA boundary;
   this scheduler slice intentionally stops at durable launch intent.
