# Desired task runtime architecture

> **Status:** Proposed foundation; this is a target contract, not current
> behavior or an implementation plan. See
> [task-runtime-state.md](../concepts/task-runtime-state.md) for the current
> system. Code remains ground truth while this design is adopted incrementally.

## Decision in one minute

A Task is Agor's only authoritative durable execution lifecycle. Once runtime
dispatch is possible, every terminal transition passes one daemon-owned release
gate:

- the executor reports that cooperative cleanup reached quiescence; or
- the daemon verifies containment for the specific runtime.

If neither proof is available, the Task remains `stopping`. An authorized
force-fail is an explicit unsafe logical release, not evidence that the runtime
stopped.

The architecture has three conceptual roles:

```text
Executor: TaskRunner        Daemon: TaskController       Daemon: SessionReconciler
adapter + watchdog + waits  Task state + release gate    tenant-scoped consequences
cooperative cleanup         containment + settlement     projection + queue + intents
           |                           |                             |
           `---- runner report ------>`---- terminal Task -------->`
```

These are responsibilities, not a requirement to create three large classes or
an execution kernel. Existing adapter, watchdog, finalizer, heartbeat,
termination, task-service, queue, and gateway seams remain useful inside these
roles. Progress and promptability are shared derivations, not additional
lifecycle owners.

## Governing ideas

1. Keep one durable lifecycle: `Task.status`.
2. Keep wrapper liveness, runtime activity, and meaningful progress separate.
3. Use one release-and-settlement protocol for normal completion, Stop, health
   failure, and recovery.
4. Materialize terminal consequences with domain-specific identities so repair
   is crash-safe without introducing a generic outbox.
5. Preserve tenant identity through every runtime, reconciliation, callback,
   queue, and gateway boundary.
6. Serialize recovery for one Session while keeping containment and external
   I/O outside database transactions.

## Problems this architecture must solve

The failure is not simply "no watchdog." Agor must distinguish wrapper
liveness from SDK progress, healthy silent work from lost completion, runtime
completion from quiescence, answerable waits from unattended waits, and Task
settlement from its downstream consequences.

No single timeout answers all of these. Each wait and outcome needs the owner
that can interpret its evidence.

## Scope and vocabulary

This foundation covers executor-backed turns for all shipped agentic tools:
Claude Code, Codex, Gemini, OpenCode, Copilot, and Cursor.

An **agentic tool** is an executable runtime integration. A **model provider**
supplies models, such as Anthropic, OpenAI, Google, or a provider exposed through
OpenCode. The runtime contract belongs to an **agentic-tool runtime adapter**.
Model-provider selection and credentials may be adapter inputs, but they do not
make the model provider the runtime owner.

**Wrapper liveness** means the executor can communicate. **Runtime activity**
means the SDK emitted an event. **Meaningful progress** means a recognized
event advanced the turn or a tracked operation. **Quiescence** is cooperative
runtime shutdown; **verified containment** is external proof that the scoped
runtime cannot keep working. A **logical release** frees durable admission
without claiming that proof. A **terminal consequence** is Session, queue,
callback, or gateway state caused by a terminal Task.

## Non-goals

This foundation preserves these Ponytail boundaries:

- no `stalled` or `cancelled` Task status;
- no execution-attempt table: one prompt creates one Task, so `task_id` is the
  current execution epoch;
- no persistent runtime-operation or event ledger;
- no generic distributed outbox;
- no automatic Task retry or prompt replay;
- no exactly-once external-effects framework;
- no general remote-execution kernel;
- no automatic progress lease that treats liveness expiry as containment.

These mechanisms remain upgrade options only when an observed requirement
cannot be satisfied by the existing owners.

## Conceptual ownership

| Role                         | Owns                                                                                            | Does not own                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `TaskRunner` (executor)      | Runtime adapter, wait supervision, operation identities, cooperative cleanup, and runner report | Durable terminal Task writes, forced containment, or reconciliation |
| `TaskController` (daemon)    | Authoritative Task transitions, runtime fences, containment, release proof, and terminal commit | Raw agentic-tool vocabulary or downstream delivery                  |
| `SessionReconciler` (daemon) | Tenant-scoped Session projection, queue continuation, callback creation, and gateway intent     | Runtime observation or containment                                  |

`Task.status` is the execution authority. `Session.status` is a persisted,
indexed materialized projection for admission and presentation; it is not a
second execution lifecycle. `Session.ready_for_prompt` also carries
attention/acknowledgement meaning and is not promptability by itself.

The shared runtime-progress and promptability functions consume these durable
facts. UI, gateway, queue, and callback callers reuse those functions rather
than deriving private meanings.

A launch/runtime fence and deterministic consequence identities are durable
coordination facts, not competing lifecycles. `task_id` remains the execution
epoch; a substrate-specific runtime identity is added only where containment
must address a more specific remote runtime.

## Runtime contracts

### Agentic-tool runtime adapter

Agentic-tool-specific vocabulary stays inside its runtime adapter. The adapter
reports semantics equivalent to:

```text
activity(kind, detail)
operation_started(id, kind)
operation_progress(id)
operation_finished(id, result)
waiting_started(kind)
waiting_finished(kind)
turn_result(success | failure(reason))
cleanup_result(quiesced | unverified(reason))
```

The exact TypeScript shape is an implementation decision. Conceptually, the
host invokes `execute(context)` and receives a normalized turn result. A
cooperative abort invokes `abort(context)` and receives cleanup evidence. The
host supplies trusted tenant, user, branch, Task, and runtime context; the
adapter must not infer or broaden those boundaries.

The adapter contract is:

- recoverable runtime transport notices do not become terminal failures;
- authoritative agentic-tool terminal events do;
- stream end without a recognized terminal result is an actionable failure;
- an incomplete agentic-tool thread is not blindly resumed;
- native SDK deadlines are declared, configured when supported, and normalized;
- the adapter never patches durable terminal Task state, performs forced
  containment, or reconciles the Session.

The adapter deliberately does not speak the durable Task-status vocabulary.
The `TaskController` maps the runner result and the winning release cause:

| Winning fact                                  | Durable terminal status after release proof |
| --------------------------------------------- | ------------------------------------------- |
| Successful turn                               | `completed`                                 |
| Runtime failure or unsolicited cancellation   | `failed`                                    |
| Bounded interaction wait expired              | `timed_out`                                 |
| Termination cause is `user_stop`              | `stopped`                                   |
| Startup, heartbeat, or SDK-health termination | `failed`                                    |

`cancelled` is therefore a runtime observation, not a proposed `TaskStatus`.
Before dispatch creates a runtime, a guarded terminal transition may use the
same mapping with absence established by the launch fence.

### Adapter conformance and unknown vocabulary

Captured runtime traces plus a tool/SDK version manifest define the adapter
conformance boundary. It has enforcement consequences:

1. A supported adapter version with trace coverage may run semantic watchdog
   enforcement.
2. An unsupported or incompletely mapped adapter/version must explicitly run
   `observe-only` or fail launch. It must never silently claim to be supervised.
3. Every shipped agentic tool has an explicit conformance mode, including
   Cursor and Copilot.

Unknown vocabulary is handled by evidence class:

- recognized progress renews the relevant progress deadline;
- unknown observational activity records a compatibility diagnosis and raw
  activity time, but does not prove meaningful progress or a semantic stall;
- if the runtime later becomes quiet after unknown observations, enforcement
  reports adapter incompatibility rather than mislabeling the result as a
  semantic stall;
- unknown control, interaction, or terminal vocabulary is an adapter
  compatibility failure, never cosmetic transcript text.

This preserves bounded failure handling without terminating a continuously
active, newly evolved event stream merely because its vocabulary is unfamiliar.

### Bounded waits and native deadlines

Every Agor-owned wait chooses a named profile. A profile declares the owner,
operation identity, progress rule, quiet and absolute deadlines, cancellation,
and expiry outcome once; call sites supply only the context-specific values.

| Profile           | Applies to                                       | Important rule                                                        |
| ----------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Turn progress     | SDK startup and semantic turn progress           | Runtime activity and meaningful progress remain separate              |
| Active operation  | Tool calls and background work                   | Track each operation by identity and require an absolute bound        |
| Human interaction | Permission or input waits                        | Pause only the relevant progress clock; require a reachable responder |
| Runtime release   | Abort, cleanup, transcript flush, and quiescence | Bound automatic attempts; failure enters containment or safety hold   |

Parallel work is tracked by stable operation identity, never only by a counter.
Losing one completion event therefore cannot disable supervision forever.
Detailed operation state remains executor-local; durable telemetry is bounded
to the latest evidence and resulting diagnosis.

An agentic tool may also own a native deadline, as the Claude SDK does. That
deadline is not an Agor wait. Its adapter must declare whether the deadline is
configurable, apply the intended value when possible, and normalize expiry into
the runner result. Agor must not present a tool-owned timeout as an Agor
phase-progress decision.

### One release-and-settlement protocol

Normal completion and forced termination share one proof and commit gate even
though different actors perform the cleanup:

```text
turn result or termination cause
  -> fence the authorized runtime / winning termination request
  -> request cooperative abort when needed
  -> settle operations and bounded transcript writes
  -> obtain runner quiescence or perform containment
  -> verify release evidence for that runtime
       verified   -> atomically commit the mapped terminal Task status
       unverified -> keep Task STOPPING and preserve the safety hold
  -> reconcile terminal consequences only after terminal commit
```

The executor finalizer remains the cooperative actor. The daemon termination
coordinator remains the authoritative forced-containment actor. They implement
one protocol; they are not merged across the process and trust boundary.

A live executor that learns the daemon no longer authorizes its Task must
self-abort instead of retrying telemetry forever. Every report and containment
attempt is fenced to the Task and winning runtime/termination request so a late
actor cannot settle newer work.

Containment is capability-based:

| Runtime capability | Evidence that permits automatic terminal settlement                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Local process      | Cooperative quiescence when available, then scoped process-group absence                            |
| Remote managed     | Fenced quiescence or substrate-confirmed termination for the specific remote runtime identity       |
| Unverifiable       | None; remain `stopping` until proof arrives or an authorized user accepts an unsafe logical release |

A stale heartbeat, failed process probe, launcher exit, or expired remote
liveness contract may initiate containment. None alone proves remote
quiescence. A lease could prove safety only if every side-effecting boundary
enforced its fence; that stronger system is deferred.

#### When containment cannot be verified

Unverified containment is an explicit branch of the protocol:

- the Task remains `stopping`;
- the Session remains non-promptable;
- queued Tasks stay ordered but blocked;
- the termination coordinator owns bounded retry/escalation attempts and a
  visible `termination_unverified` diagnosis;
- daemon startup resumes containment or preserves the hold; restart is not
  proof of quiescence;
- an owner/admin may force-fail only through an explicit, confirmed, audited
  operation.

Force-fail commits `failed`, unblocks reconciliation, and accepts the risk that
unverified work may still exist. It does not set or imply
`termination_verified`. Automatic waits are bounded; the durable `stopping`
safety hold may persist because it is state requiring action, not a process
blocked in an unbounded wait.

The current startup path that logically releases orphaned work without proof is
a known migration gap, not a target containment capability.

### Session projection and terminal reconciliation

The central promptability predicate considers the authoritative Tasks and the
Session projection. It never checks `ready_for_prompt` alone. While a Task is
active or held in `stopping`, that Task owns the Session's busy projection and
queue admission remains closed.

On a terminal commit, the daemon invokes one conceptual operation:

```text
reconcile(tenant_id, session_id)
```

The reconciler:

1. materializes `Session.status` from the authoritative Tasks;
2. applies terminal attention once for a new terminal consequence, then
   preserves later `ready_for_prompt` acknowledgement instead of deriving it
   again from terminal history;
3. atomically claims the queued Task with the lowest `queue_position` when the
   Session is promptable;
4. materializes each child-completion callback once through the same queue
   path;
5. records the originating gateway's desired terminal outcome and delivery
   receipt;
6. safely does nothing when every consequence is already materialized.

The same owner runs after normal settlement, at daemon startup, and through a
bounded repair sweep. It materializes claims and intents; existing dispatcher
and gateway owners perform executor spawn and external send. It does not
interpret SDK events or prove containment.

#### Recovery ordering and transaction scope

Recovery for one Session is an ordered continuation of the release protocol,
not a set of competing startup jobs. Containment finishes or preserves the
`stopping` hold before restart notices and terminal consequence repair run for
that Session. Queue continuation stays suppressed until that ordered recovery
reaches reconciliation. Different Sessions may recover concurrently only when
each Session retains this single-writer order.

Tenant identity may span the complete recovery operation; a database
transaction may not span process containment, a bounded wait, executor RPC, or
external delivery. Each durable claim, terminal commit, notice, and consequence
repair uses a short, idempotent database unit. If one unit must lock both the
Session and its Tasks, it locks the Session first and Tasks in stable order.
Transient database conflicts abort only that unit; a later bounded repair pass
re-reads durable Task truth rather than replaying external effects.

#### Crash-safe consequence identities

Restart repair requires narrow durable coordination facts, not another
execution lifecycle:

- a queue claim is guarded by Task status and `queue_position`;
- a callback uses a deterministic identity such as
  `(source_task_id, target_session_id, event)`; a unique claim and callback Task
  creation happen in one transaction, or Task creation itself is idempotent by
  that key;
- the Session projection records the newest terminal consequence it applied so
  repair can distinguish missing projection from later user acknowledgement;
- a gateway terminal outcome uses a durable identity derived from the source
  Task and origin before external delivery;
- an in-memory map or buffer may optimize delivery, but is not the durable
  receipt.

External delivery is at-least-once. Use a channel idempotency key when the
external API supports one; otherwise a crash after send but before receipt can
still duplicate delivery and must not be described as exactly-once. A generic
outbox remains deferred unless these domain-specific facts prove insufficient.

### Tenant boundary

Task, Session, callback, queue, and gateway resources are tenant-owned or
derived under [the multitenancy contract](../concepts/multitenancy.md). Trusted
tenant identity must cross each asynchronous boundary.

Startup may discover `(tenant_id, session_id)` pairs under a narrow, explicit
system capability. Every read, claim, callback, queue action, gateway intent,
and repair then re-enters the owning tenant scope. Ambient HTTP identity and
static-tenant fallback are not architecture contracts.

Implementation coverage includes a cross-tenant negative case that would fail
if the tenant scope were removed.

### Interaction capability

Execution may wait for a human only when its launch surface can return a
decision.

- Interactive UI execution may wait with a deadline.
- Scheduled or otherwise unattended execution never broadens permissions
  automatically; if existing policy does not authorize the operation, it fails
  fast with a truthful outcome.
- Gateway execution waits only when that gateway implements the matching
  response path.

An answer to the active interaction is control input for that Task, not a new
queued prompt. Already queued work remains behind the active Task.

An interaction timeout first aborts and closes the agentic-tool runtime. It may
map to `timed_out` only after the release gate succeeds; otherwise the Task
enters `stopping`.

### Runtime presentation

Runtime presentation is one shared pure derivation, not an architectural owner.
UI and gateway surfaces consume Task status, latest runtime activity, latest
meaningful progress, interaction state, and compatibility/health diagnosis.
They do not infer progress from `running` alone or persist another lifecycle.

Every originating gateway receives a terminal success or failure projection.
Live progress may be condensed for the channel, but it distinguishes working,
waiting, compatibility failure, stalled, and terminal outcomes truthfully.

## Required flows

All runtime exit paths converge on the release gate; only their trigger and
mapped result differ.

| Trigger                    | Runner/controller action                                                                               | Result                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Normal success             | Close runtime, settle operations, flush bounded transcript writes, report quiescence                   | Commit `completed`, then reconcile                                     |
| Recognized semantic stall  | Diagnose, abort under enforce policy, then prove cleanup or contain                                    | Commit `failed` only after proof; otherwise hold `stopping`            |
| Unknown runtime vocabulary | Record compatibility evidence without renewing progress or claiming a semantic stall                   | Continue under declared conformance policy; fail/contain after quiet   |
| Lost operation completion  | Expire the operation identity's absolute deadline and abort its work                                   | Apply the wait profile, then finalize or contain                       |
| Interaction timeout        | Abort the runtime and prove release                                                                    | Commit `timed_out`; otherwise hold `stopping`                          |
| Stop or health termination | Fence the winning cause, request abort, and verify the available containment capability                | Commit `stopped`/`failed`; otherwise hold `stopping`                   |
| Daemon restart recovery    | Claim the orphan, contain outside a database transaction, then serialize notice and repair per Session | Commit or preserve `stopping`; continue the queue only after repair    |
| Consequence repair         | Re-enter tenant scope and claim the missing deterministic identity                                     | Materialize once; repeated repair is a no-op after its durable receipt |

## Required invariants

1. `Task.status` is the authoritative durable execution lifecycle; the daemon
   owns terminal commits, and `Session.status` remains a materialized
   projection.
2. Wrapper heartbeat, runtime activity, meaningful progress, and containment
   evidence are distinct facts.
3. Every Agor-owned wait uses a bounded, abortable profile; parallel operations
   use identities, and agentic-tool-native deadlines are declared by adapters.
4. Watchdog enforcement requires explicit adapter/version conformance; unknown
   vocabulary is diagnosed and never silently counted as semantic progress or
   stall evidence.
5. Automatic terminal settlement requires cooperative quiescence or verified
   containment. Unverified work remains `stopping`; audited force-fail is an
   explicit unsafe logical-release exception.
6. One fenced release gate maps runner results and termination causes to the
   existing terminal statuses; runtime cancellation does not add a
   `cancelled` Task status.
7. Terminal consequences are tenant-scoped and crash-repairable through
   deterministic identities or receipts; external delivery is not claimed to
   be exactly-once.
8. Recovery for one Session is serialized; tenant identity may span
   orchestration, but database transactions cannot span containment or external
   I/O, and queue continuation waits for ordered reconciliation.
9. Unattended execution cannot enter an interaction wait without a reachable
   responder.
10. Supervision and consequence repair do not imply automatic Task retry,
    prompt replay, or safe runtime adoption after restart.

## Failure-family coverage

Issue state remains live GitHub truth and is not duplicated here. The table
contains 23 unique behavioral or product issues. The primary column assigns
each issue once; the secondary column records important amplifiers without
changing that ownership.

| Failure family                              | Primary evidence                                                                                                                                                                                                                                                                       | Secondary / note                                                      | Architecture contract                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| Wrapper alive while runtime is silent       | [#1541](https://github.com/preset-io/agor/issues/1541), [#1820](https://github.com/preset-io/agor/issues/1820), [#1844](https://github.com/preset-io/agor/issues/1844), [#472](https://github.com/preset-io/agor/issues/472) (weak historical evidence)                                |                                                                       | Evidence separation and turn-progress profile     |
| Awaited completion is missing or mishandled | [#1900](https://github.com/preset-io/agor/issues/1900), [#2067](https://github.com/preset-io/agor/issues/2067), [#1852](https://github.com/preset-io/agor/issues/1852)                                                                                                                 |                                                                       | Operation identities and cooperative cleanup      |
| Agentic-tool protocol is misclassified      | [#1749](https://github.com/preset-io/agor/issues/1749), [#1821](https://github.com/preset-io/agor/issues/1821), [#1984](https://github.com/preset-io/agor/issues/1984), [#1969](https://github.com/preset-io/agor/issues/1969), [#2063](https://github.com/preset-io/agor/issues/2063) |                                                                       | Adapter conformance and unknown-vocabulary policy |
| Task is terminal before runtime release     | [#682](https://github.com/preset-io/agor/issues/682)                                                                                                                                                                                                                                   | [#2062](https://github.com/preset-io/agor/issues/2062) amplifies this | One release-and-settlement protocol               |
| Healthy work is classified as stalled       | [#1809](https://github.com/preset-io/agor/issues/1809)                                                                                                                                                                                                                                 |                                                                       | Evidence-specific wait profiles                   |
| Agentic-tool-native deadline is wrong       | [#505](https://github.com/preset-io/agor/issues/505)                                                                                                                                                                                                                                   |                                                                       | Adapter-owned native deadline configuration       |
| Terminal consequences remain stale          | [#1831](https://github.com/preset-io/agor/issues/1831), [#1879](https://github.com/preset-io/agor/issues/1879), [#231](https://github.com/preset-io/agor/issues/231), [#2052](https://github.com/preset-io/agor/issues/2052)                                                           | #1831 also supplies tenant-boundary evidence                          | Tenant-scoped crash-safe reconciliation           |
| Interaction cannot reach its responder      | [#653](https://github.com/preset-io/agor/issues/653), [#2037](https://github.com/preset-io/agor/issues/2037), [#2062](https://github.com/preset-io/agor/issues/2062)                                                                                                                   | #2062 also exposes failed runtime release                             | Launch-time interaction capability                |
| Runtime presentation implies progress       | [#1498](https://github.com/preset-io/agor/issues/1498)                                                                                                                                                                                                                                 | Product/visibility evidence                                           | Shared runtime-presentation derivation            |

[#1826](https://github.com/preset-io/agor/issues/1826) is the predecessor
design for normalized executor vitals. Together, the 23 behavioral/product
issues and this predecessor design account for the 24 references reviewed for
this foundation.

## Adoption constraints

Each implementation PR identifies:

1. the conceptual role and existing code seam it deepens;
2. the invariant and primary failure family it advances;
3. the current behavior it deliberately leaves unchanged;
4. the conformance or containment capability affected;
5. the tenant boundary and proportional negative proof, when applicable;
6. whether [task-runtime-state.md](../concepts/task-runtime-state.md) and
   [task-queueing.md](../concepts/task-queueing.md) need updates;
7. for startup or repair changes, the per-Session ordering and proof that no
   database transaction spans containment or external I/O.

Timeout values, concrete TypeScript shapes, reconciliation cadence, and
agentic-tool-specific recovery results belong to the first implementation PR
that needs them. The foundation defines ownership and proof, not arbitrary
numbers or class names.

## Deferred upgrades and triggers

| Deferred mechanism                      | Introduce only when                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Multiple attempts within a Task         | One Task must safely survive multiple authorized runtime epochs                                        |
| Durable operation history               | Operations must be adopted or reconstructed after executor loss                                        |
| Generic outbox                          | Domain-specific consequence identities cannot repair observed daemon-crash gaps                        |
| Automatic Task retry                    | A failure class is demonstrably replay-safe, including external effects                                |
| New Task status                         | Another durable admission or terminal behavior cannot be expressed by the existing statuses            |
| Remote lease as release proof           | Every side-effecting boundary rejects an expired or superseded runtime fence                           |
| Automatic unverified release/quarantine | Product requirements demand task settlement while separately preventing unsafe branch or runtime reuse |

## Primary implementation seams

| Responsibility                                | Existing seam                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Task lifecycle, statuses, and terminal guards | `packages/core/src/types/task.ts`, `packages/core/src/db/repositories/tasks.ts`                                                        |
| Session projection and promptability          | `packages/core/src/types/session.ts`, `apps/agor-daemon/src/utils/session-task-state.ts`                                               |
| Agentic-tool event interpretation             | `packages/executor/src/sdk-handlers/`                                                                                                  |
| SDK supervision and conformance manifest      | `packages/executor/src/sdk-watchdog.ts`                                                                                                |
| Top-level cooperative finalization            | `packages/executor/src/index.ts`, `packages/executor/src/handlers/sdk/base-executor.ts`                                                |
| Heartbeat and pulse transport                 | `packages/executor/src/executor-heartbeat.ts`                                                                                          |
| Forced containment and release proof          | `apps/agor-daemon/src/termination-coordinator.ts`, `apps/agor-daemon/src/executor-tracking.ts`                                         |
| Wrapper-liveness supervision                  | `apps/agor-daemon/src/services/executor-heartbeat-supervisor.ts`                                                                       |
| Terminal settlement and consequences          | `apps/agor-daemon/src/services/tasks.ts`                                                                                               |
| Queue and callback continuation               | `apps/agor-daemon/src/register-routes.ts`, `apps/agor-daemon/src/register-hooks.ts`                                                    |
| Tenant-scoped queued/deferred work            | `apps/agor-daemon/src/utils/session-queue-tenant-scope.ts`, `apps/agor-daemon/src/utils/tenant-db-scope.ts`                            |
| Startup recovery and short database units     | `apps/agor-daemon/src/startup.ts`, `packages/core/src/db/tenant-unit-of-work.ts`                                                       |
| Gateway terminal outcomes                     | `apps/agor-daemon/src/services/gateway.ts`                                                                                             |
| UI/gateway progress consumers                 | `apps/agor-ui/src/components/TaskBlock/`, `apps/agor-ui/src/components/TaskStatusIcon.tsx`, `apps/agor-daemon/src/services/gateway.ts` |
