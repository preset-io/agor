# Session/prompt timeout investigation (~15 minutes)

**Date:** 2026-06-28  
**Branch:** `investigate-session-15min-timeout`  
**Prompt:** Investigate why Agor sessions/prompts appear to timeout or fail a little after ~15 minutes.

## Summary

I did **not** find a daemon/executor watchdog that applies a ~15-minute wall-clock deadline to an active agent turn.

The active-task failure mechanisms in the current tree are activity/health based:

- executor heartbeat: executor patches `tasks.last_executor_heartbeat_at` immediately and every 10s by default; daemon fails only after the heartbeat is stale (default max(3×interval, 30s)).
- Claude SDK idle watchdog: 5 minutes of **SDK-message inactivity**, not 15 minutes and not total turn duration.
- queue/turn-lock timeouts: 30–65s around lock acquisition/queue draining, not task execution.
- permission-request timeout: 10 minutes and transitions to `timed_out` only while awaiting permission.
- short-lived HTTP/proxy/discovery/model/OAuth calls: 1–30s or 5 minutes, scoped to individual calls.

The only exact 15-minute-ish runtime paths I found are:

1. **Browser access-token TTL**: `apps/agor-daemon/src/register-routes.ts` uses `ACCESS_TOKEN_TTL = '15m'`.
   - This was previously documented as a UI auth expiry issue in `docs/jwt-expiry-investigation.md`.
   - The current tree already contains the robust client-side fix: dynamic refresh based on JWT `exp`, visibility wake-up refresh, single-flight refresh, socket in-place reauth, and 401 retry in `apps/agor-ui/src/hooks/useAuth.ts`, `useAgorClient.ts`, and `utils/singleFlightRefresh.ts`.
   - This can make the **UI** show auth/connection failures around 15 minutes if running an older build, but it should not terminate executor work in the current tree.
2. **Auth rate-limit window**: `15 * 60 * 1000` for `/authentication`; not relevant to active tasks.
3. **Artifact runtime JWT test TTL**: `expiresIn: '15m'` in tests; not relevant.
4. **External MCP JWT helper cache**: `packages/core/src/tools/mcp/jwt-auth.ts` caches fetched JWTs for 15 minutes. This is for external MCP server auth, not the internal Agor executor/task watchdog. If an external MCP server issues 15-minute JWTs and the SDK/MCP client holds static headers for a long prompt, tool calls after expiry could fail. I did not find evidence that this is the observed global session timeout.

## Timeout inventory

| Path | Timeout / deadline | Scope | Can fail task/session? | Notes |
| --- | ---: | --- | --- | --- |
| Browser access token | 15m | UI auth JWT | Indirect UI/API errors only | Current tree has dynamic refresh + 401 retry. Older builds could fail around 15m. |
| Auth rate limit | 15m window | `/authentication` attempts | No active task impact | Only throttles login/refresh attempts. |
| Executor heartbeat | 10s interval; stale after default 30s | Active executor liveness | Yes | Activity-independent process heartbeat, so active long turns should remain alive as long as daemon API calls/auth work. |
| Executor session token | default 24h | Executor daemon API auth | Yes, after expiry | Not 15m by default. If configured to 15m, active heartbeats would start failing after token expiry and the heartbeat supervisor would fail the task. |
| Internal Agor MCP token | default 24h | Agent → Agor MCP tools | Tool calls can fail after expiry | Not 15m by default. Headers are static for a prompt once SDK config is built. |
| Claude SDK idle watchdog | 5m idle | No SDK messages | Yes | Moving idle check, not a total wall-clock limit. |
| Permission request | default 10m | Awaiting permission | Yes (`timed_out`) | Intended blocking human/tool permission timeout. |
| Copilot SDK sendAndWait | 10m | Whole Copilot sendAndWait call | Yes for Copilot | Clear whole-turn timeout, but 10m not 15m. Could need future work if Copilot turns should be unbounded. |
| Gemini auth | 10s | Auth setup call | Yes during startup | Per-call setup guard. |
| MCP discover/connect/list | 10–15s | Discovery/test calls | No active prompt impact | Per-call guard. |
| OAuth callback await | 5m | MCP OAuth flow | No ordinary active prompt impact | User/browser OAuth wait. |
| Queue/turn locks | 30–65s | Lock acquisition/drain | Can fail prompt enqueue/drain | Not active executor runtime. |
| Environment/repo operations | 30s–10m | Specific branch/repo commands | Specific operation only | Not active agent-loop wall clock. |

## Trace of task/session failure paths

### Executor heartbeat / lost heartbeat

- Executor starts `startExecutorHeartbeat()` in `packages/executor/src/index.ts`.
- Heartbeat patches `tasks.last_executor_heartbeat_at` in `packages/executor/src/executor-heartbeat.ts`.
- Daemon `ExecutorHeartbeatSupervisor` scans active tasks and calls `tasks.failForLostHeartbeat()` only if the latest heartbeat is older than `stale_after_ms`.
- This is correctly scoped to liveness/idle-no-heartbeat, not total elapsed turn time.

### SDK handlers

- Claude: 5-minute moving idle timeout in `ClaudePromptService` / `SDKMessageProcessor`, checked against `lastActivityTime` updated on every SDK message.
- Codex: no explicit whole-turn timeout found in prompt execution path.
- Gemini: auth setup has a 10s guard; no 15m whole-turn watchdog found.
- Copilot: `sendAndWait({ prompt }, 10 * 60 * 1000)` is a whole-call timeout. It is not the reported 15m constant, but it is the one place I found a whole-turn SDK timeout that may deserve future attention if Copilot long turns are expected.
- OpenCode: event-stream loop listens until completion; no 15m whole-turn timeout found.

### MCP/tool calls

- Internal Agor MCP token defaults to 24h (`MCP_TOKEN.DEFAULT_EXPIRATION_MS`). It is generated at session fetch time and passed as a static `Authorization` header into SDK MCP config.
- External MCP auth headers are also resolved once during SDK config build. JWT-auth external MCP tokens are cached for 15m, but long-running prompt clients may still hold a static bearer token. This is plausible for server-specific tool failures after 15m, not a global Agor task watchdog.

### Client/socket/service requests

- Browser access tokens are deliberately 15m.
- Current UI code schedules refresh from JWT `exp`, refreshes on visibility wake-up, dedupes concurrent refreshes, reauthenticates the socket in-place, and retries service calls after definite auth failures.
- If the running deployment is older than this tree, this remains the most likely explanation for user-visible failures around 15m.

## Conclusion

No safe focused server/executor code fix was identified for a ~15-minute **active agent-turn** timeout, because I did not find such a deadline in the active executor/task paths.

Most likely explanations to verify in the running deployment:

1. It is running an older UI/client bundle without the access-token refresh/401-retry fixes. Symptom: browser console/network shows `jwt expired` or `NotAuthenticated` around 15m, while executor may continue or UI service calls fail.
2. `execution.session_token_expiration_ms` or `execution.mcp_token_expiration_ms` is configured near `900000`. Symptom: executor heartbeat/MCP calls start failing after token expiry; task then fails via lost heartbeat or tool error.
3. A configured external MCP server uses JWT auth with 15-minute tokens and static headers. Symptom: only MCP tool calls against that server fail after ~15m.
4. Copilot-specific long prompts exceed the 10-minute `sendAndWait` timeout (not 15m, but a whole-turn timeout).

## Recommended next instrumentation

If this reproduces again, capture these fields at failure time:

- task `status`, `created_at`, `completed_at`, `last_executor_heartbeat_at`, and `data.error_message` / terminal system message;
- daemon logs around failure for `jwt expired`, `Invalid or expired executor token`, `Invalid or expired session token`, `Executor heartbeat lost`, `EXECUTOR_TIMEOUT`, or SDK-specific timeout messages;
- whether failures happen for all agentic tools or only one tool/provider;
- effective config values for `execution.session_token_expiration_ms`, `execution.mcp_token_expiration_ms`, and `execution.executor_heartbeat.*`;
- browser network/console errors if the visible failure is in the UI.

---

# Follow-up investigation — 2026-07-01 (durations cluster at 907–930s)

New evidence from the parent investigation: real failures cluster at **~907–930s**,
surfacing as either `Executor heartbeat lost; the executor may have crashed or
disconnected.` **or** `Executor exited unexpectedly with code 1.` Heartbeats look
live in the UI right up to the failure.

## Headline conclusion

**There is no 900s / 15-minute constant anywhere in the repo's active code or config.**
A repo-wide numeric sweep (`900`, `900000`, `900_000`, `15*60`, `15m`, `54000`) turns up
only: the browser access-token TTL (`15m`, UI-only, already has dynamic refresh), the
auth rate-limit window (`15 * 60 * 1000`), the external-MCP JWT cache (`15 * 60 * 1000`),
the MCP OAuth unknown-expiry cache (`900s`), and a Slack user cache (`15m`). **None of
these can terminate an active executor task.** The docs' only wall-clock deadline is
k8s `activeDeadlineSeconds: 7200` (2h), not 900s.

Therefore the ~900s cut is **environmental / infrastructure**, not application code.
The application's role is that it turns a *recoverable* transport blip into a *terminal*
task failure, and then reports it with a generic message.

## Why both failure messages are symptoms of "couldn't reach the daemon," not root causes

Trace of the two messages:

1. **`Executor exited unexpectedly with code 1.`** — emitted by the daemon, NOT the
   executor: `apps/agor-daemon/src/register-services.ts:966`, inside the `onExit`
   handler (`:942`). It only fires when the child exits **while the task row is still
   `EXECUTING`**. But the executor's own top-level catch already tries to record the
   real error first:
   - `packages/executor/src/index.ts:102-108` → on any thrown SDK error it calls
     `tryMarkTaskTerminal(FAILED, error.message)` then `process.exit(1)`.
   - `tryMarkTaskTerminal` (`packages/executor/src/terminal-task.ts`) does a socket
     `tasks.get` + `tasks.patch`, wrapped in a `try/catch` that only **logs** on failure.
   - So: if the executor could reach the daemon at exit time, the task would already be
     `FAILED` with the **real** SDK error string, and the daemon's `onExit` net would see
     a terminal task and NOT write the generic message (`register-services.ts:973-980`).
   - **The generic "exited unexpectedly with code 1" therefore proves the executor's
     socket to the daemon was already dead (or unwritable) at exit.** `code 1` (not
     `null`) means it exited via its own `uncaughtException`/`unhandledRejection`/catch
     handlers (`index.ts:108,228,237`), i.e. a JS-level error, not a SIGKILL.

2. **`Executor heartbeat lost; …`** — emitted by `ExecutorHeartbeatSupervisor`
   (`apps/agor-daemon/src/services/executor-heartbeat-supervisor.ts:59-62`) when
   `now - last_executor_heartbeat_at > stale_after_ms` (default 30s). The heartbeat is a
   `setInterval` in the executor (`packages/executor/src/executor-heartbeat.ts:55`) that
   patches over the **same socket** and **swallows errors** (`:44-48`). So the only ways
   heartbeats stop while the process is alive are: (a) the socket is dead, or (b) the
   event loop is blocked. A `900s` cut of the socket → heartbeats silently fail →
   supervisor fails the task ~30s later → **900 + 30 ≈ 930s.** This exactly matches the
   observed cluster.

**Both messages converge on the same mechanism: the executor↔daemon socket.io
connection dies around 900s and does not recover.**

## The repo-side amplifier: `reconnectionAttempts: 5`

`packages/executor/src/services/feathers-client.ts:58-62` creates the executor's daemon
client with `reconnectionAttempts: 5` (overriding the CLI default of 2; browsers use
`Infinity` — see `packages/core/src/api/index.ts:1015-1016`). With
`reconnectionDelay:1000 / reconnectionDelayMax:5000`, five attempts are exhausted in
~15–25s, after which socket.io emits `reconnect_failed` and **never reconnects again**.
There is a `reconnect` re-auth handler (`feathers-client.ts:108-126`) but **no
`reconnect_failed` handler** — once the budget is spent, the executor is permanently
deaf to the daemon: heartbeats fail forever and any terminal report is lost. This is why
a single ~900s transport cut becomes a hard task failure instead of a blip.

The daemon URL the executor connects to is `getDaemonUrl()`
(`apps/agor-daemon/src/utils/spawn-executor.ts:803`): `configuredDaemonUrl` if set,
else `http://localhost:3030`. **In a same-host deployment the socket is localhost and a
900s proxy cut is implausible — but in a cloud/split deployment where `daemon.url` is set
to the public/ingress URL, the executor's socket traverses the same ingress/LB/proxy as
browser traffic and is subject to its connection caps.** This is the single most
important environment fact to confirm for the affected deployment.

## Ranked hypotheses (for the affected deployment)

1. **Ingress / load-balancer max-connection-duration or idle timeout ≈ 900s severs the
   executor↔daemon websocket (TOP).** Classic 15-minute killers: GCP backend-service
   `timeoutSec` (caps *total* websocket duration, not idle — pings don't save you),
   nginx `proxy_read_timeout`, envoy route/stream idle timeout, AWS ALB idle timeout.
   Browser sockets survive because they reconnect forever; the executor gives up after 5.
   - *For:* explains BOTH messages, the 907–930s window, provider-agnostic, and "live in
     UI until failure." *Against:* only bites if executors use a proxied `daemon.url`
     (verify config). *Discriminator:* daemon log shows the executor socket
     `disconnect`/`connect_error` right at ~900s; failures are tool-agnostic.

2. **LLM gateway upstream timeout ≈ 900s cuts the model request/stream.** If
   `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` point at a Preset gateway with a 900s upstream
   read timeout, a long turn's streaming response is cut → SDK throws.
   - *For:* plausible in Preset infra; matches duration. *Against:* a clean SDK throw is
     *caught* (`index.ts:102`) and, if the (localhost) daemon socket is healthy, would be
     reported with the **real** error string (e.g. `terminated` / `premature close` /
     `fetch failed`), NOT the two generic messages. So this alone predicts a *specific*
     message. It only produces the generic messages if the daemon socket is ALSO cut —
     i.e. it collapses into hypothesis #1 when executor+daemon share one proxied path.
     *Discriminator:* provider-specific failures; SDK-specific error strings in executor
     logs before exit.

3. **Daemon restart / crash at ~900s (e.g. watch-mode reload, OOM, deploy) drops all
   executor sockets.** *For:* would produce identical symptoms fleet-wide. *Against:*
   not tied to a 900s period; would cluster in time, not in per-task elapsed. *Discriminator:*
   check daemon uptime/restart timestamps vs. failure times.

4. **Codex-specific process death.** Ruled out as the *primary* 900s source: the
   `CodexAppServerClient` (`app-server-client.ts`) is only the short-lived `thread/fork`
   sidecar (spawned + torn down immediately, 10s request timeout); the streaming turn
   uses `@openai/codex-sdk`. No 900s / whole-turn deadline exists in
   `codex/prompt-service.ts` (only `GATEWAY_MCP_STARTUP_TIMEOUT_MS = 30_000`). A Codex
   crash would still be *caught* and reported with a real message unless the daemon socket
   was also down.

## Answer to the Claude `sleep 1000` question (parent Q4)

The executor heartbeat is a standalone `setInterval` independent of SDK messages, so a
long silent shell tool **does** keep the heartbeat alive. **However**, Claude's own idle
watchdog (`packages/executor/src/sdk-handlers/claude/prompt-service.ts:52`
`IDLE_TIMEOUT_MS = 300000`, checked via `message-processor.ts:283 hasTimedOut()` against
`lastActivityTime` updated on every SDK message) would abort a silent `sleep 1000` at
**~5 minutes** with an idle-timeout message — not 900s. So the 15-minute failures are
**not** the Claude idle watchdog and **not** heartbeat starvation; this is a useful
negative discriminator (a heartbeat-starvation or Claude-idle failure would show at ~5m
with a different message).

## Recommended next instrumentation (decisive, cheap)

1. In `feathers-client.ts`, add logging for socket lifecycle in the executor:
   `client.io.on('disconnect', reason => …)`, `client.io.io.on('reconnect_attempt' | 'reconnect_failed', …)`,
   `client.io.on('connect_error', …)` — each with `Date.now()` and elapsed-since-start.
   If these fire at ~900s, hypothesis #1 is confirmed immediately.
2. At failure time capture: task `created_at` vs `completed_at` (confirm ~900 vs ~930),
   `last_executor_heartbeat_at`, `error_message`, and whether failures span multiple
   `agentic_tool` values (tool-agnostic ⇒ #1/#3; single-tool ⇒ #2).
3. Confirm the deployment's effective `daemon.url` seen by executors (localhost vs
   public) and the ingress/LB websocket timeout for that host. Check
   `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` and their gateway's upstream read timeout.
4. Grep daemon logs for `[executor-heartbeat] Marked task … failed after stale heartbeat`
   and the `onExit` `Exited with code …` lines to see which path fired per failure.

## Safe code fixes (with risk notes)

- **Highest value, low risk — raise executor reconnection budget.** In
  `packages/executor/src/services/feathers-client.ts:60`, change
  `reconnectionAttempts: 5` to `Number.POSITIVE_INFINITY` (matching the browser), and add
  a `client.io.io.on('reconnect_failed', …)` that logs loudly and, ideally, rebuilds the
  client. This makes a periodic ~900s transport cut *survivable* (the existing `reconnect`
  handler re-authenticates), turning a hard failure into a brief gap. *Risk:* if the
  daemon is genuinely, permanently gone, the executor lingers instead of exiting — but it
  is bounded by task lifetime, daemon-issued SIGTERM on stop, and unref'd timers, and the
  browser already behaves this way. Acceptable.
- **Medium value — decouple heartbeat transport from the SDK socket** (or send heartbeats
  over a plain REST call with its own short retry) so daemon-side liveness does not depend
  on a single long-lived websocket. *Risk:* larger change; adds an auth path.
- **Do NOT** add an application-level 15m watchdog — there is none today and the users
  want longer turns, not a codified 15m cap.

**Bottom line:** the root cause is almost certainly a ~900s infrastructure connection cap
(ingress/LB or LLM gateway) on the executor's long-lived connection; the code makes it
fatal because the executor gives up reconnecting after 5 tries and then can only report a
generic message. Confirm with socket-lifecycle logging at ~900s, and raise
`reconnectionAttempts` as the immediate mitigation.

**Follow-up action taken in this branch:** implemented the immediate mitigation in
`packages/executor/src/services/feathers-client.ts` by switching executor socket
`reconnectionAttempts` to `Number.POSITIVE_INFINITY` and adding executor socket lifecycle
logs (`disconnect`, `connect_error`, `reconnect_attempt`, `reconnect_error`,
`reconnect_failed`, `reconnect`) with elapsed-since-client-start timing.

## Checks run

- Repository-wide timeout search with `rg` for 900s/900000ms/15-minute constants, `AbortSignal.timeout`, `p-timeout`, timeout/watchdog/heartbeat/stale/idle/deadline paths.
- Targeted test attempt: `pnpm --filter @agor/daemon test -- src/services/executor-heartbeat-supervisor.test.ts src/services/tasks.executor-heartbeat.test.ts`.
  - Result: could not run in this worktree because dependencies are not installed (`vitest: not found`; local `node_modules` missing).
