# Operational logging

Operational logs should give operators a lean, bounded, safe account of what the system was
doing: lifecycle changes and outcomes. They are not a transcript, payload archive, or metrics
store.

## Mechanics

`patchConsole()` (`packages/core/src/utils/logger.ts`) runs at startup in
`apps/agor-daemon/src/index.ts` and `packages/executor/src/index.ts`. It filters by level and
is **not** a structured logger or redactor. The level comes from `LOG_LEVEL`
(`debug|info|warn|error`). If that's unset, `DEBUG=*` or any `DEBUG` containing `agor` selects
debug. Otherwise the default is `info` when `NODE_ENV=production` and `debug` elsewhere.
`console.log` maps to info. Under systemd (`JOURNAL_STREAM` set), each line gets an
sd-daemon priority prefix.

`AGOR_LOG_FORMAT` selects the framing: `text` (default) or `json`. Text output is the raw
console arguments, unchanged. JSON is opt-in for hosted deployments whose log collector
parses JSON. Each console call becomes one JSON object on one stdout line, so stack traces and
object dumps stay one entry:

- `timestamp` (ISO-8601 emit time), `status` (`debug|info|warn|error`, from the console
  method), and `message` (the whole call rendered with `util.format`, capped at 16 KiB, with
  `"message_truncated": true` when cut).
- The active run context from `packages/core/src/utils/log-context.ts`, when known:
  `tenant_id`, `user_id`, `session_id`, `task_id`, `branch_id`, always full IDs. Values outside
  `^[A-Za-z0-9_.:-]{1,128}$` are dropped. The daemon fills them per service call (tenant scope,
  authenticated caller, executor token) and per task dispatch; an executor sets them once from
  its run payload. Timer work outside a request or dispatch carries only `tenant_id`.
- No `service`, `host`, `source`, `env`, `version`, or `component`: the collector owns those.
- JSON framing is not sanitization. `message` is exactly what the caller logged.

In JSON mode the logger also adds one process `'warning'` listener that logs
`[process.warning] name=<name> code=<code|none>`, never the warning text, and keeps existing
listeners. Set `NODE_NO_WARNINGS=1` together with `AGOR_LOG_FORMAT=json` so Node doesn't also
print the multi-line warning to stderr. Both variables are forwarded to local and launched
executors. Paths that run while the console is suppressed (e.g. inside an SDK call) use
`writeLogLine(level, text)`, which frames one line the same way and writes straight to the
process stream.

In text mode, normal events go to stdout and warnings/errors to stderr; in JSON mode every
line goes to stdout and `status` carries the severity. The environment owns routing. A
detached CLI daemon writes both streams to `~/.agor/logs/daemon.log`. Under systemd, output
goes to the journal and that file doesn't exist. Collect from the journal with a
`journald` source scoped by `include_units`; without it the whole host journal is collected.
Don't create an empty file, redirect output, or add a file logger to satisfy a stale file
tailer. APM traces and metrics don't prove logs are being ingested.

CLI output is UI, not logging. Don't add permanent `console.*` logging in `agor-ui`.

## What to log

- Meaningful server-owned outcomes, logged once by the owning layer: startup/shutdown, task
  dispatch and terminal state, environment start/stop, retry exhaustion, degraded fallbacks.
  A lower layer that can't recover returns a sanitized failure instead of logging and
  rethrowing.
- Use a stable `[area.operation]` prefix with bounded `key=value` fields in one string
  argument. An object argument renders as a multi-line dump that a key=value parser can't read.
  Failure lines name their run (for example `session_id=` and `task_id=` with full IDs), because
  text mode does not render the log context.
- No per-token, per-chunk, per-heartbeat, per-row, or per-loop logs. Leave them out, emit a
  summary, or use an existing rate limiter.
- Debug logs are exceptional, so `LOG_LEVEL=debug` stays usable. Remove one-off diagnostics
  before merging. Permanent ones belong behind a narrow `AGOR_DEBUG_*` flag tied to a known
  support workflow.

## Safety boundary

**No PII, user-authored values, or sensitive content.** Never log prompts, messages,
titles, names, slugs, labels, tool input/output, file contents, revealing paths, emails,
tokens, cookies, auth headers, connection strings, credentials, env values, request bodies,
commands, child stdout/stderr, or URLs that may contain secrets. "System-generated" doesn't
make a value safe; tokens, provider errors, URLs, and generated commands are still prohibited.
Redaction helpers are narrow and don't make an unsafe object safe to log. If unsure, log the
category or presence instead.

A UUID isn't safe just because it's a UUID. Log an identifier only when correlation needs it
and the destination's access control and retention are appropriate. Tenant IDs come from
trusted context, are used only for correlation, and must never let one tenant see or infer
another tenant's data.

Don't log raw exceptions, `Error` objects, or stacks. Log a stable code, the operation, IDs,
retryability, and a bounded, sanitized message:

```ts
console.warn(
  `[tasks.dispatch] failed task_id=${task.task_id} code=executor_unavailable retryable=true`
);
// not: console.error('[tasks.dispatch] failed', error);
```

Codex example (`packages/executor/src/sdk-handlers/codex/runtime-diagnostics.ts`): the Codex
SDK flattens most errors into prose, so most failures log as
`category=unknown metadata=unavailable`. Never parse, hash, or log that prose to infer a
cause.

## Logs vs analytics, telemetry, and accounting

- **Operator analytics** (`@agor/core/analytics`, off by default) is for curated,
  higher-cardinality metrics.
- **OSS telemetry** (`@agor/core/telemetry`) is opt-in, anonymous, and allowlisted.
- **Usage/cost** is durable task data (`normalized_sdk_response`), not something to
  reconstruct from logs.

None of these may carry content that logs are forbidden to carry, and all of them must
respect tenant isolation.
