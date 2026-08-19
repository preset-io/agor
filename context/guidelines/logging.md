# Operational logging guidelines

Operational logs should tell a safe, bounded story of what Agor did. They are an event stream for
operators, not a transcript, payload archive, or metrics warehouse.

**Keep that story lean.** Its job is to answer, at a somewhat high level, “what was the system doing
at the time?” An operator should be able to follow meaningful lifecycle changes and outcomes
without searching through implementation chatter.

This document owns the operational logging policy. For the exact mechanics of the current console
patch, process entry points, and destinations, see
[`packages/core/src/utils/LOGGING.md`](../../packages/core/src/utils/LOGGING.md).

## Current surfaces and responsibilities

The daemon and executor currently use a patched `console.*`. The patch filters output, but it is not
a structured logger or redactor. The implementation document linked above owns the current level
mapping, defaults, systemd behavior, startup points, and detached-daemon capture details.

Write normal events to stdout (`console.log`/`info`/`debug`) and warnings/errors to stderr
(`console.warn`/`error`). Emit the stream and let the execution environment own routing and
retention. CLI output is a user interface, not operational logging. Do not add permanent `console.*`
operational logging in `agor-ui`: browser output is user-controlled, inconsistently retained, and
unavailable to server operators. Use UI feedback for failures; remove temporary browser diagnostics
before merging.

## What to log

- Log meaningful lifecycle or operation outcomes: process startup/shutdown, task dispatch and
  terminal state, environment start/stop, retry exhaustion, degraded fallbacks, and configuration
  changes with operational impact.
- A user action is not automatically a log event. Log only a meaningful server-owned outcome or
  lifecycle transition caused by it, once at the owning layer. Record permitted system-generated
  identifiers, operation names, and safe result categories—not user-authored values.
- A lower layer that cannot recover should return a sanitized failure. Do not log and rethrow merely
  to repeat the owning layer's event.
- Prefer stable operation/event names and fields. With today's console API, use a consistent prefix
  and bounded `key=value` values. Include an identifier only when it is operationally necessary for
  correlation, its classification permits logging, and the destination's access controls and
  retention are appropriate. UUID shape alone does not make an identifier safe. Avoid arbitrary,
  high-cardinality text.
- Do not emit per-token, per-chunk, per-heartbeat, per-row, or per-loop success logs. Omit them,
  aggregate a useful completion summary, or use an existing sampler/rate limiter.

### Debug logging is exceptional

Do not add `debug` calls as a copy of normal operations. `LOG_LEVEL=debug` should remain usable. Add
one-off diagnostics locally and remove them before merging.

Permanent debug logging needs a recurring operator problem that the lifecycle stream cannot
diagnose. An existing narrow `AGOR_DEBUG_*` flag can be preferable to enabling all debug calls; do
not add one without a known support workflow.

`DEBUG_SDK_MESSAGES=true` is a legacy unsafe diagnostic that dumps raw SDK messages from the
executor. Raw messages can contain prohibited content. It must not be enabled where process output
is retained or shared, and new logging must not copy this pattern. Its presence does not relax any
rule in this policy.

## Safety boundary

**Operational logs contain no PII, user-authored values, or sensitive content.** Never log prompts,
messages, titles, descriptions, labels, names, slugs, tool input/output, code or file contents,
paths when they reveal user content, emails, access, refresh, or API tokens, cookies, authorization
headers, connection strings, credentials, environment values, raw request bodies/headers,
commands, stdout/stderr from child tools, or URLs that may contain secrets. “System-generated” does
not mean safe: tokens, provider errors, URLs, environment values, and generated commands remain
prohibited. Redaction helpers are narrow, not permission to log an otherwise unsafe object. If
safety is uncertain, omit the value and log its safe category or presence instead.

Identifiers are data, and UUID shape alone is not a safety classification. Use an entity or tenant
identifier only when it is operationally necessary for correlation, its classification permits
logging, and the destination's access controls and retention are appropriate. Tenant IDs must come
from trusted tenant context and are correlation data only; they must never authorize access.
Logging an identifier must never cause cross-tenant exposure or allow cross-tenant data to be
inferred.

Keep errors useful without dumping the source: stable category/code, operation, relevant UUIDs,
retryability/outcome, and a bounded sanitized message. Do not blindly log exceptions, `Error`
objects, stacks, commands, payloads, or captured stdout/stderr. Include a reviewed stack only at
`debug`; development does not make unsafe data safe.

```ts
// Good: stable and bounded.
console.warn(
  `[tasks.dispatch] failed task_id=${task.task_id} code=executor_unavailable retryable=true`
);

// Bad: the exception may contain secrets or payloads.
console.error('[tasks.dispatch] failed', error);
```

## Logs, analytics, telemetry, and accounting

These are separate current mechanisms:

- **Operational logs** diagnose a running system and provide its lifecycle narrative.
- **Operator-configured analytics** (`@agor/core/analytics`, disabled by default) sends curated,
  structured lifecycle and higher-cardinality metrics to configured stdout or HTTP-batch plugins.
  Use it for intricate metrics and warehouse analysis rather than noisy operational logs.
- **Open-source telemetry** (`@agor/core/telemetry`) is separate and opt-in, with an anonymous
  install ID, event allowlist, sanitization, and aggregate usage summaries.
- **Usage/accounting** is durable task data (`normalized_sdk_response`) queried by the leaderboard
  service for token, cost, duration, and grouping reports; it is not reconstructed from logs.

Analytics does not relax privacy or tenant isolation: curate fields, propagate trusted tenant
context, and apply the destination's retention/access policy. Never move forbidden log content to
analytics or telemetry.

## Contributor checklist

- Is this useful or actionable, and logged only by the owning layer?
- Is `error` an operation failure, `warn` degraded/risky but continuing, and `info` a meaningful
  lifecycle event shown by default? If this is `debug`/`trace`, what recurring support problem
  justifies keeping it in the codebase?
- Is every field safe even if its source is hostile?
- Is volume bounded under load, with atomic events omitted, summarized, or controlled?
- Is this a system narrative (log), curated analysis event (analytics/telemetry), or durable usage
  fact (database)?

## Prior art

This policy applies the [Twelve-Factor logs-as-event-stream principle](https://12factor.net/logs),
OWASP's guidance on [event selection, sanitization, and excluded data](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html),
and Google SRE's advice on [verbosity, sampling, structured logs, and correlation IDs](https://sre.google/sre-book/effective-troubleshooting/)
to Agor's current implementation.
