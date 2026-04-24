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

## 5. Recommendation

**Do Alternative D.** It's the 80% of Max's idea with 20% of the risk, and it incidentally collapses the IDLE/queued code-path asymmetry that exists today.

### Concrete plan

1. **In `apps/agor-daemon/src/register-routes.ts`** (the `POST /sessions/:id/prompt` handler, around line 889):
   - Wrap task-create and message-create in a single block (ideally a transaction).
   - Immediately after `tasksService.create`, call `messagesService.create({ type: 'user', role: 'user', task_id, session_id, content: data.prompt, … })`.
   - Keep emitting the same `messages` events as the executor does today so the UI sees no change in event ordering.

2. **Collapse the queued-path** (`register-routes.ts:821` and the drain at `1605`): queued messages already get a real row, but it's deleted and rewritten by the drain path. Change the drain path to *update* the queued row (`status: 'queued' → null/done`, set `index`, etc.) rather than delete + recreate. This removes the delete-and-recreate wart.

3. **In the executor SDK handlers** (`packages/executor/src/sdk-handlers/{claude,codex,gemini,copilot}/**`):
   - At the top of each tool's execute path where `createUserMessage(sessionId, prompt, taskId, …)` is called for the initial prompt, first check `messagesRepo.findByTaskId(taskId)` (or equivalent) for an existing `role:'user'` row. If found: skip. If not: create (backward-compat, and covers the gateway/MCP callback path if any).
   - Keep `createUserMessage` on hand for the *non-initial* cases (tool results, continuation messages). Only the very first user message per task gets moved.

4. **Tests:**
   - Unit: `POST /sessions/:id/prompt` idle-path creates task + user-message atomically.
   - Unit: queued-path produces one row per prompt (no delete-and-recreate).
   - Integration: kill executor mid-spawn → user message visible in chat + task `FAILED`.
   - Integration: executor runs to completion → no duplicate user-message row.

5. **Rollout:**
   - Behind a feature flag (`execution.daemon_writes_user_message`) is probably unnecessary — the change is small and easily revertable — but an env-var kill switch for the first release wouldn't hurt.

### Why not do B (outbox/queue) now

Worth revisiting once we have multi-daemon or multi-worker deployments. Today the daemon is a single process; the return value of the HTTP call already gives the UI the `taskId`, and the safety-net pattern in `executorProcess.on('exit')` plus the `tasks:failed` event covers the executor-crash case end-to-end. Outbox is the right shape for a distributed system, which this isn't yet.

### What about daemon restart (scenario 8)?

Alt D does **not** fix this. A daemon restart with an executor in-flight leaves `tasks.RUNNING` orphans. A separate PR should add a startup-time reconciliation pass: *on daemon boot, scan for tasks in `RUNNING/AWAITING_*/STOPPING` whose `session_id` has no active executor process → mark `FAILED` with `error_message: 'daemon restart'`.* This is cheap and complements the never-lose-prompt work.

---

## 6. Open questions for Max

1. **Task failure message display.** Today, when a task is marked `FAILED` by the exit handler, the error message is set. But does the chat view surface it? I think it doesn't (it only renders `messages`). Should we emit a synthetic "system" message row on executor-spawn failure so the chat shows *why* the assistant didn't respond? (This is orthogonal but relevant to the "don't lose context" goal.)

2. **Should we atomize the write?** Drizzle supports transactions. Using one around `createTask + createUserMessage` is safer. Preference?

3. **Queued-path cleanup scope.** Collapsing the `createQueued → delete → create` to `createQueued → update` is adjacent cleanup. Do as part of this work, or defer? I'd argue "do as part" because otherwise we still have two ways user-message rows get born.

4. **Daemon-restart reconciliation.** Separate PR, or bundled? Leaning separate, but want confirmation.

5. **Gateway / MCP callback path.** Some queued-message metadata includes `is_agor_callback` (`packages/core/src/db/repositories/messages.ts:244`). Does the callback path currently go through the same `POST /sessions/:id/prompt`? If so, Alt D covers it. If it has its own path, we need to audit.

6. **Multi-tool feature parity.** The four SDK handlers (`claude`, `codex`, `gemini`, `copilot`) each have their own `createUserMessage`. They should all skip if the row exists. Any tool-specific quirks (e.g., does Codex encode the prompt specially before writing?) that make a uniform "skip if exists" unsafe?

7. **`messageSource` metadata.** Today the executor stamps `metadata: { source: messageSource }` on the user message (`message-builder.ts:61`). The daemon-side handler has `messageSource` in scope, so this transfers cleanly — just making sure this isn't load-bearing in a way I missed.

---

## Appendix: one-paragraph summary of the current flow

On `POST /sessions/:id/prompt`, the daemon (1) stores the prompt text on a new `tasks` row (`full_prompt`), (2) patches the session's task list, (3) returns 200 with the task id, (4) in a `setImmediate`, spawns a child executor process via `node executor --stdin` passing `{sessionToken, daemonUrl, sessionId, taskId, prompt, tool, cwd, …}` on stdin; the executor connects back to the daemon over Feathers/WebSocket using the session token and only then calls `messages.create(user)` — which is itself an over-the-wire call to the daemon's `messages` service. If the executor crashes any time before that write (rebuild, missing binary, bad API key, SDK init error, Feathers-connect failure), the task row is marked `FAILED` by `executorProcess.on('exit')` in `register-services.ts:800`, but the user-message row is never created, so the chat transcript silently loses the prompt even though `tasks.full_prompt` still has the text.
