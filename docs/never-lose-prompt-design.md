# Never Lose a Prompt — Design Doc

**Status:** Research / Proposal
**Author:** Claude (design research pass)
**Date:** 2026-04-24
**Branch:** `never-lose-prompt`

---

## TL;DR

The prompt text is **not** lost today — it lands in `tasks.full_prompt` on the daemon side *before* the executor is even spawned. What **is** lost when the executor dies during startup is the **user-message row** (the thing the chat transcript actually renders). So the user types a prompt, the task appears in the task list with a "failed" status, but the conversation view has no trace of what the user said.

Max's proposed fix — have the daemon create the user-message row up front and pass only `task_id` to the executor — is the right direction and is **cheaper than it sounds**, because the executor already writes messages *through the daemon via Feathers* (no direct DB). So "moving the write to the daemon" is literally moving a function call from the executor process to the route handler, not a new integration.

**Recommendation:** Adopt Max's idea, with a refinement — frame it as *"the `POST /sessions/:id/prompt` handler owns the user-message write"* (Alternative D), not *"executor fetches the prompt by ID"*. Keep passing the prompt in the payload (cheap, avoids a refetch round-trip, avoids auth concerns) and have the executor skip its own `createUserMessage` when it sees the row already exists. This gets us the durability property without complicating the executor's startup path.

---

## 1. Current state (ground truth)

### 1.1 The happy-path flow

```
┌───────┐                  ┌─────────────────────────┐               ┌────────────┐
│  UI   │                  │       DAEMON            │               │  EXECUTOR  │
│ / MCP │                  │  (POST /sessions/:id    │               │ subprocess │
│ / CLI │                  │        /prompt)         │               │            │
└───┬───┘                  └────────────┬────────────┘               └─────┬──────┘
    │                                   │                                   │
    │ 1. prompt text                    │                                   │
    ├──────────────────────────────────►│                                   │
    │                                   │ 2. create task                    │
    │                                   │    (full_prompt stored here!)     │
    │                                   │    tasks.RUNNING                  │
    │                                   │ ─────────────────────►  DB        │
    │                                   │                                   │
    │                                   │ 3. patch session.tasks[]          │
    │                                   │ ─────────────────────►  DB        │
    │                                   │                                   │
    │  4. HTTP 200 { taskId, RUNNING }  │                                   │
    │◄──────────────────────────────────│                                   │
    │                                   │                                   │
    │                                   │ 5. setImmediate →                 │
    │                                   │    sessionsService.executeTask    │
    │                                   │                                   │
    │                                   │ 6. spawn(node executor --stdin)   │
    │                                   │ ───────────────────────────────►  │
    │                                   │    stdin: { command:'prompt',     │
    │                                   │      sessionToken, daemonUrl,     │
    │                                   │      params:{sessionId, taskId,   │
    │                                   │              prompt, tool,… } }   │
    │                                   │                                   │
    │                                   │                                   │ 7. connect via
    │                                   │                                   │    Feathers/WS
    │                                   │◄──────────────────────────────────│    (session token)
    │                                   │                                   │
    │                                   │ 8. messages.create(user msg)      │
    │                                   │◄──────────────────────────────────│    ← prompt
    │                                   │    via Feathers client            │      persisted as
    │                                   │                                   │      a message row
    │                                   │                                   │      HERE, not
    │                                   │                                   │      earlier
    │                                   │                                   │
    │                                   │ 9. SDK starts streaming…          │
    │                                   │◄──────────────────────────────────│
    │                                   │                                   │
```

### 1.2 Citations

**Entry points.** All three user-facing pathways funnel into the same FeathersJS custom route:

- UI (socket or REST) → `POST /sessions/:id/prompt`, registered at `apps/agor-daemon/src/register-routes.ts:746-1074`.
- MCP `agor_sessions_prompt` → `apps/agor-daemon/src/mcp/tools/sessions.ts` "Tool 5" → same route.
- MCP `agor_sessions_create` (with initial prompt) → same route after session creation.
- CLI `agor session prompt` → daemon HTTP.

**Task creation (daemon).** `apps/agor-daemon/src/register-routes.ts:889-909`:

```ts
const task = await tasksService.create({
  session_id: id as SessionID,
  status: TaskStatus.RUNNING,
  started_at: new Date().toISOString(),
  description: data.prompt.substring(0, 120),
  full_prompt: data.prompt,      // ◀── the prompt text IS persisted here
  message_range: { … },
  …
}, params);
```

Session status is then patched to `RUNNING` via the `tasks.create` hook in `apps/agor-daemon/src/services/tasks.ts:115-150`.

**Executor spawn.** `apps/agor-daemon/src/register-services.ts:770-791`:

```ts
const executorProcess = spawn(cmd, args, { cwd, env, stdio: ['pipe','pipe','pipe'] });
executorProcess.stdin?.write(JSON.stringify(executorPayload));
executorProcess.stdin?.end();
```

Payload (`register-services.ts:708-723`):

```ts
{
  command: 'prompt',
  sessionToken,       // JWT for Feathers auth
  daemonUrl,
  env,
  params: { sessionId, taskId, prompt, tool, permissionMode, cwd, messageSource }
}
```

So the executor receives **both** the `taskId` and the `prompt`. This matters for the design — Max's proposal isn't swapping one for the other, it's making the `prompt` field redundant for durability while keeping it for cheap hand-off.

**User-message write (executor).** The executor writes the user-message row AFTER it starts up:
- `packages/executor/src/sdk-handlers/claude/message-builder.ts:43-66` (`createUserMessage`)
- Called from `packages/executor/src/sdk-handlers/claude/claude-tool.ts:314` inside `executePromptStream`, which only runs after the SDK handler is constructed and repositories are wired.
- Identical pattern exists per-tool in `codex-tool.ts:181, 559`, `gemini-tool.ts:144, 265`, `copilot-tool.ts:153, 328`.

**Executor → daemon transport.** The executor does **not** touch the DB directly. It goes through the daemon via a Feathers WebSocket client wrapped as repositories: `packages/executor/src/db/feathers-repositories.ts` and `packages/executor/src/index.ts:45-90`. So `messagesService.create(userMessage)` inside the executor is a network call back to the daemon's `messages` service.

**Safety nets that already exist.**
- `register-routes.ts:1036-1046`: if `executeTask` throws *before* spawn completes, the task is `safePatch`-ed to `FAILED` with `error_message`, and `tasks:failed` is emitted.
- `register-services.ts:800-862`: `executorProcess.on('exit')` handler. If the latest task is still `RUNNING/AWAITING_*/STOPPING/TIMED_OUT` when the process dies, task is patched to `FAILED` and session repaired to `IDLE`.
- `packages/executor/src/index.ts:215-254`: executor's own `SIGTERM/SIGINT/uncaughtException/unhandledRejection` handlers try to patch the task to `FAILED` before exit.

### 1.3 The queued-path asymmetry (important)

When the session is **not IDLE** (another task running, queue not empty), the daemon *does* persist the user prompt as a message row up front — as a `status: 'queued'` message — at `register-routes.ts:821`:

```ts
const queuedMessage = await queueCheckRepo.createQueued(id as SessionID, data.prompt, {
  queued_by_user_id: params.user?.user_id,
});
app.service('messages').emit('queued', queuedMessage);
return { success: true, queued: true, message: queuedMessage, … };
```

So there are already **two different durability regimes depending on whether the session is idle or not**:

| Path | Who writes the user-message row | When |
|------|-------------------------------|------|
| Session IDLE | Executor | After spawn + Feathers connect + repo init |
| Session busy / queued | Daemon | Synchronously in the HTTP handler |

This asymmetry is a code smell. Normalizing on "daemon always writes the user-message row" is a simplification, not a new mechanism.

Note: the queue-drain path at `register-routes.ts:1605` *deletes* the queued row and re-invokes `promptService.create`, which then goes through the executor-writes path again. So today the lifecycle is: queue row → (deleted) → executor writes a fresh non-queued row. This is another small design wart worth cleaning up.

### 1.4 What survives a crash today

- ✅ **Prompt text.** Stored in `tasks.full_prompt` at `register-routes.ts:895` before spawn.
- ✅ **Task row.** Created before spawn; marked `FAILED` by exit handler.
- ✅ **`tasks:failed` event.** Emitted on spawn failure (`register-routes.ts:1051`).
- ❌ **User-message row.** Only exists after executor connects and writes it. This is the gap.
- ❌ **Chat transcript rendering.** The conversation view reads the `messages` table. It does **not** fall back to `tasks.full_prompt`. (`TaskListItem.tsx:40` uses `full_prompt` as a description fallback, but that's the task list, not the chat.)

---

## 2. Failure modes in the current design

Mapping scenarios to user-visible outcomes:

| # | Scenario | Prompt text preserved? | User-message row written? | Task row state | User experience |
|---|---|---|---|---|---|
| 1 | Rebuild kills executor mid-spawn | yes (`tasks.full_prompt`) | **no** | `FAILED` (by exit handler) | **(a) Silent in chat**, visible in task list |
| 2 | Executor binary missing / path wrong | yes | **no** | `FAILED` (spawn throws → catch at 1036) | **(a) Silent in chat**, task shows "FAILED: spawn ENOENT" |
| 3 | SDK init error (bad API key, network) | yes | **no** (throws before `createUserMessage`) | `FAILED` (exit handler) | **(a) Silent in chat**, task shows failed |
| 4 | Executor OOM immediately | yes | **no** | `FAILED` | **(a) Silent in chat** |
| 5 | Feathers client can't connect to daemon | yes | **no** | `FAILED` | **(a) Silent in chat** |
| 6 | Node version mismatch / module resolution | yes | **no** | `FAILED` | **(a) Silent in chat** |
| 7 | Executor crashes mid-stream (after user-msg write) | yes | yes | `FAILED` | **(b) Visible but errored** — already fine |
| 8 | Daemon restart mid-spawn | yes (task row + full_prompt written before restart) | **no** | Left `RUNNING`; exit handler won't fire on reboot | **(a) Silent in chat**, task hangs `RUNNING` until manual intervention |
| 9 | User re-prompts while first executor still spawning | depends on status; usually queued → persisted | yes (as queued) | second task queued | (c) fine |

**The core UX bug:** in scenarios 1-6 (common in dev, occasional in prod), the chat transcript loses the user's prompt entirely. From the user's perspective the message they typed just vanished — even if they can find it by drilling into the task list, the conversation they were having has a hole in it.

Scenario 8 (daemon restart) is a separate correctness bug (no process alive to run the exit handler), worth calling out but orthogonal to "never lose a prompt".

---

## 3. Evaluate Max's proposal

Max's proposal: *daemon creates Task and user-message row up front, passes `task_id` to executor, executor retrieves the user message, then starts SDK.*

### 3.1 Feasibility

**Very high.** The daemon already owns the Feathers `messages` service and already calls `messagesService.create(...)` in the queued-path (`register-routes.ts:821` via `createQueued`). It also already calls `tasksService.create` and `sessionsService.patch` in the idle-path. Adding one `messagesService.create` call next to the existing `tasksService.create` at line 889 is mechanically a ~10-line change.

The executor's current `messagesService.create(userMessage)` call is itself an over-the-wire Feathers call to the same service — so we're not introducing a new code path, we're moving *which process holds the connection* at the moment of write.

### 3.2 Interface change

The executor's CLI surface stays the same. It already receives `taskId` in the payload (`register-services.ts:716`), so no argument migration is needed. If we remove `prompt` from the payload and force the executor to fetch it, we introduce:
- an extra round-trip at executor startup (Feathers `tasks.get` or `messages.find`)
- a new failure mode (executor can start but can't find task/message → need to decide what to do)
- no durability benefit (the prompt was already in the payload; the issue was the *write*, not the hand-off)

**So: don't force the executor to fetch.** Keep the prompt in the payload as a hint, but have the executor check for an existing user-message row for `taskId` before calling `createUserMessage`. If it exists, skip. If it doesn't (backward-compat / queued-path edge), create it as today. This is idempotency-preserving.

### 3.3 What does the executor actually need from the DB on startup?

Today (all via Feathers): `sessionId`, `taskId`, `prompt`, `tool`, `permissionMode`, `cwd`, plus model config / MCP config / conversation history (fetched lazily). Only `prompt` is in question for durability. Everything else is either in the payload or fetched on demand. So the "executor fetches by task_id" framing overstates the change.

### 3.4 Atomicity & orphaned records

New concern: if daemon writes user-message row then `spawn()` fails synchronously (ENOENT, permission), we now have a user-message row with no assistant response.

- This is actually **what we want**. It's outcome (b) "visible but marked errored" from the problem statement, which the user explicitly flagged as acceptable.
- The existing `safePatch → tasks.FAILED` logic plus `tasks:failed` socket event gives the UI what it needs to render the user message alongside an error indicator.
- To go one better: wrap the "create task + create message" in a single transaction boundary, or at least order writes so that if message-create fails we abort and don't create the task either. Drizzle supports transactions; using them here is cheap.

### 3.5 Concurrency / pending-message window

In the proposed model, the UI briefly sees a user message with no assistant response. This is already how *every* chat app works; it's also how Agor's queued-path works today. No regression.

If the executor takes >N seconds to produce its first token, users already tolerate that. The gap between "daemon wrote user-message" and "executor starts streaming" is the same gap that exists today between "user-message row appears" and "first assistant chunk appears" — we're just shifting the start of the gap earlier by a few hundred ms.

### 3.6 Verdict on Max's idea

Sound direction, with one refinement: **don't remove `prompt` from the payload**. Keep it. The win is where the `messages.create` call lives, not what the executor receives.

---

## 4. Challenge: is this the right approach?

### Alt A — Executor writes, daemon supervises with dead-man timeout

Current design + a timer: if the executor hasn't written a user-message row within N ms, daemon writes one itself marked `{ content: full_prompt_from_task, error_metadata: 'executor failed to start' }`.

- **Solves:** all scenarios 1-6.
- **Complexity:** moderate — need a timer, coordination with exit handler (avoid double-writes), edge cases around slow-but-healthy spawns.
- **Cost:** two code paths writing the same logical row, which is the opposite of fixing the IDLE/queued asymmetry. Adds timing heuristic nobody wants to tune.
- **Verdict:** solves the symptom, worsens the architecture.

### Alt B — Transactional outbox / queue

Daemon writes to a durable queue table; a worker pool (or spawned executor) consumes. Message lifetime is "claimed → in-progress → done/failed".

- **Solves:** everything, including daemon-restart (scenario 8).
- **Complexity:** high. Requires a worker model, claim-lease-visibility logic, idempotency on re-delivery, retry policy, poison-message handling.
- **Cost:** large migration, test surface explosion, very different mental model. Probably the *correct* answer if Agor were operating at scale, but overkill for the current pain.
- **Verdict:** right answer eventually, wrong answer now.

### Alt C — Max's original (daemon owns Task + user-message; executor fetches by task_id)

As analyzed in §3. Minor concerns about removing `prompt` from the payload.

- **Solves:** 1-6.
- **Complexity:** low-medium. Main cost is a new failure mode at executor startup if it can't fetch the task/message.
- **Verdict:** good, but over-specifies the change.

### Alt D — "Route handler owns the user-message write" (recommended)

Refinement of Alt C. The `POST /sessions/:id/prompt` handler is the single writer of the user-message row, in both idle-path and queued-path. Executor stops writing `createUserMessage` for the initial prompt (keeps doing it for tool-result user messages and multi-turn continuations if any). Payload keeps both `taskId` and `prompt` (prompt becomes non-load-bearing for durability, stays for convenience).

- **Solves:** 1-6.
- **Complexity:** low. ~20 lines in `register-routes.ts`, gated branches in each `*-tool.ts` to skip initial-prompt message creation.
- **Cost:** need to audit each SDK handler (`claude-tool`, `codex-tool`, `gemini-tool`, `copilot-tool`) to ensure they don't assume they created the row.
- **Fixes the IDLE/queued asymmetry** as a side effect.
- **Verdict:** best bang for the buck.

### Alt E — Make spawn crash-resilient with retry

Wrap `spawn()` in a retry with backoff on specific error classes (ENOENT, ENOEXEC, EAGAIN).

- **Solves:** 2 (binary missing), maybe 6 (transient).
- **Does not solve:** 1, 3, 4, 5 (crashes are not retryable at this layer).
- **Verdict:** addresses a thin slice; not a durability fix.

### Compatibility matrix

All alternatives are compatible with the existing long-running executor pattern — the user message is written once, at task start, whether we write it in the daemon or the executor. Streaming, tool calls, multi-turn, cancellation all work the same afterwards.

| Alt | Fixes silent-drop | Effort | Arch debt | Fixes daemon-restart |
|-----|------|-----|-----|------|
| A (supervise w/ timer) | yes | med | adds timing heuristic | no |
| B (outbox/queue) | yes | high | reduces debt long-term | **yes** |
| C (Max's) | yes | low-med | removes idle/queued asymmetry | no |
| **D (route owns write)** | **yes** | **low** | **removes asymmetry, no new paths** | **no** |
| E (retry spawn) | partial | low | no | no |

---

## 5. Recommendation (post-review)

**Do Alternative D + the task-centric queue refactor from §6.3.** The review surfaced a deeper structural issue: the current *message*-queue is a misplaced abstraction of what should be a *task* queue. Fixing that in the same change removes the root cause of the IDLE/queued asymmetry, makes never-lose-prompt trivial (prompt lives on `tasks.full_prompt` from moment one), and aligns the code with what the Nov-2025 design doc had originally proposed.

### Concrete plan

**A. Make the daemon the sole writer of the initial user-message row.** (Alt D)

1. In `apps/agor-daemon/src/register-routes.ts:889`, immediately after `tasksService.create`, call `messagesService.create({type:'user', role:'user', task_id, session_id, content: data.prompt, metadata:{source: messageSource}})`. Wrap in a Drizzle transaction *only if* the calls stay co-located (§6.2).
2. On spawn-failure paths (`register-routes.ts:1036-1058`), additionally synthesize an error `type:'system'` message so the chat surfaces *why* the assistant didn't respond (§6.1).

**B. Executor changes.**

3. Consolidate the four `createUserMessage` implementations into one shared helper on the base handler (§6.6). Add a "skip if task already has a user-message row" check — covers Alt D plus any legacy/backward-compat path.
4. Delete `createUserMessage` from `gemini-tool.ts`, `codex-tool.ts`, `copilot-tool.ts`; `message-builder.ts` retains a single canonical impl.

**C. Collapse "queued messages" into "queued tasks".** (§6.3)

5. Add `TaskStatus.QUEUED`. Add `tasks.queue_position` (or a `task_queue` join table — pick the one the archived design preferred).
6. In `POST /sessions/:id/prompt`, when session is not IDLE: create `task` with `status=QUEUED` + `queue_position`; do **not** create a queued `messages` row. User-message row is created when the task transitions to `RUNNING`.
7. Replace `processNextQueuedMessage` (`register-routes.ts:1545`) with `processNextQueuedTask`. Same trigger points (task-completion hook, auto-process after queue add).
8. One-time migration: any existing `messages.status='queued'` rows become `tasks.status='queued'` with `full_prompt := messages.content`. Drop `messages.status`, `messages.queue_position`, and related indexes afterward.
9. UI: "Queued (n)" list in the session drawer reads tasks where `status='queued'`, ordered by `queue_position`. Display `task.description` (already truncated to 120 chars) and `task.full_prompt` on hover.
10. Orphan sweep in `startup.ts:50-63`: leave `QUEUED` tasks alone — they should survive a restart and drain naturally.

**D. Tests.**

11. Unit: `POST /sessions/:id/prompt` (idle) creates task + user-message in one go.
12. Unit: `POST /sessions/:id/prompt` (busy) creates `QUEUED` task, no message row, no legacy queued-message row.
13. Integration: kill executor mid-spawn → user message *and* system error message both visible in chat + task `FAILED`.
14. Integration: queue three prompts → all execute in order, one user-message row per task, no duplicates.
15. Integration: daemon restart with queued tasks → tasks persist, drain correctly on reboot.
16. Migration test: synthetic DB with queued-message rows → after migration, equivalent queued-task rows exist with identical content.

**E. Rollout.**

17. The Alt-D portion is revertable via a `config.execution.daemon_writes_user_message` kill switch; the task-queue portion is a schema migration so has a clearer cutover line. Ship as a single PR but call out the migration explicitly in release notes.

### Out of scope (explicit)

- **Outbox / queue-table architecture (Alt B).** Right shape at scale, wrong shape today. Revisit when we have multi-daemon.
- **Daemon-restart reconciliation.** Already implemented in `startup.ts:50-132` (§6.4); nothing to add.
- **Per-task callback overrides.** Worth formalizing (§6.5) but parked as a follow-up; bundling here risks scope blowup.

---

## 6. Resolved design questions (from review with Max, 2026-04-24)

### 6.1 Error visibility in the chat view *(resolved: yes, always show)*

Confirmed: today when the exit handler marks a task `FAILED` with `error_message`, the chat view does **not** surface it — it only renders `messages` rows. Resolution: **always** create the user-message row *and* synthesize an assistant/system error message when the task fails before producing output. The chat should never silently swallow an error. This becomes part of the spawn-failure path in `register-routes.ts:1036-1058`: after `safePatch(tasks, FAILED)`, also `messagesService.create({type:'system', role:'assistant', content: <rendered error>})`.

### 6.2 Atomicity *(resolved: yes if adjacent, no if threaded)*

Wrap `createTask + createUserMessage` in a Drizzle transaction **if and only if** the two calls can stay co-located in the route handler. Don't thread a transaction through helper call stacks or subservices to make this work — the risk/complexity trade favors two back-to-back calls without a transaction over a transaction that's hard to reason about.

### 6.3 Queued-path cleanup *(resolved: bundle — and it's really about TASKS, not messages)* ⭐

**This turned out to be the most important reframe in the review.** Max's intuition: "wondering if it's really a queued Task, not message." Investigation confirms it.

The archived design (`context/archives/task-queuing-and-message-lineup.md`, Nov 2025) **originally proposed a task-centric queue**:

```ts
Task.status: 'queued' | 'running' | 'completed' | 'failed'
Session.task_queue: TaskID[]
```

That's the correct abstraction — a queued prompt *is* a pending unit of agent work, not a pending chat message. But the shipped implementation (`context/concepts/message-queueing.md`, Nov 2025) deviated and added `Message.status='queued'` + `Message.queue_position` instead. The likely reason was UI convenience (easy to list alongside real messages), but the cost is the two-writers / delete-and-recreate ugliness we're now trying to fix, plus the IDLE/queued asymmetry called out in §1.3.

**Unified model (proposed):**

| Concept | Source of truth |
|---|---|
| Prompt text (the thing that must not be lost) | `tasks.full_prompt` (already today) |
| Scheduled work units per session | `tasks` with `status ∈ {queued, running, …}` |
| Chat-transcript rendering | `messages` — *derived* from tasks, not the durable store |
| Queue position | `tasks.queue_position` (or a `task_queue` join table, per the archived design) |

Under this model, the durability guarantee is trivial: **the moment a prompt enters the system it becomes a `tasks` row**. The user-message row is a UI artifact created when the task starts running (or up-front as a convenience, as in Alt D). If the executor crashes, the task is there; no chat-transcript gap either, because a `messages` row pointing to that task can be re-synthesized from `task.full_prompt` as needed.

**Scope proposal:** do this cleanup *here*, in the never-lose-prompt work. If we leave message-queueing as-is, we're forever patching around a leaky abstraction. Concretely:

1. Add `TaskStatus.QUEUED`. Extend orphan cleanup in `startup.ts:52-63` to include it.
2. In `POST /sessions/:id/prompt`, when session is not IDLE: create `task` with status=`QUEUED` and assign `queue_position` — do **not** create a queued message row.
3. Rewrite `processNextQueuedMessage` (`register-routes.ts:1545`) as `processNextQueuedTask`: find lowest-position `QUEUED` task for session, transition to `RUNNING`, create user-message row (Alt D), spawn executor.
4. Migration: one-time pass that converts existing `messages.status='queued'` rows into `tasks.status='queued'` rows with `full_prompt` copied from content. Then drop `messages.status` and `messages.queue_position`.
5. UI: the "Queued (n)" drawer reads from tasks, not messages. The user can still *see* queued prompts because each has `task.full_prompt` + `task.description`.

This is materially bigger than a pure never-lose-prompt fix — but given the queueing path is the root of the current two-writers problem, and given the archived design already points this direction, bundling feels right.

### 6.4 Daemon-restart reconciliation *(resolved: already works)*

Verified at `apps/agor-daemon/src/startup.ts:50-132`. On boot, `tasksService.getOrphaned()` finds tasks in `RUNNING/STOPPING/AWAITING_PERMISSION` and transitions them to `STOPPED`; sessions with active statuses are repaired to `IDLE`. **No action needed.** Striking this from the plan. If we add `TaskStatus.QUEUED` per §6.3, we should intentionally *not* include it in the orphan sweep (a queued task should survive a restart and drain when the daemon comes back up).

### 6.5 Callbacks — session-level or task-level? *(needs formalization)*

Callbacks today (`context/explorations/parent-session-callbacks.md`) are stored as `callback_config` on the **session** row (per-subsession-creator config), but fire on each child-**task** terminal status, delivering a `system/is_agor_callback` message via the parent's queue. So the current model is: *session configures callback policy, each task-completion triggers a delivery*.

Max's observation: "both a session and a task could potentially have their own callback scheme (session creator and/or Task creator)." This is correct and latent today. A sensible formalization:

- **Session-level callback config** (`session.callback_config`) — default behavior for *all* tasks spawned under this session (already exists).
- **Task-level callback override** (`task.callback_config`, nullable) — per-prompt override, e.g., "when this specific task finishes, notify parent; ignore session-level default". Would support fire-once semantics natively.
- Precedence: task > session.

Not required for never-lose-prompt, but worth landing at the same time as §6.3 since we're already modifying task-centric plumbing. Parking as a distinct follow-up to avoid scope blowup.

### 6.6 Multi-tool `createUserMessage` divergence *(resolved: consolidate)*

Confirmed: `gemini-tool.ts:265-287`, `codex-tool.ts:559-581`, and `copilot-tool.ts:328-...` have **byte-for-byte identical** `createUserMessage` implementations to the one in `packages/executor/src/sdk-handlers/claude/message-builder.ts:43-66`. No tool-specific quirks — pure copy-paste debt. Resolution: move the shared `createUserMessage` to the base handler (likely `packages/executor/src/sdk-handlers/base.ts` or `base-executor.ts`), delete the three copies, and implement the "skip if task already has a user-message row" check once in one place.

### 6.7 `metadata.source` *(resolved: it does apply to user messages; carries cleanly)*

Per `packages/core/src/types/message.ts:236-265`, `metadata` is a general field on every message. The `source: 'gateway' | 'agor'` field is specifically documented as "where the message originated" — so yes, it legitimately lives on user-message rows (e.g., to distinguish a prompt that came in from Slack via the gateway vs. one typed in the Agor UI). `messageSource` is already in the route handler's scope (`register-routes.ts:1018` passes it into the payload; it comes in on the request body), so stamping `metadata.source` on the daemon side is a literal one-liner. Max's instinct that "metadata is mostly for tool calls" is partly right — most *fields* there (`model`, `tokens`, `parent_id`) are assistant-oriented — but `source` is the one that's user-oriented and we need to preserve it.

---

## Appendix: one-paragraph summary of the current flow

On `POST /sessions/:id/prompt`, the daemon (1) stores the prompt text on a new `tasks` row (`full_prompt`), (2) patches the session's task list, (3) returns 200 with the task id, (4) in a `setImmediate`, spawns a child executor process via `node executor --stdin` passing `{sessionToken, daemonUrl, sessionId, taskId, prompt, tool, cwd, …}` on stdin; the executor connects back to the daemon over Feathers/WebSocket using the session token and only then calls `messages.create(user)` — which is itself an over-the-wire call to the daemon's `messages` service. If the executor crashes any time before that write (rebuild, missing binary, bad API key, SDK init error, Feathers-connect failure), the task row is marked `FAILED` by `executorProcess.on('exit')` in `register-services.ts:800`, but the user-message row is never created, so the chat transcript silently loses the prompt even though `tasks.full_prompt` still has the text.
