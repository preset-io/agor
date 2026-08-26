# Authoritative MCP egress gateway — implemented phase

Status: structural implementation for #2500, stacked on #2553. #2501 is not in
scope.

## Security objective

Reusable MCP provider credentials never cross the daemon/executor boundary in a
mediated rollout mode. Executors receive only an opaque authenticated-encrypted capability
bound to:

- tenant, live Task, Session, prompting principal, and credential owner;
- one MCP server and its existing monotonic `config_version`;
- an HMAC of every saved credential-bearing configuration field plus referenced
  session/user environment material;
- OAuth grant generation/binding identity when applicable; and
- the tenant rollout mode and a unique capability id.

There is intentionally no wall-clock expiry. Long tasks do not break after one
hour; every use reloads the Task and all current authority. Terminal/revoked
Tasks make the capability unusable. The capability contains neither endpoint,
headers, environment, access/refresh token, bearer token, JWT client secret, nor
minted provider token.

The daemon owns template/environment resolution, OAuth refresh lookup, JWT
minting, final header injection, pinned destination validation, redirect policy,
and the outbound socket.

## Chosen linearization contract

This phase does not implement a durable drain/lease state machine. That design
cannot honestly prove provider observation or transport teardown merely from a
JavaScript enqueue or `request.end()` acknowledgement, and crash recovery would
turn routine restarts into unsafe mass quarantine.

Instead, every physical HTTP hop has one explicit admission point: after pinned
DNS resolution and immediately before socket construction, the gateway reloads
and checks the durable authority/version/grant. The contract is:

> No hop is admitted after a relevant mutation commits. A hop admitted before
> the commit may complete and may already have been observed by the provider.

All constituent authority reads use one SQLite immediate transaction or
PostgreSQL repeatable-read snapshot. Runtime OAuth access/refresh values are
excluded from canonical durable material; grant generation/binding remains explicit.

Mutations use their existing transactions. MCP configuration updates already
advance `config_version` atomically. Attachment removal commits its relationship
change. OAuth disconnect/invalid-grant paths delete or replace the durable grant
identity. Task/user/role/branch changes remain in their canonical authorities.
The gateway does not duplicate these state machines.

An in-process `AbortController` map cancels matching local calls after observed
writes and rollout changes. It is an availability accelerator only. A second
daemon does not need its hint for correctness. PostgreSQL supplies HA visibility;
SQLite uses the same repository checks. Redis may later accelerate cancellation
but must never decide admission. Local hints carry only closed structured gateway
codes; the durable authority reason supersedes a hint when revalidation succeeds,
and unknown shutdowns collapse to generic egress unavailability.

## Transport boundary

Supported:

- bounded Streamable HTTP `POST` and `DELETE`;
- fully buffered JSON responses;
- fully buffered JSON-only SSE responses that terminate within 30 seconds and
  16 MiB.

GET/server-stream channels, unsupported methods, and all redirects are refused.

Refused before credential resolution/spawn:

- all stdio in compatibility and enforced modes;
- legacy SSE endpoint handoff;
- WebSocket;
- unbounded or unstructured streaming; and
- a server with any `ask` tool rule, until the canonical permission service can
  mint a one-shot tenant/task/session/server/tool receipt.

`deny` tool rules are checked again against decoded `tools/call` input. Remote or
delegated executors fail closed; no mediated path silently projects raw config.
Connection pooling is disabled so a previous socket cannot bypass per-hop DNS
and admission checks.

Capacity reservations bound concurrent calls to 32/process, 16/tenant, 4/task,
and 8/server before credential work. Exhaustion fails with a retryable bounded
429, limiting buffered response memory and sockets.

## Credential authority

Bearer/custom/environment material is resolved only in the daemon. JWT client
credentials go through `fetchJWTToken` with the same async durable assertion
immediately before the token-provider dispatch; process token caching is disabled
for gateway calls. OAuth authentication uses the canonical daemon OAuth service,
and refresh-token exchanges carry the same task/session/tenant/server assertion
through DNS resolution to the instant before the credential-bearing token request.
A rejected assertion or caller authority cancellation before socket construction
is typed as a known no-send outcome. PostgreSQL releases only the exact claimed
grant back to idle; SQLite removes only the matching in-process flight. Neither
path deletes or quarantines the prior per-user/shared grant. Real failures after
socket construction remain ambiguous.
A capability records grant generation and binding fingerprint. Final admission
reloads that identity, so disconnect, invalid-grant deletion, replacement, or
binding change stops the send. Routine access-token refresh keeps the same grant
identity and therefore does not unnecessarily revoke a task.

Gateway templates use a strict subset of the shared Handlebars renderer: absolute
`user.env.KEY` values and the registered static helpers, including nested/default
fallback expressions. Relative/context-changing paths, `@root`, `this`, `./`,
blocks, partials, unknown/dynamic helpers, and `lookup` are ineligible. When an
ineligible form might name user environment material, projection omits only that
server and executor defense-in-depth scrubs every user-defined environment key.

## Provider and reflection trust

The configured MCP provider and configured token provider are credential
recipients. A malicious provider can reversibly encode or exfiltrate what it
receives; this system does not claim otherwise.

Accidental reflection is closed at a structured boundary. Secret candidates come
from final auth/custom headers, auth configuration, resolved server environment,
all referenced environment values (including templates used in URL path/query),
and decoded URL path/query material. The baseline is eight characters and four
distinct characters; untemplated literal URL parts use a stricter 16/eight
floor to avoid treating common path names as credentials. JSON and each JSON SSE
`data` frame are parsed and decoded before inspection. Only allowlisted, scanned
response headers and the validated bounded body reach the executor. Non-JSON,
oversized, or non-terminating responses fail closed, so no indefinite unscanned
tail exists.

This is not a DLP guarantee against arbitrary reversible encodings.

## Rollout and product contract

Per-tenant modes:

- `off`: raw legacy projection;
- `observe`: raw projection plus secret-free observations;
- `compatibility`: only eligible servers are capability-projected; unsupported
  servers are omitted;
- `enforced`: identical mediated transport set and all legacy raw-secret paths
  fail closed.

Enforcement requires explicit confirmation that executors created before the
rollout were terminated. Emergency downgrade remains possible at any time, with
an explicit acknowledgement that reusable credentials will again reach
executors and a security audit log of tenant, actor, previous mode, and new mode.
There is no quarantine UI or recovery state.

Operators always receive a compact status control, including `off` with zero
calls. To avoid a noisy unusable operator banner, non-admins see nothing for the
default `off`/zero-call/zero-exclusion state and receive useful diagnostics once
there is mediated or actionable state. Lists are semantic,
buttons have accessible names, and status/error changes use polite/assertive live
regions. It never labels stdio, WebSocket, endpoint-handoff SSE, or unbounded
streaming as mediated.

## Query shape and budgets

A normal call loads one consistent authority/material snapshot and forwards
only the server, destination, headers, and material from that snapshot. It
performs one current-version/identity check immediately before
each physical dispatch. Redirects pay the latter once per hop. There are no
lease renewals, durable mutation polling, outbox reconciliation, quarantine
counts, or long credential-decryption transactions.

Target budgets remain <=5 ms p95 / <=25 ms p99 admission and <=20 ms p95 forwarding
overhead. This phase does not claim measured HA or 99.99% availability evidence. MCP alone fails closed if durable
authority is unavailable; unrelated Tasks and conversation handles remain live.
The repository includes a reproducible SQLite benchmark harness. PostgreSQL/HA
measurements are conditional on the managed environment and
`AGOR_TEST_POSTGRES_URL`.

Reference quiet-host SQLite run (2026-08-25, 200 warmed no-send admission checks): p50
3.450 ms, p95 4.236 ms, p99 5.088 ms. The harness is gated by
`AGOR_RUN_MCP_EGRESS_BENCHMARK=1`; these figures do not substitute for HA/PG
measurement. The harness reports rather than enforcing host-sensitive latency
thresholds and is not a release gate.

## Tests required at review

- opaque capability content, long-task lifetime, stale config, terminal Task,
  revoked principal/role, ACL and attachment removal, and cross-tenant scope;
- real two-connection SQLite and PostgreSQL provider-observation races for
  mutation-before-admission and admission-before-mutation;
- redirect refusal, bounded body/time/capacity, JSON/SSE decoded reflection, short
  low-entropy false positives, and safe response headers/logs;
- OAuth grant deletion/replacement and routine refresh, JWT mint mutation, and
  bearer/custom/env credential non-export;
- stdio refusal before spawn/write, ask/deny exclusion, malicious executor
  headers, and remote raw-secret fallback refusal;
- rollout guards, emergency downgrade acknowledgement/audit, health/status types,
  tenant isolation, source-mode tests, lint, boundaries, and UI keyboard/a11y.

## Migration and rollback

No schema migration is needed. This phase reuses tenant app variables,
`mcp_servers.config_version`, canonical OAuth grants, Tasks, users, branch access,
and session attachments. Rollout begins at `off`. Binary rollback to a version
without the gateway is equivalent to an explicit raw-secret downgrade regardless
of the saved tenant mode and must be handled as a security rollback.
