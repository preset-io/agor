# Desired task runtime architecture

> **Status:** Proposed foundation; this is a target contract, not current
> behavior or an implementation plan. See
> [task-runtime-state.md](../concepts/task-runtime-state.md) for the current
> system. Code remains ground truth while this design is adopted incrementally.

## Governing idea

A Task is Agor's only durable execution lifecycle. Every executor-side wait
must be identifiable, bounded, and abortable. Terminal Task state is committed
only after the agentic-tool runtime is quiescent or daemon containment is
verified.

The desired architecture deepens existing owners instead of adding an execution
kernel:

```text
Task — only durable lifecycle and execution epoch
  |
  +-- Agentic-tool runtime adapter
  |     raw tool/SDK events -> normalized activity, operations, and outcome
  |
  +-- SDK watchdog
  |     bounded waits and active operation identities
  |
  +-- Executor finalizer
  |     close SDK -> settle operations -> report outcome
  |
  +-- Termination coordinator
  |     forced containment and verified abnormal settlement
  |
  `-- Session reconciler
        session projection, queue continuation, callbacks,
        and terminal gateway notification

Task state and bounded telemetry also feed one derived progress projection for
the UI and gateways; that projection never writes lifecycle state.
```

## Problems this architecture must solve

The failure is not simply "no watchdog." Agor must distinguish:

- an executor wrapper that can communicate from an SDK turn that is
  progressing;
- healthy silent work from a lost completion event;
- agentic-tool completion from transcript persistence and executor quiescence;
- recoverable runtime transport notices from terminal failure;
- a wait that has a responder from one that can never be answered;
- terminal task settlement from its downstream queue, callback, and gateway
  consequences.

No single timeout answers all of these. Each wait and outcome needs the owner
that can interpret its evidence.

## Scope and non-goals

This foundation covers executor-backed turns, including Claude Code, Codex,
Gemini, OpenCode, and other agentic tools that use the same Task lifecycle.

In this document, an **agentic tool** is an executable runtime integration such
as Claude Code, Codex, Gemini, or OpenCode. A **model provider** is a service
that supplies models, such as Anthropic, OpenAI, Google, or a provider exposed
through OpenCode. The runtime contract belongs to an **agentic-tool runtime
adapter**; model-provider selection and credentials may be inputs to that
adapter, but they do not make the model provider the runtime owner.

It preserves these Ponytail boundaries:

- no `stalled` Task status;
- no execution-attempt table: one prompt already creates one Task, so `task_id`
  is the current execution epoch;
- no persistent runtime-operation or event ledger;
- no generic distributed outbox;
- no automatic retry or prompt replay;
- no exactly-once external-effects framework;
- no general remote-execution kernel.

These mechanisms remain upgrade options only when an observed requirement
cannot be satisfied by the existing owners.

## Ownership model

| Owner                         | Owns                                                                                            | Does not own                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Task.status`                 | Durable lifecycle and prompt admission                                                          | Wrapper or SDK health                                                  |
| Agentic-tool runtime adapter  | Tool/SDK event interpretation, normalized turn outcome, and cooperative cleanup evidence         | Durable Task transitions, forced containment, or Session reconciliation |
| SDK watchdog                  | Executor-local deadlines, meaningful progress, and active operation identities                  | Session state or terminal settlement                                   |
| Executor finalizer            | Cooperative runtime shutdown, operation settlement, bounded transcript flush, and report        | Forced containment                                                     |
| Termination coordinator       | Stop, startup timeout, lost heartbeat, enforced stall, and failed cooperative cleanup           | Normal agentic-tool event interpretation                               |
| Session reconciler            | Session projection, queue/callback continuation, and terminal gateway notification              | SDK observation or containment                                         |
| Executor heartbeat supervisor | Dispatch and wrapper-liveness suspicion                                                         | Proof of SDK progress or, when stronger evidence exists, process death |
| Runtime progress projection   | UI/gateway `working`, `waiting`, `stalled`, and terminal presentation derived from shared facts | Durable lifecycle or supervision decisions                             |

## Runtime contracts

### Agentic-tool runtime adapter contract

Agentic-tool-specific vocabulary stays inside its runtime adapter. The adapter
reports semantics equivalent to:

```text
activity(meaningful?)
operation_started(id, kind)
operation_progress(id)
operation_finished(id, outcome)
waiting_started(reason)
waiting_finished(reason)
terminal_outcome(completed | failed | timed_out | cancelled)
```

The exact TypeScript shape is an implementation decision. Conceptually, the
host invokes an operation equivalent to `execute(context)` and receives a
normalized turn outcome. Cooperative cancellation invokes an operation
equivalent to `abort(context)` and receives quiescence evidence. The host
supplies trusted tenant, user, branch, Task, and execution context; the adapter
must not infer or broaden those boundaries.

The contract is:

- recoverable runtime transport notices do not become terminal failures;
- authoritative agentic-tool terminal events do;
- stream end without a recognized terminal outcome is an actionable failure;
- unknown activity does not refresh meaningful progress;
- unknown control, interaction, or terminal vocabulary produces a visible
  compatibility diagnosis rather than becoming cosmetic transcript text;
- an incomplete agentic-tool thread is not blindly resumed;
- the adapter returns outcomes and cooperative cleanup evidence but does not
  patch durable terminal Task state, perform forced containment, or reconcile
  the Session.

Captured runtime traces and the tool/SDK version manifest are the adapter
conformance boundary.

### Bounded-wait contract

Every operation that can block the turn declares:

- a stable operation identity;
- the owner expected to settle it;
- what counts as meaningful progress;
- a quiet deadline that progress may extend;
- an absolute deadline that cannot move indefinitely;
- cancellation behavior;
- the outcome produced when the deadline expires.

The watchdog tracks parallel work by operation identity, never only by a
counter. Losing one completion event therefore cannot disable supervision
forever.

Detailed operation state remains executor-local. Durable telemetry stays
bounded to the latest activity/progress and the resulting diagnosis.

### Cooperative finalization contract

Agentic-tool runtime handlers return a normalized outcome; they do not patch
terminal Task state. The top-level executor finalizes in this order:

```text
agentic-tool outcome
  -> close the tool/SDK iterator or query
  -> settle or abort active operations
  -> flush bounded transcript writes
  -> report the terminal outcome
  -> exit the executor
```

If cooperative cleanup cannot prove quiescence, the task enters `stopping` and
the termination coordinator takes over. A live executor that learns the daemon
no longer considers its Task active must self-abort instead of retrying
telemetry forever.

### Forced-containment contract

User Stop, startup timeout, lost heartbeat, enforced SDK health failure, and
failed cooperative cleanup converge on the existing termination coordinator:

```text
active task
  -> atomically claim STOPPING
  -> deliver abort
  -> run agentic-tool cleanup
  -> verify local process absence or remote quiescence
  -> settle STOPPED or FAILED
```

A stale heartbeat is suspicion, not proof of death, when the daemon has stronger
local process-liveness evidence. A failed process probe or expired remote
liveness contract can authorize containment.

### Session reconciliation contract

One idempotent reconciliation path runs after Task settlement. It:

1. derives the Session projection from nonterminal Tasks;
2. starts the oldest queued Task when the Session is promptable;
3. processes child-completion callbacks through the same queue path;
4. surfaces terminal failure to the originating gateway;
5. safely does nothing when the consequences already settled.

The same owner runs at normal settlement, daemon startup, and through a bounded
repair sweep for promptable sessions with queued work. A generic outbox is not
required unless observed process-crash gaps remain after this reconciliation.

### Interaction-capability contract

Execution may wait for a human only when its launch surface can return a
decision.

- Interactive UI execution may wait with a deadline.
- Scheduled or otherwise unattended execution never broadens permissions
  automatically; if existing policy does not authorize the operation, it fails
  fast with a truthful outcome.
- Gateway execution waits only when that gateway implements the matching
  response path.

An answer to the Task's active interaction is control input for that wait, not a
new queued prompt; already queued work remains behind the active Task.

An interaction timeout first aborts and closes the agentic-tool query. It cannot
write `timed_out` while the executor remains active.

### Runtime presentation contract

UI and gateway surfaces derive progress from the same Task status, latest
activity, latest meaningful progress, and stall diagnosis. They do not infer
progress from `running` alone and do not create another persisted state.

Every originating gateway receives a terminal success or failure projection.
Live progress may be condensed for the channel, but it must distinguish
working, waiting, stalled, and terminal outcomes truthfully.

## Required flows

### Normal completion

```text
agentic-tool terminal success
  -> adapter returns completed
  -> executor closes query and flushes transcript
  -> executor reports completed and exits
  -> daemon commits terminal Task
  -> reconciler projects Session and drains queued work
```

### Silent SDK stall

```text
wrapper heartbeat remains fresh
  + meaningful progress deadline expires
  -> watchdog records diagnosis
  -> enforce policy aborts SDK
  -> cooperative cleanup succeeds?
       yes -> report failed
       no  -> daemon containment
```

### Active operation loses completion

```text
operation_started(id)
  -> progress may extend quiet deadline
  -> operation_finished never arrives
  -> absolute deadline expires
  -> abort/close the operation
  -> apply the operation-specific timeout outcome
  -> finalize or enter containment
```

### Permission or input timeout

```text
interaction wait expires
  -> executor aborts agentic-tool query
  -> cleanup succeeds?
       yes -> report timed_out and exit
       no  -> STOPPING -> containment
  -> only then commit terminal Task state
```

### Stop or lost heartbeat

```text
daemon claims STOPPING with race fences
  -> executor receives abort request
  -> agentic-tool cleanup and quiescence report
  -> local process absence / remote quiescence verification
  -> terminal settlement
  -> session reconciliation
```

### Terminal consequence repair

```text
Task is terminal
  + Session projection, queue, callback, or gateway outcome disagrees
  -> idempotent reconciliation derives and applies missing consequences
```

## Required invariants

1. `Task.status` remains the only durable execution lifecycle.
2. Heartbeat liveness, SDK activity, and meaningful progress remain distinct.
3. Every blocking wait is identifiable, bounded, and abortable.
4. Parallel work is tracked by operation identity, never only by a counter.
5. Unknown activity does not refresh meaningful progress.
6. Unknown control or terminal events produce compatibility diagnostics.
7. Agentic-tool runtime adapters do not write terminal Task state.
8. A Task cannot be terminal while its agentic-tool runtime remains active.
9. Cooperative cleanup precedes executor-reported terminality.
10. Failed cooperative cleanup enters daemon containment.
11. Stale heartbeat is not proof of process death when stronger evidence exists.
12. Terminal settlement always invokes idempotent Session reconciliation.
13. Unattended execution cannot enter an unanswerable interactive wait.
14. Supervision does not imply automatic retry or safe replay.

## Failure-family coverage

Issue state remains live GitHub truth and is not duplicated here. Each issue
has one primary architecture family even when it has secondary effects.

| Failure family                              | Evidence                                                                                                                                                                                                                                                                               | Desired owner                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Wrapper alive while SDK is silent           | [#1541](https://github.com/preset-io/agor/issues/1541), [#1820](https://github.com/preset-io/agor/issues/1820), [#1844](https://github.com/preset-io/agor/issues/1844), [#472](https://github.com/preset-io/agor/issues/472)                                                           | SDK watchdog                                 |
| Awaited completion is missing or mishandled | [#1900](https://github.com/preset-io/agor/issues/1900), [#2067](https://github.com/preset-io/agor/issues/2067), [#1852](https://github.com/preset-io/agor/issues/1852)                                                                                                                 | Bounded operations and executor finalizer    |
| Agentic-tool protocol is misclassified      | [#1749](https://github.com/preset-io/agor/issues/1749), [#1821](https://github.com/preset-io/agor/issues/1821), [#1984](https://github.com/preset-io/agor/issues/1984), [#1969](https://github.com/preset-io/agor/issues/1969), [#2063](https://github.com/preset-io/agor/issues/2063) | Agentic-tool runtime adapters                |
| Task is terminal before runtime quiesces    | [#2062](https://github.com/preset-io/agor/issues/2062), [#682](https://github.com/preset-io/agor/issues/682)                                                                                                                                                                           | Executor finalizer / termination coordinator |
| Healthy work is classified as stalled       | [#505](https://github.com/preset-io/agor/issues/505), [#1809](https://github.com/preset-io/agor/issues/1809)                                                                                                                                                                           | Phase-specific supervision and liveness      |
| Terminal consequences remain stale          | [#1831](https://github.com/preset-io/agor/issues/1831), [#1879](https://github.com/preset-io/agor/issues/1879), [#231](https://github.com/preset-io/agor/issues/231), [#2052](https://github.com/preset-io/agor/issues/2052)                                                           | Session reconciler                           |
| Interaction cannot reach its responder      | [#653](https://github.com/preset-io/agor/issues/653), [#2037](https://github.com/preset-io/agor/issues/2037)                                                                                                                                                                           | Interaction capability                       |
| Runtime presentation implies progress       | [#1498](https://github.com/preset-io/agor/issues/1498)                                                                                                                                                                                                                                 | Runtime progress projection                  |

[#1826](https://github.com/preset-io/agor/issues/1826) is the predecessor
design for normalized executor vitals. This foundation keeps that useful
direction while avoiding a second durable lifecycle or operation ledger.
[#472](https://github.com/preset-io/agor/issues/472) is retained as weak
historical evidence because its underlying mechanism was not confirmed.

## Adoption constraints

Each implementation PR should identify:

1. the invariant it advances;
2. the existing owner it deepens;
3. the failure family it addresses;
4. the current behavior it deliberately leaves unchanged;
5. whether [task-runtime-state.md](../concepts/task-runtime-state.md) must be
   updated.

Timeout values, concrete TypeScript event shapes, reconciliation cadence, and
agentic-tool-specific recovery outcomes belong to the implementation PR that first
needs them. They are not foundation decisions.

## Deferred upgrades and triggers

| Deferred mechanism              | Introduce only when                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Multiple attempts within a Task | One Task must safely survive multiple executor runs                                      |
| Durable operation history       | Operations must be adopted or reconstructed after executor loss                          |
| Generic outbox                  | Proven daemon-crash delivery gaps remain after idempotent reconciliation                 |
| Automatic retry                 | A failure class is demonstrably replay-safe, including its external effects              |
| New Task status                 | Users or another lifecycle owner require distinct durable admission or terminal behavior |

## Primary implementation seams

| Responsibility                         | Existing seam                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Task lifecycle and terminal guards     | `packages/core/src/types/task.ts`, `packages/core/src/db/repositories/tasks.ts`                                                        |
| Agentic-tool event interpretation      | `packages/executor/src/sdk-handlers/`                                                                                                  |
| SDK supervision                        | `packages/executor/src/sdk-watchdog.ts`                                                                                                |
| Top-level executor finalization        | `packages/executor/src/index.ts`, `packages/executor/src/handlers/sdk/base-executor.ts`                                                |
| Heartbeat and pulse transport          | `packages/executor/src/executor-heartbeat.ts`                                                                                          |
| Forced containment                     | `apps/agor-daemon/src/termination-coordinator.ts`, `apps/agor-daemon/src/executor-tracking.ts`                                         |
| Wrapper-liveness supervision           | `apps/agor-daemon/src/services/executor-heartbeat-supervisor.ts`                                                                       |
| Task settlement and Session projection | `apps/agor-daemon/src/services/tasks.ts`, `apps/agor-daemon/src/utils/session-task-state.ts`                                           |
| Queue and callback continuation        | `apps/agor-daemon/src/register-routes.ts`, `apps/agor-daemon/src/register-hooks.ts`                                                    |
| Gateway terminal outcomes              | `apps/agor-daemon/src/services/gateway.ts`                                                                                             |
| UI/gateway progress consumers          | `apps/agor-ui/src/components/TaskBlock/`, `apps/agor-ui/src/components/TaskStatusIcon.tsx`, `apps/agor-daemon/src/services/gateway.ts` |
