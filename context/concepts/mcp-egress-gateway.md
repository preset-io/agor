# MCP egress gateway

Internal contract for the daemon-mediated MCP egress path
(`apps/agor-daemon/src/mcp-egress/`). Modes, supported transports, capacity
limits, diagnostics, and rollout/rollback are documented for operators in
[`mcp-administration.mdx`](../../apps/agor-docs/content/guide/mcp-administration.mdx#mcp-connection-security);
don't restate them here.

## Credential boundary

In `compatibility` and `enforced` modes, reusable MCP provider credentials never
cross the daemon/executor boundary. Executors get an opaque
authenticated-encrypted capability (`capability.ts`) bound to:

- tenant, live Task, Session, prompting principal, credential owner;
- one MCP server and its monotonic `config_version`;
- an HMAC of every credential-bearing config field plus referenced session/user
  environment material;
- OAuth grant generation + binding fingerprint, when applicable;
- rollout mode, a unique capability id, and a keyed tool-policy fingerprint.

It contains no endpoint, headers, env, tokens, client secrets, or minted JWTs.
There is deliberately **no wall-clock expiry**: every use reloads the Task and
current authority, so long tasks keep working and terminal/revoked Tasks stop.

The daemon alone owns template/env resolution, OAuth refresh, JWT minting,
final header injection, pinned destination validation, redirect refusal, and the
outbound socket. Remote/delegated executors never fall back to raw config.

## Admission / linearization

There is no durable drain/lease state machine — it couldn't prove provider
observation or teardown, and crash recovery would mean unsafe mass quarantine.
Instead each physical HTTP hop has one admission point: after pinned DNS
resolution, immediately before socket construction, the gateway re-reads the
durable authority/version/grant.

> No hop is admitted after a relevant mutation commits. A hop admitted before
> the commit may complete and may already have been observed by the provider.

- Authority reads use one SQLite immediate transaction or one PostgreSQL
  repeatable-read snapshot. Runtime OAuth access/refresh values are excluded
  from the hashed material; grant generation/binding is explicit, so a routine
  refresh keeps the capability valid while disconnect, invalid-grant deletion,
  replacement, or binding change stops the next hop.
- Mutations use their existing transactions (`config_version` bump, attachment
  removal, grant deletion, Task/user/role/branch changes); the gateway does not
  duplicate those state machines.
- Connection pooling is off so a reused socket can't skip per-hop DNS and
  admission.
- The in-process `AbortController` map is an availability accelerator only.
  Correctness never depends on it or on another daemon seeing a hint (Redis may
  someday accelerate cancellation but must never decide admission). Hints carry
  only closed structured codes; durable reasons supersede them.
- If durable authority is unavailable, MCP fails closed; unrelated Tasks and
  conversation handles stay live.

### Credential acquisition

JWT client credentials go through `fetchJWTToken` with the same durable
assertion immediately before dispatch; process token caching is disabled for
gateway calls. OAuth refresh-token exchanges carry the task/session/tenant/server
assertion through DNS resolution to the instant before the token request. A
rejection before socket construction is a known no-send: PostgreSQL releases
only the exact claimed grant back to idle and SQLite removes only the matching
in-process flight — neither deletes or quarantines the grant. Failures after
socket construction are ambiguous.

### Templates

Gateway templates are a strict subset of the shared Handlebars renderer:
absolute `user.env.KEY` plus registered static helpers. When an ineligible form
might reference user env, only that server is omitted
(`template_configuration`) and the executor scrubs every user-defined env key.

### Tool rules

`ask` rules are not mediated: the server is omitted with
`approval_not_mediated`. `deny` rules are re-checked against decoded
`tools/call` input at the gateway.

## Reflection filtering

Providers (MCP and token) are credential recipients; a malicious one can
exfiltrate what it receives. Filtering only closes accidental reflection:
secret candidates come from final auth/custom headers, auth config, resolved
server env, referenced env values (including URL templates), and decoded URL
path/query. Floor is 8 chars / 4 distinct; untemplated literal URL parts use
16 / 8. JSON bodies and each JSON SSE `data` frame are decoded before
inspection; only allowlisted scanned headers and the bounded validated body reach
the executor. Non-JSON, oversized, or non-terminating responses fail closed. Not
a DLP guarantee against reversible encodings.

## Live reprojection

`POST /tasks/:id/mcp-reprojection` (executor-only) requires the exact live
executor token with matching task/session/principal/tenant; refuses
completed/stopping tasks and stale generations; is request-id idempotent; and
returns only daemon gateway URLs plus fresh opaque capabilities. Excluded
servers (stdio, template, OAuth, `ask`) become per-server actions without
blocking the ready subset. Server names/IDs are shown only to session
owner/admin; other Task viewers get a count.

| Adapter                                                   | Current-turn transport rebuild |
| --------------------------------------------------------- | ------------------------------ |
| Claude Agent SDK                                          | `setMcpServers`                |
| Claude Code CLI, Copilot, Codex, Gemini, OpenCode, Cursor | Next turn only                 |

- Never write a task capability into provider config on disk to fake hot reload.
  Claude keeps `sdk_session_id`; others preserve the conversation handle.
- No adapter can safely replay the exact model MCP call, so
  `retries_unstarted_call` is false everywhere. Gateway errors record proven
  unstarted vs ambiguous; neither is replayed.
- `disallowedTools` can't be mutated mid-query: gateway permission admission
  changes immediately, but tool visibility is a next-turn action.
- Claude serializes apply and validates the durable generation/request right
  before `setMcpServers`, so an older delayed response can't overwrite a newer
  transport. A timed-out apply records `transport_refresh_uncertain` and blocks
  further live refreshes that turn.
- Attachment mutations write one generation-numbered recovery state on the
  affected live Tasks only (bounded, paginated, one short tenant transaction per
  Task, after commit) and send private executor hints. Fanout failure can't
  change the mutation result; missed hints are recovered when admission rejects
  the stale capability and writes the same Task projection.
- A duplicate claim after restart/HA routing proceeds only if re-derived
  authority matches the projection digest first bound to the claim; drift fails
  closed. Settlement keeps a monotonic generation tombstone so late rejections
  for older authority are suppressed. The reprojection rate limiter is
  process-local and per-tenant; idempotency never depends on it.
- In `off`/`observe` there is no reprojection signaling (next-turn behavior).
  Downgrading converts pending mediated recovery into next-turn state, also
  applied lazily on executor registration/reconnect.

## Rollback

Binary rollback to a version without the gateway restores raw-secret projection
regardless of saved mode — treat it as a security downgrade.
