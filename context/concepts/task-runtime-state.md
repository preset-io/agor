# Task runtime state and supervision

> Read this before changing task lifecycle, executor startup, runtime telemetry,
> SDK activity mapping, watchdog policy, Stop behavior, or session
> promptability. The code remains ground truth; this is the current-state map.

## Mental model

`Task.status` is the durable execution lifecycle. Heartbeats report whether the
executor wrapper can still communicate. Pulses report bounded SDK activity.
Watchdogs interpret those signals. Agentic-tool adapters return a normalized
success/failure result after their runtime path settles. The executor reports
quiescence; the daemon maps that result to terminal Task state. The daemon's
termination coordinator owns forced containment and terminal release.

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
             +-----------+-----------+
             |                       |
      adapter outcome        supervised failure
             |                    or Stop
             v                       v
   executor finalizer             STOPPING
     closes runtime                  |
             |             containment verified?
             v               +------+------+
 semantic settlement       yes            no
             |              |             |
             v       STOPPED or FAILED  remain STOPPING
 daemon terminal guard                    and non-promptable
             |
             v
 COMPLETED / FAILED / TIMED_OUT
             |
             v
     Session reconciler
```

These are deliberately separate signals. A fresh heartbeat proves wrapper
liveness, not useful SDK progress. A recent pulse describes activity, not task
ownership. Neither replaces `Task.status`.

## Durable task lifecycle

| State                 | Meaning                                                         | Normal owner of the next transition                             |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `queued`              | The prompt is durable and waiting behind another turn.          | Daemon queue processor                                          |
| `created`             | The task exists but launch intent has not been persisted.       | Daemon launch path                                              |
| `dispatching`         | Launch intent is durable; no executor has claimed the task.     | Authenticated task-scoped executor                              |
| `running`             | The executor connected and owns the active turn.                | Executor finalizer, permission flow, or termination coordinator |
| `awaiting_permission` | SDK execution is paused for a permission decision.              | Executor permission flow                                        |
| `awaiting_input`      | Legacy historical state; new tasks do not enter it.             | Legacy executor flow                                            |
| `stopping`            | Termination is durably claimed; containment is not yet settled. | Daemon termination coordinator                                  |
| `completed`           | The SDK turn completed successfully.                            | Terminal                                                        |
| `failed`              | The turn or supervised containment failed.                      | Terminal                                                        |
| `stopped`             | A user-requested stop settled after verified release.           | Terminal                                                        |
| `timed_out`           | A permission/input wait expired.                                | Terminal                                                        |

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
`dispatching`, `running`, `stopping`, and permission/input waits all block
admission. `stopping` is daemon-coordinator-owned; the others represent an
executor handoff or active executor turn. `created` and `queued` are excluded
from that set; queued work does not block prompt reconciliation, while a
created launch handoff can still block admission until it is dispatched or
settled.

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
| `latest_executor_progress`   | What was the latest accepted meaningful-progress fact?                 | Current wait or wrapper liveness         |
| `sdk_failure`                | What runtime-health diagnosis was observed or enforced?                | Proof that execution stopped             |
| `termination_request`        | Which termination cause owns containment, and for which request epoch? | Final containment outcome by itself      |
| `metadata.executor_runtime`  | Which local process identity startup may safely re-check?              | Proof that the process still exists      |

An executor pulse contains a monotonically increasing executor-local sequence,
a bounded kind/detail, and a daemon-authored observation time. The repository
keeps only the greatest accepted sequence. Pulses intentionally coalesce to the
latest fact instead of creating a runtime-event log.

The shared pulse vocabulary is:

- `sdk_started` — the SDK boundary or a supervised resume was reached;
- `progress` — known meaningful SDK activity;
- `waiting` — a known permission/input wait that pauses watchdog time;
- `unknown_activity` — unrecognized observational activity retained as
  compatibility evidence, not semantic progress.

Agentic-tool runtime adapters own the translation from SDK-specific events into
this vocabulary and executor-local operation events. Operations and waits carry
stable identities; operation progress can extend a quiet deadline, while every
operation and wait retains an absolute deadline. The common task contract must
not depend on raw agentic-tool event names or persist an operation ledger. The
SDK version manifest beside the mappings makes dependency upgrades an explicit
mapping-review point.

## Two supervisors, two failure classes

| Supervisor              | Runs in  | Observes                                                                        | Detects                                                                                               | Default behavior on `main`                                  |
| ----------------------- | -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Task runtime reconciler | Daemon   | Durable dispatch/connection, heartbeat, and termination-coordination timestamps | Dispatches that never connect; stale connected wrappers; stranded termination requests                | Requests database-fenced daemon containment                 |
| SDK watchdog            | Executor | Semantic activity on a monotonic clock                                          | No first progress; Claude/Codex post-progress stalls; bounded operation/wait deadlines; unknown events | `enforce`: abort recognized stalls and hand off containment |

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
- Connected active tasks heartbeat every 10 seconds by default.
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
  rediscovery and remains owner/admin-guarded.

### Executor SDK watchdog

- Starts at the executor boundary, before SDK import/subscription/prompt setup,
  so a silent SDK startup is covered.
- Bounds the complete turn with the shared runtime-profile absolute ceiling.
- Uses semantic activity rather than heartbeat time.
- Pauses quiet supervision while waiting for a known permission/input decision,
  but enforces that wait's absolute deadline.
- Tracks parallel tool/item/background work by stable operation ID, each with
  quiet and absolute deadlines.
- Records unknown observational vocabulary once as `unknown_activity` without
  counting it as progress. Continuous unknown activity does not become a
  semantic stall; if the stream later becomes quiet, enforcement reports
  `adapter_incompatible`. Unknown control/lifecycle ordering fails immediately
  as adapter incompatibility.
- In `observe` mode, writes a `would_fire` diagnosis and leaves lifecycle state
  unchanged. The fired deadline is latched to avoid a busy repeat; meaningful
  activity for that deadline invalidates the latch and rearms supervision.
- In `enforce` mode, recognized first-progress, absolute-turn, idle, operation, or wait
  deadline failures terminate supervision once, request SDK abort, and hand
  containment to the daemon.

First-progress supervision covers all mapped executor SDKs, including Cursor.
Claude and Codex also have a one-hour post-progress idle timeout by default;
operators may disable either tool's check explicitly with `null`. Every mapped
turn and identified operation retains the shared four-hour absolute ceiling;
operations use that tool-specific idle timeout as their default quiet deadline.
Copilot configures its SDK-owned blocking deadline from the same absolute turn
ceiling instead of imposing a shorter adapter-specific timeout.
With `null`, operation quiet supervision falls back to that absolute ceiling.
Disabling wrapper heartbeat keeps coalesced
pulse telemetry but disables periodic heartbeat writes and the stale-wrapper
backstop; the executor-local watchdog still makes and reports direct health
decisions. New Tasks default to `enforce`; a legacy active Task without a
persisted watchdog mode remains observe-only for compatibility. If a telemetry
write is rejected, the executor refreshes durable Task state; when the daemon
already considers the Task terminal, the executor aborts its runtime and does
not attempt another terminal settlement.

The conformance manifest names all six shipped adapters, their pinned SDK
versions, and `enforce`, `observe-only`, or `blocked` launch behavior. An
observe-only adapter cannot silently inherit enforcement. Claude also declares
its native idle deadline as observable, while Copilot declares its blocking SDK
deadline as configured. Matching SDK expiry is normalized as
`agentic_tool_timeout`, not an Agor semantic-stall diagnosis.

## Cooperative completion and interaction waits

Agentic-tool adapters return normalized `success` or `failure(cause)` plus
non-lifecycle task data such as model, SDK response, context usage, error
detail, and final git state. They do not speak Task-status vocabulary or patch
terminal state. The daemon maps the winning result/cause. The
top-level executor accepts that outcome only after the adapter's SDK call and
bounded cooperative cleanup have settled. Outstanding transcript-stream side
effects are drained within the same bound so a terminal outcome cannot overtake
them. The executor then reports one semantic `quiesced` settlement to the
daemon. The daemon strictly validates that runtime payload at the trust seam,
then commits terminal timing and result fields atomically.
Runtime cancellation without a winning `user_stop` request maps to `failed`;
`cancelled` is not a durable Task status.
Process-level failure handlers never guess terminality; cleanup uncertainty
reports `containment_required` and converges on the termination coordinator.

The executor host waits for each adapter's asynchronous runtime stop hook before it
returns. Cursor waits for the active run and closes the agent, Copilot fences
pre-launch work and stops its CLI client, and OpenCode waits for its stop
request. If the abort belongs to daemon containment, adapters return no
cooperative terminal outcome and the termination coordinator remains authoritative.

Claude and Copilot permission decisions use the executor's outer abort
controller. A denial, timeout, unavailable responder, or permission-flow error
first aborts the agentic-tool query. Only after that query settles does the
executor finalizer commit `failed` or `timed_out`. A `timed_out` task retains
the same terminal reconciliation contract as other settled tasks. Their shared
permission service owns the interaction deadline while the watchdog only
pauses quiet supervision, avoiding two clocks racing to choose the outcome.

Executor launch payloads also declare whether the surface is `interactive` or
`unattended`. A direct agent launch is interactive only when its request or
Session stream room has a live authenticated browser responder. Scheduled and
gateway sessions are unattended while those surfaces lack a matching response path.
Claude and Copilot fail unavailable requests immediately; their interactive
waits use the shared `execution.permission_timeout_ms` resolver and its
ten-minute default. Codex unattended runs fail before SDK work when their
approval policy requires a responder; policy-only runs retain the configured
sandbox and network boundaries. OpenCode has no Agor permission-response path, so it
resolves each request from the configured launch policy: authorized edits or
bypass modes proceed, and everything else is rejected instead of waiting or
broadening access. The watchdog owns the bound around that policy-response
round trip. Gemini's SDK policy engine runs in non-interactive mode, so
requests outside its configured approval policy are denied instead of waiting.
Cursor exposes neither permission callbacks nor a granular policy surface, so
restrictive modes fail before launch rather than silently running autonomously.

UI and gateway progress use the same pure projection. Adapter incompatibility
remains distinct from a semantic stall, so unknown protocol vocabulary is not
presented as evidence that meaningful work stopped.

## Termination and safe release

The termination coordinator is the single owner for executor-backed:

- user Stop;
- dispatch startup timeout;
- lost heartbeat;
- enforced SDK health failure.

It first atomically claims `stopping` with a durable `termination_request`.
The request timestamp fences late or duplicate executor quiescence reports.
Service RPCs persist that claim inside their request transaction, then defer
containment until after commit with tenant identity but without carrying the
request's database transaction. Long coordination uses fresh, short service
database units instead of reusing a committed PostgreSQL scope.
The task-scoped executor receives the committed request over its authenticated
socket, aborts the agentic-tool runtime, runs its cleanup, and reports
quiescence. The durable task patch/read covers reconnect and delivery races.

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
| Server-side execution     | Failed forced cleanup records `runtime_cleanup_unverified`; local wrapper absence alone cannot release the Task.                                                                            |

Verified user Stop settles as `stopped`; verified health/startup/heartbeat
containment settles as `failed`. If absence cannot be verified, the task stays
`stopping`, the session stays non-promptable, and an authorized owner/admin must
explicitly force-fail it. Standalone startup reloads a durable local runtime
identity when available, claims `daemon_restart` termination, and resumes
containment after the server is listening. Restart itself never releases the
Task. Shared PostgreSQL startup never treats another replica's work as
orphaned; the fleet reconciler acts only on expired durable runtime evidence.

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
- generic Task patches cannot commit terminal status; executor settlement and
  termination settlement are the only release-gated terminal paths;
- permission and Stop states are projected while their task owns the turn;
- terminal settlement writes Task truth and the minimal Session projection in
  the same transaction. A fresh transition publishes its Task event and
  analytics once; observing the same immutable terminal truth again reruns
  reconciliation without duplicating them;
- terminal reconciliation repairs the Session projection, dispatches callbacks,
  materializes the originating gateway consequence, and may trigger the queued
  Task with the lowest `queue_position`;
- required reconciliation failures propagate so later terminal observation can
  retry them. Queue processing and other idempotent side effects run after
  commit;
- callback Task creation and its source receipt are one transaction. Gateway
  terminal intent is stored on the source Task, and the final assistant
  response is reloaded from persisted Messages instead of an in-memory buffer.
  Missing or pending consequence state remains repairable after restart;
- after verified settlement, a separately queued durable Task may run after
  commit; it is not a retry or replay of the settled prompt;
- reconciliation repairs a failed/not-ready Session when no non-queued Task
  still owns that busy state;
- `reconcileSessionState` is the bounded startup/route repair entry point and
  derives the coarse projection from durable Task truth;
- generic Session patch hooks do not independently drain the queue or finalize
  gateways.

Standalone recovery performs narrow tenant-ID discovery, re-enters each tenant,
and runs bounded containment and consequence repair after listening. Queued
prompts behind unverifiable work remain ordered and blocked; they are neither
discarded nor replayed. Session projection records the terminal Task it applied
under the Session row lock, so repair preserves a later
`ready_for_prompt=false` acknowledgement.

UI and gateway consumers use the shared runtime presentation projection derived
from Task status, latest activity, latest meaningful progress, and stall
diagnosis. `working`, `waiting`, `stalled`, and terminal presentation are not
persisted lifecycle states, and `running` alone does not imply progress.

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
3. Agentic-tool-specific event names stay inside agentic-tool runtime adapters.
4. Terminal state remains immutable.
5. `stopping` is released only through the termination coordinator.
6. A session is not made promptable before required containment is verified.
7. Unknown activity is compatibility evidence, not progress or semantic-stall
   evidence; quiet after unknown activity reports adapter incompatibility.
8. Remote launcher exit, wrapper exit, SDK quiescence, and process absence are
   different evidence and must not be collapsed.
9. Daemon and executor releases are one runtime contract; mixed-version
   rollouts are unsupported.
10. Supervision does not imply automatic retry, prompt replay, or exactly-once
    external effects. Verified settlement may continue a separately queued
    Task; unverified containment may not. Durable domain receipts make restart
    repair idempotent inside Agor; external delivery remains at-least-once.
11. Daemon startup is non-destructive in shared PostgreSQL policy; queues and
    Session projection change only from authoritative Task outcomes.
12. Agentic-tool adapters return normalized outcomes and do not write terminal
    task state.
13. Permission timeout commits terminal state only after the outer
    agentic-tool query settles.
14. An unattended launch cannot block on an interactive permission response.
15. Parallel operations are tracked by identity and retain absolute deadlines.
16. Fresh and already-observed terminal settlements run idempotent terminal
    consequences only after terminal state commits; only the fresh transition
    emits lifecycle analytics and events.

## Code map

| Responsibility                                                        | Primary code                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Canonical types and status sets                                       | `packages/core/src/types/task.ts`, `packages/core/src/types/session.ts`                                |
| Task persistence and guarded transitions                              | `packages/core/src/db/repositories/tasks.ts`                                                           |
| Queue admission and launch                                            | `apps/agor-daemon/src/register-routes.ts`                                                              |
| Task service methods and projections                                  | `apps/agor-daemon/src/services/tasks.ts`                                                               |
| Executor claim, cooperative finalization, watchdog, and abort handoff | `packages/executor/src/index.ts`, `packages/executor/src/terminal-task.ts`                             |
| Heartbeat transport                                                   | `packages/executor/src/executor-heartbeat.ts`                                                          |
| SDK activity mapping and watchdog policy                              | `packages/executor/src/sdk-watchdog.ts`, `packages/executor/src/sdk-handlers/`                         |
| Agentic-tool outcome normalization                                    | `packages/executor/src/handlers/sdk/`                                                                  |
| Interaction capability and permission waits                           | `packages/executor/src/permissions/permission-service.ts`, `apps/agor-daemon/src/register-services.ts` |
| Runtime discovery and recovery                                        | `apps/agor-daemon/src/services/task-runtime-reconciler.ts`                                             |
| Stale-wrapper and dispatch supervision                                | `apps/agor-daemon/src/services/executor-heartbeat-supervisor.ts`                                       |
| Termination claims and containment settlement                         | `apps/agor-daemon/src/termination-coordinator.ts`, `apps/agor-daemon/src/executor-tracking.ts`         |
| Startup orphan reconciliation                                         | `apps/agor-daemon/src/startup.ts`                                                                      |
| Full HA kill-point audit                                              | `docs/internal/task-runtime-ha-reconciliation-2026-08-06.md`                                           |
| Shared UI/gateway runtime projection                                  | `packages/core/src/types/task.ts`, `apps/agor-daemon/src/services/gateway.ts`                          |

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
