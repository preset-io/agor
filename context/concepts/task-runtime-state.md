# Task runtime state and supervision

> Read this before changing task lifecycle, executor startup, runtime telemetry,
> SDK activity mapping, watchdog policy, Stop behavior, or session
> promptability. The code remains ground truth; this is the current-state map.

## Mental model

`Task.status` is the durable execution lifecycle. Heartbeats report whether the
executor wrapper can still communicate. Pulses report bounded SDK activity.
Watchdogs interpret those signals. The daemon's termination coordinator owns
safe release.

```text
Prompt
  |
  `-- durable admission --> QUEUED
                               |
                     queue-head/Session claim
                               v
                          DISPATCHING
                         |
                         | authenticated executor claims task
                         v
                      RUNNING
                         |
              +----------+-----------+
              |                      |
       wrapper heartbeat       semantic SDK pulse
       "executor can talk"      "started/progress/
              |                 waiting/unknown"
              |                      |
       daemon heartbeat          executor-local
         supervisor               SDK watchdog
              |                      |
              +----------+-----------+
                         |
                  failure or Stop
                         v
                      STOPPING
                         |
              containment verified?
                 +-------+--------+
                yes               no
                 |                |
        STOPPED or FAILED    remain STOPPING
                              and non-promptable
```

These are deliberately separate signals. A fresh heartbeat proves wrapper
liveness, not useful SDK progress. A recent pulse describes activity, not task
ownership. Neither replaces `Task.status`.

## Durable task lifecycle

| State                 | Meaning                                                                | Normal owner of the next transition                               |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `queued`              | The prompt is durable and waiting behind another turn.                 | Daemon queue processor                                            |
| `created`             | The task exists but launch intent has not been persisted.              | Daemon launch path                                                |
| `dispatching`         | Launch intent is durable; no executor has claimed the task.            | Authenticated task-scoped executor                                |
| `running`             | The executor connected and owns the active turn.                       | Executor result path, permission flow, or termination coordinator |
| `awaiting_permission` | SDK execution is paused for a permission decision.                     | Executor permission flow                                          |
| `awaiting_input`      | Legacy historical state; new tasks do not enter it.                    | Legacy executor flow                                              |
| `stopping`            | Termination is durably claimed; containment is not yet settled.        | Daemon termination coordinator                                    |
| `completed`           | The SDK turn completed successfully.                                   | Terminal                                                          |
| `failed`              | The turn or supervised containment failed.                             | Terminal                                                          |
| `stopped`             | A user-requested stop settled, or restart recovery released an orphan. | Terminal                                                          |
| `timed_out`           | A permission/input wait expired.                                       | Terminal                                                          |

The important transitions are:

```text
QUEUED -----> DISPATCHING <----- CREATED
                    |
                    | connectExecutor()
                    v
                 RUNNING <----> AWAITING_PERMISSION
                    |
          +---------+----------+
          |                    |
   normal result         termination claim
          |                    |
          v                    v
 COMPLETED or FAILED         STOPPING
                               |
                     containment settlement
                               |
                       STOPPED or FAILED
```

Terminal task state is immutable at the row-locked repository boundary. A late
executor claim, result, or permission resume cannot revive or overwrite it.
`dispatching`, `running`, `stopping`, and permission/input waits are
executor-owned states. `created` and `queued` are excluded from that set; queued
work does not block prompt reconciliation, while a created launch handoff can
still block admission until it is dispatched or settled.

Queue materialization and draining are documented separately in
[task-queueing.md](task-queueing.md).

Prompt admission normally enters through `queued` even for an idle Session, so
ordering and idle-vs-waiting are one database decision. `created` remains for
the explicit create-then-run API and scheduled compatibility/reconciliation.

## The runtime facts stored on a task

| Fact                         | What it answers                                                        | What it does not answer                  |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `status`                     | Who owns the task lifecycle, and is the turn active or terminal?       | Whether the wrapper or SDK is healthy    |
| `executor_connected_at`      | Did an authenticated executor claim this dispatch?                     | Whether it remains reachable             |
| `last_executor_heartbeat_at` | When could the wrapper last report to the daemon?                      | Whether the SDK made meaningful progress |
| `latest_executor_pulse`      | What bounded SDK activity fact was most recently accepted?             | Complete history or task ownership       |
| `sdk_failure`                | What runtime-health diagnosis was observed or enforced?                | Proof that execution stopped             |
| `termination_request`        | Which termination cause owns containment, and for which request epoch? | Final containment outcome by itself      |

The Task JSON also carries one daemon-private
`executor_launch_fs_access_floor`. The launch path writes it exactly once from
the locked Task principal and normalized Branch policy before issuing the
task-scoped credential. Repository mapping removes it from public Task DTOs,
and generic Task patches preserve rather than accept it. This is launch
authority, not a request field or a dynamic mount description.

An executor pulse contains a monotonically increasing executor-local sequence,
a bounded kind/detail, and a daemon-authored observation time. The repository
keeps only the greatest accepted sequence. Pulses intentionally coalesce to the
latest fact instead of creating a runtime-event log.

The shared pulse vocabulary is:

- `sdk_started` — the SDK boundary or a supervised resume was reached;
- `progress` — known meaningful SDK activity;
- `waiting` — a known permission/input wait that pauses watchdog time;
- `unknown_activity` — an unrecognized event that is retained as diagnostic
  evidence and fails open.

Provider adapters own the translation from SDK-specific events into this
vocabulary. The common task contract must not depend on raw provider event
names. The SDK version manifest beside the mapping makes dependency upgrades
an explicit mapping-review point.

## Two supervisors, two failure classes

| Supervisor              | Runs in  | Observes                                                                        | Detects                                                                                | Default behavior on `main`                                      |
| ----------------------- | -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Task runtime reconciler | Daemon   | Durable dispatch/connection, heartbeat, and termination-coordination timestamps | Dispatches that never connect; stale connected wrappers; stranded termination requests | Requests database-fenced daemon containment                     |
| SDK watchdog            | Executor | Semantic pulses on a monotonic clock                                            | No first progress; Claude post-progress stall; unknown activity                        | `observe`: persist diagnosis without aborting recognized stalls |

### Daemon Task runtime reconciler

- A task remains `dispatching` until an authenticated executor claims it.
- The dispatch claim and Session projection commit before any executor launch.
  A daemon death in that gap therefore leaves durable, diagnosable launch
  intent rather than silently returning the prompt to the queue. Re-enqueueing
  automatically would be unsafe because the external launch may have happened.
- The default dispatch connection deadline is five minutes.
- A local dispatch that misses the deadline enters termination coordination.
- A templated/remote dispatch records a warning and keeps waiting because the
  launcher exit or delay may not prove that remote work was not created. A
  durable observation marker removes that ambiguous dispatch from subsequent
  deadline scans so it cannot hot-loop or starve other candidates.
- Connected active tasks heartbeat every 10 seconds by default. A scoped
  executor continues heartbeat and pulse telemetry while `stopping` until its
  provider cleanup returns and it reports quiescence.
- That same heartbeat is the runtime-authority check; there is no second poll.
  Before the atomic heartbeat write, the repository revalidates the durable
  task-token fingerprint and the exact Task creator → Session → Branch binding,
  current user existence, current prompt capability, shared-session gates and
  branch-home scope when applicable, and effective filesystem access. Access
  below the immutable launch floor denies the write. Higher access does not
  change existing mounts.
- An explicit denial claims the normal fenced `stopping` path with cause
  `authorization_revoked`. Authority-store/query errors throw and do not stamp
  liveness. The existing stale-heartbeat threshold supplies the bounded
  fail-closed backstop; there is no authority cache, Redis dependency, second
  watchdog, or uncertainty-specific timer.
- The default stale threshold is at least 30 seconds and at least three
  heartbeat intervals.
- A stale heartbeat requests containment using the expected status and
  heartbeat timestamp as race fences. A newer heartbeat makes that claim lose
  safely.
- Scans are bounded and indexed, and each category advances an independent
  keyset cursor with wraparound so a held/failing page cannot starve later
  Tasks or tenants. PostgreSQL uses database time; startup offset, saturated
  drain jitter, and idle backoff reduce contention but never confer correctness.
- Candidate writes assert the tenant write gate in the same fresh tenant
  transaction as the mutation.
- Every daemon may discover the same routing refs. A Task-specific opaque
  coordination token and expiring lease unconditionally fence normal
  containment settlement. Guarded-unverified state clears the token and
  rejects any later stale-coordinator settlement.
- A replacement daemon resumes an existing durable `stopping` request after
  the prior claim expires. Durable unverified containment is excluded from
  rediscovery and remains owner/admin-guarded unless a first, correctly
  task/request-fenced executor quiescence report arrives later. That new
  evidence clears the old guard exactly once and makes the same termination
  epoch reconcilable; a repeated failed containment writes a fresh guard that a
  duplicate acknowledgement cannot clear.

### Executor SDK watchdog

- Starts at the executor boundary, before SDK import/subscription/prompt setup,
  so a silent SDK startup is covered.
- Uses semantic activity rather than heartbeat time.
- Pauses while waiting for a known permission/input decision.
- Tracks known active tool/background-task lifetimes so healthy silent work is
  not treated as idle.
- Records unknown vocabulary once as `unknown_activity` and continues rather
  than terminating work it cannot classify.
- In `observe` mode, writes a `would_fire` diagnosis and leaves lifecycle state
  unchanged.
- In `enforce` mode, recognized `no_first_progress` or `progress_stalled`
  decisions request SDK abort and hand containment to the daemon.

On current `main`, first-progress supervision covers the mapped executor SDKs;
Claude also has a one-hour post-progress idle timeout by default. Cursor is not
yet wired into the SDK watchdog. Disabling executor heartbeat disables
persisted pulse telemetry and the stale-wrapper backstop, but the executor-local
watchdog can still make and report a direct health decision.

## Termination and safe release

The termination coordinator is the single owner for executor-backed:

- user Stop;
- dispatch startup timeout;
- lost heartbeat;
- enforced SDK health failure;
- authorization revocation observed by the existing heartbeat.

It first atomically claims `stopping` with a durable `termination_request`.
The request timestamp fences late or duplicate executor quiescence reports.
The task-scoped executor receives the committed request over its authenticated
socket, aborts the provider SDK, runs provider cleanup, and reports quiescence.
The durable task patch/read covers reconnect and delivery races.

Containment coordination is durable but deliberately Task-specific. Daemon
instance/boot identity is diagnostic only; the opaque claim token is the
settlement fence. Cooperative waits and process signaling occur outside short
database transactions. Terminal settlement writes Task truth first and the
minimal Session status/promptability projection second in one short
transaction, eliminating a daemon-death gap between durable commits.

Containment then depends on execution mode:

| Runtime                   | Evidence required before terminal settlement                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local executor            | Cooperative quiescence when available, followed by process-group absence verification by the daemon application that owns the PID/PGID handle; escalation can use `SIGTERM` then `SIGKILL`. |
| Templated/remote executor | The scoped executor's fenced quiescence report, because the daemon cannot inspect a process group on another host.                                                                          |
| OpenCode provider work    | Local process absence is insufficient to prove server-side work stopped, so termination can remain unverified.                                                                              |

Local cooperative shutdown gives the process wrapper 250 ms to disappear before
signaling. A PGID probe may still be `unverified` because of an OS inspection
error; only an explicit later `absent` result verifies termination. Persistent
uncertainty fails closed. Templated/remote executors get a 15 second cooperative
window because the daemon has no local signal fallback.

After provider cleanup returns, the executor makes bounded, idempotent retries
to report its exact Task/request-fenced quiescence fact. A failed write is
followed by a bounded durable Task read so a lost response after commit does
not strand an already-quiesced runtime. The executor logs the first outage and
one final exhaustion event rather than every retry. Provider cleanup that is
still running after 15 seconds emits one warning but is not falsely reported as
quiescent.

Verified user Stop settles as `stopped`; verified health/startup/heartbeat
containment settles as `failed`. If absence cannot be verified, the task stays
`stopping`, the session stays non-promptable, and an authorized owner/admin must
explicitly force-fail it by typing `STOP`. Force-fail changes durable status to
`failed`; it does not prove or guarantee process termination. A daemon restart
can logically release orphaned work as `stopped`, but records that termination
was not verified. This last release exists only in explicit `standalone`
compatibility mode; shared PostgreSQL startup never treats another replica's
work as orphaned.

An abrupt local-launcher-daemon loss is not absence proof. If its execution
substrate survives the launcher and callbacks route to the fleet, the detached
executor may reconnect through another daemon. Shared workspace storage alone
does not guarantee that process survival. If it does not reconnect, a non-owner can
resume the durable request after the owner grace/lease, but without an
authoritative handle it must leave containment unverified.

Standalone graceful shutdown preserves historical local executor
containment. Shared-replica shutdown instead avoids intentionally killing
detached executors so an independently surviving substrate can reconnect and
resume heartbeat through a peer. Shared-local/container deployment does not
guarantee that survival; the policy only avoids destroying the process and the
sole process-local evidence itself.

## Task truth and session projection

The task row describes the active turn. The session row is a coarser
admission/UI projection:

- task launch projects the session to `running` and not promptable;
- the Session row is also the admission fence across different pending Tasks,
  so concurrent daemons cannot launch two executors for one Session; a losing
  created Task is durably queued;
- permission and Stop states are projected while their task owns the turn;
- terminal settlement writes the task terminal state, then projects the
  session back to its appropriate resting state in the same transaction;
  queue processing and other side effects run after commit;
- reconciliation repairs a failed/not-ready session when no non-queued task
  still owns that busy state.

`queued` Tasks are not startup orphans and are never wiped during daemon
startup. The all-daemon queue worker rediscovers them. Fleet-safe ownership and
cross-tenant reconciliation of already-`dispatching`/running work remains the
runtime-supervision contract; this queue layer deliberately does not redesign
heartbeat, containment, or startup orphan ownership.

`Session.ready_for_prompt` is also used as an attention/acknowledgement flag. It
is not equivalent to promptability and must not be checked alone. Use the
central session/task helpers at execution boundaries instead of inventing a
second busy-state test.

## Change invariants

Any PR that changes task statuses, pulse semantics, watchdog defaults or
coverage, termination evidence, or session promptability must update this file.
Preserve these invariants:

1. Heartbeat liveness and SDK progress remain separate.
2. `Task.status` remains the durable lifecycle; pulses do not become a second
   state machine.
3. Provider-specific event names stay inside provider adapters.
4. Terminal state remains immutable.
5. `stopping` is released only through the termination coordinator.
6. A session is not made promptable before required containment is verified.
7. Unknown activity fails open; absence of classification is not proof of a
   stall.
8. Remote launcher exit, wrapper exit, SDK quiescence, and process absence are
   different evidence and must not be collapsed.
9. Daemon and executor releases are one runtime contract; mixed-version
   rollouts are unsupported.
10. Supervision does not imply automatic retry, prompt replay, or exactly-once
    external effects.
11. Daemon startup is non-destructive in shared PostgreSQL policy; queues and
    Session projection change only from authoritative Task outcomes.

## Code map

| Responsibility                                         | Primary code                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Canonical types and status sets                        | `packages/core/src/types/task.ts`, `packages/core/src/types/session.ts`                        |
| Task persistence and guarded transitions               | `packages/core/src/db/repositories/tasks.ts`                                                   |
| Queue admission and launch                             | `apps/agor-daemon/src/register-routes.ts`                                                      |
| Task service methods and projections                   | `apps/agor-daemon/src/services/tasks.ts`                                                       |
| Executor claim, heartbeat, watchdog, and abort handoff | `packages/executor/src/index.ts`                                                               |
| Heartbeat transport                                    | `packages/executor/src/executor-heartbeat.ts`                                                  |
| SDK activity mapping and watchdog policy               | `packages/executor/src/sdk-watchdog.ts`, `packages/executor/src/sdk-handlers/`                 |
| Runtime discovery and recovery                         | `apps/agor-daemon/src/services/task-runtime-reconciler.ts`                                     |
| Termination claims and containment settlement          | `apps/agor-daemon/src/termination-coordinator.ts`, `apps/agor-daemon/src/executor-tracking.ts` |
| Startup orphan reconciliation                          | `apps/agor-daemon/src/startup.ts`                                                              |
| Full HA kill-point audit                               | `docs/internal/task-runtime-ha-reconciliation-2026-08-06.md`                                   |

## Why the architecture has this shape

Pull requests are rationale, not current truth, but these milestones explain
the present boundaries:

- [#319](https://github.com/preset-io/agor/pull/319) separated the privileged
  daemon from SDK execution.
- [#1068](https://github.com/preset-io/agor/pull/1068) made tasks the queueable
  unit and the daemon the initial prompt writer.
- [#1302](https://github.com/preset-io/agor/pull/1302) added executor
  heartbeats.
- [#1444](https://github.com/preset-io/agor/pull/1444) made terminal state
  first-writer-wins and repaired session/task divergence.
- [#1888](https://github.com/preset-io/agor/pull/1888) separated dispatch
  intent from authenticated executor connection.
- [#1964](https://github.com/preset-io/agor/pull/1964) separated wrapper
  liveness from SDK progress and centralized containment.
- [#2004](https://github.com/preset-io/agor/pull/2004) made Stop socket-first
  with durable quiescence reporting.
- [#2057](https://github.com/preset-io/agor/pull/2057) aligned Claude
  background-task lifetime with query and watchdog lifetime.
