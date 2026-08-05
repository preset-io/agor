# Operational logging guidelines

**Keep the operational stream lean.** Its job is to answer, at a somewhat high level, “what was
the system doing at the time?” An operator should be able to follow meaningful lifecycle changes
and outcomes without searching through implementation chatter. Logs are a safe, bounded system
narrative—not a transcript, payload archive, exhaustive trace, or metrics warehouse.

## Current surfaces and responsibilities

The daemon and executor currently use `console.*`, patched by
[`packages/core/src/utils/logger.ts`](../../packages/core/src/utils/logger.ts). The patch filters
`debug`/`info`/`warn`/`error` using `LOG_LEVEL` (`info` in production, `debug` otherwise) and adds
systemd journal priorities when `JOURNAL_STREAM` is set; it is not a structured logger or a general
redactor. `console.log` is treated as `info`; there is no `trace` implementation today.

Write normal events to stdout (`console.log`/`info`/`debug`) and warnings/errors to stderr
(`console.warn`/`error`). In foreground development, these streams appear in the terminal. The
installed CLI's detached daemon currently combines both streams in `~/.agor/logs/daemon.log`;
containers, systemd, and other process managers may capture and route them differently. Emit the
stream and let the execution environment own routing and retention. CLI output is a user interface,
and browser console output is not a reliable server-side operational stream.

## What to log

- Log meaningful lifecycle or operation outcomes: process startup/shutdown, task dispatch and
  terminal state, environment start/stop, retry exhaustion, degraded fallbacks, and configuration
  changes with operational impact.
- Log once at the layer that owns the outcome. A lower layer that cannot recover should return a
  sanitized failure; the owning layer records it. Do not log and rethrow merely to repeat it.
- Prefer stable operation/event names and fields. With today's console API, use a consistent prefix
  and bounded `key=value` values. Permitted UUID entity IDs are useful correlation fields. Avoid
  arbitrary, high-cardinality text other than permitted IDs.
- Do not emit per-token, per-chunk, per-heartbeat, per-row, or per-loop success logs. Omit them,
  aggregate a useful completion summary, or use an existing sampler/rate limiter.

### Debug logging is exceptional

Do not add `debug` calls as a second copy of normal operations. `LOG_LEVEL=debug` should not make
Agor's logs unusable. For one-off investigation, add diagnostics locally and remove them before
merging.

Permanent debug logging needs a recurring operator problem that the lifecycle stream cannot
diagnose. Keep it narrow and bounded. An existing `AGOR_DEBUG_*` flag can be preferable to enabling
all debug calls; do not add one without a known support workflow. Flags such as
`DEBUG_SDK_MESSAGES` do **not** relax privacy: debug output must never dump SDK messages or other
prohibited content. Omit diagnostics that only explain ordinary control flow.

## Safety boundary

**Operational logs contain no PII or sensitive content.** Never log prompts, messages, tool
input/output, code or file contents, paths when they reveal user content, emails/names, access,
refresh, or API tokens, cookies, authorization headers, connection strings, credentials,
environment values, raw request bodies/headers, commands, stdout/stderr from child tools, or URLs
that may contain secrets. Redaction helpers are narrow, not permission to log an otherwise unsafe
object. If safety is uncertain, omit the value and log its safe category or presence instead.

UUID entity IDs may be correlation identifiers. Tenant IDs may be used on the same basis, but must
come from trusted tenant context—not request data—and never authorize access. Do not expose or infer
one tenant's data through another tenant's logs.

Errors must remain useful without dumping the source. Keep a stable category/code, operation,
relevant UUIDs, retryability/outcome, and a bounded sanitized message. Do not blindly log
provider/network/database exceptions, `Error` objects, stacks, commands, payloads, or captured
stdout/stderr. Include a reviewed stack only at `debug`; development does not make unsafe data safe.

```ts
// Good: stable, correlatable, bounded.
console.warn(
  `[tasks.dispatch] failed task_id=${task.task_id} code=executor_unavailable retryable=true`
);

// Bad: the exception may contain a URL, headers, query text, or payload.
console.error('[tasks.dispatch] failed', error);

// Good: summarize a meaningful completed operation once.
console.log(`[executor.stream] completed task_id=${taskId} chunks=${chunkCount}`);

// Bad: noisy and potentially content-bearing.
console.log('[executor.stream] chunk', chunk);
```

## Logs, analytics, telemetry, and accounting

These are separate current mechanisms:

- **Operational logs** diagnose a running system and provide its lifecycle narrative.
- **Operator-configured analytics** (`@agor/core/analytics`, disabled by default) sends curated,
  structured lifecycle and higher-cardinality metrics to configured stdout or HTTP-batch plugins.
  Use it for intricate metrics and warehouse analysis rather than noisy operational logs.
- **Open-source telemetry** (`@agor/core/telemetry`) is separate, opt-in community telemetry with an
  anonymous random install ID, a small event allowlist, property sanitization, and aggregate usage
  summaries.
- **Usage/accounting** is durable task data (`normalized_sdk_response`) queried by the leaderboard
  service for token, cost, duration, and grouping reports; it is not reconstructed from logs.

Analytics does not relax privacy or tenant isolation: curate fields, propagate trusted tenant
context, and apply the destination's retention/access policy. Never move forbidden log content to
analytics or telemetry.

## Contributor checklist

- Is this event useful for diagnosis or action, and does the owning layer log it only once?
- Is `error` an operation failure, `warn` degraded/risky but continuing, and `info` a meaningful
  lifecycle event shown by default? If this is `debug`/`trace`, what recurring support problem
  justifies keeping it in the codebase?
- Are every message and field safe even if an upstream error or value is hostile?
- Is volume bounded under load, with atomic events omitted, summarized, or controlled?
- Is this a system narrative (log), curated analysis event (analytics/telemetry), or durable usage
  fact (database)?

## Prior art

This policy applies the [Twelve-Factor logs-as-event-stream principle](https://12factor.net/logs),
OWASP's guidance on [event selection, sanitization, and excluded data](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html),
and Google SRE's advice on [verbosity, sampling, structured logs, and correlation IDs](https://sre.google/sre-book/effective-troubleshooting/)
to Agor's current implementation.
