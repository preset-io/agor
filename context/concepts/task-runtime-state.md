# Task runtime state and supervision

> Read this before changing task lifecycle, executor startup, runtime telemetry,
> SDK activity mapping, watchdog policy, Stop behavior, or session
> promptability. The code remains ground truth; this is the current-state map.
> Agentic-tool package ownership and adapter boundaries are defined separately
> in [agentic-tool-integration-architecture.md](../explorations/agentic-tool-integration-architecture.md).

## Mental model

`Task.status` is the durable execution lifecycle. Heartbeats report whether the
executor wrapper can still communicate. Pulses report bounded SDK activity.
Watchdogs interpret those signals. The daemon's termination coordinator owns
safe release.

```text
Prompt
  |
  +-- busy session --> QUEUED
  `-- available ----> CREATED
                         |
                         | daemon persists launch intent
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

## The runtime facts stored on a task

| Fact                         | What it answers                                                        | What it does not answer                  |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `status`                     | Who owns the task lifecycle, and is the turn active or terminal?       | Whether the wrapper or SDK is healthy    |
| `executor_connected_at`      | Did an authenticated executor claim this dispatch?                     | Whether it remains reachable             |
| `last_executor_heartbeat_at` | When could the wrapper last report to the daemon?                      | Whether the SDK made meaningful progress |
| `latest_executor_pulse`      | What bounded SDK activity fact was most recently accepted?             | Complete history or task ownership       |
| `sdk_failure`                | What runtime-health diagnosis was observed or enforced?                | Proof that execution stopped             |
| `termination_request`        | Which termination cause owns containment, and for which request epoch? | Final containment outcome by itself      |

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

Agentic-tool runtime adapters own the translation from SDK-specific events into
this vocabulary. The common task contract must not depend on raw agentic-tool
event names. The SDK version manifest beside the mapping makes dependency
upgrades an explicit mapping-review point.

## Two supervisors, two failure classes

| Supervisor                    | Runs in  | Observes                                             | Detects                                                                               | Default behavior on `main`                                      |
| ----------------------------- | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Executor heartbeat supervisor | Daemon   | Durable dispatch/connection and heartbeat timestamps | Local dispatches that never connect; connected wrappers whose heartbeat becomes stale | Requests daemon-owned containment                               |
| SDK watchdog                  | Executor | Semantic pulses on a monotonic clock                 | No first progress; Claude post-progress stall; unknown activity                       | `observe`: persist diagnosis without aborting recognized stalls |

### Daemon heartbeat supervisor

- A task remains `dispatching` until an authenticated executor claims it.
- The default dispatch connection deadline is five minutes.
- A local dispatch that misses the deadline enters termination coordination.
- A templated/remote dispatch records a warning and keeps waiting because the
  launcher exit or delay may not prove that remote work was not created.
- Connected active tasks heartbeat every 10 seconds by default.
- The default stale threshold is at least 30 seconds and at least three
  heartbeat intervals.
- A stale heartbeat requests containment using the expected status and
  heartbeat timestamp as race fences. A newer heartbeat makes that claim lose
  safely.

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
- enforced SDK health failure; and
- a runner that cannot verify cooperative runtime cleanup.

It first atomically claims `stopping` with a durable `termination_request`.
The request timestamp fences late or duplicate executor quiescence reports.
The task-scoped executor receives the committed request over its authenticated
socket, aborts the agentic-tool runtime, runs adapter cleanup, and reports
quiescence. The durable task patch/read covers reconnect and delivery races.

Containment then depends on execution mode:

| Runtime                   | Evidence required before terminal settlement                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Local executor            | Cooperative quiescence when available, followed by process-group absence verification; escalation can use `SIGTERM` then `SIGKILL`. |
| Templated/remote executor | The scoped executor's fenced quiescence report, because the daemon cannot inspect a process group on another host.                  |
| OpenCode server-side work | Local process absence is insufficient to prove server-side work stopped, so termination can remain unverified.                      |

Verified user Stop settles as `stopped`; verified health/startup/heartbeat
containment settles as `failed`. If absence cannot be verified, the task stays
`stopping`, the session stays non-promptable, and an authorized owner/admin must
explicitly force-fail it. A daemon restart can logically release orphaned work
as `stopped`, but records that termination was not verified.

OpenCode is the first runner to report its normalized turn result and cleanup
result together. A quiesced report lets the Task service map success, runtime
failure, or interaction timeout to `completed`, `failed`, or `timed_out`. A
termination claim that already won consumes the same report as cooperative
quiescence. An unverified cleanup report claims `stopping` instead of writing a
terminal Task or making the Session promptable.

## Task truth and session projection

The task row describes the active turn. The session row is a coarser
admission/UI projection:

- task launch projects the session to `running` and not promptable;
- permission and Stop states are projected while their task owns the turn;
- terminal settlement projects the session back to its appropriate resting
  state and may trigger queue processing;
- reconciliation repairs a failed/not-ready session when no non-queued task
  still owns that busy state.

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
3. Agentic-tool-specific event names stay inside runtime adapters.
4. Terminal state remains immutable.
5. `stopping` is released only through the termination coordinator.
6. A session is not made promptable before required containment is verified.
7. Unknown observational activity fails open; absence of classification is not
   proof of a stall. Unrecognized interaction or terminal-control vocabulary
   fails compatibility rather than being guessed.
8. Remote launcher exit, wrapper exit, SDK quiescence, and process absence are
   different evidence and must not be collapsed.
9. Daemon and executor releases are one runtime contract; mixed-version
   rollouts are unsupported.
10. Supervision does not imply automatic retry, prompt replay, or exactly-once
    external effects.

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
| Stale-wrapper and dispatch supervision                 | `apps/agor-daemon/src/services/executor-heartbeat-supervisor.ts`                               |
| Termination claims and containment settlement          | `apps/agor-daemon/src/termination-coordinator.ts`, `apps/agor-daemon/src/executor-tracking.ts` |
| Startup orphan reconciliation                          | `apps/agor-daemon/src/startup.ts`                                                              |

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
