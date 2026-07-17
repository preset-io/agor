# Executor SDK Health and Containment Plan

**Status:** Proposed. This document must be approved before implementation.

**Delivery shape:** One clean branch from current `main`, one self-contained pull request, no stacked pull requests.

**Primary scope:** Reapply the accepted dispatch/connection contract from PR #1888 and add the smallest reliable mechanism that distinguishes executor liveness from SDK progress, diagnoses stalled SDK turns, and automatically continues only after supported local execution has proven quiescence.

**Related work:**

- Issue #1541: detect SDK tasks whose executor remains alive while the SDK turn makes no meaningful progress.
- PR #1888: accepted `dispatching -> running` connection boundary. It was merged into `executor-runtime-overseer`, not `main`, so its behavior must be reapplied here.
- PR #1926: implementation reference only. The current four-table execution-kernel direction is not the architecture for this scope.
- Reviewed PR #1926 head `435049c6`: preserve as a reference for later lifecycle work if the team still wants it. Do not silently discard the review; route its applicable findings as described below.

## 1. Decision summary

Build a **task-scoped SDK health layer**, not a general execution kernel.

```text
TASK HANDOFF                         SDK HEALTH

queued
  |
  v
dispatching     PR #1888
  | authenticated executor connection
  v
running --------------------------> SDK starting
  |                                      |
  | wrapper heartbeat                    | meaningful SDK event
  |                                      v
  |                                 SDK progressing
  |                                      |
  |                         +------------+------------+
  |                         |                         |
  |                    human wait              stall/disconnect
  |                         |                         |
  |                         +------ resume ---------+|
  |                                                   v
  |                                      termination coordinator
  |                                                   |
  |                         +-------------------------+------------------+
  |                         |                                            |
  |                 verified local containment                  unprovable execution
  |                         |                                            |
  v                         v                                            v
existing terminal lifecycle after absence                    diagnose and remain blocked
                                                                         |
                                                        explicit owner/admin force-fail
                                                                         |
                                                                         v
                                                        existing FAILED lifecycle
```

The responsibility boundary is:

> Observe and classify the health of one authenticated SDK-backed Task. The executor reports health; the daemon owns containment and automatic forced terminality. Existing task/session/callback/queue behavior runs after verified containment, or after an authorized owner/admin explicitly accepts unverified termination through the existing failure path.

This PR deliberately does **not** solve general distributed execution, daemon-restart containment, arbitrary remote-driver fencing, exactly-once effects, or branch-wide lifecycle ownership.

## 2. Why this is the cleanest ponytail architecture

Main already has most of the required shape:

- A Task is the canonical logical turn.
- Executor heartbeats already distinguish a reachable wrapper from a dead wrapper.
- A daemon heartbeat supervisor already evaluates staleness.
- Existing task terminal transitions already own session state, callbacks, and queue behavior.
- Existing `STOPPING` state can represent requested termination before terminal proof.
- Existing task `data`/`metadata` can hold bounded health facts.
- Existing SDK adapters already have the raw events needed to identify progress.
- Existing local executor tracking already knows the spawned executor PID while the spawning daemon remains alive.

The missing pieces are narrow:

1. The accepted pre-connect `dispatching` state from PR #1888.
2. A protected, task-scoped telemetry path.
3. A small normalized SDK pulse vocabulary.
4. An independent first-progress watchdog.
5. One shared local process-group containment primitive.
6. A coordinator that terminalizes only after supported containment proves absence.

The implementation must reduce parallel mechanisms:

- Move heartbeat writes off generic `tasks.patch` rather than add a second telemetry path.
- Use one containment primitive for user Stop, startup timeout, stale heartbeat, and SDK stall.
- Replace Claude's loop-internal idle check if the new independent Claude policy lands; do not stack two idle watchdogs.
- Reuse existing terminal task side effects after containment; do not rebuild queue or callback orchestration.
- Reuse Task JSON for bounded health facts; do not add lifecycle tables.

## 3. Frozen scope

### 3.1 In scope

- Reapply PR #1888's `dispatching -> running` contract and `executor_connected_at` column for SQLite and PostgreSQL.
- Preserve the PR #1888 exception for `claude-code-cli`, which has no executor heartbeat path.
- Classify local executor process exit separately from fire-and-forget templated launcher exit.
- Add a dispatch-connect timeout distinct from connected heartbeat staleness.
- Add task-scoped executor telemetry with daemon-authored timestamps.
- Reject generic external mutation of daemon-owned task lifecycle and telemetry fields.
- Piggyback bounded SDK pulses on the existing executor heartbeat channel.
- Define and test meaningful progress separately for each supported SDK adapter.
- Detect no first meaningful SDK progress with an independent executor-side timer.
- Separate meaningful progress from raw stream activity so unknown-but-active SDK vocabulary diagnoses without enforcement.
- Ship one observe/enforce decision path and require a real-workload observe-only soak before enforcement becomes the default.
- Detect explicit SDK stream failures/disconnections and route ambiguous local-child outcomes through the same containment path.
- Pause first-progress policy while the task is legitimately waiting for permission/input.
- Optionally replace Claude's existing 60-minute loop-internal idle policy with the same independent watchdog, enabled for Claude only.
- Create one Unix process-group containment primitive for supported local execution.
- Reuse that primitive for user Stop, startup timeout, stale heartbeat, and SDK-stall termination.
- Best-effort contain tracked groups during graceful daemon shutdown without changing main's restart reconciliation behavior.
- Add an explicit branch-owner/admin force-fail action for termination that cannot be verified automatically.
- Preserve current product outcomes after verified containment:
  - user Stop -> `STOPPED` and existing queue-preservation behavior;
  - heartbeat loss or SDK stall -> `FAILED`, session promptable, and existing no-auto-drain heartbeat-failure behavior;
  - normal completion -> unchanged callbacks and queue drain.
- Surface actionable, bounded, secret-free diagnostics.
- Prove pulse coalescing under concurrent executor load does not amplify database writes or WebSocket publications beyond heartbeat cadence.

### 3.2 Explicitly out of scope

- `task_attempts`, `runtimes`, `effects`, or `runtime_events` tables.
- Attempt history, same-task redispatch, or automatic execution retry.
- Authority grants, branch generations, collision-scope registries, or worktree generations.
- General exactly-once external Effects or provider tombstones.
- Callback redesign or new durable queue-trigger machinery.
- Branch-wide queue serialization beyond current behavior.
- Branch deletion, worktree cleanup, environment, or terminal lifecycle redesign.
- Persistent CLI runtime ownership or Binding concepts.
- General configured-executor driver protocol.
- Multi-daemon process-owner routing; the documented supported topology remains one daemon replica.
- Guaranteed remote executor termination without an existing inspectable stop contract.
- Guaranteed containment after daemon restart; local process identity is process-memory-owned in this PR.
- Windows Job Object integration.
- A generic post-progress inactivity timeout for every SDK adapter.
- Pulse history, event sourcing, durable replay, a recent-event ring, or raw provider payload persistence.
- New user-visible SDK-health status enum when existing Task status plus diagnostics is sufficient.
- UI work beyond PR #1888's minimal `dispatching` presentation, existing error/status surfaces, and the narrow force-fail confirmation affordance.

### 3.3 Change control

If implementation appears to require any out-of-scope item:

1. Stop implementation.
2. Record the concrete blocker and the failed simpler alternative.
3. Decide whether to reduce the claimed guarantee or create a separate follow-up.
4. Do not silently broaden this PR.

## 4. Guarantee profile

The product must not make a stronger guarantee than the runtime mode can enforce.

| Execution mode                                           | Detection                                                                 | Automatic termination                                                            | Automatic terminality/continuation                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Local Linux, same UID, live spawning daemon              | Heartbeat + SDK pulse                                                     | Start-identity-checked process-group SIGTERM/SIGKILL                             | Yes, after group absence                                      |
| Local Linux, insulated/strict UID, live spawning daemon  | Heartbeat + SDK pulse                                                     | Only through verified privileged UID-aware group signaling                       | Yes only after group absence; otherwise diagnose-only         |
| Local macOS, live spawning daemon                        | Heartbeat + SDK pulse                                                     | Conditional on a stable process start-identity adapter                           | Yes only when identity and group absence are verified         |
| Local Windows                                            | Heartbeat + SDK pulse                                                     | Existing best effort only; no Job Object guarantee                               | Diagnose-only in V1                                           |
| Templated/remote                                         | Heartbeat + SDK pulse after connection                                    | Only if an existing stop path returns verified absence; generic templates do not | Diagnose-only in V1 unless verified absence exists            |
| `claude-code-cli`                                        | Existing JSONL/process watcher                                            | Existing CLI path                                                                | Unchanged; excluded from this architecture                    |
| Any mode after daemon restart with lost process tracking | Existing startup reconciliation plus `termination_unverified` diagnostics | Not proven by this PR                                                            | Existing STOPPED/idle recovery behavior; no containment claim |

For diagnose-only outcomes:

- Store bounded `sdk_failure` evidence.
- Transition to or retain `STOPPING` when a stop has been requested.
- Keep `ready_for_prompt = false` until termination is verified or an authorized force-fail explicitly accepts the risk.
- Do not run callbacks before verified terminality or force-fail.
- Do not drain the queue before verified terminality or force-fail.
- Do not accept a late pulse as proof that a previously requested stop is safe to cancel.
- Populate the existing `error_message` surface with a bounded explanation and the force-fail recovery action.
- Allow only a branch owner/admin to explicitly force-fail the Task after acknowledging that the old workload may still be running.

The diagnose-only/fail-closed guarantee is scoped to the lifetime of the current daemon process. A daemon restart deliberately applies main's orphan reconciliation to every active Task, including remote or templated `STOPPING` Tasks: they become `STOPPED`, the session recovers under existing behavior, and diagnostics disclose that termination was never verified. Restart is therefore a coarse availability escape hatch, not containment proof.

## 5. Canonical state and data

### 5.1 Task lifecycle

PR #1888 contributes one state and one timestamp:

```text
created/queued -> dispatching -> running/awaiting_* -> stopping -> terminal
```

- `dispatching`: launch/submission persisted; authenticated executor has not connected.
- `executor_connected_at`: daemon timestamp written by the guarded connect operation.
- `running`: authenticated executor connected and may report telemetry.
- `stopping`: termination requested; terminality and queue/session release have not yet been earned.
- terminal: existing `completed | failed | stopped | timed_out` meanings.

Do not add `stalled` as a second lifecycle enum. SDK health is orthogonal evidence, not another writable status machine.

### 5.2 Minimal persisted data

Use existing Task storage plus the one PR #1888 column:

```ts
type ExecutorMode = 'local' | 'templated';

type ExecutorPulseKind = 'sdk_started' | 'progress' | 'waiting' | 'unknown_activity';

interface ExecutorPulse {
  sequence: number; // executor-local, strictly increasing for each new normalized event
  kind: ExecutorPulseKind;
  detail?: string; // bounded code/identifier, never raw provider content
  observed_at: string; // daemon-authored; changes only when sequence advances
}

type SdkFailureReason =
  | 'startup_timeout'
  | 'no_first_progress'
  | 'progress_stalled'
  | 'stream_disconnected'
  | 'unknown_activity'
  | 'heartbeat_lost'
  | 'termination_unverified';

interface SdkFailure {
  reason: SdkFailureReason;
  detected_at: string; // daemon-authored
  tool: AgenticToolName;
  last_pulse?: Pick<ExecutorPulse, 'sequence' | 'kind' | 'detail' | 'observed_at'>;
  elapsed_ms?: number;
  watchdog_action?: 'would_fire' | 'enforced';
  unknown_event_count?: number;
  sdk_version?: string; // bounded package/runtime version, never provider payload
  termination: 'not_requested' | 'requested' | 'verified' | 'unverified';
}

interface TerminationRequest {
  cause: 'user_stop' | 'startup_timeout' | 'heartbeat_lost' | 'sdk_health_failure';
  requested_at: string; // daemon-authored
  final_status: 'stopped' | 'failed';
}

interface Task {
  executor_connected_at?: string; // dedicated column from PR #1888
  last_executor_heartbeat_at?: string;
  latest_executor_pulse?: ExecutorPulse;
  sdk_failure?: SdkFailure;
  termination_request?: TerminationRequest; // bounded termination-intent fact
  executor_mode?: ExecutorMode; // immutable dispatch snapshot in Task data
  sdk_watchdog_mode?: 'disabled' | 'observe' | 'enforce'; // immutable dispatch snapshot
}
```

Names may be adjusted to existing type conventions, but the semantic fields may not multiply.

Do not persist:

- Raw SDK events.
- Arbitrary command output.
- Credentials, prompts, or provider payloads.
- An unbounded event list.
- PID/PGID as externally writable Task data.
- A parallel SDK-health status enum.

### 5.3 Process containment state

Containment identity remains internal to the live spawning daemon:

```ts
interface LocalExecutorProcess {
  sessionId: SessionID;
  taskId: TaskID;
  pid: number;
  pgid: number;
  processStartIdentity: string; // platform kernel/process identity, not wall-clock time
  startedAt: Date;
  unixUsername?: string;
}
```

The map entry remains until terminality is applied or containment is explicitly classified unverified. A process exit event does not remove evidence before the coordinator completes its decision.

This is not restart-safe. Do not infer a process from a reused PID after daemon restart.

## 6. Ownership and write paths

| Actor/path                     | Allowed responsibility                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| User/API caller                | Submit, answer, request Stop, or explicitly force-fail when authorized; never write daemon-owned telemetry/lifecycle fields directly                |
| Authenticated task executor    | Connect its exact Task, report bounded heartbeat/pulse, report an SDK stall; normal result writes remain limited to the explicit executor allowlist |
| SDK adapter                    | Translate its raw events into the common pulse callback; never patch lifecycle directly                                                             |
| Executor watchdog              | Evaluate local monotonic time and request stall handling once; never mark the Task terminal itself                                                  |
| Daemon telemetry service       | Authenticate, sanitize, stamp DB/server time, deduplicate pulse sequences, reject terminal/foreign writes                                           |
| Daemon termination coordinator | Move eligible work to `STOPPING`, contain supported local execution, verify absence, then invoke existing terminal paths                            |
| Existing Task service          | Own normal terminal side effects, callbacks, session state, and queue behavior after the coordinator authorizes terminality                         |
| Existing heartbeat supervisor  | Detect stale connected wrappers and request the same termination coordinator; never terminalize directly before containment decision                |

### 6.1 Protected fields

Generic external `tasks.patch`/`update` must reject daemon-owned fields, including at minimum:

- `status` when the caller is not an allowed existing executor/internal lifecycle path.
- `executor_connected_at`.
- `last_executor_heartbeat_at`.
- `latest_executor_pulse`.
- `sdk_failure`.
- `termination_request`.
- Health-owned `error_message` values.
- `executor_mode` after dispatch.
- `sdk_watchdog_mode` after dispatch.
- queue position and lifecycle timestamps.
- Task/session identity fields.

The validator must inspect nested JSON patches, not only top-level property names. Removing externally exposed `update` is preferred if no supported caller uses it.

### 6.2 Custom methods

Keep the method surface small:

1. `connectExecutor(taskId)` — PR #1888 guarded `dispatching -> running` transition.
2. `reportRuntimeTelemetry(taskId, { heartbeat, pulse? })` — authenticated exact-task telemetry.
3. `reportSdkHealthFailure(taskId, evidence)` — authenticated idempotent request for an observe-only would-fire diagnosis or an enforced stall/stream-disconnect outcome; daemon behavior is selected from validated mode/reason, never caller-chosen terminal fields.

Do not add one custom method per pulse kind, adapter, or failure reason.

### 6.3 Telemetry rules

- Heartbeat time is daemon-authored on each accepted heartbeat.
- Each newly normalized SDK event increments a Task-local pulse `sequence`, even when its kind/detail matches the prior event.
- The sequence is a positive safe integer scoped to the authenticated Task connection. Equal sequences are idempotent, lower sequences are stale, and higher sequences may skip because transport intentionally coalesces to the latest event.
- Pulse `observed_at` changes only when an accepted sequence is greater than the stored sequence.
- A liveness-only heartbeat never refreshes SDK progress time.
- Retries of the same sequence are accepted idempotently without rewriting progress time.
- A later meaningful event with the same kind/detail and a higher sequence does refresh progress time.
- A valid heartbeat carrying an equal/lower sequence still advances heartbeat time while the stale pulse is ignored. A malformed pulse rejects the whole telemetry request.
- Pulse sequence and daemon `observed_at` are diagnostic only. No daemon-side stall, kill, or terminality policy reads pulse recency or trusts executor-claimed sequence ordering; the watchdog's policy clock is executor-local and monotonic.
- Telemetry is rejected before connection and after terminality.
- Telemetry is rejected from the wrong Task/executor scope.
- Payload sizes and `detail` values are bounded and sanitized; `detail` is an allowlisted code/identifier capped at 128 UTF-8 bytes, never provider text.
- Telemetry failure does not grant the executor authority to patch Task state generically.

## 7. Dispatch and connection contract

Reapply PR #1888 behavior without importing the later attempt/kernel architecture.

### 7.1 Launch classification

| Launch/exit case                                        | Required behavior                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Local executor process exits while Task is executing    | Authoritative local-executor exit; request coordinator/final outcome                                          |
| Templated launcher exits nonzero before connection      | Terminal launch failure by default; block only when configuration explicitly says nonzero may follow dispatch |
| Templated launcher exits zero before connection         | Submission succeeded; remain `dispatching`; do not revoke or terminalize                                      |
| Templated launcher exits after authenticated connection | Passive launcher exit; do not rewrite Task state or revoke runtime access                                     |

The launcher process is not the remote executor. Do not track it as containment evidence after successful submission.

Token lifetime follows the same classification:

- Proven/default launch failure: revoke the task-scoped executor token.
- Local executor exit: revoke the token as part of coordinator-owned exit handling.
- Templated launcher zero exit before connection or any launcher exit after connection: do not revoke merely because the launcher exited; the remote executor still needs the token.
- Task terminality, explicit cancellation, expiry, or the configured use limit remains the ultimate token boundary.

The compatibility/default contract is:

```yaml
execution:
  executor_command_nonzero_may_have_dispatched: false
```

When `false`, nonzero-before-connect follows Max's accepted classification and main's spawn-failure behavior: terminal launch failure. Operators with an unusual fire-and-forget template that can create remote work and still exit nonzero must opt into `true`; only that explicit mode diagnoses and blocks.

### 7.2 Dispatch-connect timeout

Add a separate configuration value:

```yaml
execution:
  dispatch_connect_timeout_ms: 300000 # 5 minutes
```

- It is independent from heartbeat `stale_after_ms`.
- It applies only to `dispatching` Tasks without `executor_connected_at`.
- The daemon rechecks current Task state immediately before acting.
- A local spawn failure that proves no child was created remains immediate.
- On timeout, tracked local launch evidence is contained and verified before the existing startup-failure path runs.
- Templated mode is warning-only: remain `dispatching`, populate a bounded visible warning, and continue accepting a late authenticated connection. The warning clears on connect.
- A templated submission does not move to `STOPPING` merely because scheduling exceeded five minutes. Actual launcher failure, user Stop, heartbeat loss after connection, or SDK health failure follow their own contracts.
- `claude-code-cli` does not enter `dispatching` and is excluded.

## 8. SDK progress contract

### 8.1 One callback, not a framework

Extend the existing shared adapter callback surface with one optional pulse callback, or the smallest equivalent already compatible with every adapter:

```ts
onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
```

The callback is synchronous/in-memory and immediately updates the local watchdog clock. Each adapter calls it from the top of its raw event loop: mapped semantic events emit their normal kind, while an unrecognized discriminator emits `unknown_activity` with only a bounded event-type code. Heartbeat transport always sends the latest available pulse fact; an acknowledgement is useful for ordinary retry behavior but does not turn the pulse into an ordered event log. Do not create a second network sender or a durable event spool; only the latest diagnostic health fact is required.

### 8.2 Mapping rules

Every adapter must have an explicit mapping test. Initialization chatter must not satisfy first meaningful progress.

Raw activity and meaningful progress are distinct clocks:

- Meaningful mapped progress satisfies the first-progress policy.
- Any raw SDK event, including `unknown_activity`, refreshes the executor-local raw-activity clock.
- The enforcing watchdog fires only after both conditions hold: no first meaningful progress and total raw stream silence for the configured timeout.
- If only unknown events continue flowing past the first-progress deadline, persist one bounded `unknown_activity` diagnosis and do not abort or terminate. If that stream later becomes totally silent for a full timeout, normal silence policy may fire.
- This preserves the silent-after-context signature while failing open when an SDK vocabulary changes under an otherwise active stream.

| Adapter    | `sdk_started` / not meaningful progress                            | Meaningful `progress`                                                                                        | `waiting` / pause                         | V1 idle policy                                                                          |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Codex      | `task_started`, `turn_context`, `thread.started`, equivalent setup | Assistant/reasoning deltas, relevant item updates/completion, tool start/result, fixture-proven token events | Permission/input only when observable     | First progress only; no generic mid-turn idle timeout                                   |
| Claude SDK | `system`/`init` setup                                              | Assistant, thinking, tool start/result, other processed semantic events                                      | Permission/input request until resolution | First progress plus Claude-only 60-minute idle policy if active-tool semantics are safe |
| Gemini     | Adapter initialization                                             | Stream text/reasoning and tool events                                                                        | Observable permission/input               | First progress only in V1                                                               |
| Copilot    | Adapter initialization                                             | Stream text/reasoning and tool events                                                                        | Permission request until resolution       | First progress only in V1                                                               |
| OpenCode   | Server/session setup                                               | Semantic stream and tool events                                                                              | Observable permission/input               | First progress only in V1                                                               |

For Codex `token_count` and similar events:

- Capture representative healthy long-turn fixtures.
- Capture the observed silent-after-`turn_context` fixture.
- Count the event as progress only if it distinguishes healthy activity without making the observed stall look healthy.
- Do not decide from the event name alone.

### 8.3 Active tools and idle policy

First tool start is meaningful first progress. A generic idle watchdog must not kill a known active long-running tool merely because the tool is silent.

For Claude's optional 60-minute policy, pause while a tool is known active and resume with the preserved remaining duration after completion/error. V1 intentionally does not diagnose a silent hung tool. Do not accidentally change this behavior through timer placement.

## 9. Watchdog contract

### 9.1 Configuration

Use one small block following existing heartbeat config conventions:

```yaml
execution:
  sdk_watchdog:
    mode: observe # disabled | observe | enforce
    first_progress_timeout_ms: 180000 # 3 minutes
    abort_grace_ms: 15000 # 15 seconds
    claude_idle_timeout_ms: 3600000 # 60 minutes; null disables
```

Avoid per-adapter configuration unless behavior genuinely differs. In V1 only Claude has a post-progress idle timeout.

Waiting pauses preserve the timer's remaining duration; they do not reset it. Each accepted meaningful progress sequence resets the eligible Claude idle timer. A known active tool pauses the Claude idle timer until a matching completion/error event; V1 intentionally does not diagnose a silent hung tool.

`mode` is the only global watchdog switch:

- `disabled`: no watchdog timer or SDK-health action.
- `observe`: evaluate the exact enforcing policy and persist/log one `would_fire` or `unknown_activity` diagnosis, but never abort, request containment, change Task/session state, run callbacks, or affect queues.
- `enforce`: use the same decision function, then run the report/abort/coordinator path.

`claude_idle_timeout_ms: null` disables only Claude's post-progress rule. Non-disabled numeric thresholds and `dispatch_connect_timeout_ms` must be positive safe integers; invalid values fail configuration validation instead of silently changing policy. Watchdog values are resolved and frozen into the executor payload at dispatch. Daemon supervisor values are resolved at daemon startup and change only after restart.

Implementation and dogfood begin in `observe`. The default may change to `enforce` in this same PR only after the §13.12 soak receipt passes and the policy/mapping/defaults are unchanged for the full acceptance window. `disabled` remains the emergency rollback.

The mode controls timeout-based watchdog decisions only. Explicit SDK errors/disconnections, user Stop, heartbeat loss, and launch failure keep their existing/coordinator outcomes in every mode.

`execution.executor_heartbeat.enabled: false` disables the heartbeat/pulse transport and the daemon-side stale-wrapper backstop. It does not disable the executor-local SDK watchdog or its direct `reportSdkHealthFailure` call. This is a supported but explicitly degraded configuration: first-progress detection remains, persisted pulse diagnostics and L2 crash detection do not.

### 9.2 State

One executor-side watchdog instance exists per Task:

```text
not_started -> waiting_for_first_progress -> healthy
                       |                      |
                       +-> paused             +-> optional Claude idle check
                       |      |
                       +------+
                       |
                       +-> decision (exactly once: would_fire or enforce)
```

Use monotonic time for local elapsed calculations. Persist only daemon timestamps.

### 9.3 Fire conditions

- No first meaningful progress **and** no raw SDK event for `first_progress_timeout_ms` while not paused.
- Explicit SDK stream disconnect/error that can leave a local SDK child ambiguous uses the same stall-report/coordinator path with `stream_disconnected` diagnostics. Ordinary agent/tool-reported failures whose adapter contract confirms return and cleanup retain the existing result path.
- Claude-only idle timeout after first progress, if enabled and policy says the current state is eligible.

### 9.4 Non-fire conditions

- SDK has emitted first meaningful progress and no adapter idle policy applies.
- Task is waiting for permission/input.
- Task is already terminal or stopping for another cause.
- User Stop won the race.
- Watchdog mode is `disabled`.
- Unknown/unmapped SDK events are still arriving; record bounded `unknown_activity` once after the first-progress deadline, but do not kill an active unknown vocabulary.
- `claude-code-cli` mode.

### 9.5 Observe and enforce outcomes

In `observe`, the watchdog sends one idempotent diagnostic through `reportSdkHealthFailure` with `watchdog_action = 'would_fire'`. The daemon stamps/persists it without creating `termination_request`, changing status/session state, or invoking containment. The local Task continues normally.

In `enforce`, the watchdog:

1. Stops its timer.
2. Snapshots bounded diagnostics.
3. Starts one logical, idempotent `reportSdkHealthFailure` operation so the daemon can claim termination ownership and persist the diagnosis; transport retries use the same Task/connection/reason identity.
4. Calls `abortController.abort()` after the report is accepted or a two-second reporting deadline expires; reporting failure must not prevent local cancellation.
5. Marks the local abort cause as `sdk_health_failure`, distinct from a user-requested Stop.
6. Never patches Task terminality itself.

The base executor's normal abort-result path must recognize the `sdk_health_failure` cause and suppress its usual `STOPPED`/terminal result write. The daemon coordinator is the sole forced-terminal writer for this cause. This prevents an SDK abort from releasing the session before containment proof. Duplicate deliveries are idempotent; a lost report is eventually backstopped by stale-heartbeat detection without changing the containment rule.

## 10. Shared termination coordinator

### 10.1 One path, multiple causes

```ts
type TerminationCause = 'user_stop' | 'startup_timeout' | 'heartbeat_lost' | 'sdk_health_failure';
```

All causes use the same local containment primitive. Only their final product outcome differs.

| Cause           | Terminal status after verified absence | Queue/callback policy                                                                                                 |
| --------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| User Stop       | `STOPPED`                              | Preserve existing Stop semantics: queued work preserved, no automatic callback, no unintended drain                   |
| Startup timeout | `FAILED`                               | Preserve existing startup-failure behavior only after local absence or verified remote rejection/absence              |
| Heartbeat lost  | `FAILED`                               | Preserve existing heartbeat semantics: session promptable, queued prompts do not auto-start, existing callback policy |
| SDK stall       | `FAILED` with `sdk_failure`            | Same as heartbeat failure after absence; no queue start before proof                                                  |

The request transition stores one bounded `termination_request` in the same transaction/CAS that moves the Task to `STOPPING`. `user_stop` has precedence over health/startup causes until terminality commits, preserving explicit user intent; an authorized force-fail explicitly overrides the pending result to `FAILED`. Failure causes share the same failed outcome and retain the first canonical diagnosis. Duplicate or lower-precedence requests are idempotent.

### 10.2 Local Unix containment

For supported local execution:

1. Spawn the executor as a dedicated process-group leader (`detached: true` on Unix) while retaining managed stdio and process tracking.
2. Track Task, session, PID, PGID, a platform start identity, start time, and Unix identity in the daemon's existing process map.
3. On termination request, atomically/state-safely move eligible work to `STOPPING` without making the session promptable.
4. For `sdk_health_failure`, allow at most `abort_grace_ms` for the executor's in-process SDK abort to end the group. User Stop and heartbeat loss may begin group signaling immediately under their existing policy.
5. If the group remains present, send SIGTERM using same-UID signaling or a narrow UID-aware group-signal helper built on the repository's verified run-as-user substrate.
6. Poll for bounded graceful group absence.
7. If still present, send SIGKILL to the group.
8. Poll `kill(-pgid, 0)` or the privileged equivalent until absence (`ESRCH`) or a bounded unverified result.
9. Only after verified absence, invoke the existing terminal Task/session path with the cause-specific outcome.
10. Retain tracking until the terminal transition completes.

Before every first signal, verify that the live leader's platform start identity matches the tracked identity. Linux uses a kernel-derived identity such as `/proc/<pid>/stat` start time. A platform adapter that cannot distinguish PID reuse does not qualify for automatic terminality. After a verified signal begins, continuous group-presence checks may follow descendants when the leader exits. Any identity mismatch or discontinuity becomes `termination_unverified`; never signal a possibly unrelated group.

There is a residual TOCTOU window between identity verification and group signaling. The implementation minimizes it by keeping both operations adjacent and failing closed on any mismatch, but V1 does not claim a race-free kernel process handle. Linux `pidfd_send_signal` (and a group-capable equivalent such as cgroup signaling) is future hardening, not required machinery for this scoped PR.

Agor currently documents a single daemon replica. The persisted request lets that daemon's existing supervisor reconcile `STOPPING` Tasks it owns in its process map; no cross-replica owner routing, daemon lease, or replica handoff is added.

In insulated/strict mode the detached process-group leader may be the `sudo` wrapper while the executor and SDK descendants run under another UID. Track and identity-check the actual wrapper leader, then signal the entire cross-UID group only through the verified UID-aware helper. If Phase 0 cannot prove that helper and its sudoers contract safely signal and inspect the full group, insulated/strict automatic containment is diagnose-only in V1; simple-mode containment may still ship.

`EPERM` means **present but unprovable**, not absent. Unsupported platform behavior is diagnose-only.

The implementation must test descendants in the same process group. Descendants that intentionally escape the group are outside V1 containment and must not be silently claimed contained.

### 10.3 Stale heartbeat behavior

Refactor `failForLostHeartbeat` so the supervisor requests termination instead of immediately marking the Task/session failed.

- Tracked supported local execution: contain -> verify -> fail.
- Untracked, unsupported, or remote execution: record heartbeat-loss diagnostics, move/retain `STOPPING`, keep session blocked.
- Recheck Task state and heartbeat timestamp immediately before requesting termination.
- A fresh heartbeat that wins before the stopping transition cancels the stale decision.
- A heartbeat after stopping begins does not automatically revoke the stop request.

This fixes the live-daemon local fail-open path. It does not claim restart-safe containment.

### 10.4 Daemon restart behavior

Restart reconciliation remains the behavior on main:

- Startup marks orphaned active Tasks `STOPPED`.
- Existing session recovery returns the session to its current idle/promptable behavior and preserves its current queue-cleanup policy.
- The stopped Task receives bounded `termination_unverified` diagnostics and an actionable `error_message`; this is honest disclosure, not containment proof.
- Graceful daemon shutdown best-effort contains tracked process groups before exit to reduce surviving-orphan risk.
- Abrupt daemon death can still lose process tracking and release logical state without proving child absence. This is an explicitly retained limitation of the scoped PR.

Fail-closed restart reconciliation would be a separate, explicit product/configuration decision. It is not enabled or implemented by this PR.

### 10.5 Authorized force-fail escape hatch

Every diagnose-only `STOPPING` state must be operable:

- Extend the existing session Stop/action surface with `force_unverified: true`; do not add a fourth Task lifecycle service.
- Only a branch owner or administrator may invoke it for the exact active Task.
- Server-side eligibility requires `STOPPING` plus canonical unverified-termination evidence; the action cannot force-fail a healthy, merely slow, or ordinarily running Task.
- Require an explicit confirmation containing the Task ID. The confirmation copy is: “Agor could not verify that this executor stopped. It may still be running and writing to the branch. Force-fail Task `<short-id>` anyway?” The user must type the short Task ID.
- Emit the existing structured security/audit log (no new audit table), set `sdk_failure.termination = 'unverified'`, retain the original diagnosis, override the pending final outcome to `FAILED`, populate bounded `error_message`, and finalize through the existing `FAILED` terminal path.
- The action is never automatic. Ordinary Stop continues attempting verified containment first.
- Apply the existing failure callback/session/queue policy exactly once; do not create a special force-release lifecycle.

The existing Stop UI/CLI affordance must expose this confirmation only when the daemon reports `termination_unverified`. This is the promised operator action and the explicit availability-over-safety choice.

### 10.6 Remote/templated execution

Generic command templates do not prove remote absence.

- Successful launcher exit is passive.
- Connected remote heartbeat/pulses are accepted.
- On SDK stall or heartbeat loss, store diagnostics and request `STOPPING`.
- Do not mark terminal, promptable, or drain queues without a stop operation that returns verified absence or an authorized explicit force-fail.
- Existing configured stop behavior may be used only if its documented contract is strong enough and is tested live; otherwise V1 remains diagnose-only.
- Populate `error_message` with the exact branch-owner/admin force-fail recovery instruction.
- State explicitly in the warning that a daemon restart will apply main's orphan cleanup and release the logical session without proving remote termination.

## 11. DRY, KISS, ponytail, and LoC controls

### 11.1 Hard implementation rules

- One canonical heartbeat/pulse transport.
- One protected telemetry service method.
- One adapter pulse callback.
- One watchdog implementation.
- One local termination coordinator.
- One process-group kill/verify helper.
- One source of daemon timestamps.
- One existing terminal side-effect path after containment or explicit authorized force-fail.
- No duplicated adapter watchdogs.
- No duplicated Stop, startup-timeout, heartbeat-loss, and SDK-stall kill implementations.
- No framework whose only consumer is this feature.
- No abstraction introduced before two real call sites require it, except the shared containment primitive with four known callers.
- Prefer pure functions for pulse normalization, policy decisions, and process-result classification.
- Prefer discriminated unions over boolean combinations.
- Prefer deleting/replacing old code over wrapping and retaining it.
- Replacement and deletion are one atomic change: the phase/commit that lands a replacement must delete its superseded path before its gate can pass.
- No dual-path compatibility period. Daemon and executor deploy from the same release, so old and new telemetry, containment, exit, or watchdog mechanisms never intentionally ship together.
- Phase 6 may verify contraction but may not defer required deletion from an earlier phase.

### 11.2 LoC budget

Record exact baseline and final counts with the same command/method. Generated migration metadata, product source, tests, and docs are reported separately.

Targets, not excuses:

| Category                               |                                                                                                                  Target |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------: |
| Reapplied PR #1888 product source      | Measured/reported separately; historical diff was +1,209/-74 across 40 files, adapted diff must not grow without reason |
| New product source beyond PR #1888     |                                                                                                           <= +1,200 net |
| Total product-source net change        |                                                                                                           <= +2,500 net |
| New production modules beyond PR #1888 |                                                                                                      <= 3 focused files |
| New custom Task methods                |                                                                                <= 3 total including PR #1888 connection |
| New database tables                    |                                                                                                                       0 |
| New dedicated columns                  |                                                                                             1 (`executor_connected_at`) |
| New persisted JSON aggregates          |          3 bounded facts (`latest_executor_pulse`, `sdk_failure`, `termination_request`) plus two scalar mode snapshots |
| New Task lifecycle statuses            |                                                                                         1 from PR #1888 (`dispatching`) |
| New timers per active executor         |                                                                            1 watchdog plus the existing heartbeat timer |
| Test/source ratio for complex logic    |                                                                                          2-3x; >4x requires refactoring |

If new product source beyond the adapted PR #1888 diff exceeds +1,200 net or the total exceeds +2,500 net:

1. List the five largest additions.
2. Identify duplicated old paths that should have been deleted.
3. Explain why each excess block is necessary to a frozen invariant.
4. Obtain explicit review before expanding the budget.

Per-phase net ceilings for new product source beyond the adapted PR #1888 bucket:

| Phase   | Net ceiling | Required accounting                                                                                         |
| ------- | ----------: | ----------------------------------------------------------------------------------------------------------- |
| Phase 0 |           0 | Baseline and deletion-credit measurement only                                                               |
| Phase 1 |        +150 | Handoff/classification additions minus same-commit launcher/token-path deletion                             |
| Phase 2 |        +150 | Guarded telemetry additions minus generic heartbeat patch deletion                                          |
| Phase 3 |        +250 | Adapter mappings and latest-fact pulse transport                                                            |
| Phase 4 |        +450 | Coordinator/containment/timeout/force-fail additions minus all replaced Stop, heartbeat, and `onExit` paths |
| Phase 5 |        +200 | Watchdog additions minus Claude's superseded idle implementation                                            |
| Phase 6 |        <= 0 | Verification only; no deferred production mechanism or cleanup                                              |

Each phase gate checks gross added, deleted, and net source lines before the next phase begins. Deletion credit counts only when the old executable path and its obsolete tests are actually removed; planned deletion cannot subsidize current additions. Moving budget between phases requires updating this plan and reviewing the affected invariant before implementation continues.

The largest LoC savings are scope already removed, not compressed implementations: main-compatible restart recovery instead of fail-closed reconciliation, status-quo launcher failure plus warning-only templated timeout, no PostgreSQL replica ownership machinery, and diagnose-only insulated/strict fallback when group signaling is not already supportable. Do not reintroduce those subsystems to make a stronger-looking guarantee.

### 11.3 Deletion targets bound to replacements

- **Phase 1:** Delete duplicate launcher-exit assumptions that conflate templated launchers with remote executors, plus unconditional executor-token revocation on passive templated launcher exit, in the same commit as classification.
- **Phase 2:** Delete the generic executor heartbeat sender through `tasks.patch` in the same commit that lands `reportRuntimeTelemetry`. No release contains both transports.
- **Phase 3:** Delete any temporary adapter-specific pulse sender in the same commit that moves its adapter to the common callback.
- **Phase 4:** Delete direct stale-heartbeat terminalization, the single-PID-only local Stop implementation, the direct Task/session terminal patch in `register-services.ts`'s executor `onExit` safety net, and `onExit` untracking before verification in the same commit that lands coordinator/group containment.
- **Phase 5:** Delete Claude's loop-internal idle timeout in the same commit that proves and lands its independent-watchdog replacement. If equivalence is not proven, Claude's new idle policy does not ship; the two policies do not coexist.
- **Phase 6:** Delete nothing that should have been removed above; use reference searches and whole-diff inspection to prove every registered superseded path is already absent.

### 11.4 Per-commit ledger

Each implementation commit records its phase ceiling and measured deletion credit:

| Category         | Baseline/deletion target | Added | Deleted | Net | Phase ceiling | Why unavoidable |
| ---------------- | -----------------------: | ----: | ------: | --: | ------------: | --------------- |
| Product source   |                          |       |         |     |               |                 |
| Tests            |                          |       |         |     |               |                 |
| Schema/migration |                          |       |         |     |               |                 |
| Docs             |                          |       |         |     |               |                 |

The final PR description includes the cumulative ledger and names every old path deleted.

## 12. Implementation plan

### Phase 0 — Review alignment and baseline

**Before code:**

- Draft a concise comment for PR #1926; post only after user approval.
- State that protected-field and launcher-classification findings move into this PR.
- State that durable queue-drain and attempt-snapshot findings remain attached to the archived lifecycle architecture/follow-ups.
- Preserve reviewed head `435049c6` and current v3 as references; do not implement from either wholesale.
- Create one new branch from current `main` after user approval.
- Record current migrations, focused test baseline, changed-path baseline, and LoC baseline.
- Record the adapted PR #1888 bucket separately from new SDK-health/containment code; do not hide either in generated migration output.
- Measure the exact executable/test line ranges for every §11.3 deletion target: generic heartbeat patch sender, launcher/token exit branches, single-PID Stop, stale-heartbeat terminalization, `onExit` terminal/untrack safety net, and Claude idle check. These are baseline credits, not promises.
- Inventory supported SDK adapter raw event types using code and real fixtures.
- Record a small reviewed SDK-version manifest for every mapped adapter. A resolved SDK dependency/version change must fail the mapping-freshness test until fixtures and mappings are re-ratified; do not infer compatibility from semver alone.
- Measure first-connect and first-meaningful-progress timing distributions from healthy local, extended-thinking, and available templated runs. Ratify the 5-minute/3-minute defaults against those receipts rather than intuition; retain configuration overrides as the operational pressure valve.
- Confirm the supported daemon topology from user documentation (currently one daemon replica); do not design replica ownership machinery without a supported deployment.
- Prove whether the shipped sudoers/run-as-user configuration can signal a negative process group as the executor identity. Main currently has no group-kill/absence helper; if the shipped sudoers contract is insufficient, Phase 4 must update the sudoers file, setup guide, validation, and operator upgrade note.
- Trace task-scoped token revocation for local and templated launch/exit cases. Main currently revokes in `onExit`; the implementation must preserve remote access after passive launcher exit while still revoking proven failures and terminal local execution.

**Gate:** reviewer/product alignment on the scope and guarantee table, plus an agreed timing-measurement protocol; no code yet.

### Phase 1 — Protected handoff and dispatch

**Implement atomically:**

- Reapply PR #1888 Task status, timestamp, migration, API/client/UI contract.
- Guard the authenticated `connectExecutor` transition.
- Snapshot `executor_mode` at dispatch.
- Classify local versus templated launcher exit.
- Classify token revocation with the same launch/exit decision; passive templated launcher exit cannot revoke remote runtime access.
- Delete the superseded launcher/token-exit branches in this same change; no dual classification remains.
- Add the explicit nonzero-may-have-dispatched template configuration, defaulting to `false`.
- Protect all newly daemon-owned fields from generic external writes.

**Do not add:** attempts, runtimes, release barriers, or new queue ownership.

**Gate:** all handoff, launcher, auth, and migration scenarios pass for both database dialects; Phase 1 net-new source is within +150 beyond the separately measured PR #1888 bucket; required Phase 1 deletions are present. No timeout path depends on not-yet-built containment.

### Phase 2 — Guarded runtime telemetry

**Implement:**

- `reportRuntimeTelemetry` custom method.
- Move the existing heartbeat sender off generic patch and delete the generic-patch sender in the same commit.
- Daemon timestamp ownership.
- Terminal/pre-connect/wrong-scope rejection.
- Sequence-advance pulse timestamp semantics, initially with a test pulse/double.
- External patch allowlist/denylist tests.

**Gate:** no production heartbeat uses generic patch, no dual transport exists, forged lifecycle/telemetry writes fail, and Phase 2 net source is within +150.

### Phase 3 — Semantic SDK pulses

**Implement:**

- One optional shared pulse callback.
- Per-adapter mappings and fixtures.
- Mapping-freshness assertion against the reviewed SDK-version manifest.
- Heartbeat coalescing that always transports the latest pulse fact.
- Permission/input waiting and resume signals where observable.
- Bounded detail sanitization.
- Delete any temporary adapter-specific sender as each adapter moves to the shared callback.

**Gate:** the observed Codex `turn_context` stall emits no meaningful progress; healthy fixtures for every adapter emit at least one meaningful pulse without excessive writes; unknown-but-active vocabulary does not enforce; the version-manifest freshness test passes; healthy timing receipts support the 3-minute first-progress default or the default is adjusted before Phase 4; no adapter-specific transport remains; Phase 3 net source is within +250.

### Phase 4 — Shared local containment

**Implement:**

- Unix process-group spawn and tracking.
- Same-UID signaling plus a verified narrow UID-aware group-signal helper using existing run-as-user facilities.
- Bounded SIGTERM/SIGKILL and absence verification.
- Cause-neutral termination coordinator.
- Persisted `termination_request` plus owner-local `STOPPING` reconciliation in the supported single-daemon topology.
- Wire user Stop and stale heartbeat through it.
- Add local enforced dispatch-connect timeout and templated warning-only timeout now that containment exists.
- Add the authorized force-fail extension to the existing Stop surface.
- Preserve main's restart reconciliation while attaching `termination_unverified` diagnostics and best-effort graceful-shutdown containment.
- Add/update the narrow UID-aware group-signal helper, sudoers/setup documentation, and upgrade validation if Phase 0 proves they are required.
- Diagnose-only behavior for unsupported/untracked/remote modes.
- In the same containment commit, delete the single-PID Stop path, direct stale-heartbeat failure, executor-`onExit` direct terminal patch, and premature `onExit` untracking.

**Gate:** live-daemon supported local forced termination does not become terminal/promptable before process-group absence; local/template timeout scenarios pass; healthy connect timings support the 5-minute local default; force-fail is owner/admin-only and explicit; restart behavior matches main plus diagnostics; every Phase 4 superseded path is absent; Phase 4 net source is within +450.

### Phase 5 — SDK watchdog

**Implement:**

- Independent first-progress timer.
- Separate raw-activity and meaningful-progress clocks with unknown-active fail-open policy.
- One pure timeout decision function shared by `observe` and `enforce`; mode changes only the action after the decision.
- Observe-only diagnostic branch with no abort, containment, or lifecycle side effect.
- Permission/input pause/resume.
- One-shot, idempotently retryable stall report.
- Bounded graceful SDK abort request.
- Cause-aware abort handling that cannot emit a premature `STOPPED` result.
- Daemon coordinator integration.
- Claude-only idle policy and same-commit deletion of its superseded loop-internal check if equivalence is proven; otherwise the new Claude idle policy does not land.
- Explicit `claude-code-cli` exclusion.

**Gate:** the #1541 silent-after-context failure signature becomes actionable in controlled tests; this does not claim reproduction or diagnosis of the underlying SDK bug. Observe/enforce share identical decisions, observe has zero process/lifecycle side effects, unknown-but-active streams fail open, supported enforced local execution terminates safely and becomes promptable, remote/unprovable execution is visible and remains blocked, Claude has exactly one idle policy, and Phase 5 net source is within +200.

### Phase 6 — Contraction proof, full QA, and whole-diff review

- Run reference searches proving all §11.3 paths were deleted in their owning phases; Phase 6 is not a cleanup implementation phase.
- Run focused tests first, then required full package suites and typechecks.
- Run live containment and real-adapter QA.
- Complete the §13.12 macOS/real-workload observe-only soak and concurrent telemetry load receipt.
- Change the default from `observe` to `enforce` only if the soak acceptance bar passes; rerun config, watchdog, and focused end-to-end gates after that one-line policy flip.
- Review final diff for duplicated state, timers, kill paths, telemetry paths, and policy code.
- Complete LoC ledger.
- Refresh PR body from the final diff and evidence.

**Gate:** every required matrix row passes, the §13.12 soak has zero unjustified would-fire events across its full window, telemetry load stays bounded, mapping freshness passes, no unresolved P0/P1 finding remains, no superseded production path exists, Phase 6 product-source net is <= 0, and all per-phase/cumulative LoC budgets are met or explicitly approved.

## 13. QA strategy

The goal is high confidence through contract coverage, deterministic race tests, real process containment, both database dialects, and representative live SDK runs. Do not create a literal Cartesian product of every input; cover every legal transition and every distinct failure boundary, then combine the highest-risk dimensions.

### 13.1 Test principles

- Co-locate Vitest files with source.
- Use fake clocks and explicit barriers; do not depend on timing sleeps for race correctness.
- Use a real helper process tree for containment tests; do not mock `process.kill` as the only evidence.
- Test behavior/contracts, not third-party implementation details.
- Keep fixtures inline unless shared by multiple files.
- Use typed mocks; no `as any`, `@ts-ignore`, or loose lifecycle fixtures.
- Cover matrix rows with table-driven tests grouped by contract/failure boundary; do not create one bespoke test function/file per row.
- Keep complex-logic tests within the §11.2 2-3x source ratio. If tests exceed 4x, refactor the source/test seams instead of duplicating setup and assertions.
- Delete obsolete tests in the same commit as their superseded production path; do not retain dual-path fixtures for compatibility that the release does not support.
- Run SQLite and PostgreSQL for persistence/transition rules.
- Test Linux start identity/process groups live; macOS must prove its identity adapter or its diagnose-only fallback; Windows follows diagnose-only contract tests.
- Record exact command, revision, topology, repetitions, and result in the QA receipt.

### 13.2 Task handoff and dispatch matrix

| Scenario                                                | Expected outcome                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Idle session submits local SDK task                     | Task enters `dispatching`, then guarded connect moves it to `running`       |
| Busy session receives another prompt                    | Existing Task queue behavior unchanged                                      |
| Queue head is launched                                  | Queue semantics unchanged; new Task passes through `dispatching`            |
| Correct executor connects once                          | `running`, one daemon `executor_connected_at`                               |
| Correct executor reconnects idempotently                | Same Task/timestamp; no duplicate side effects                              |
| Wrong Task-scoped executor connects                     | Rejected                                                                    |
| User/session token calls connect                        | Rejected                                                                    |
| Connect arrives after terminality                       | Rejected; terminal Task unchanged                                           |
| Connect races user Stop                                 | Exactly one valid outcome; stopped Task cannot be revived                   |
| User Stop before local spawn begins                     | Stop commits safely and the launch cannot start later                       |
| User Stop after local spawn but before connect          | `STOPPING`; contain/verify tracked group, then `STOPPED`                    |
| User Stop during ambiguous templated submission         | `STOPPING`; blocked pending verification or explicit owner/admin force-fail |
| Local spawn fails before connect                        | Task fails through existing startup-failure path                            |
| Default templated launcher exits nonzero before connect | Terminal launch failure; token/task handled once                            |
| Opt-in may-have-dispatched template exits nonzero       | Submission diagnosis; blocked pending verification or force-fail            |
| Templated launcher exits zero before connect            | Task remains `dispatching`; remote token remains valid                      |
| Templated launcher exits after connect                  | Passive; Task remains running                                               |
| Local executor leader exits while descendant remains    | `onExit` requests coordinator; no direct terminal patch/untrack             |
| Default/proven launch failure                           | Task-scoped executor token revoked                                          |
| Passive templated launcher exit                         | Token remains valid for remote executor                                     |
| Tracked local `dispatching` exceeds connect timeout     | Contain and verify, then fail startup; no forever-busy silent state         |
| Templated submission exceeds connect timeout            | Remains `dispatching`, visible warning only; late connect remains valid     |
| Templated executor connects after timeout warning       | Guarded connect succeeds and clears the warning                             |
| Connect arrives exactly as timeout is claimed           | Recheck/CAS chooses one result; connected Task is not incorrectly failed    |
| `claude-code-cli` prompt                                | Does not enter executor `dispatching`; existing CLI behavior unchanged      |

### 13.3 Authorization and telemetry matrix

| Scenario                                                | Expected outcome                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| External user patches heartbeat                         | Rejected                                                             |
| External user patches pulse or SDK failure              | Rejected                                                             |
| External user patches connection time/mode              | Rejected                                                             |
| External user patches protected status/queue timestamps | Rejected according to explicit allowlist                             |
| Non-owner/non-admin requests force-fail                 | Rejected                                                             |
| Owner/admin force-fail omits/wrongs Task confirmation   | Rejected; Task remains nonterminal                                   |
| Owner/admin force-fails healthy/non-eligible Task       | Rejected; force is not a general terminal override                   |
| Owner/admin confirms exact unverified Task              | Audited existing `FAILED` path; diagnosis retained                   |
| Force-fail confirmation is replayed after terminality   | Idempotent/no second terminal, callback, or queue action             |
| Executor token patches another Task                     | Rejected                                                             |
| Executor reports telemetry before connect               | Rejected                                                             |
| Connected executor reports heartbeat                    | Heartbeat receives daemon timestamp                                  |
| Connected executor reports a higher pulse sequence      | Pulse gets daemon `observed_at`                                      |
| Connected executor retries the same sequence            | Heartbeat advances; pulse `observed_at` does not                     |
| New same-kind/detail event has a higher sequence        | Pulse `observed_at` advances once                                    |
| Connected executor reports a lower sequence             | Heartbeat advances; stale pulse is ignored                           |
| Coalescing skips intermediate sequences                 | Highest sequence/latest fact accepted; no event-history guarantee    |
| Liveness heartbeat without pulse                        | Does not refresh SDK progress time                                   |
| Telemetry arrives after terminality                     | Rejected/no mutation                                                 |
| Telemetry races terminal commit                         | Exactly one ordered result; terminal row has no later pulse mutation |
| Oversized/malformed pulse detail                        | Rejected or bounded deterministically                                |
| Pulse contains prompt/secret-like content               | Mapping/sanitizer stores no raw content                              |
| Two telemetry requests race                             | Monotonic heartbeat, highest canonical pulse sequence                |

### 13.4 Adapter mapping matrix

For every adapter, maintain fixtures for initialization, healthy progress, tool use, waiting, completion, explicit failure, and malformed/unexpected events.

| Adapter/scenario                                                  | Expected pulse behavior                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Codex `task_started`/`turn_context` only                          | `sdk_started` at most; no meaningful first progress                  |
| Codex assistant/reasoning item activity                           | `progress`                                                           |
| Codex tool start/result                                           | `progress`, bounded tool/detail identifier                           |
| Codex representative healthy long generation                      | Fixture-selected events prevent false first-progress stall           |
| Codex controlled silent-after-`turn_context` signature            | Watchdog decision fires; no claim about reproducing the root cause   |
| Codex explicit stream disconnect with ambiguous child             | Coordinator containment before failure; no duplicate terminal report |
| Ordinary adapter-reported failure with confirmed cleanup          | Existing failure path; no health-failure reclassification            |
| Claude init/system only                                           | No meaningful first progress                                         |
| Claude assistant/thinking/tool event                              | `progress`                                                           |
| Claude permission request/resolution                              | pause then resume without false stall                                |
| Claude long silent policy boundary                                | Exact configured policy; no accidental loop-dependent behavior       |
| Gemini healthy text/tool stream                                   | At least one meaningful `progress`                                   |
| Gemini initialization-only silence                                | First-progress watchdog fires                                        |
| Copilot healthy text/tool stream                                  | `progress`                                                           |
| Copilot permission wait                                           | pause/resume                                                         |
| OpenCode healthy semantic stream/tool event                       | `progress`                                                           |
| Unknown event among healthy mapped progress                       | Bounded `unknown_activity`; mapped progress still governs health     |
| Healthy stream containing only unknown events                     | No enforcing fire while events flow; one bounded diagnosis           |
| Unknown-only stream later becomes totally silent                  | Silence policy may fire after a full timeout from last raw event     |
| SDK dependency version changes without refreshed fixture manifest | Mapping-freshness test fails loudly                                  |

### 13.5 Watchdog timing and race matrix

Use fake timers and explicit synchronization hooks.

| Scenario                                                        | Expected outcome                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| First progress well before deadline                             | Watchdog disarms first-progress rule                                                                        |
| First progress at the deadline boundary                         | Deterministic ordering; never double-fire                                                                   |
| No first progress                                               | One stall report with correct elapsed/reason                                                                |
| Watchdog mode `disabled`                                        | No timer/action; heartbeat unchanged                                                                        |
| Observe mode reaches a would-fire boundary                      | One persisted/logged `would_fire`; no abort, containment, Task/session/queue/callback mutation              |
| Enforce mode reaches the same boundary                          | Same decision evidence, then one report/abort/coordinator action                                            |
| Unknown events flow past first-progress deadline                | One `unknown_activity` diagnosis; no abort while raw activity continues                                     |
| Invalid/zero/negative configuration                             | Configuration validation fails; no silent policy reinterpretation                                           |
| Permission begins before deadline                               | Timer pauses                                                                                                |
| Permission resolves                                             | Timer resumes with its preserved remaining duration                                                         |
| Permission times out                                            | Existing permission outcome wins; no duplicate watchdog terminality                                         |
| User Stop races watchdog                                        | One termination cause wins; final status follows winner policy                                              |
| SDK completes as watchdog fires                                 | Completion or stall wins once; no terminal rewrite                                                          |
| SDK abort returns a normal `stopped` result after watchdog fire | Result is suppressed for the `sdk_health_failure` abort cause; coordinator alone decides forced terminality |
| Heartbeat becomes stale as SDK watchdog fires                   | One coordinator request; no duplicate kill/terminal side effects                                            |
| Duplicate stall reports                                         | Idempotent; one containment run                                                                             |
| Late progress after `STOPPING`                                  | Does not cancel requested termination automatically                                                         |
| Claude idle just below/above threshold                          | Exact configured behavior                                                                                   |
| Known active tool under Claude policy                           | Idle timer pauses and resumes with preserved duration after completion/error                                |
| Watchdog timer cleaned after every terminal outcome             | No leaked timer or later action                                                                             |

### 13.6 Local process containment matrix

Use a purpose-built test helper capable of spawning a leader, descendants, SIGTERM handlers, SIGTERM-ignoring children, delayed exit, and sentinel file writes.

| Scenario                                            | Expected outcome                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Same-UID group exits on SIGTERM                     | Absence verified; no SIGKILL; terminality follows                                      |
| Leader exits but descendant remains                 | Group remains present; no terminality until descendant gone/killed                     |
| Descendant ignores SIGTERM                          | SIGKILL group; absence verified                                                        |
| Entire group already absent                         | `ESRCH` treated as absence; idempotent outcome                                         |
| Signal returns `EPERM`                              | Unverified; Task remains blocked and visible                                           |
| Untracked local Task                                | No guessed PID; diagnose-only                                                          |
| PID exists but belongs to different start identity  | Never signal it; diagnose-only                                                         |
| Start identity cannot be read reliably              | No automatic signal/terminal claim; diagnose-only                                      |
| User Stop                                           | Same shared primitive; final `STOPPED` only after absence                              |
| Heartbeat loss                                      | Same shared primitive; final `FAILED` only after absence                               |
| SDK stall                                           | Same shared primitive; final `FAILED` only after absence                               |
| Concurrent Stop and heartbeat loss                  | One containment operation; deterministic cause/outcome policy                          |
| Concurrent Stop and SDK stall                       | One containment operation; user intent precedence documented/tested                    |
| SIGKILL sent                                        | Coordinator waits for verified absence, not signal-send success                        |
| Absence proven, terminal patch transiently fails    | Tracking/evidence retained; retry terminalization without re-killing unrelated process |
| Terminal patch commits                              | Tracking removed exactly once                                                          |
| Supported insulated/strict execution                | Privileged signal runs as authorized identity and proves absence                       |
| Insulated spawn uses `sudo` wrapper as group leader | Track/check wrapper identity; signal cross-UID group through verified helper           |
| Insulated group helper/sudoers unavailable          | Diagnose-only V1; no false automatic-containment claim                                 |
| Unsupported Windows/local mode                      | Diagnose-only; no false absence claim                                                  |
| Identity changes between pre-check and signal       | Residual TOCTOU exercised where possible; mismatch never counts as verified absence    |
| Authorized force-fail after unverified containment  | Audited `FAILED`; no further signal or absence claim                                   |

### 13.7 Queue, session, callback, and outcome matrix

| Scenario                                                | Expected outcome                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Normal completion with queued successor                 | Existing automatic queue drain unchanged                                                      |
| Normal failure with queued successor                    | Existing normal failure policy unchanged                                                      |
| User Stop with queued tasks                             | Queued tasks preserved; existing Stop no-auto-drain behavior unchanged                        |
| User Stop while awaiting permission/input               | Waiting resolves/cancels normally; containment still gates `STOPPED`                          |
| Repeated User Stop                                      | Idempotent request and one containment operation                                              |
| User Stop races normal completion                       | One terminal winner; no rewrite, duplicate callback, or queue action                          |
| User Stop in one session on a shared branch             | Does not signal another session's tracked process group                                       |
| Local heartbeat loss with queued tasks                  | No queue start before absence; after failure preserve existing heartbeat no-auto-drain policy |
| Local SDK stall with queued tasks                       | Same as heartbeat failure; session becomes promptable only after absence                      |
| Remote/unverified heartbeat loss with queue             | `STOPPING`/diagnostic; session not promptable; queue does not drain                           |
| Remote/unverified SDK stall with queue                  | Same fail-closed behavior                                                                     |
| Owner/admin force-fails remote/unverified Task          | Existing failed outcome runs once; queue/callback behavior matches ordinary failure           |
| Stop with no active Task                                | Existing session reset behavior unchanged                                                     |
| Stall/failure in child session with completion callback | Callback only after verified local terminality and according to existing failure policy       |
| Remote diagnose-only child session                      | No completion callback before terminality                                                     |
| Duplicate coordinator completion                        | One task/session transition, callback, and queue decision                                     |
| New prompt after verified local health failure          | Accepted according to existing promptable session policy                                      |
| New prompt while remote/unverified stopping             | Queued/rejected according to current busy-session policy; never starts concurrently           |

### 13.8 Heartbeat supervisor matrix

| Scenario                                                 | Expected outcome                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Fresh heartbeat                                          | No action                                                                                         |
| Stale snapshot but fresh re-read                         | No action                                                                                         |
| Stale tracked local Task                                 | Coordinator contains and verifies before failure                                                  |
| Stale untracked local Task                               | Visible `termination_unverified`; no promptable transition                                        |
| Stale templated/remote Task                              | Diagnose-only unless verified stop capability exists                                              |
| Task terminal before supervisor action                   | No containment or mutation                                                                        |
| Task changes from running to awaiting permission         | Heartbeat remains valid; SDK watchdog paused                                                      |
| Multiple supervisor ticks                                | Idempotent coordinator request                                                                    |
| Supported single daemon reconciles owned `STOPPING` Task | Supervisor finds its tracked Task and resumes containment                                         |
| Daemon restarts and loses process tracking               | Existing orphan Task becomes `STOPPED`; session recovery is unchanged; diagnostics say unverified |
| Remote diagnose-only Task is `STOPPING` at restart       | Main orphan cleanup releases logical Task/session and records unverified warning                  |

### 13.9 Migration and configuration matrix

| Scenario                                                | Expected outcome                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fresh SQLite                                            | New column/status accepted; schema initializes                                       |
| SQLite upgrade from current main                        | Additive migration preserves Tasks                                                   |
| Fresh PostgreSQL                                        | Equivalent schema and constraints                                                    |
| PostgreSQL upgrade from current main                    | Additive migration preserves Tasks/RLS behavior                                      |
| Rollback binary reads additive schema                   | Documented compatible behavior or explicit rollback requirement                      |
| Missing watchdog config                                 | Uses the Phase 6-approved final mode/defaults                                        |
| Watchdog mode `disabled`                                | Existing heartbeat-only behavior                                                     |
| Watchdog mode `observe`                                 | Would-fire diagnostics only; no lifecycle/process action                             |
| Watchdog mode `enforce`                                 | Same decision function plus containment workflow                                     |
| Invalid watchdog mode                                   | Configuration validation fails                                                       |
| Executor reports enforcement contrary to Task mode      | Daemon rejects/downgrades to immutable dispatch snapshot; caller cannot escalate     |
| Heartbeat disabled, watchdog non-disabled               | Local watchdog/direct diagnosis works; pulse transport and L2 backstop absent        |
| Dispatch timeout differs from heartbeat stale threshold | Each policy acts only on its intended state                                          |
| Default template nonzero policy                         | Nonzero-before-connect is terminal launch failure                                    |
| Opt-in template may-have-dispatched policy              | Nonzero-before-connect diagnoses/blocks                                              |
| Templated connect timeout                               | Warning-only; `dispatching` and late connection remain valid                         |
| Config passed to local/templated executor               | Only necessary non-secret values included                                            |
| Config hot/restart behavior                             | Watchdog snapshots at dispatch; daemon policies change only on daemon restart        |
| Healthy timing receipts                                 | Defaults exceed observed healthy connect/first-progress tails with documented margin |

### 13.10 Fault-injection matrix

Prefer named hooks/barriers in tests over probabilistic sleeps.

| Fault boundary                                             | Required result                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Task committed `dispatching`, daemon fails around spawn    | Main's restart reconciliation occurs; orphan stop records unverified diagnostics                  |
| Launcher succeeds, daemon misses launcher response         | Reconciliation/timeout does not classify launcher exit as remote exit                             |
| Passive launcher exits before remote executor connects     | Task stays `dispatching` and task-scoped token remains usable                                     |
| Executor connects, response is lost                        | Idempotent reconnect returns same connection fact                                                 |
| Heartbeat/pulse commits, acknowledgement lost              | Same-sequence retry is safe and does not refresh pulse time                                       |
| Watchdog fires before stall report reaches daemon          | Retry/report or heartbeat path remains safe; no executor-side terminal patch                      |
| Stall report accepted before SIGTERM                       | Task remains nonterminal/blocked                                                                  |
| SDK abort returns before coordinator containment completes | No `STOPPED`/terminal patch; Task remains `STOPPING` until absence proof                          |
| Local leader `onExit` fires while descendant still writes  | No direct terminal patch/untrack; coordinator contains descendant first                           |
| Daemon stops after SIGTERM before verification             | Within live-process tests, restart limitation is explicit; no test manufactures absence           |
| Replacement daemon sees a surviving detached sentinel      | Retained restart limitation is explicit; Task follows existing STOPPED/idle recovery with warning |
| Remote unverified Task is blocked when daemon restarts     | Main orphan cleanup releases it; diagnostics say remote termination was not proven                |
| Group disappears before SIGKILL                            | Absence wins; no unnecessary signal to reused identity                                            |
| Group absent, daemon fails before terminal patch           | Retry terminal patch using retained live-daemon evidence                                          |
| Terminal patch commits before response                     | Idempotent retry does not duplicate callbacks/queue actions                                       |
| User Stop arrives during SDK abort grace                   | One coordinator/cause policy                                                                      |
| Health failure enters `STOPPING`, then user Stop arrives   | User-stop precedence persists; verified final status is `STOPPED`                                 |
| Force-fail races successful absence verification           | One terminal transition and one callback/queue decision                                           |
| Permission resolves during watchdog fire                   | Deterministic winner; no double transition                                                        |

### 13.11 Live QA matrix

Run on disposable branches/worktrees and isolated credentials. Repeat race-prone scenarios exactly three times and record each result.

| Environment                                             | Required live scenarios                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Linux, simple mode                                | #1888 handoff, healthy Codex turn, controlled silent-after-context signature, graceful abort, SIGTERM-ignoring process-tree escalation, user Stop, force-fail, stale heartbeat, queued successor barrier |
| Local Linux, insulated mode                             | Cross-UID executor spawn, shipped sudoers/run-as validation, group signal, verified absence, Stop and watchdog outcomes                                                                                  |
| Local Linux, strict mode when available                 | Per-user executor containment and no cross-user process signal                                                                                                                                           |
| macOS development host                                  | Start-identity adapter proof plus group kill when supported; otherwise diagnose-only proof, healthy SDK turn, first-progress watchdog                                                                    |
| PostgreSQL single daemon                                | Persistence/auth/terminal races and supervisor/coordinator checks                                                                                                                                        |
| SQLite daemon                                           | Equivalent single-daemon behavior and migration                                                                                                                                                          |
| Templated launcher double                               | Default and may-have-dispatched nonzero modes, exit zero/after connect, warning-only timeout with late connect, diagnose-only stall, force-fail                                                          |
| Real Claude SDK                                         | Healthy progress, permission wait, configured idle boundary smoke                                                                                                                                        |
| Real Codex SDK                                          | Healthy progress and abort behavior plus controlled silent-after-context signature; do not claim reproduction of the unknown root cause                                                                  |
| Gemini/Copilot/OpenCode where credentials are available | At least one healthy progress mapping and one controlled adapter failure each                                                                                                                            |

Never run live stall/kill QA against a valuable worktree or broad credential set. Use a disposable worktree and a sentinel writer that proves no writes occur after terminality.

### 13.12 Observe-only dogfood, vocabulary, and load gates

The enforcement rollout requires a real-workload safety receipt, not fixtures alone.

#### Observe-only dogfood

- Run the exact enforcing decision function in `observe` on daily-driver macOS instances using the real resolved SDK versions.
- The acceptance window is **at least seven consecutive days and at least 100 completed real turns after the last mapping, threshold, or decision-policy change**, whichever takes longer.
- Include Codex and Claude plus every other adapter for which enforcement is claimed; exercise extended thinking, long generations, tool use, permission/input waits, queueing, and User Stop. Because V1 mode is global rather than per-adapter, making `enforce` the global default requires soak evidence for every supported SDK adapter. If any adapter cannot be soaked, keep the global default `observe` and document explicit operator enforcement as reduced-confidence opt-in rather than silently generalizing.
- Inject at least one controlled silent-after-context signature and prove it records `would_fire` without aborting, changing Task/session state, running callbacks, or affecting the queue.
- Acceptance requires **zero unjustified would-have-fired events**. Every observed event is classified with its bounded evidence as justified fault, mapping gap, threshold problem, or policy bug.
- Any unjustified event requires a mapping/threshold/policy fix and resets the full seven-day/100-turn window. Operational outages unrelated to policy may pause, but not shorten, the window.
- Record total turns, adapter/version distribution, turn-duration/first-progress percentiles, would-fire count, unknown-activity count, triage outcome, and confirmation that force-fail/restart tests still pass.

Only after this receipt passes may Phase 6 select `enforce` as the default. If it does not pass, the PR remains observe-only or pauses; it does not weaken the acceptance bar.

#### Vocabulary freshness

- CI compares each adapter's resolved SDK version with the reviewed fixture manifest.
- A version change fails with an actionable mapping-refresh message until healthy, unknown-only, waiting, failure, and completion fixtures are reviewed again.
- A stream of only unknown events never enforces while events continue; it records one bounded `unknown_activity` diagnosis. This is tested for every adapter loop.

#### Concurrent telemetry/write amplification

- Run a deterministic load test with at least 100 concurrent active executor doubles for 60 seconds at the configured heartbeat interval, with many pulse/raw events inside each interval.
- Compare pulse-enabled traffic with the same heartbeat-only schedule. Coalescing must produce no more than one accepted Task telemetry write and one corresponding WebSocket publication per executor heartbeat interval; raw/pulse event count must not multiply writes.
- Record total/peak writes per second, WebSocket publications, database latency, event-loop delay, and memory. Any superlinear growth or per-event publication is a blocker.
- Repeat a representative measurement during the macOS dogfood soak so real SDK burst shapes and the daily-driver platform are covered.

### 13.13 Regression suites

At completion, run the relevant focused and full suites allowed by the repository workflow, without starting user-managed background processes or running forbidden builds:

- Core Task types, schema, migrations, repositories, config, and client contracts.
- Daemon task hooks/services, heartbeat supervisor, executor tracking, spawn classification, session Stop, queue, callbacks, startup, and authorization.
- Executor heartbeat, base executor, terminal fail-safe, permissions, and every changed SDK adapter.
- CLI/UI focused tests for `dispatching` presentation, template warning, and force-fail confirmation affordance.
- Package typechecks for every changed package.
- Repository formatting/lint/whitespace/multitenancy boundary checks applicable to the diff.
- Provider CI after push.

Do not run `pnpm build` unless explicitly authorized by the user/repository workflow.

## 14. Evidence and confidence gate

The PR is not ready for review until it contains a QA receipt with:

- Base and head SHA.
- Exact changed files and LoC ledger.
- Phase 0 deletion-target line measurements and per-phase gross-added/deleted/net receipts.
- Reference-search proof that each superseded path disappeared in its replacement phase, not Phase 6.
- Exact commands and package versions.
- SQLite and PostgreSQL migration/test results.
- Deterministic matrix totals.
- Live environment topology and OS/UID mode.
- Three-run receipts for containment, Stop latency, heartbeat loss, SDK stall, force-fail, queue barrier, restart recovery, and templated-launcher classification.
- Proof that no automatic supported-local terminal transition occurred before process-group absence.
- Proof that remote/unverified cases remained nonterminal and blocked unless an authorized, explicitly confirmed force-fail occurred.
- Proof that force-fail was rejected for unauthorized/unconfirmed callers and recorded unverified termination for authorized use.
- Proof that restart reconciliation matches main and adds diagnostics without claiming containment.
- Proof that a restart releases remote diagnose-only Tasks under main's orphan behavior and visibly records the unverified-termination caveat.
- Proof that executor `onExit` no longer terminalizes/untracks before descendant-group verification.
- Proof that task-scoped token revocation follows launch classification and passive templated exit preserves remote access.
- Proof that forged telemetry/lifecycle writes failed.
- Proof that liveness heartbeats did not refresh SDK progress timestamps.
- Proof that daemon policy never used executor pulse sequence/recency to decide a stall or termination.
- Healthy timing percentiles and the documented margin supporting the selected dispatch/first-progress defaults.
- Full §13.12 dogfood receipt: seven consecutive days, at least 100 post-change real turns, adapter/version mix, and zero unjustified would-fire events.
- Proof that observe/enforce use the same decision function and observe caused zero abort, containment, lifecycle, callback, or queue actions.
- Mapping-freshness manifest/test results and unknown-only active-stream fail-open evidence.
- Concurrent telemetry receipt showing bounded writes/WebSocket publications relative to the heartbeat-only baseline.
- Insulated/strict group-signal proof, or an explicit diagnose-only V1 result when the helper/sudoers contract is unavailable.
- Proof that the controlled Codex silent-after-context signature was detected, explicitly without claiming reproduction or diagnosis of the underlying bug.
- Proof that normal completion, callbacks, Stop, queueing, and CLI behavior did not regress.
- Any platform/mode not exercised and the exact reduced guarantee for it.

Confidence gate:

1. Every required matrix row passes.
2. No unresolved P0/P1 finding remains.
3. No duplicate telemetry, watchdog, or containment path remains in the final diff.
4. Every phase stayed inside its LoC slice before the next phase began, and cumulative product source stays inside the global budget or received explicit advance exception review.
5. The final behavior matches the frozen guarantee table.
6. Whole-diff review confirms that no attempt/kernel/callback/deletion architecture leaked into scope.
7. Reviewer confirms the routed #1926 feedback was not silently dropped.
8. The dogfood/load/mapping-freshness gate passed before enforcement became the default.

## 15. Review checklist

### Architecture

- [ ] One Task remains the lifecycle aggregate.
- [ ] SDK health remains orthogonal evidence.
- [ ] No new lifecycle table or generic framework.
- [ ] PR #1888 behavior is preserved without later attempt/kernel machinery.
- [ ] Daemon owns timestamps, containment, and forced terminality.
- [ ] Remote/unprovable execution never gains a false automatic-continuation guarantee.
- [ ] Remote fail-closed behavior is explicitly scoped to the current daemon lifetime; restart release is disclosed.
- [ ] Daemon-restart behavior remains compatible with main and its containment limitation is explicit.

### DRY/KISS/ponytail

- [ ] Existing heartbeat transport is reused.
- [ ] Existing supervisor is extended, not duplicated.
- [ ] One pulse callback serves every adapter.
- [ ] One watchdog serves every SDK, with only necessary adapter policy.
- [ ] One containment primitive serves Stop, startup timeout, heartbeat loss, and SDK stall.
- [ ] Existing terminal/callback/queue code is reused after proof.
- [ ] Superseded single-PID and Claude idle paths are deleted.
- [ ] The direct executor-`onExit` terminal/untrack safety net is deleted or routed through the coordinator.
- [ ] Every replacement commit deletes its predecessor atomically; no dual-path compatibility shim ships.
- [ ] Phase 6 contains verification/contraction proof, not deferred production cleanup.
- [ ] No speculative abstraction or compatibility layer remains.

### Security and correctness

- [ ] Generic external writes cannot forge daemon-owned fields.
- [ ] Telemetry is exact-task authenticated and terminal-fenced.
- [ ] Pulse payload is bounded and secret-free.
- [ ] Pulse sequence/recency remains diagnostic and never drives daemon policy.
- [ ] Unknown-but-active SDK vocabulary records diagnostics and fails open rather than enforcing.
- [ ] Watchdog mode is an immutable dispatch snapshot; the executor cannot escalate observe to enforce.
- [ ] Templated launcher exit is not confused with remote executor exit.
- [ ] Token revocation uses the same launch classification; passive template exit preserves runtime access.
- [ ] Signal permission failures are unverified, never absence.
- [ ] Automatic terminality never precedes supported local absence proof.
- [ ] The only unverified terminality path is explicit, authorized, confirmed, and audited force-fail.
- [ ] Queued work never starts while unverified execution may still write unless an owner/admin explicitly accepts that risk through force-fail.

### QA and delivery

- [ ] Both database dialects pass.
- [ ] Every adapter has mapping fixtures.
- [ ] SDK-version mapping-freshness assertions pass.
- [ ] Deterministic race/fault tests pass.
- [ ] Observe-only dogfood meets the full duration/turn-count and zero-unjustified-fire bar.
- [ ] Concurrent telemetry writes and WebSocket publications remain bounded by heartbeat cadence.
- [ ] Real process-group containment passes.
- [ ] Live simple/insulated QA passes; strict-mode result recorded when available.
- [ ] Remote diagnose-only behavior passes.
- [ ] LoC ledger is complete.
- [ ] Phase 0 deletion credits and every per-phase budget slice are evidenced.
- [ ] Full allowed regression suites and typechecks pass.
- [ ] PR body reflects the final diff, limitations, QA, and rollback.

## 16. Rollout and rollback

- Deploy daemon and executor from the same release; the telemetry and connection methods are a coordinated protocol.
- The schema migration is additive: one nullable connection timestamp plus existing JSON data.
- Default watchdog thresholds must be conservative and documented.
- Ratify the 3-minute first-progress and 5-minute local-connect defaults against recorded healthy timing percentiles before enabling them by default.
- The watchdog has one `disabled | observe | enforce` mode switch; `observe` is the safe rollout/diagnostic position and `disabled` is the emergency rollback.
- Do not make `enforce` the default until the unchanged policy completes the full §13.12 dogfood window with zero unjustified would-fire events.
- Document that disabling executor heartbeat also disables pulse persistence and the stale-wrapper backstop while leaving the executor-local watchdog active.
- Dispatch timeout is independently configurable.
- Remote diagnose-only behavior must be called out in release notes/docs if user-visible.
- User Stop no longer reports `STOPPED` immediately: supported local Stop may take the configured graceful-abort plus SIGTERM/SIGKILL verification bounds before terminality. Document this latency change.
- Insulated/strict operators must install the updated sudoers/setup contract if Phase 0 proves UID-aware process-group signaling requires it; startup validation must explain a missing upgrade.
- Restart reconciliation remains main-compatible and may release local or remote logical state without containment proof after abrupt daemon death; the resulting Task warning must disclose that limitation.
- The identity-check-to-signal TOCTOU remains a known V1 limitation; document `pidfd_send_signal`/group-capable host containment as future hardening.
- Rollback may leave an unused nullable column and ignored JSON facts; old binaries must not receive new executor protocol traffic after rollback.
- Before rollback, stop or drain active Tasks when operationally practical.

## 17. Final definition of done

This work is done when a reviewer can answer all of these from code and evidence without reading design intent into it:

1. Did the executor connect?
2. Is the wrapper alive?
3. Has the SDK produced meaningful progress?
4. Is the Task legitimately waiting for a human?
5. If a stop was requested, who owns containment?
6. Is the supported local executor process group actually absent?
7. Is automatic terminality now safe, or did an authorized owner/admin explicitly accept unverified termination?
8. While the daemon remains live, will queued work stay blocked when absence is unprovable unless force-fail occurs—and does restart recovery disclose that it releases this guarantee?
9. Can an external caller forge any of those facts?
10. Did the implementation add only the minimum machinery needed to answer them?
11. Would unknown-but-active SDK vocabulary fail open, and would an SDK version bump force fixture review?
12. Did real-workload dogfood and concurrent telemetry measurements show both zero unjustified enforcement decisions and bounded write volume?

If any answer depends on an implicit assumption, ambient configuration, an unverified remote action that was not explicitly force-failed, or a second competing lifecycle path, the PR is not complete.
