# Task runtime HA reconciliation

**Checkpoint date:** 2026-08-07
**Base dependencies:** scheduler HA PR [#2174](https://github.com/preset-io/agor/pull/2174), merged as `f48e929e`, and Session queue HA PR [#2180](https://github.com/preset-io/agor/pull/2180), merged as `a1dc2c15`.

**Successor status:** the explicit constrained HA composition now selects
`shared_postgres`; see `daemon-ha-redis-realtime-2026-08-07.md`. References below
to a future activation or a hard-coded standalone composition describe this
design checkpoint, not the current integration.

**Base integration checkpoint:** this branch was rebased onto `main` after both dependencies merged. #2180 now owns durable queue admission, ordering, all-daemon queue discovery, and the Session-first dispatch fence. This change retains the post-claim runtime work that #2180 explicitly left as its follow-up: dispatch/heartbeat expiry, stranded termination recovery, containment evidence, startup ownership, and outcome UX. Generic contained executor commands retain their legacy process-local registry. PostgreSQL `0073` and SQLite `0076` are the next migration ordinals on this base.

This change deliberately reuses the thin helpers in `@agor/core/coordination` for diagnostic identity and deterministic delay policy. It does **not** introduce a distributed-worker framework or a central controller. Task state remains owned by `TaskRepository` and Task-specific services.

## Policy boundary

Task runtime startup now has an explicit internal policy:

| Policy            | Boot behavior                                                                                                                                 | Intended deployment       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `standalone`      | Preserves the legacy sentinel, active-orphan release, Session reset, and restart messages; queued Tasks remain durable per #2180              | Default/non-HA and SQLite |
| `shared_postgres` | Does not consume/write the process-global sentinel and does not mutate Tasks, queues, Sessions, or transcripts merely because a daemon starts | Explicit constrained HA   |

The successor composition root passes `shared_postgres` only after explicit HA
validation. Standalone remains the default and must not be changed implicitly
by PostgreSQL or `REDIS_URL` alone.

Both policies run the Task runtime reconciler. PostgreSQL uses database time for discovery, dispatch/connect heartbeats, termination claims, coordination leases, and settlement where practical. SQLite retains its existing process-clock behavior and supports injected clocks in tests.

## Current-state and kill-point audit

### Startup cleanup and clean-shutdown sentinel

**Before the HA queue/runtime work:** `daemon-shutdown-clean.flag` was global to `AGOR_HOME`. Every daemon boot consumed it, classified all active Tasks/Sessions as orphaned, settled active Tasks as `restart_unverified`, stopped every queued Task, reset active Sessions, and injected daemon restart/crash messages. Replica B starting could therefore destroy replica A's work. #2180 already removed queued Tasks from standalone orphan cleanup; this PR owns the remaining active-runtime and notice boundary.

**Now:** the entire sentinel/cleanup/notice path is gated by `standalone`. `shared_postgres` startup performs no Task-runtime mutation. A daemon boot is not evidence of executor death.

**Kill points:**

- Crash before sentinel write: standalone preserves legacy “unexpected restart” behavior.
- Crash after sentinel write but before shutdown completes: standalone preserves the legacy classification limitation.
- Any shared-mode boot/shutdown: ignores the sentinel because it cannot encode replica ownership.

### Dispatching Tasks awaiting executor connection

Durable authority is `tasks.status='dispatching'`, `started_at`, `executor_connected_at`, and the internal `dispatch_timeout_observed_at` recovery marker.

- Discovery is bounded and ordered by `(started_at, task_id)` through a partial index.
- PostgreSQL computes expiry from `CURRENT_TIMESTAMP`.
- The executor connection and timeout claim race at the row lock. Connection changes the status and connection timestamp; a timeout claim requires the exact expected status and a null connection.
- Slow templated launchers receive one idempotent nonterminal warning and leave the expired-deadline scan through the durable observation marker; this prevents permanently ambiguous remote launches from hot-looping or starving local candidates. Local launchers enter containment.
- #2180's Session-first admission fence covers **different** pending Tasks. Prompt admission is already durable and queued; an explicit `created` Task cannot jump the queue. This PR adds PostgreSQL database time to the winning dispatch deadline without replacing that fence.

**Kill points:**

- Daemon dies after Task dispatch claim but before spawn: the dispatch deadline makes the Task discoverable.
- Executor connects while a timeout candidate is in flight: connection wins or the exact timeout claim wins; both cannot own the Task.
- Two daemons claim the same Task: the Task expected-state fence admits one.
- Two daemons claim different Tasks for one Session: #2180's Session lock and durable queue-head check admit one without allowing a second executor.

### Connected heartbeats and SDK pulses

Executor heartbeat remains the sole liveness signal. No daemon-per-Task heartbeat was added.

- Heartbeat writes use PostgreSQL database time.
- Discovery returns only routing identity plus the exact heartbeat timestamp observed by the stale scan.
- The tenant-scoped reload must still match that timestamp and an executor-owned status.
- The termination claim repeats the same exact timestamp fence.
- SDK pulse data remains a bounded fact coalesced at heartbeat cadence.
- A heartbeat handled by any daemon returns the current durable Task. If it is already `stopping`, the executor observes the termination request even without cross-replica realtime fanout.

**Kill points:**

- Fresh heartbeat after discovery but before tenant reload: reload rejects the old candidate.
- Fresh heartbeat after reload but before claim: row-locked exact timestamp check rejects the claim.
- Original daemon dies while a detached/remote executor remains alive: another daemon accepts its token-authenticated heartbeat and returns durable control state.

### STOPPING and stranded termination

A termination request remains durable in `Task.termination_request`. Containment coordination is Task-specific:

- Materialized claim token, claimed time, lease expiry, instance ID, and boot ID live on the Task row.
- The opaque token is an unconditional settlement fence for normal containment
  outcomes. Clearing it into guarded-unverified state prevents a stale
  coordinator from settling later. Daemon identity is diagnostic only.
- Every daemon may discover `stopping` Tasks whose coordination claim is absent or expired.
- One conditional database transition wins a coordination lease.
- A replacement daemon reuses the existing termination request epoch and claims a new token after expiry.
- Old coordinators cannot settle after replacement.
- A durable `termination_unverified_at` marker removes guarded Tasks from stranded discovery so they do not hot-loop or starve later rows.
- User Stop retains cause precedence.

**Kill points:**

- Coordinator dies after writing `stopping` but before coordination claim: immediately discoverable.
- Coordinator dies with a live claim: discoverable after lease expiry.
- Coordinator dies after containment but before settlement: a replacement repeats idempotent containment and settles with a new token.
- Lease expires during a slow containment attempt: the old settlement loses its token fence. The default lease is longer than the cooperative and signal grace windows.

Transactions cover only discovery, claim, evidence, settlement, and the settlement's minimal Session projection. Cooperative waits and OS containment occur outside database transactions.

### Local and templated containment

Initial HA support for process tracking is intentionally narrow:

- Local process handles are scoped to one daemon application via a `WeakMap`; tests can construct two applications in one process without sharing ownership accidentally.
- Only the daemon with the matching tracked PID/PGID may claim local verified absence.
- Missing local tracking is **not** absence proof.
- After cooperative quiescence, local containment gives the process wrapper a brief exit grace. This includes transient `EPERM` inspection in strict mode while a root-owned `sudo` wrapper unwinds; only a subsequent explicit absence result is authoritative.
- A non-owner waits a short grace period for the owner, then may reclaim the durable request, but containment remains `unverified` without an authoritative handle. The Task stays `stopping`.
- A branch owner/admin may force-fail an unverified Task by typing the stable literal `STOP`. This changes durable status only; it does not convert the evidence to verified or guarantee process termination.
- Local executors are detached from the daemon process, but survival still depends on the execution substrate. If the substrate survives launcher loss, they may reconnect and heartbeat through another replica. The checked-in shared-local Compose smoke stack does not guarantee survival when the whole daemon container is lost.
- Standalone graceful shutdown retains local PGID containment. A shared
  replica does not intentionally kill its detached executors, allowing a
  substrate that independently survives the daemon to reconnect through a
  peer; this is not a guarantee that a shared-local container keeps the process
  alive. Killing it here and discarding the only process-local absence evidence
  would force the peer into an avoidable unverified hold.
- Templated executors become verified only through authoritative launcher failure before dispatch or scoped executor cooperative-quiescence evidence.

OpenCode remains guarded when server-side execution termination cannot be verified.

### Session projection

Task settlement is authoritative and happens before Session projection.

- A verified non-user interruption writes the Task as `failed`, marks containment `verified`, then writes the Session as `failed` and `ready_for_prompt=true` in the same short transaction.
- User Stop writes the Task as `stopped`, then projects the Session to `idle` in that transaction.
- Unverified containment does not terminalize the Task or make the Session promptable.
- If the Session projection cannot be written, the transaction rolls back the Task settlement. A daemon therefore cannot die between two durable commits and strand a terminal Task behind a `stopping` Session. After commit, `TasksService` republishes the latest Session fact and owns queue/callback side effects, but never rewrites the terminal projection: a newer Task may already have claimed the Session.
- The different-Task Session admission fence prevents a second executor from starting while the first Task owns the Session.

**Kill point:** a coordinator that dies during settlement leaves either the prior durable `stopping` state or the Task-terminal/Session-promptable pair; it cannot commit only the Task half.

### Queue preservation and recovery UX

- All startup policies preserve queued Tasks; #2180's all-daemon worker rediscovers them.
- Queue eligibility follows authoritative Task settlement and the resulting Session projection. Startup itself never releases or discards queued intent.
- A verified interruption may therefore release an existing durable queue head after settlement. The interruption UI also lets the user create an explicit new Resume Task; it never revives the failed Task.
- Verified runtime interruption UI is derived from the durable Task outcome, so it is idempotent and cannot accumulate duplicate restart messages.
- The action is **Resume in new task**. It creates a new durable Task; it never revives the failed Task or reuses executor ownership.
- Unverified containment never shows Resume and remains behind owner/admin force-fail.
- Legacy daemon restart/crash messages and their old Resume action remain only in explicit `standalone` compatibility mode.

### Shutdown and restart notices

- Shared shutdown does not write the global clean-shutdown sentinel.
- The reconciler stops before services close.
- Standalone shutdown contains executors tracked by that application.
- Shared shutdown does not intentionally kill tracked detached executors;
  durable heartbeat and termination state remains authoritative if the
  execution substrate survives for peer handoff.
- Shared startup injects no daemon-restart-specific transcript messages.
- Standalone retains its historical active-runtime cleanup, containment, sentinel, and notices behind policy while preserving queued Tasks per #2180.

## Reconciler scan behavior

`TaskRuntimeReconciler` performs three independently bounded indexed scans:

1. expired, not-yet-observed dispatch deadlines;
2. stale connected-executor heartbeats;
3. absent/expired termination coordination.

The scanner:

- uses routing-only global PostgreSQL discovery under `task_runtime_discovery`;
- advances independent keyset cursors for all three scans and wraps after an
  empty page, so a saturated page of held or failing candidates cannot starve
  later Tasks or tenants;
- reloads and mutates each candidate under its trusted tenant scope after
  asserting the tenant write gate in the same fresh transaction;
- never exposes prompt, credentials, or other payload in discovery refs;
- starts at a deterministic randomized offset;
- uses 50–250 ms jittered drain delay when any category saturates;
- uses jittered bounded exponential idle backoff;
- treats jitter only as contention etiquette, never as a correctness boundary.

## Multitenancy boundary

PostgreSQL RLS grants the system capability SELECT access only to active Task states. Repository discovery selects Task ID, tenant routing ID, and the exact heartbeat fact needed for fencing. Every Task reload, claim, heartbeat, settlement, Session projection, and queue read/write runs inside its tenant scope.

Negative integration coverage proves tenant A cannot reload or mutate tenant B's discovered Task. Static-tenant mode never enters the global capability.

## Test matrix

Implemented coverage includes:

- shared startup does not call orphan/queue/Session cleanup;
- SQLite bounded dispatch, heartbeat, and termination discovery;
- exact fresh-heartbeat race and executor-connection race;
- durable templated-dispatch warning suppression from later deadline scans;
- same-Task coordination races and stale-token settlement rejection;
- expired coordinator reclaim;
- guarded unverified rows are not rediscovered;
- Session-first locked termination transitions with atomic Task/Session projection,
  with unverified containment remaining guarded;
- keyset fairness and wraparound after saturated/failing pages;
- tenant write-gate fail-closed behavior and database-time local-owner grace;
- shared shutdown handoff without destroying the only verified local evidence;
- post-settlement side effects cannot clobber a newer Task's Session projection;
- compatibility with #2180's different-Task Session admission and durable queue-head fence;
- app-scoped local process tracking and non-owner negative proof;
- executor heartbeat propagation of durable `stopping` state;
- verified versus unverified outcome UX;
- deterministic startup offset, saturated drain jitter, and idle backoff;
- PostgreSQL-gated two-repository races, cross-tenant negative proof, queue preservation, and coordinator recovery;
- PostgreSQL-gated two independently constructed daemon app/reconciler instances, including daemon B shared startup plus executor heartbeat handoff leaving daemon A's Task, Session, and queue intact.

PostgreSQL tests skip unless both `AGOR_TEST_POSTGRES_URL` and `AGOR_DB_DIALECT=postgresql` are set.

## Remaining HA blockers

1. **Activation configuration:** the composition root deliberately remains `standalone`; a reviewed HA config contract must activate `shared_postgres`.
2. **Cross-replica realtime fanout:** heartbeat responses and reconnect refresh cover executor control, but general browser/executor Socket.IO events still need the planned shared adapter.
3. **Local owner loss cannot prove absence:** after abrupt owner death, another daemon can accept heartbeats or reach guarded `unverified`; it cannot inspect an unknown PID/PGID. Strong recovery requires a durable external execution substrate identity/containment API.
4. **Standalone active-runtime cleanup remains destructive by design:** it is compatibility behavior, not valid HA behavior; queued Tasks are preserved.
