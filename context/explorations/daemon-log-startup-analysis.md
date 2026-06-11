# Daemon startup/runtime log analysis (2026-06-11)

Scope: inspected `journalctl -u agor-daemon --no-pager -n 2000` and `--since '2 hours ago'` on the production-ish host. I did not copy secrets into this note. The current shell cannot see all system journal entries (`journalctl` reports that this user is not in `adm` / `systemd-journal`), so the captured logs are mostly executor child-process output under the `agor-daemon` unit, not the main daemon boot banner. `systemctl status agor-daemon` showed the main daemon was active since `2026-06-11 00:51:13 UTC`, but `journalctl` returned no visible main-process startup entries for that window.

## High-signal findings

### 1. Per-Codex executor startup scans `/tmp` and logs one stack trace per stale instructions file

In the last 2h sample, normalized counts showed:

- 400 `Failed to sweep /tmp/agor-codex-instructions-... EPERM` warnings
- plus ~2,000 stack/object-detail lines produced by those 400 warnings
- the same sweep happens during Codex prompt service construction, i.e. on every ephemeral executor startup

Source: `packages/executor/src/sdk-handlers/codex/prompt-service.ts` constructor calls `sweepStaleInstructionsFiles()`, which scans `os.tmpdir()` and `~/.agor/tmp`, then previously logged `console.warn(..., err)` for every failed unlink.

Interpretation: this is both noisy and potentially real wasted startup work. In strict/insulated/user-switched execution, many `/tmp/agor-codex-instructions-*` files may belong to other Unix users, so EPERM is expected. Logging a full stack per file makes executor startup look broken and floods the daemon unit logs.

Fix applied: summarize failures by error code at debug level instead of warning per file, and keep successful deletion summary debug-only.

Follow-up worth considering: avoid scanning global `/tmp` on every executor. Prefer only the per-user fallback dir, a daemon-owned cleanup job, or a marker/mtime cache that runs the sweep at most once per user/process interval.

### 2. Codex streams log every SDK event at info level

In the last 2h sample:

- 528 `Event N: item.completed`
- 485 `Event N: item.started`
- 165/154 of those appeared in just the last 2,000 lines

Source: `packages/executor/src/sdk-handlers/codex/prompt-service.ts` logs every `for await (const event of events)` iteration.

Interpretation: event-by-event logging is low value during normal operation and scales with response/tool activity. It dominates the journal during active sessions and obscures actual warnings/errors.

Fix applied: move Codex per-event and per-run setup chatter (`Starting prompt execution`, permissions, MCP breakdown, runStreamed start, etc.) to `console.debug`. Also patch executor console filtering so debug logs can be hidden in production the same way daemon logs are.

### 3. Executor-token authorization failures are repeated on every task

In the last 2h sample there were 42 occurrences of each of these, with stack traces in several paths:

- `[API Key Resolution] Failed to resolve via daemon service: Forbidden: Executor token is not valid for this endpoint`
- `Failed to resolve MCP servers: Forbidden: Executor token is not valid for this endpoint`
- `[codex git.safe-directory] Failed to load repo ... for safe.directory setup: Executor token is not valid for this endpoint`

Sources:

- `packages/executor/src/handlers/sdk/base-executor.ts` calls `/config/resolve-api-key`.
- `packages/executor/src/sdk-handlers/base/mcp-scoping.ts` resolves MCP servers.
- `packages/executor/src/handlers/sdk/git-safe-directory.ts` tries to read the repo for `safe.directory` setup.
- `apps/agor-daemon/src/auth/executor-runtime-scope.ts` currently rejects endpoints outside its allowlist; `config/resolve-api-key` is explicitly covered by a test asserting rejection.

Interpretation: this is more than log noise. Executors are attempting daemon calls that the runtime-scope guard forbids, then falling back or continuing with degraded behavior. That means repeated unnecessary round trips and lost functionality (per-user API key resolution and user/session MCP server resolution appear to fall back to none in these logs).

Fix applied only for logging: API-key and MCP failures now log concise messages instead of full stack traces. I did not change the authorization model because allowing these endpoints needs a security review and targeted tests.

Recommended follow-up: decide whether executor runtime tokens should be allowed to call:

- `config/resolve-api-key.create` scoped to their own `taskId`
- the specific MCP-server read paths needed by `getMcpServersForSession`
- `repos.get` for the repo attached to the executor-scoped branch

If yes, update `executor-runtime-scope.ts` and the existing rejection tests to enforce task/session/branch scoping instead of blanket rejection.

### 4. API-key resolution fallback logs too many negative checks

Each Codex task with no app/env key produced a multi-line sequence: resolving key, skipping user check, checking config, no config key, checking env, no env key, fallback to native auth, and Codex subscription-auth explanation.

Source: `packages/core/src/config/key-resolver.ts`, `packages/executor/src/handlers/sdk/base-executor.ts`, and Codex prompt-service constructor.

Interpretation: useful when debugging auth, low-value on every normal task. It is especially noisy because the forbidden daemon-service call prevents per-user lookup first.

Fix applied: demote key-resolution trace and native-auth explanation to debug. Keep decryption failures/errors as normal errors.

### 5. Node `punycode` deprecation warning appears once per executor

The 2h sample had 42 copies of Node's `[DEP0040]` warning. This likely comes from a dependency loaded by each executor process.

No fix applied. Recommended follow-up: run one executor with `node --trace-deprecation` in a safe dev environment to identify the importer, or suppress process deprecation warnings in production if it is known third-party noise.

## Files changed

- `packages/executor/src/index.ts`
  - Applies the shared console log-level patch in executor processes.
- `packages/executor/src/sdk-handlers/codex/prompt-service.ts`
  - Summarizes stale instructions sweep results; demotes verbose Codex setup/MCP/event logs to debug.
- `packages/executor/src/sdk-handlers/base/mcp-scoping.ts`
  - Demotes normal MCP-resolution trace to debug; logs concise warning on resolution failure.
- `packages/executor/src/handlers/sdk/base-executor.ts`
  - Demotes API-key resolution success/fallback chatter to debug; concise warning for daemon-service failure.
- `packages/core/src/config/key-resolver.ts`
  - Demotes step-by-step key resolver tracing to debug.

## Validation notes

Run after edits:

- `git diff --check`

No targeted tests were added because the changes are logging-only and nearby tests mostly assert authorization behavior that I intentionally did not change.

## Addendum: SessionTokenService chatter

Max also reported seeing lots of `SessionTokenService` lines. I could not see those lines in my limited journal view, but source inspection confirms they were normal per-token lifecycle logs at info level:

- `generateToken()` logged every executor JWT issuance.
- `validateToken()` logged every successful validation, including use count.
- revocation/cleanup logged at info level.
- `SessionTokenStrategy` also had verbose parse/authenticate/verify/getEntity logs.

Cost assessment from source: `SessionTokenService.validateToken()` itself is cheap: one in-memory `Map.get(token)`, a `Date` comparison, a few string comparisons for expected session/task/branch scope, and an integer increment. The heavier part is the surrounding Feathers/JWT authentication path, which must parse/verify the JWT and run auth hooks for protected service calls. That cost is still likely tiny compared with an SDK turn, git operations, or database work, but the frequency can be high because executors make many daemon service calls while streaming a task.

Necessity: validation is security-sensitive because it enforces revocation, expiration, max-use counting, and executor scope. We should not remove it casually. However, with the current default unlimited-use executor tokens, validating on every protected service call may be stricter than necessary after a socket has authenticated. A real optimization would need a deliberate design: e.g. cache validation for the lifetime of an authenticated socket, or cache per token for a short TTL while preserving revocation/max-use semantics. That should come with auth tests and probably metrics first.

Fix applied: demoted successful generation/validation/revocation/cleanup and `SessionTokenStrategy` trace logs to debug. Warnings for missing/expired/scope-mismatched/max-use-exceeded tokens remain warnings. For unlimited reusable tokens (`max_uses === -1`), validation no longer increments the diagnostic use counter on every request; finite max-use tokens still count/enforce exactly as before.

## Addendum: repeated `Login event fired` for the same user

Source: `apps/agor-daemon/src/setup/socketio.ts` logs `✅ Login event fired` from the Feathers `app.on('login')` channel hook. That event fires every time a socket client calls `client.authenticate()`.

I found one frontend path that could cause duplicate login events on an initial socket connection:

- `apps/agor-ui/src/hooks/useAgorClient.ts` registered a `client.io.on('connect')` handler that authenticated immediately.
- The outer `connect()` flow also waited for the same connect event and then authenticated.
- On first connection this can produce two back-to-back socket authentications for the same token/user. Reconnects and token-refresh reauths can also legitimately produce login events, but the initial double-auth was avoidable.

Fix applied:

- The socket `connect` handler now re-authenticates only on reconnects. Initial auth remains in the outer `connect()` flow.
- Demoted normal socket login/user-room join logs to debug so production logs do not show a line for every routine socket auth.

This suggests the frontend was not necessarily "going crazy", but it was at least doing redundant initial socket authentication. If repeated login events continue after this, the next suspects are multiple tabs/windows, token refresh reauths, or reconnect loops.

### What `uses=N/∞` means and why it climbs quickly

`SessionTokenService` prints `uses=${use_count}/${max_uses}`. `∞` is rendered when `max_uses === -1`, meaning the executor token is unlimited-use until expiry/revocation. The numerator is not CPU cycles; it is the count of successful validations for that same bearer token.

Why it can increment several times in the same second: the executor uses a Feathers client and each protected daemon service call passes through the auth hook. During one agent task, the executor can call services for task patches, message writes, streaming/thinking events (`/messages/streaming`), heartbeat updates, session/branch/repo lookups, API-key/MCP resolution attempts, and terminal-state fallbacks. Each of those calls can cause the JWT strategy to re-validate the executor-session token.

Current design is conservative/stateless per request. "Once per executor socket" may be viable, but it would be a behavior change: we'd need to cache trusted executor auth on the socket/connection while preserving token expiry, revocation, task/branch/session scope, and any finite max-use semantics. If we do that, add targeted auth tests and ideally counters for validations per task/path before/after.

Follow-up assessment: the repeated `uses=N/∞` lines were a sign that the log was added under an assumption closer to 'token checked once per executor' than the actual implementation, where executor JWTs pass through auth on every protected service call. We should treat successful auth validation as a hot-path debug-only event, not an operational info event.

## Addendum: Knowledge pgvector `relation already exists, skipping` NOTICE spam

The pasted logs are Postgres NOTICE objects, not application errors. They come from `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in `apps/agor-daemon/src/knowledge/pgvector.ts`. Postgres emits NOTICE `42P07` for "already exists, skipping", and postgres.js prints those notices as structured objects.

The bigger issue was not just the log level: `KnowledgeEmbeddingIndexer.indexBatch()` called `ensureKnowledgePgvectorStorage()` before first checking whether any Knowledge units were pending. With semantic search enabled and an API key configured, every 30s tick could re-run pgvector storage DDL even when there was no indexing work to do. The DDL was idempotent, but it is still startup/runtime junk and not aligned with the expected "get pending rows, then process them" flow.

Fix applied:

- `KnowledgeEmbeddingIndexer.indexBatch()` now checks `kb_document_units` for one pending/stale unit before pgvector storage setup. Idle ticks return before DDL/capability/index setup.
- `ensureKnowledgePgvectorStorage()` now inspects the table/index regclasses and returns immediately when all expected storage objects exist.
- When storage objects are missing, it creates only the missing object(s), instead of always issuing `CREATE ... IF NOT EXISTS` for all of them.
- Added a pgvector unit test asserting no CREATE statements are issued when storage already exists.

This should remove the repeated Postgres NOTICE objects during normal idle ticks and reduce unnecessary Knowledge indexer startup/runtime work.

### Embedding provider cost log

There previously was no normal success log immediately before the paid embedding provider call; only tick/wake failures were logged. Added one info-level line per provider batch:

`[knowledge-indexer] Computing N embedding chunk(s) across M document(s) (docShort=count, ...); model=..., dimensions=..., chars=...`

This is intentionally one line per outbound embedding batch so operators can see paid work without dumping content or per-chunk detail.
