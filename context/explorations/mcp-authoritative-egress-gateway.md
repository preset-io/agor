# Authoritative MCP egress gateway

Status: issue-ready design; not implemented by the #2500 auth-mutation slice.

## Why lifecycle invalidation is insufficient

Today an executor gives a provider SDK an MCP configuration containing an
endpoint or process command and, for some transports, credential material. Once
that SDK owns the client, a daemon-side generation check cannot close the gap
between “checked” and “sent.” Stopping a Task after a configuration write is an
availability optimization, not a revocation boundary:

- PostgreSQL does not expose an uncommitted “mutation pending” row to another
  transaction.
- A remote executor acknowledgement proves only that it sent an acknowledgement,
  not that a third-party SDK or subprocess stopped.
- an HTTP request or provider side effect already accepted before revocation
  cannot be recalled;
- credential-bearing environment and stdio process startup happen outside the
  daemon's request checks; and
- crash recovery cannot safely infer that an unobserved provider is quiescent.

The strong invariant therefore requires one owner for both credential use and
MCP egress. No executor or provider SDK may receive a reusable raw credential or
open a provider transport directly.

## Target invariant and linearization point

For each `(tenant, credential principal, MCP server)` authority:

1. Every tool request obtains a gateway read lease before credentials are
   resolved and retains it until the response, cancellation, or bounded timeout.
2. An authority mutation obtains the corresponding write lease. New read leases
   stop immediately. The mutation becomes authoritative only after admitted
   reads have completed or the gateway has closed their owned transports.
3. The write transaction increments a durable authority epoch, changes config or
   grants, records an outbox event, and commits. A request may dispatch only when
   its read lease and observed epoch are still current at the gateway's final
   send boundary.
4. Raw bearer, JWT, OAuth, header, and environment secrets remain inside the
   gateway/credential store. Executors carry an opaque, short-lived capability
   naming the tenant, Task, Session, prompter principal, server, and authority
   epoch.

“No old request after revocation” means no provider request is _admitted or
dispatched after the write lease linearization point_. A provider side effect
completed by a request admitted before that point is historical and cannot be
undone. The mutation API must either wait for those admitted operations or fail
closed with a bounded, actionable `egress_drain_failed` result; it must not claim
to revoke already-completed provider effects.

## Components

### Gateway-facing MCP transport

Expose an Agor-controlled MCP endpoint per effective server (or one endpoint
with a server capability). Claude, Codex, Gemini, Cursor, OpenCode, and delegated
executors connect only to that endpoint. The gateway validates the opaque Task
capability, resolves the current effective server through the canonical branch,
Session, Task, role/policy, attachment, and principal owners, and forwards
JSON-RPC under a read lease.

The Task capability is not a credential cache. It is audience-bound to the
gateway, short lived, non-transferable across tenant/Task/server, and checked
against durable Task activity and authority epoch on every call.

### HTTP, SSE, and long-lived transports

- The gateway owns DNS pinning, connection establishment, request bodies, and
  response streaming.
- Authorization is injected only after the final authority check. Redirects are
  either refused or followed by the gateway under the existing safe-outbound
  policy, with a new lease/epoch check at every hop. Authorization is never
  forwarded to a different origin.
- SSE, WebSocket, and streamable-HTTP connections are registered under the read
  lease. A write lease closes them and waits for gateway-observed closure; an
  executor acknowledgement is not part of the proof.
- Each JSON-RPC tool invocation has its own admission record even when it shares
  a pooled connection, so revocation can stop new calls without treating a TCP
  socket as authority.

### OAuth, JWT, and refresh

- OAuth access/refresh tokens and registered client secrets stay in the daemon's
  credential store. Refresh runs inside the gateway immediately before a call
  that needs it and rechecks the grant binding before returning an internal
  header value to the sender component.
- Routine access-token rotation retains the grant identity/authorization epoch
  and does not acquire an authority write lease. Reauthentication, disconnect,
  grant revocation, OAuth mode changes, client/binding changes, and subject
  changes do.
- JWT client-credential exchanges are performed inside the gateway. The minted
  bearer is request-local or bounded to the current read lease and is never
  returned to a remote executor.
- OAuth start, callback, polling, disconnect, and runtime failures use the same
  closed recovery categories already exposed by the daemon; provider details
  remain in redacted secure telemetry.

### stdio

Stdio cannot be made strong by proxying only HTTP. The gateway (or a co-located
trusted egress worker) must own the subprocess, its credential-bearing
environment, stdin/stdout JSON-RPC, and process group. Executors talk to the
gateway, never spawn the configured command. Acquiring a write lease stops
admission, closes pipes, terminates the gateway-owned process group, verifies
process absence, and only then commits the mutation. Delegated platforms need a
reviewed worker with the same contract; until then strong revocation is
unsupported for delegated stdio and must fail closed rather than silently fall
back to direct execution.

### PostgreSQL, SQLite, and multiple daemons

Database state is authority; Redis is only a wake-up hint.

- PostgreSQL uses short transactions, not an HTTP-long outer transaction. A
  per-authority row contains the epoch and mutation state. A write operation
  claims it with a row/advisory lock, sets durable `draining`, and coordinates
  with gateway-owned active leases before committing the new epoch.
- Active distributed leases need a bounded TTL plus gateway heartbeat and an
  ownership token. Expiry is not proof of third-party teardown, so an expired
  gateway owner leaves the authority quarantined until that owner is fenced by
  infrastructure or an operator-approved recovery verifies it cannot send.
- SQLite uses `BEGIN IMMEDIATE` and the same state machine without pretending it
  supplies cross-host coordination.
- Outbox delivery accelerates connection closure and UI refresh. Every gateway
  admission reads the durable epoch, so missed Redis events and daemon restarts
  converge lazily.

## Durable mutation state machine

Use an idempotent operation keyed by `(tenant, authority, requested mutation
fingerprint)`:

1. `requested`: mutation payload is validated and durably staged under the
   deployment's documented storage controls, but is not authoritative.
2. `draining`: new gateway reads are refused; current owned reads are cancelled
   or allowed to finish within policy.
3. `ready_to_commit`: all registered gateway transports are observably closed.
4. `committed`: config/grant change and epoch increment committed atomically;
   an outbox row announces the new epoch.
5. `failed` or `quarantined`: mutation did not become authoritative. Access stays
   disabled only when absence of an old gateway owner cannot be proven. The API
   returns an operational recovery code and an admin can retry the same operation.

Startup reconciliation resumes idempotent operations from durable state. It
never waits forever for an acknowledgement from a process that may not exist.
Quarantine has an explicit owner, reason, timestamp, and operator recovery path.

## Migration and compatibility

1. **Observe:** inventory every direct MCP configuration/credential handoff and
   emit secret-free telemetry for transports and SDKs in use.
2. **HTTP opt-in:** introduce the gateway behind a per-tenant feature flag. Keep
   direct mode behavior unchanged and label it as non-strong; do not mix direct
   and gateway clients for one authority.
3. **SDK adapters:** configure every provider SDK with the gateway endpoint and
   opaque capability. Preserve `sdk_session_id` and conversation resume handles;
   a transport refresh must not erase conversation state.
4. **Remote executors:** require gateway reachability and capability audience
   validation. Never export raw config as a compatibility fallback.
5. **stdio worker:** move process ownership and env injection into the trusted
   egress worker before enabling strong mode for stdio.
6. **Enforce:** once a tenant has no observed direct clients, make direct
   credential/config endpoints unavailable to executor tokens and enable the
   write-lease mutation contract.

Archives and existing MCP rows require no data-shape migration before rollout.
Today MCP auth/header/env secrets are stored in MCP JSON and OAuth grants in the
token tables according to the deployment's storage security; API, realtime,
and UI projections redact them, but the JSON is not application-encrypted by
this design. The gateway migration changes who may resolve and exercise those
values. Older executors remain supported only in explicitly non-strong mode
during rollout.

The existing owner/admin raw session-config route remains a compatibility path
for local executors. It must not be widened to collaborators or delegated
executors: a repeated Task check immediately before returning a raw secret does
not mediate the later provider send. Collaborator/delegated execution becomes
supported only when its SDK receives a gateway capability rather than raw MCP
configuration.

## Latency and availability budgets

These are rollout gates, not aspirations to measure after enforcement:

- capability validation and lease admission add at most 5 ms p95 and 25 ms p99
  within one region, excluding provider latency;
- gateway forwarding adds at most 20 ms p95 to ordinary HTTP JSON-RPC calls and
  must not buffer streaming responses beyond protocol framing;
- routine access-token refresh may consume the provider's latency but must add
  no authority write/drain cycle;
- mutation drain defaults to 10 seconds and has a 30-second hard ceiling, after
  which it returns `egress_drain_failed` or leaves the authority explicitly
  quarantined rather than waiting indefinitely;
- the gateway targets 99.99% monthly admission availability. Loss of the
  authoritative database/lease owner fails closed for new MCP calls; control
  plane and non-MCP conversation work remain available;
- capability/epoch lookups require bounded caches with a maximum 1-second TTL,
  invalidated eagerly by outbox hints but always checked at the final gateway
  send boundary for write-draining authorities.

## Acceptance tests for the gateway phase

- Held HTTP body send, redirect, pooled connection, SSE, and WebSocket tests
  prove no send occurs after write-lease admission.
- OAuth/JWT refresh tests hold credential resolution across revocation and prove
  no old or newly minted bearer leaves the gateway.
- Stdio tests hold a JSON-RPC request and credential-bearing environment while
  mutation terminates and verifies the process group.
- Collaborator, role/policy, branch grant/group/visibility, attachment,
  Marketplace permission/removal, OAuth disconnect/reauth, and deletion tests
  exercise the canonical effective-authority resolver.
- PostgreSQL tests use two real connections/daemons and cover transaction
  visibility, lock loss, crash between each state, outbox replay, and restart.
- Remote-executor tests kill the gateway owner and prove quarantine rather than
  accepting an unverifiable acknowledgement.
- Provider-side-effect tests document the admitted-before-linearization case and
  prove mutations either wait for it or return the bounded drain failure.

## Explicitly deferred from the current #2500 slice

The current delivery does not add runtime generations, authority watermarks,
remote quiescence acknowledgements, or strict hot reload. It provides safe
configuration mutation and actionable recovery. Existing Tasks may retain the
MCP clients with which their turn started; subsequent Task dispatch resolves the
saved configuration again. Strong active revocation and authoritative live
reload belong to this gateway phase.
