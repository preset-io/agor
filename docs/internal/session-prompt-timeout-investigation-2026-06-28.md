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

## Checks run

- Repository-wide timeout search with `rg` for 900s/900000ms/15-minute constants, `AbortSignal.timeout`, `p-timeout`, timeout/watchdog/heartbeat/stale/idle/deadline paths.
- Targeted test attempt: `pnpm --filter @agor/daemon test -- src/services/executor-heartbeat-supervisor.test.ts src/services/tasks.executor-heartbeat.test.ts`.
  - Result: could not run in this worktree because dependencies are not installed (`vitest: not found`; local `node_modules` missing).
