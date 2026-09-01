# Process-affine and transient-state HA support matrix

**Date:** 2026-08-07

**Status:** superseded by the constrained HA activation integrated on 2026-08-09; retained as the detailed process-affine audit. The built-in MCP endpoint is stateless, and PostgreSQL-backed MCP OAuth is enabled only after its offline cutover and shared-secret prerequisites.

**Base:** `8d5d9ed3` plus the uncommitted Redis/realtime HA integration

**Private design predecessor:**
[`Daemon HA readiness: distributed work model and prerequisite plan`](agor://kb/document/019fd41f-0cbc-756c-a22d-8d2ecac0176b)
**Private Knowledge successor/mirror:**
[`Process-affine HA support matrix`](https://agor.sandbox.preset.zone/ui/kb/agor-cloud-team/architecture/process-affine-ha-support-matrix-2026-08.md)
**Longer-term durable interactive-permission design:**
[`Durable permission-boundary resume`](agor://kb/document/019fe832-cafa-7cbe-af21-728c260ff1ca)

## Decision

The daemon is safe to start as an interchangeable active-active fleet only in
the explicit `constrained-active-active` profile. The profile activates the
merged PostgreSQL scheduler, Session queue, Task runtime, executor-token,
Knowledge indexer, and audited gateway foundations while failing closed on the
process-affine surfaces below. It is not a claim that every daemon feature is
HA-safe.

Two P0 contradictions were especially important in the initial audit:

1. **Resolved on this branch:** when the selected execution substrate survives
   the launcher daemon, the Task runtime design lets its detached executor
   reconnect through another daemon. PostgreSQL mode now fingerprints the
   signed JWT, persists its full tenant/user/resource authority, and atomically
   validates it on any daemon. SQLite retains the issuer-local Map
   (`apps/agor-daemon/src/services/session-token-service.ts:175-216,223-298,300-388`;
   `packages/core/src/db/repositories/executor-session-token-authorities.ts:107-198`).
2. Task control rooms are Feathers `app.channel` objects
   (`apps/agor-daemon/src/utils/realtime-publish.ts:67-84,94-95,651-658`), not
   native Socket.IO rooms. Installing the Socket.IO Redis adapter alone would
   not replicate Feathers' process-local membership or make a publisher on
   daemon B see an executor connection on daemon A.

The implemented contract is therefore:

- keep standalone as the compatible default, but select
  `taskRuntimePolicy: 'shared_postgres'` only after explicit validated HA
  activation;
- bridge Feathers publications through Socket.IO `serverSideEmit`, then rerun
  tenant/RBAC publication on every receiving replica; native rooms remain
  separately tenant-qualified and authorized;
- keep the built-in stateless MCP endpoint, durable MCP OAuth, and
  PostgreSQL-backed GitHub App setup enabled while disabling web terminals,
  OpenCode native-state OAuth, and Codex device auth. MCP OAuth browser
  admission remains exact-socket local; its PostgreSQL callback authority and
  tenant-qualified completion hints are fleet-routable, while MCP OAuth/token
  services stay off the generic Feathers relay. Slack, GitHub, and Shortcut
  gateway listeners are enabled through the merged PostgreSQL lease/occurrence
  fences; Teams and unimplemented providers fail closed;
- preserve all existing SQLite/standalone behavior.

PostgreSQL remains the only durable authority. Redis is a Socket.IO fanout
transport, not a token registry, lease store, callback store, rate-limit
authority, or domain state machine.

## Implemented prerequisite: PostgreSQL executor-session token authority

Current main supplies the executor-token prerequisite from the ordered list
below. This integration consumes it only after explicit constrained HA
activation; it does not widen the remaining process-affine surfaces.

- `executor_session_token_authorities` persists SHA-256 of the high-entropy
  signed JWT, never the bearer, together with tenant, type, purpose, Session,
  optional Task/branch, user, expiry, max/use count, last-use, and revocation
  (`packages/core/drizzle/postgres/0075_executor_session_token_authority.sql:1-18`).
  A random JWT `jti` makes otherwise-identical same-second issuances distinct
  (`session-token-service.ts:245-262`).
- Signature, algorithm, issuer, audience, expiry, purpose/type, trusted tenant,
  user, Session, Task, and branch are checked before the fingerprint reaches the
  repository. The authority row must then match every fact and be live;
  signature validity alone cannot bypass revocation, expiry, absence, or use
  policy (`session-token-service.ts:300-388,447-484`).
- Bounded-use validation is a single conditional PostgreSQL `UPDATE`; competing
  daemons cannot both claim the final use. Values `<= 0` retain the existing
  unlimited per-RPC/reconnect contract without incrementing a diagnostic
  counter (`executor-session-token-authorities.ts:107-198`). Task executor
  issuance explicitly remains `maxUses: -1` because the same bearer is
  authenticated for every protected RPC and on reconnect
  (`register-services.ts:824-846`). Reconnect therefore does **not** consume a
  distinct “connection use.”
- Issuance commits its authority transaction before returning the bearer, even
  when called inside a domain transaction; bounded-use consumption likewise
  commits independently of the later protected RPC result. Validation and
  revocation database errors propagate, so PostgreSQL authentication fails
  closed and never falls back to the local Map (`session-token-service.ts:200-216,
264-298,332-351,390-406`). Stable shared signing secrets remain mandatory but
  are not an authority substitute.
- Forced RLS and explicit tenant predicates bind every normal operation. The
  only cross-tenant maintenance capability is read-only discovery of tenant IDs
  for rows already beyond the 24-hour tombstone window; deletion then re-enters
  ordinary tenant scope (`0075_executor_session_token_authority.sql:31-55`;
  `session-token-service.ts:126-151`). The table is tenant-deleted but excluded
  from export/import because restoring it could reactivate an extant bearer.
- Every daemon performs bounded hourly cleanup. Expired/revoked rows are
  retained for 24 hours and then deleted; absence is permanently fail-closed
  (`session-token-service.ts:35-37,424-496`;
  `executor-session-token-authorities.ts:245-301`). Cleanup failure is retryable
  and logs only a stable category, never DB errors, bearers, fingerprints, or
  claims.
- SQLite receives a compatible schema-history mirror but the runtime continues
  to use its historical process-local raw-token Map
  (`packages/core/drizzle/sqlite/0078_executor_session_token_authority.sql:1-27`;
  `session-token-service.ts:280-293,354-388`).

### Review remediation

The first Codex review and PostgreSQL CI exposed three blocking integration
gaps, all corrected before follow-up review:

- the tenant database identity now classifies movable and non-portable tables
  separately. Archives carry the non-portable classification but never its
  rows, and import/re-home treats any destination authority row as occupied
  rather than silently retaining it;
- retention SQL uses the Drizzle timestamp column encoder for every raw
  PostgreSQL `Date` parameter, including the integration fixture;
- executor `onExit` explicitly accepts asynchronous callbacks and centrally
  observes synchronous throws and promise rejections with bounded, secret-safe
  logging, so revocation failure is not an unhandled rejection.

Reconnect coverage now enters the production Feathers `ServiceJWTStrategy`
twice with distinct connection objects. The PostgreSQL form still issues on
daemon A and performs both authentications through daemon B; the fast form
executes without the PostgreSQL test gate so this boundary cannot silently
degrade when the database suite is unavailable.

### Owner death and recovery after this prerequisite

If daemon A issued the token and dies, its sockets and any in-flight ACK still
die. The executor reconnects and reauthenticates through daemon B with the same
JWT. B verifies the shared signature and claims, then claims the PostgreSQL
authority row; it does not need A's memory. It can resume the durable Task
heartbeat/Stop contract. Revocation and expiry are visible on every daemon.

If PostgreSQL is unavailable, issuance fails before returning a bearer and
authentication/revocation raise an error. There is no local fallback. Existing
connections may continue at the transport layer, but their next protected RPC
cannot authenticate. When PostgreSQL recovers, authentication resumes from the
same authority rows and use counts. A revocation attempted while PostgreSQL is
down is not durably recorded merely by task/launcher exit; the current caller
surfaces the error, but automatic durable retry is a remaining lifecycle risk
called out for Max below.

### Rollout and rollback

This migration is additive, but **mixed application versions are not safe**.
Old daemons issue only local authorities; new daemons require PostgreSQL rows,
and neither can import the other's live token state. Rollout must migrate first,
drain/terminate active executors, replace all daemons as one compatibility
cohort, then issue fresh tokens. Do not canary active execution across old/new
versions.

Rollback likewise drains active executors and returns the whole fleet to the
old cohort; existing new-version tokens will not authenticate there. The table
may remain in place because old SQLite/PostgreSQL code does not read it. Dropping
the table is unnecessary and would erase revocation/use evidence. Reapplying
the new cohort issues fresh authorities.

## Classification legend

| Mark  | Meaning                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| **L** | Safely replica-local; loss changes only optimization/diagnostics or causes an explicit retry.                           |
| **R** | Reconstructable by an authenticated client/executor from PostgreSQL or signed immutable claims.                         |
| **S** | Can use native Socket.IO Redis room fanout after membership and tenant scoping are fixed. Redis is not the authority.   |
| **A** | Needs ingress affinity or deterministic application owner routing. Ordinary Engine.IO stickiness alone is insufficient. |
| **P** | Needs shared PostgreSQL persistence and an atomic consume/transition.                                                   |
| **E** | Needs a short per-resource PostgreSQL lease plus a fencing token around process/external ownership.                     |
| **D** | Must be disabled or make HA startup fail initially.                                                                     |

Marks are composable. For example, a process can need **P+E+A**: durable
ownership, a fenced live owner, and routing to that owner.

## Transport substrate and room audit

| Surface                        | Evidence and current binding                                                                                                                                                                                                                    | Classification                                | Owning-daemon death / reconnect behavior                                                                                                                                                                                | Initial HA disposition                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine.IO WebSocket/polling    | Server and browser both enable `['websocket', 'polling']` (`apps/agor-daemon/src/setup/socketio.ts:325-339`; `packages/core/src/api/index.ts:1125-1140`).                                                                                       | **A** for the Engine.IO connection only       | A WebSocket remains on one daemon until disconnect. Polling or upgrade requests that hit another daemon do not have that daemon's Engine.IO session. After death the client opens a new connection and reauthenticates. | Require ingress stickiness for polling/upgrade, prefer WebSocket, and test reconnect to a different replica. This affinity does **not** select a terminal/MCP/OAuth resource owner. |
| Socket.IO Redis fanout         | Explicit HA creates separate ioredis pub/sub clients, attaches `@socket.io/redis-adapter` under a deployment prefix, and includes both clients/adapter/drain in readiness.                                                                      | implemented **S**, still non-durable          | Live sockets remain owner-local; owner death disconnects them. Redis outage makes every daemon unready and notifications during the gap are not replayed.                                                               | Supported in constrained HA with private Redis, bounded reconnect, explicit affinity, readiness removal, and client refetch.                                                        |
| Feathers realtime channels     | Authenticated, tenant, session-stream, and executor-task membership remains process-local, so the integration relays after-hook `dispatch` envelopes with root-namespace `serverSideEmit` and reruns receiving-replica tenant/RBAC publication. | implemented **S** with receiver authorization | Membership still disappears with its socket, but an event originating on another daemon reaches authorized local connections exactly once in the tested topology.                                                       | Supported for the audited event inventory; denied secret-bearing services remain local and auth-resolved multi-tenant deployment still needs end-to-end certification.              |
| Native user rooms and presence | Rooms are tenant-qualified; auth replacement/logout clears old membership; board watch calls authenticated tenant-scoped `boards.get` before join.                                                                                              | implemented **S**                             | Reconnect recreates authorized membership. No live room membership is reconstructed on owner death.                                                                                                                     | Supported for the audited presence/repo event inventory with cross-tenant/anonymous negative tests. Terminal/OAuth packets remain gated.                                            |

### Socket.IO acknowledgements are not failover transactions

An acknowledgement belongs to the socket and daemon that handled the packet.
Redis fanout cannot resurrect an in-flight callback after that daemon dies. The
executor client uses a 60-second ACK deadline
(`packages/executor/src/services/feathers-client.ts:18-24,120-140`) and does not
blindly retry a stranded mutation. The integration proof deliberately confirms
one mutation followed by a timeout, not duplicate execution
(`apps/agor-daemon/src/setup/socketio-ack.integration.test.ts:46-90`), and the
executor converges the turn to failure on the terminal-boundary case
(`socketio-ack.integration.test.ts:92-269`).

That is a safe at-most-once posture, but it is not seamless failover. Durable
methods that need a stronger UX must use a stable operation ID plus PostgreSQL
read-after-timeout; an ACK or Redis delivery must never be the commit proof.

## Browser web terminal and PTY matrix

The terminal is one long-lived bridge process per user and one Zellij session
with tabs per branch (`apps/agor-daemon/src/services/terminals.ts:97-105`). The
PTY and Zellij process are executor-owned, not daemon-owned
(`packages/executor/src/commands/zellij.ts:30-39,368-390`).

| Item                                                      | Current state and authorization                                                                                                                                                                                                                                                                                                                        | Classification                           | Exact owner-death behavior                                                                                                                                                                                                                                                                  | Can another daemon reconstruct?                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terminals.create`, branch selection, tab choreography    | HTTP path loads the authenticated user and branch inside the active tenant and requires branch `session` permission when RBAC is enabled (`terminals.ts:173-218,528-577`). Active branches and start serialization are local Maps (`terminals.ts:239-265`).                                                                                            | **A+E+D**                                | If the daemon dies before/after spawn, the local reservation and branch/tab intent vanish. Concurrent creates on two replicas can both see no bridge and spawn two executors.                                                                                                               | The branch/user facts are in PostgreSQL, but bridge ownership and tab intent are not. A per-tenant/user lease must fence spawn; create/tab control must reach the lease owner or become a durable command.                                                               |
| Readiness, waiters, errors                                | `readyExecutors` and `readyWaiters` are local (`terminals.ts:267-290,320-354`). Socket `terminal:ready/error` becomes a process-local `app.emit` (`socketio.ts:868-887`), then the local service emits to the browser room (`terminals.ts:297-317`).                                                                                                   | **A+R+D**                                | Waiters on the dead daemon disappear. If executor and browser reconnect to different daemons, the executor's ready ACK updates only its daemon; a create waiter on the other daemon times out and may spawn a duplicate.                                                                    | A surviving executor re-announces readiness after reauth (`zellij.ts:273-302`), so the fact is reconstructable only on the daemon that receives that socket. Redis room fanout does not replicate `app.emit` or the local ready set.                                     |
| Active executor socket selection and duplicate retirement | `activeTerminalExecutorByUser` is local (`socketio.ts:468-469`). An executor join shuts down only the previous socket known to that replica (`socketio.ts:747-753`); disconnect deletes only local entries (`socketio.ts:787-791`).                                                                                                                    | **E**, optionally **A**; otherwise **D** | Two replicas can each retain an active bridge. A browser daemon with no local exact socket target falls back to the whole room for input/resize (`socketio.ts:808-842`), so duplicate bridges both consume keystrokes.                                                                      | Not from PostgreSQL. Use a tenant/user lease with a generation/fence. Native Socket.IO targeting can reach a remote socket through Redis only after the winning socket identity/generation is known safely.                                                              |
| PTY input/resize/output/tab/exit                          | Browser input/resize must match the authenticated user's ID; executor output/tab/exit must carry a terminal-scoped service JWT for that same user (`socketio.ts:643-708`). Join is limited to `user/<self>/terminal` (`socketio.ts:710-785`). Branch RBAC is enforced only when the HTTP path asks the daemon to create a tab (`socketio.ts:619-624`). | **S** after **E** and room hardening     | All sockets attached to the dead daemon disconnect. The bridge keeps PTY/Zellij alive for a 30-second authenticated reconnect grace, then kills the PTY bridge and exits (`zellij.ts:42-73,304-330`). Zellij itself can outlive a detached bridge. Buffered output not yet emitted is lost. | The terminal-scoped JWT is stateless and can authenticate at another replica if every replica shares the signing secret. The bridge rejoins and re-announces (`zellij.ts:273-302`). It cannot safely resume cross-replica input until single-bridge ownership is fenced. |
| Terminal service JWT                                      | Thirty-day signed token is bound to `terminal_user_id`, rejected from REST/Feathers services, and valid only on its user's terminal events (`terminals.ts:45-61,582-593`; `socketio.ts:673-708`). Room name does not include tenant. There is no revocation.                                                                                           | **R**, with security prerequisite        | Owner death does not invalidate it. It works at a peer with the same stable JWT secret until expiry.                                                                                                                                                                                        | Yes, cryptographically. Tenant and user must both be included in room identity/validation before fleet fanout; token rotation/revocation remains a separate security debt.                                                                                               |
| Output coalescing, rate limit, cleanup                    | Output buffer is executor-local, capped at 64 KiB/16 ms (`zellij.ts:153-228`). Input token bucket is per socket, burst 1000/refill 500 per second (`socketio.ts:630-635,811-826`). Service cleanup clears local tracking; executor disconnect grace owns PTY cleanup (`terminals.ts:681-725`; `zellij.ts:304-330`).                                    | **L**                                    | Coalesced tail and rate-limit history vanish; reconnect starts a new bucket. Daemon cleanup cannot kill or prove absence of a remote bridge.                                                                                                                                                | No reconstruction is needed for buffers/buckets. Rate limiting is best-effort, not a fleet security quota. Ownership cleanup needs the lease/fence above.                                                                                                                |

**Terminal conclusion:** ordinary load-balancer stickiness is not enough. Browser
and executor have independent Engine.IO sessions/cookies, and `terminals.create`
is a separate HTTP/service operation. Initial HA must either (a) disable web
terminal, or (b) introduce a tenant/user PostgreSQL lease plus deterministic
owner routing and tenant-qualified native rooms. Option (a) is recommended for
the first activation branch.

## Task executor control matrix

| Item                                    | Current state and authorization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Classification                                           | Exact owner-death behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Initial HA disposition                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executor-session credential authority   | **Implemented here.** PostgreSQL stores only a SHA-256 bearer fingerprint plus tenant/user/type/purpose/Session/Task/branch/expiry/revocation/use facts under forced RLS (`session-token-service.ts:223-388`; `executor-session-token-authorities.ts:107-243`; migration `0074`:1-55). SQLite alone retains the local raw-token Map.                                                                                                                                                                                                                                                                                                                                                       | **P+R** implemented; no longer **D** for this credential | A's death drops only its connection. Initial auth or reconnect at B verifies the shared signature and exact claims, then validates the PostgreSQL row. Revocation, expiry, and bounded use are fleet-visible. In-flight ACK behavior is unchanged. Tokens issued by a pre-migration/old daemon have no row and fail closed.                                                                                                                                                                                                | Supported after migration plus an all-at-once daemon cohort replacement with shared signing secrets. No Redis token state and no owner routing. PostgreSQL outage fails authentication closed.                                                                                                                 |
| Task connect, heartbeat, and Stop truth | Executor claims `dispatching -> running` durably (`tasks.ts:1277-1304`). Heartbeat writes PostgreSQL and returns durable `stopping` even when realtime was missed (`tasks.ts:1370-1394`). Termination request/coordination/settlement are durable Task state.                                                                                                                                                                                                                                                                                                                                                                                                                              | **R**                                                    | If the launcher daemon dies but executor survives, it can now reauthenticate through any new-version daemon, resume heartbeat, and observe Stop. If it never reconnects, stale-heartbeat reconciliation claims containment; without authoritative remote absence it can remain guarded/unverified.                                                                                                                                                                                                                         | No Task owner routing or fleet leader. PostgreSQL remains authority. Realtime Stop is latency only.                                                                                                                                                                                                            |
| Task control room                       | Executor joins `executor-task:${tenant}:${task}` only after a verified executor JWT's signed `task_id` matches the auth result. The HA Feathers relay carries `termination_requested`, and each receiving replica re-resolves only its local tenant/task channel before dispatch.                                                                                                                                                                                                                                                                                                                                                                                                          | **R+S** in constrained HA                                | Room disappears with the connection/daemon, but a connected executor on any replica receives the low-latency event. Stop also survives in the Task row; reconnect/heartbeat reconstructs it if realtime was missed.                                                                                                                                                                                                                                                                                                        | Supported with receiver-side tenant/task containment. Durable Task state remains correctness; Redis is latency only. Cross-replica positive and wrong-tenant negative contracts cover the bridge.                                                                                                              |
| Feathers RPC acknowledgements           | Client reauth is process-local single-flight and one-shot 401 retry (`feathers-client.ts:154-196`); non-auth ACK timeout is not retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **L+R** only method-by-method                            | Death after DB commit but before ACK gives the executor an ambiguous failure. Current containment boundary intentionally fails the Task rather than replaying arbitrary mutations. Heartbeats repeat naturally; Stop callers can read Task state.                                                                                                                                                                                                                                                                          | Document at-most-once failover. Add stable operation IDs/read-after-timeout only for methods whose UX must survive the ambiguity. Redis ACKs do not solve it.                                                                                                                                                  |
| Permission request and decision         | The pending Promise/timeout remains local to the surviving executor process (`packages/executor/src/permissions/permission-service.ts`; `permission-manager.ts`). The decision route authorizes a hooked Session read, binds request+Task to the persisted permission Message, derives the approver from authenticated params, and emits `messages.permission_resolved` without patching durable state (`permissions/deliver-permission-decision.ts`). The Feathers publisher treats that event like Stop: only `executor-task:${tenant}:${task}` receives it locally or after the HA relay. The executor then patches the Message and Task before returning the decision to the provider. | live executor **R+S**; no replay                         | Origin-daemon death is harmless before the click because any daemon can admit and relay it. If the transient delivery is lost, the Message remains pending and the button remains retryable. If delivery reaches the executor and that process dies before its patches commit, no approval is recorded and the provider cannot proceed. If it commits and the response/patch event is missed, clients refetch the committed Message. Executor death still loses the waiter and Task reconciliation owns the stale runtime. | Enabled for Claude, Copilot, and OpenCode Agor-managed callbacks. Gemini/Codex provider-native prompt modes remain gated. This is deliberate manual retry, not automatic decision replay or exactly-once messaging; use the linked durable boundary design only if that product contract becomes insufficient. |
| `awaiting_input` / input ACK            | `AskUserQuestion` was removed; new Tasks do not enter `awaiting_input` and the state is retained only for historical rows (`packages/core/src/types/task.ts:14`; `packages/core/src/types/message.ts:151-154`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **L+R** (inactive compatibility state)                   | No current live input waiter exists. Historical rows are handled by runtime/startup reconciliation.                                                                                                                                                                                                                                                                                                                                                                                                                        | No new HA transport. Keep compatibility coverage. Widgets are the durable input mechanism below.                                                                                                                                                                                                               |

## MCP HTTP matrix

| Item                  | Current state and authorization                                                                                                                                                                                                                                                                                                                                             | Classification          | Exact owner-death behavior                                                                                                     | Initial HA disposition                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateless MCP POST    | The v2 protocol handler constructs and closes a request-local server/transport for modern JSON and legacy request-scoped responses. Every request authenticates a personal API key in the resolved tenant or a signed tenant/user/Session MCP JWT, then enters tenant scope. A legacy `Mcp-Session-Id` is validated as input syntax and discarded before protocol handling. | **R**, safely stateless | In-flight request fails if its daemon dies; a new request can go to any replica.                                               | Supported with shared PostgreSQL, stable signing secret, and identical config. Mutating tools retain their own PostgreSQL idempotency/lease requirements. |
| MCP session JWT cache | Module-local cache stores a reusable signed token keyed by tenant/Session/user (`mcp/tokens.ts:104-149,221-268`). Validation verifies signature, `tid/uid/sub/jti/exp`, then reloads Session existence inside signed tenant scope (`mcp/tokens.ts:284-369`).                                                                                                                | **L+R**                 | Cache disappears; existing signed tokens remain valid at peers with the same secret and PostgreSQL. A new token can be minted. | Supported. Never copy cached bearer tokens to Redis.                                                                                                      |

Polling affinity answers only Engine.IO's transport requirement. Built-in MCP
has no transport owner: every POST reconstructs authenticated request context,
and legacy `Mcp-Session-Id` values do not affect routing.

## OAuth, device, installation, and launch state

| Flow                                      | Current state and binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Classification                                                  | Exact owner-death behavior                                                                                                                                                                                                                                                                                                                                        | Initial HA disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP OAuth pending flow/callback           | PostgreSQL stores hashed state plus OAuth-AAD-sealed PKCE/client material with trusted tenant/user/server/mode, expiry, a versioned full configuration fingerprint, and one current grant generation. Claims are atomic one-shot; strict protected-resource metadata/resource/issuer/S256/HTTPS and hardened DNS-pinned egress are default. Shared grant mutation rechecks current admin role. SQLite retains the local Map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **P+R** with explicit ambiguous exchange gap                    | Any daemon can claim. Owner loss or failure after possible provider-code consumption becomes `ambiguous`; the code is never replayed. A newer attempt/config change fences older completion.                                                                                                                                                                      | Supported in constrained HA after offline migration `0078`, additive DCR migration `0100`, a shared stable `AGOR_MASTER_SECRET`, and whole-cohort rollout. Existing legacy grants are deleted and users reconnect. DCR uses a tenant/server/config-bound encrypted registration generation with a database-time dispatch lease; dispatched owner loss is recorded as ambiguous rather than replayed.                                                                                                                                                                                        |
| OAuth completion events                   | Authorization URL is returned to the authenticated start request; legacy blocking discover/test calls target only their exact initiating socket, never a user/tenant/global room. Completion/disconnect carry attempt/server metadata only and use tenant or tenant+user native rooms with lifecycle cleanup. UI polls durable attempt status and refetches token/server state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **L+S** for UX; PostgreSQL refetch is **R**                     | Missed completion fanout adds latency only. A missed exact-socket browser-open hint requires a safe flow restart; reconnect/callback state still converges durably.                                                                                                                                                                                               | Correctness no longer depends on completion realtime. Redis may fan out only tenant-qualified hints; authorization URLs are exact-socket only and raw state is never a separate event field.                                                                                                                                                                                                                                                                                                                                                                                                |
| Persisted MCP OAuth token + daemon cache  | PostgreSQL access/refresh/grant-client fields use OAuth-specific versioned envelopes bound to tenant/subject/server/generation. Full grant configuration binding is rechecked before use; relevant server mutations delete attempts/grants. No daemon bearer cache is used. PostgreSQL refresh uses a database-time claim ID plus grant/refresh generations; SQLite retains the local Promise coalescer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **P+R** on PostgreSQL; standalone local on SQLite               | One daemon refreshes a rotating token while peers observe its commit. A stale owner becomes `ambiguous`; exact fences prevent a losing `invalid_grant` from deleting a newer row.                                                                                                                                                                                 | Supported on PostgreSQL after `0078` and `0100` with a fleet-shared master secret. Shared start/completion/replacement/refresh/disconnect are admin-only; local deletion is not provider revocation. Never put secrets in Redis.                                                                                                                                                                                                                                                                                                                                                            |
| Codex device auth                         | Local per-tenant/user attempt contains device auth ID, user code, target Unix identity, poll timer, and status (`services/codex-device-auth.ts:225-294,376-390`). Poller exchanges and writes credentials only after a local ownership check (`codex-device-auth.ts:296-365`). `required_from_auth` already rejects create (`codex-device-auth.ts:392-401`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **D** initially; later **P+E** per user                         | Owner death stops polling and status becomes idle elsewhere. User must request a fresh provider code. Two replicas can each create a “single” attempt in static HA.                                                                                                                                                                                               | Keep disabled in hosted/multi-tenant HA; also fail HA startup if static mode enables it. A future design needs durable attempt generation and a per-user poller lease/fence. Device IDs, codes, authorization codes, and tokens never go to Redis.                                                                                                                                                                                                                                                                                                                                          |
| OpenCode OAuth/native credential mutation | Attempt Map contains a live local executor handle, code-delivery channel, readiness Promise, and credential namespace (`integrations/opencode/auth-service.ts:39-50,237-299`). Get/code/cancel require that local handle (`auth-service.ts:308-392`). Serialization Maps are local, while containment fence files are explicitly local-state-only for paths that reject remote/multi-replica execution (`native-state-coordinator.ts:9-10,70-130`; `executor-tracking.ts:28-54`).                                                                                                                                                                                                                                                                                                                                                                                                                                         | **P+E+A+D**                                                     | Wrong replica returns not found. Owner death loses code/cancel handle; local process may be ambiguous and later mutation must fail closed.                                                                                                                                                                                                                        | Disable OpenCode auth and native-state mutation in HA. Supporting it requires per-credential-namespace lease/fence, deterministic routing to the live handle, and an authoritative execution substrate or shared owner-specific filesystem contract. Codes and credentials never go to Redis.                                                                                                                                                                                                                                                                                               |
| GitHub App installation state             | **Implemented for PostgreSQL.** Authenticated admin initiation creates a 256-bit random bearer and persists only SHA-256 plus the trusted tenant/admin/`github-app-install` intent and PostgreSQL-clock 10-minute expiry (`services/github-install-state.ts`; `repositories/github-install-states.ts`; `0082_github_install_state.sql`). The unauthenticated callback hashes possession, uses a callback-only forced-RLS discovery capability for tenant routing, then performs one tenant-scoped atomic `DELETE ... RETURNING`; ordinary RLS requires an explicit tenant GUC even for tenant `default`. Issue, consume, and cursor-paginated cleanup honor the tenant write gate. SQLite retains a hash-keyed local Map. State possession proves only access to a bearer issued to an authenticated admin; it does not authenticate GitHub, the callback caller, or the caller-spoofable display-only `installation_id`. | PostgreSQL: durable **P+D**; SQLite: process-local **P+D**      | Any new-version PostgreSQL daemon can consume. Issuer death before callback is harmless; competing callbacks yield one success. Death after committed delete but before HTML delivery requires a fresh flow/manual ID lookup. GitHub App creation/installation already occurred externally and is not rolled back. SQLite restart/peer routing still loses state. | Supported and advertised as `githubInstall: true` in constrained HA after the enforced offline cutover for migration `0082`: stop every old daemon, migrate with `--offline-cutover`, then start only new daemons. Raw state is browser-only, never persisted in raw form, sent to Redis, or logged by application code; responses are `no-store`/`no-referrer`, and the shipped nginx log format omits query strings. On binary rollback, hash rows are inert until a new daemon resumes cleanup, new-version tenant deletion removes them, or an operator intentionally drops the schema. |
| External one-time launch                  | Daemon keeps no pending state. It exchanges code with configured service credential, verifies signed assertion/JWKS, derives tenant only from signed claims, and upserts in that tenant before issuing runtime tokens (`auth/launch-auth.ts:478-586,673-727`). The issuer owns one-time consumption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | safely stateless **R**                                          | Any replica can handle it. Death after upstream consumes the code but before response leaves the browser unable to replay that same code; it needs issuer idempotency or a fresh link.                                                                                                                                                                            | Supported if every replica has identical launch config/JWT secret and the issuer contract accepts the crash gap. Decide whether fresh-link retry is sufficient or issuer exchange must be idempotent. Launch code/assertion/service credential never go to Redis.                                                                                                                                                                                                                                                                                                                           |
| Auth/launch rate limit                    | `express-rate-limit` uses its default in-memory store, explicitly described as solo/team (`register-routes.ts:469-505`); the same limiter guards launch (`register-routes.ts:543-559`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **L** only as best effort; HA needs external/shared enforcement | Death resets buckets; N replicas multiply allowed attempts. Affinity makes one client's bucket steadier but is bypassable and not a fleet quota.                                                                                                                                                                                                                  | Because Redis is fanout-only, require trusted ingress/WAF fleet rate limiting or add a PostgreSQL-backed limiter. Do not silently claim the local limiter is HA enforcement.                                                                                                                                                                                                                                                                                                                                                                                                                |

## Adjacent callback, prompt, and local registry audit

| Registry/path                                                                                                                                    | Classification                                                             | HA result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completion callback `completionCallbackDispatches` Promise Map (`apps/agor-daemon/src/services/tasks.ts:120-128,1004-1055`)                      | **L+R**                                                                    | Safe coalescer only. Once admission starts, deterministic queued Task identity makes two replicas converge and peer queue workers elect one PostgreSQL dispatch claim. There is still a post-source-completion, pre-callback-admission death gap with no durable replay scanner; capability reporting exposes that limitation rather than claiming complete callback recovery.                                                                                                                                                 |
| Widget `inFlightResolutions` Map (`apps/agor-daemon/src/widgets/submissions.ts:109-147`)                                                         | **L+R**, with a domain-specific durable claim                              | Safe coalescer only. `WidgetResolutionStore` owns `pending -> resolving` with opaque token and refuses automatic replay of ambiguous external effects (`apps/agor-daemon/src/widgets/resolution-store.ts:21-32,40-64,104-128`). Existing tenant/branch prompt authorization is explicit (`widgets/submissions.ts:90-107,150-181`).                                                                                                                                                                                             |
| Artifact runtime logs/status/waiters/query Promise and session grants (`apps/agor-daemon/src/services/artifacts.ts:175-229,1483-1582,1885-2037`) | **L+A**; retryable, but initially unsupported for synchronous HA semantics | Per-viewer keying protects secret-derived output, but browser status POST/query response hitting a peer cannot resolve the owner's Promise and the request times out. Owner death loses logs, status, just-once grants, and queries. Durable Artifact CRUD remains supported. Runtime query/wait APIs need deterministic owner routing or explicit best-effort retry semantics; do not persist or Redis-fanout secret-derived DOM/log/env values. Any generalized pending record must capture tenant as well as artifact/user. |
| Gateway listeners and streaming buffers (`apps/agor-daemon/src/services/gateway.ts`)                                                             | listener ownership is **P+E**; transient streams/buffers remain **L**      | The merged gateway foundation leases Slack, GitHub, and Shortcut listener ownership in PostgreSQL and fences provider-event occurrence admission without a fleet leader. A peer can acquire after lease expiry. Teams/unimplemented providers fail closed. Local streaming buffers and provider outbound acknowledgement/send crash gaps can still lose or repeat externally visible output. The legacy generic inbound channel-key route is not a durable HA ingress.                                                         |
| Branch legacy managed-process Map and health timers (`apps/agor-daemon/src/services/branches.ts`; `services/health-monitor.ts`)                  | lifecycle remains gated; observation is **P+E**                            | HA remains webhook-only for lifecycle control. A separate all-daemon observer uses bounded routing-only discovery, tenant re-entry, a DB-time PostgreSQL branch lease with opaque token, and an environment lifecycle generation checked again at result commit. Standalone preserves its historical per-branch timers. Missing remote health URLs record `unknown`; the HA observer never consults a replica-local process Map.                                                                                               |

## Secret-bearing material and Redis boundary

Redis may transport an already-authorized Socket.IO packet when that is the
reviewed data-plane design. It must never become the registry, cache, replay
store, or lookup authority for:

- browser access/refresh JWTs, executor-session JWTs, terminal service JWTs, MCP
  session JWTs, personal API keys, or their plaintext values;
- OAuth `state`, PKCE verifier, authorization code, device auth ID/user code,
  access/refresh token, DCR client secret, or provider credentials;
- GitHub install state, external launch code/assertion/service credential;
- artifact env values, just-once grants, or secret-derived DOM/log responses;
- PTY input/output if Redis is not explicitly approved as part of the
  confidential terminal data plane.

For executor credentials and one-time callbacks, PostgreSQL should store a
fingerprint/hash where lookup allows it. Reversible fields such as PKCE verifier
or refresh token require the existing secrets-at-rest policy/encryption, never a
Redis detour.

A generic Socket.IO adapter serializes event payloads through Redis Pub/Sub.
Therefore “Redis is fanout-only” does not mean Redis sees only room names. The
first fanout branch needs a payload inventory and a deployment requirement for
private networking, TLS, ACLs, no command/key access for tenants, and no durable
packet retention. Terminal frames and arbitrary transcript content deserve an
explicit Max/security decision rather than an accidental consequence of
installing the adapter.

## Does polling affinity suffice?

| Resource                                         | Polling stickiness sufficient?                                                 | Required routing                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| One Engine.IO socket, including upgrade          | **Yes**, for transport correctness while the connection lives.                 | Sticky cookie/source routing; reconnect may choose another replica.                                                      |
| Browser ↔ terminal executor ↔ `terminals.create` | **No.** These are independent connections and a service request.               | Disable initially, or tenant/user lease plus deterministic application owner routing.                                    |
| Task executor heartbeat/Stop                     | **No owner routing should be required.**                                       | The PostgreSQL token authority lets any daemon validate and read/write durable Task state. Realtime is optional latency. |
| OAuth/GitHub third-party callback                | **No.** Redirects need not carry the originating affinity cookie.              | PostgreSQL covers both states; either callback may land on any ready replica without affinity.                           |
| OpenCode code/cancel handle                      | **No.**                                                                        | Per-namespace lease/fence plus deterministic live-owner routing, or disable.                                             |
| Artifact runtime query response                  | Usually **no**; the browser POST is independent of the original agent request. | Owner-bearing opaque request routing, or best-effort timeout/retry.                                                      |

## Honest initial HA topology

After the P0 prerequisite branches, the narrow topology that can honestly be
called initially supported is:

1. two or more otherwise interchangeable daemon replicas;
2. PostgreSQL as the durable authority, with the existing all-daemon scheduler,
   Session queue, and Task runtime reconciliation policies explicitly activated;
3. one stable JWT/signing-secret set and identical security/multi-tenancy config
   on every replica;
4. Socket.IO Redis Pub/Sub fanout with Redis health in readiness, plus explicit
   Feathers-event bridging/native room migration and tenant-qualified room
   membership;
5. ingress stickiness for Engine.IO polling/upgrades and trusted edge fleet-wide
   auth/launch rate limiting;
6. stateless HTTP/REST, stateless MCP POST, durable scheduled/queued Task
   admission, and Task execution using PostgreSQL-backed executor credentials;
7. Task execution with live Agor-managed permission routing for Claude,
   Copilot, and OpenCode, the current autonomous Cursor SDK, and only
   noninteractive Gemini/Codex modes;
8. web terminal, Codex device auth, OpenCode native-state mutation, and
   synchronous artifact runtime introspection disabled; PostgreSQL-backed MCP
   OAuth and GitHub App installation setup remain enabled;
   only Slack/GitHub/Shortcut gateway listeners enabled behind their PostgreSQL
   lease/occurrence fences with startup validation or explicit unsupported errors.

This topology tolerates loss of an idle API replica and, when the configured
execution substrate survives the launcher and callbacks route to the fleet,
lets a detached executor reconnect and recover durable Task control through
another new-version replica. The checked-in shared-local Compose smoke stack
shares workspace files but does not guarantee executor-process survival.
It does **not** promise that an in-flight HTTP/Socket.IO request receives its
ACK, that arbitrary provider side effects are exactly once, or that stateful
streams survive their owner.

Before the prerequisite branches landed, the only honest multi-process deployment was
active-passive at ingress (one daemon serving traffic at a time) or stateless
read/API experimentation with Task execution and all listed process-affine
features disabled. The constrained profile is the successor to that state; it
does not soften the remaining gates merely because the activation, credential,
and realtime prerequisites have landed.

## Prerequisite branch list

Ordered by activation dependency, not estimated size:

1. **HA activation and startup contract (P0) — implemented in this integration.** Add an explicit shared-Postgres
   mode; refuse SQLite; select `shared_postgres`; require stable secrets and
   instance diagnostics; keep current standalone defaults; fail startup for
   unsupported enabled features. Do not infer HA merely from PostgreSQL.
2. **Shared executor credential authority (P0) — implemented on current main.**
   PostgreSQL fingerprint registry with random JWT JTI, tenant, user,
   Session/Task/branch/purpose, expiry, revocation, and atomic bounded-use
   validation. First auth, peer reauth, competing use, revocation, expiry,
   retention, cross-tenant RLS, and wrong-scope coverage are present. SQLite
   retains its local Map. PostgreSQL execution is env-gated and still requires
   a review environment with `AGOR_TEST_POSTGRES_URL`.
3. **Realtime fanout and room hardening (P0) — implemented in this integration.** Socket.IO Redis adapter plus
   readiness; Engine.IO ingress contract; explicit Feathers event bridging or
   native task/session rooms; tenant-qualified native user/presence rooms;
   logout/auth-replacement cleanup; no global OAuth/presence emits. Two-daemon
   negative/positive tests.
4. **Live Task permission delivery (implemented compatibility slice).** Relay
   an authenticated, tenant/Session/Task-bound decision to the task-private
   executor room. The executor is the commit authority; until its Message
   patch lands the UI stays pending and retryable. The linked durable boundary
   design remains a future option rather than an HA activation prerequisite.
5. **Terminal ownership (P1, required only to enable terminal).** PostgreSQL
   tenant/user lease + generation fence, deterministic owner routing, remote
   socket targeting, readiness/adoption redesign, duplicate retirement, and
   lease-expiry kill tests. Decide whether PTY payload may traverse Redis.
6. **Stateless MCP contract (complete).** The built-in endpoint serves modern
   per-request JSON and stateless legacy request-scoped responses, issues no
   `Mcp-Session-Id`, and returns 405 for GET/DELETE. It needs no HA-mode gate,
   transport owner, shared SDK object, sticky route, or Redis transport state.
7. **Transient callback state (P1/P2) — durable prerequisites complete; GitHub
   setup activated.** MCP OAuth uses a forced-RLS,
   tenant/user/server/mode-bound PostgreSQL
   attempt state machine, hashed one-time state, OAuth-specific sealed
   material, current-attempt and grant generations, explicit ambiguous
   exchange outcomes, atomic grant-success, database-coordinated rotating-token
   refresh, strict protocol/egress checks, and durable UI refetch. GitHub setup
   uses hash-only, tenant/admin/intent/expiry-bound state with atomic
   tenant-scoped consumption and cursor-paginated cleanup. OAuth hints remain
   tenant-qualified and no origin-only authorization-code cache remains. The constrained
   profile activates MCP OAuth only after the encrypted DCR lease/CAS authority
   in migration `0100` is present across the whole cohort.
8. **Process-affine native integrations (P2).** Keep Codex device auth and
   OpenCode OAuth/native mutations off. If product requires them, add their own
   per-user/per-namespace leases and authoritative owner/containment contracts.
9. **Gateway/environment/artifact follow-ups (P2, partial).** Slack/GitHub/Shortcut
   channel leases and inbound occurrence fences are merged. Provider outbound
   crash gaps, unsupported gateway providers, explicit environment ownership,
   and Artifact runtime owner/query semantics remain.
10. **Fleet abuse controls (parallel security prerequisite).** Trusted edge/WAF
    rate limiting or PostgreSQL-backed limiter. Redis remains fanout-only.

No branch should introduce a fleet leader, ZooKeeper, or a generic
`DistributedWorkController`. `@agor/core/coordination` is intentionally only
diagnostic identity and bounded delay policy, not authority or fencing
(`packages/core/src/coordination/index.ts:1-24,45-66,93-118`). Each consumer
above owns its explicit PostgreSQL state machine and fence.

## Multi-tenancy and authorization conclusions

- A tenant ID must be established from a signed claim, configured static
  tenant, or trusted edge header **before** reading a tenant-owned token/session
  row. Redis room names and callback state are not trusted tenant signals.
- Executor credential control requires the signed tenant/user/Session/Task/
  branch scope to exactly match a forced-RLS PostgreSQL authority row. Task
  control membership remains local by design, while the HA relay re-authorizes
  the event against the receiving replica's tenant/task channel.
- Built-in MCP retains no transport authority. Each POST reconstructs trusted
  tenant+user+optional Session context and performs fresh authentication and
  access checks; a legacy `Mcp-Session-Id` on POST is ignored, never trusted.
- Terminal auth/process ownership remains unsupported. Native user/presence
  rooms are now tenant-qualified, but no PTY bytes are admitted to Redis.
- MCP OAuth and GitHub callback state are stored under trusted tenant context
  and atomically consumed through narrow hashed-state RLS capabilities. Their
  persisted tenant/user/intent or server/mode bindings are rechecked; neither
  callback accepts tenant from query/body, and ordinary GitHub-state RLS has
  no implicit `default`-tenant fallback.
- OpenCode's namespace and Codex attempt key already include trusted tenant/user
  identity, but local Maps do not serialize that ownership across replicas.
- User/presence rooms are tenant-qualified and auth replacement/logout removes
  their lifecycle state. MCP OAuth hints are tenant-qualified UX signals only;
  durable refetch is authoritative and no global emit carries auth state.
- Artifact local maps use artifact+user UUIDs and currently rely on globally
  unique IDs. Any persisted or routed successor must explicitly capture tenant
  and reauthorize visibility.
- Every PostgreSQL migration/claim branch above needs at least: same-resource
  race proof, stale-fence rejection, wrong-tenant negative proof using the same
  logical ID/token where feasible, and SQLite compatibility proof.

## Settled activation decisions

1. The profile disables web terminal, Gemini/Codex provider-native interactive
   permission prompts, Codex device auth, OpenCode auth/native mutation, and
   synchronous Artifact runtime introspection. Claude, Copilot, and OpenCode
   Agor-managed permission callbacks are enabled with manual retry while the
   executor remains alive. PostgreSQL-backed MCP OAuth and GitHub App
   installation setup are enabled.
2. Executors whose substrate survives the launcher may reconnect through peers;
   an in-flight unacknowledged mutation remains explicitly ambiguous/at-most-once
   unless its domain adds a durable operation identity. Shared-local workspace
   sharing alone is not a process-survival guarantee.
3. Built-in MCP is stateless-only; no transport continuity is advertised.
4. Production ingress must provide Engine.IO affinity and fleet abuse controls;
   Redis remains fanout-only.
5. Redis may see ephemeral ordinary authorized payloads, including transcript
   text, only on a private TLS/ACL-controlled data plane. Terminal PTY bytes and
   every listed credential class remain excluded; persistence is off in the
   example but is not treated as an authorization control.
6. Origin-only OAuth caches and global credential-bearing native emits remain
   prohibited. MCP OAuth removes that cache and uses tenant-qualified UX hints;
   unsupported transient flows stay disabled rather than widened by Redis.
7. Stateless external launch remains supported subject to the issuer's
   documented post-consume/pre-response crash contract; a fresh launch link is
   required unless the issuer offers idempotent exchange.
8. Executor-authority rollout uses a maintenance drain and all-at-once daemon
   cohort replacement. Old/unrecorded token cohorts fail closed.
9. Binding token validation more tightly to active durable Task runtime state
   and durable revocation retry remain defense-in-depth follow-ups. Durable
   permission-decision replay is an optional UX follow-up: the current managed
   path deliberately uses manual retry, and none of these follow-ups widens the
   Gemini/Codex provider-native prompt gate.

## Prerequisite test record

Focused implementation tests were added only for the executor credential
prerequisite:

- fast unit/contract tests cover SQLite local max-use/reuse, tenant claim,
  wrong tenant/user/Session/Task/branch without use consumption, local expiry,
  revocation/cleanup, fingerprint-only issuance, issuance failure, PostgreSQL
  no-fallback construction, and database-failure fail-closed behavior
  (`apps/agor-daemon/src/services/session-token-service.test.ts`);
- migration/static tests prove the PostgreSQL table has no raw-token column,
  forced RLS and narrow read-only maintenance, tenant deletion but no portable
  export/import, plus an applicable tenant-free SQLite mirror
  (`packages/core/src/db/{migrations,multitenancy-schema,tenant-portability-manifest}.test.ts`);
- the env-gated PostgreSQL suite creates two independent service instances and
  covers A-issue/B-initial-auth+B-reconnect, peer visibility before an enclosing
  domain transaction returns, exactly one competing max-use claim, wrong
  resource non-consumption, fleet revocation despite a valid signature,
  PostgreSQL-clock expiry despite a valid JWT, wrong-tenant service and direct
  RLS denial, and 24-hour cleanup/retention
  (`session-token-service.postgres.test.ts`). Run it locally with:

  ```bash
  AGOR_DB_DIALECT=postgresql \
  AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
  pnpm --filter @agor/daemon exec vitest run src/services/session-token-service.postgres.test.ts
  ```

In the prerequisite branch's targeted run, 89 core tests and 56 daemon/auth tests passed; the 8
PostgreSQL tests are discovered but skipped because `AGOR_TEST_POSTGRES_URL` is
unavailable. `pnpm check` also passes, including repository-wide typecheck,
Biome/lint and boundary checks, and its built-in non-docs workspace build.

The MCP OAuth prerequisite adds migration, cryptography, protocol, egress,
daemon authorization/realtime, UI durable-refetch, and CLI cutover coverage.
Its PostgreSQL tests use independent clients and authority instances for
cross-daemon callback claims, latest-attempt/configuration fences, atomic
token-success rollback, forced-RLS cross-tenant denial, expiry,
crash-to-ambiguous cleanup, encrypted storage, and rotating refresh
concurrency/owner-loss/stale-`invalid_grant` behavior. Final validation must run
these tests with a real non-superuser, `NOBYPASSRLS` role.

For GitHub install state, standalone and route tests cover entropy, hash-only
retention, replay, binding mismatches, expiry, authenticated admin issuance,
database failure, and display-only callback behavior. PostgreSQL tests use
independent clients and registered routes for cross-daemon issue/consume,
exactly-one concurrency, explicit-tenant forced RLS including tenant `default`,
intent/user/tenant negatives, database-clock expiry, tenant write gates, and
cleanup pagination past gated tenants. Migration/static coverage proves unique
`0082`/`0085` history, no raw-state column, no implicit default-tenant RLS,
non-portable deletion semantics, and no Redis dependency. The opt-in HA Compose
harness also exercises peer callback consumption and proves nginx logs omit the
raw query bearer both on successful routes and while both upstreams are down.
The case-insensitive sensitive matcher mirrors Express's default routing, and
the outage proof covers canonical and mixed-case callback spellings. The route
retains the redacted access-log status/timing signal and suppresses nginx's
fixed-format upstream error log, which otherwise includes the complete
still-valid request target. A broad validation run passed all 3,586 runnable
core tests, and the latest rebase-specific run passed 111 focused core tests
and 61 focused daemon tests (with 15 and 9 environment-gated skips,
respectively). Typecheck, lint, and the multitenancy boundary check pass, as do
all 125 PostgreSQL tests across 22 files
(including 9 GitHub-state tests as a `NOSUPERUSER`/`NOBYPASSRLS` role), the
PostgreSQL runner interruption harness, and the opt-in two-daemon HA Docker
integration including the upstream-failure regression.

The successor Redis/realtime integration and live two-daemon evidence are in
`docs/internal/daemon-ha-redis-realtime-2026-08-07.md`; this document remains
the detailed negative inventory rather than the current activation status.
