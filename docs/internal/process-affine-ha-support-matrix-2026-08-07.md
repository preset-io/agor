# Process-affine and transient-state HA support matrix

**Date:** 2026-08-07

**Status:** executor-token and MCP OAuth pending/grant/refresh prerequisites implemented for review; no HA activation or broad transport work

**Base:** current `main` after scheduler, Session queue/dispatch, and Task runtime reconciliation foundations

**Private design predecessor:**
[`Daemon HA readiness: distributed work model and prerequisite plan`](agor://kb/document/019fd41f-0cbc-756c-a22d-8d2ecac0176b)
**Private Knowledge successor/mirror:**
[`Process-affine HA support matrix`](https://agor.sandbox.preset.zone/ui/kb/agor-cloud-team/architecture/process-affine-ha-support-matrix-2026-08.md)

## Decision

The current daemon is **not safe to start as an interchangeable active-active
fleet**. The durable scheduler, Session queue, and Task runtime state machines
are necessary foundations, but they do not make process-affine transports or
transient credentials fleet-safe.

Two P0 contradictions were especially important in the initial audit:

1. **Resolved on this branch:** the Task runtime design says a detached executor
   can reconnect through another daemon. PostgreSQL mode now fingerprints the
   signed JWT, persists its full tenant/user/resource authority, and atomically
   validates it on any daemon. SQLite retains the issuer-local Map
   (`apps/agor-daemon/src/services/session-token-service.ts:175-216,223-298,300-388`;
   `packages/core/src/db/repositories/executor-session-token-authorities.ts:107-198`).
2. Task control rooms are Feathers `app.channel` objects
   (`apps/agor-daemon/src/utils/realtime-publish.ts:67-84,94-95,651-658`), not
   native Socket.IO rooms. Installing the Socket.IO Redis adapter alone would
   not replicate Feathers' process-local membership or make a publisher on
   daemon B see an executor connection on daemon A.

The initial honest contract is therefore:

- keep the shipped composition root in standalone mode; it is hard-coded to
  `taskRuntimePolicy: 'standalone'`
  (`apps/agor-daemon/src/index.ts:746-750`);
- land the explicit HA activation and audited cross-replica realtime branches
  before enabling multiple active daemons; shared executor credential authority
  is implemented here but does not activate HA by itself;
- initially disable web terminals, stateful MCP, GitHub setup OAuth, OpenCode
  native-state OAuth, Codex device auth, and gateway listeners in HA mode
  unless their specific prerequisite below has landed; MCP OAuth may be enabled
  only after its offline PostgreSQL cutover and shared-secret prerequisites;
- preserve all existing SQLite/standalone behavior.

PostgreSQL remains the only durable authority. Redis is a Socket.IO fanout
transport, not a token registry, lease store, callback store, rate-limit
authority, or domain state machine.

## Implemented prerequisite: PostgreSQL executor-session token authority

This branch implements the executor-token prerequisite from the ordered list below, without
enabling shared mode or changing any other process-affine surface.

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

| Surface                        | Evidence and current binding                                                                                                                                                                                                                                                                                                           | Classification                                                     | Owning-daemon death / reconnect behavior                                                                                                                                                                                | Initial HA disposition                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine.IO WebSocket/polling    | Server and browser both enable `['websocket', 'polling']` (`apps/agor-daemon/src/setup/socketio.ts:325-339`; `packages/core/src/api/index.ts:1125-1140`).                                                                                                                                                                              | **A** for the Engine.IO connection only                            | A WebSocket remains on one daemon until disconnect. Polling or upgrade requests that hit another daemon do not have that daemon's Engine.IO session. After death the client opens a new connection and reauthenticates. | Require ingress stickiness for polling/upgrade, prefer WebSocket, and test reconnect to a different replica. This affinity does **not** select a terminal/MCP/OAuth resource owner.                                             |
| Socket.IO Redis fanout         | The composition root only configures the ordinary Socket.IO transport (`apps/agor-daemon/src/index.ts:573-589`); the daemon has a Socket.IO dependency but no Redis adapter dependency (`apps/agor-daemon/package.json:28-56`).                                                                                                        | prerequisite for **S**                                             | Today, native rooms and direct socket IDs exist only in one daemon. A publisher on another daemon cannot reach them.                                                                                                    | Add an explicitly configured adapter, readiness failure on Redis loss, bounded reconnect behavior, and two-daemon proof. Redis outage must not silently degrade to split realtime islands.                                      |
| Feathers realtime channels     | Authenticated, tenant, session-stream, and executor-task memberships use `app.channel` (`apps/agor-daemon/src/setup/socketio.ts:968-1082`; `apps/agor-daemon/src/utils/realtime-publish.ts:59-108`).                                                                                                                                   | neither **S** nor **R** today                                      | Membership disappears with the socket/daemon. A service event emitted on a different daemon is published only against that daemon's local channel objects.                                                              | The Redis-adapter branch must explicitly bridge Feathers events or migrate security-sensitive delivery to audited native tenant-qualified rooms. Merely calling `io.adapter(...)` is not sufficient.                            |
| Native user rooms and presence | Native user room is only `user:${userId}` (`socketio.ts:235-254`); login joins it (`socketio.ts:909-930`) but logout only leaves Feathers channels (`socketio.ts:1058-1082`). Board presence accepts any nonempty board ID without loading the board (`socketio.ts:519-529`) and globally broadcasts presence (`socketio.ts:531-574`). | **S**, but security prerequisite; otherwise **D** for fleet fanout | Reconnect recreates membership. Authentication replacement can accumulate an old native user-room capability. Redis fanout would widen the current global/unqualified delivery scope across replicas.                   | Before fanout: tenant-qualify native rooms, leave old rooms on logout/auth replacement, authorize board subscription in the trusted tenant, and remove global cross-tenant presence broadcast. Add cross-tenant negative tests. |

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

| Item                                    | Current state and authorization                                                                                                                                                                                                                                                                                                                                                                                                                                             | Classification                                                                                      | Exact owner-death behavior                                                                                                                                                                                                                                                                                                                  | Initial HA disposition                                                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executor-session credential authority   | **Implemented here.** PostgreSQL stores only a SHA-256 bearer fingerprint plus tenant/user/type/purpose/Session/Task/branch/expiry/revocation/use facts under forced RLS (`session-token-service.ts:223-388`; `executor-session-token-authorities.ts:107-243`; migration `0074`:1-55). SQLite alone retains the local raw-token Map.                                                                                                                                        | **P+R** implemented; no longer **D** for this credential                                            | A's death drops only its connection. Initial auth or reconnect at B verifies the shared signature and exact claims, then validates the PostgreSQL row. Revocation, expiry, and bounded use are fleet-visible. In-flight ACK behavior is unchanged. Tokens issued by a pre-migration/old daemon have no row and fail closed.                 | Supported after migration plus an all-at-once daemon cohort replacement with shared signing secrets. No Redis token state and no owner routing. PostgreSQL outage fails authentication closed.                                                |
| Task connect, heartbeat, and Stop truth | Executor claims `dispatching -> running` durably (`tasks.ts:1277-1304`). Heartbeat writes PostgreSQL and returns durable `stopping` even when realtime was missed (`tasks.ts:1370-1394`). Termination request/coordination/settlement are durable Task state.                                                                                                                                                                                                               | **R**                                                                                               | If the launcher daemon dies but executor survives, it can now reauthenticate through any new-version daemon, resume heartbeat, and observe Stop. If it never reconnects, stale-heartbeat reconciliation claims containment; without authoritative remote absence it can remain guarded/unverified.                                          | No Task owner routing or fleet leader. PostgreSQL remains authority. Realtime Stop is latency only.                                                                                                                                           |
| Task control room                       | Executor joins `executor-task:${tenant}:${task}` only after a verified executor JWT's signed `task_id` matches the auth result (`socketio.ts:1038-1053`). Stop publication targets only that room (`realtime-publish.ts:627-658`). It is a Feathers channel, not a native Socket.IO room.                                                                                                                                                                                   | **R**; not **S** today                                                                              | Room disappears with the connection/daemon. Stop still survives in the Task row; the next heartbeat/get reconstructs it after reauth.                                                                                                                                                                                                       | Keep durable read as correctness. For low-latency fleet delivery, explicitly migrate/bridge this private room; test that a publisher on daemon B reaches an executor on A without widening tenant/task scope.                                 |
| Feathers RPC acknowledgements           | Client reauth is process-local single-flight and one-shot 401 retry (`feathers-client.ts:154-196`); non-auth ACK timeout is not retried.                                                                                                                                                                                                                                                                                                                                    | **L+R** only method-by-method                                                                       | Death after DB commit but before ACK gives the executor an ambiguous failure. Current containment boundary intentionally fails the Task rather than replaying arbitrary mutations. Heartbeats repeat naturally; Stop callers can read Task state.                                                                                           | Document at-most-once failover. Add stable operation IDs/read-after-timeout only for methods whose UX must survive the ambiguity. Redis ACKs do not solve it.                                                                                 |
| Permission request and decision         | Executor's pending Promise/timeout and manager registry are local to the surviving executor process (`packages/executor/src/permissions/permission-service.ts:53-68,94-167`; `permission-manager.ts:11-44`). Request/decision content is persisted as a Message; decision route patches it then emits `permission_resolved` (`register-routes.ts:2905-2978`). Message hooks require tenant auth and, with RBAC, prompt access in the Session (`register-hooks.ts:939-989`). | durable facts are **R**; live wakeup needs **S** plus replay; initially **D** for interactive modes | If the daemon dies before event delivery, the same executor still holds its Promise but never queries the already-resolved Message. If it reconnects after the decision, there is no decision replay; it waits until the 10-minute local timeout. If the executor dies, the Promise is gone and Task reconciliation owns the stale runtime. | In initial HA allow noninteractive permission modes only. Then add task-private delivery plus reconnect/read-after-gap of the durable decision. Set `decidedBy` from authenticated params instead of trusting the request body's audit value. |
| `awaiting_input` / input ACK            | `AskUserQuestion` was removed; new Tasks do not enter `awaiting_input` and the state is retained only for historical rows (`packages/core/src/types/task.ts:14`; `packages/core/src/types/message.ts:151-154`).                                                                                                                                                                                                                                                             | **L+R** (inactive compatibility state)                                                              | No current live input waiter exists. Historical rows are handled by runtime/startup reconciliation.                                                                                                                                                                                                                                         | No new HA transport. Keep compatibility coverage. Widgets are the durable input mechanism below.                                                                                                                                              |

## MCP HTTP matrix

| Item                         | Current state and authorization                                                                                                                                                                                                                                                                                                                                                                        | Classification          | Exact owner-death behavior                                                                                                                                                            | Initial HA disposition                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateless MCP POST           | A transport/server is built per POST and closed after the response (`apps/agor-daemon/src/mcp/server.ts:816-836`). Every request authenticates a personal API key in the resolved tenant or a signed tenant/user/Session MCP JWT, then enters tenant scope (`mcp/server.ts:491-688`).                                                                                                                  | **R**, safely stateless | In-flight request fails if its daemon dies; a new request can go to any replica.                                                                                                      | Supported with shared PostgreSQL, stable signing secret, and identical config. Mutating tools retain their own PostgreSQL idempotency/lease requirements.                                                                                                                         |
| Stateful Streamable HTTP MCP | SDK server, transport, mutable context, immutable tenant/user/optional Agor Session, last-used time, and TTL timer live in a local Map, max 100/30-minute TTL (`mcp/server.ts:387-442`). Follow-ups look up `Mcp-Session-Id` only in that Map (`mcp/server.ts:690-706`). Each request rechecks tenant, user, immutable Session binding, fresh user role, and Session access (`mcp/server.ts:707-768`). | **A+D**; not **R**      | A follow-up that reaches another replica, or any follow-up after owner death, receives 404 “Session not found.” SSE/transport state is not in PostgreSQL and cannot be reconstructed. | In initial HA reject stateful initialize/GET/DELETE and advertise stateless POST only. A later lossy option may deterministically route by `Mcp-Session-Id` and require clients to reinitialize on owner death; zero-loss failover requires a protocol-aware redesign, not Redis. |
| MCP session JWT cache        | Module-local cache stores a reusable signed token keyed by tenant/Session/user (`mcp/tokens.ts:104-149,221-268`). Validation verifies signature, `tid/uid/sub/jti/exp`, then reloads Session existence inside signed tenant scope (`mcp/tokens.ts:284-369`).                                                                                                                                           | **L+R**                 | Cache disappears; existing signed tokens remain valid at peers with the same secret and PostgreSQL. A new token can be minted.                                                        | Supported. Never copy cached bearer tokens to Redis.                                                                                                                                                                                                                              |

Polling affinity answers only Engine.IO's transport requirement. It cannot route
MCP because MCP ownership is keyed by the `Mcp-Session-Id` header, not an
Engine.IO cookie, and it cannot survive owner death.

## OAuth, device, installation, and launch state

| Flow                                      | Current state and binding                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Classification                                                  | Exact owner-death behavior                                                                                                                                                                   | Initial HA disposition                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP OAuth pending flow/callback           | PostgreSQL stores hashed state plus OAuth-AAD-sealed PKCE/client material with trusted tenant/user/server/mode, expiry, a versioned full configuration fingerprint, and one current grant generation. Claims are atomic one-shot; strict PRM/resource/issuer/S256/HTTPS and hardened DNS-pinned egress are default. Shared grant mutation rechecks current admin role. SQLite retains the local Map.                                                                              | **P+R** with explicit ambiguous exchange gap                    | Any daemon can claim. Owner loss or failure after possible provider-code consumption becomes `ambiguous`; the code is never replayed. A newer attempt/config change fences older completion. | Supported on PostgreSQL only after enforced offline migration `0077`, shared stable `AGOR_MASTER_SECRET`, and whole-cohort rollout. Existing grants are deleted and users reconnect. Legacy providers require explicit per-server compatibility; DCR is explicit fallback.                                                                                                       |
| OAuth completion events                   | Authorization URL is returned to the authenticated start request; legacy blocking discover/test calls target only their exact initiating socket, never a user/tenant/global room. Completion/disconnect carry attempt/server metadata only and use tenant or tenant+user native rooms with lifecycle cleanup. UI polls durable attempt status and refetches token/server state.                                                                                                   | **L+S** for UX; PostgreSQL refetch is **R**                     | Missed completion fanout adds latency only. A missed exact-socket browser-open hint requires a safe flow restart; reconnect/callback state still converges durably.                          | Correctness no longer depends on completion realtime. Redis may fan out only tenant-qualified hints; authorization URLs are exact-socket only and raw state is never a separate event field.                                                                                                                                                                                     |
| Persisted MCP OAuth token + daemon cache  | PostgreSQL access/refresh/grant-client fields use OAuth-specific versioned envelopes bound to tenant/subject/server/generation. Full grant configuration binding is rechecked before use; relevant server mutations delete attempts/grants. No daemon bearer cache is used. PostgreSQL refresh uses a database-time claim ID plus grant/refresh generations; SQLite retains the local Promise coalescer.                                                                          | **P+R** on PostgreSQL; standalone local on SQLite               | One daemon refreshes a rotating token while peers observe its commit. A stale owner becomes `ambiguous`; exact fences prevent a losing `invalid_grant` from deleting a newer row.            | Active-active OAuth is supported on PostgreSQL after `0077` and fleet-shared master secret. Shared start/completion/replacement/refresh/disconnect are admin-only; local disconnect is not provider revocation. Admin-configured client secrets in MCP server JSON remain under the existing configuration-storage contract, not the grant envelope. Never put secrets in Redis. |
| Codex device auth                         | Local per-tenant/user attempt contains device auth ID, user code, target Unix identity, poll timer, and status (`services/codex-device-auth.ts:225-294,376-390`). Poller exchanges and writes credentials only after a local ownership check (`codex-device-auth.ts:296-365`). `required_from_auth` already rejects create (`codex-device-auth.ts:392-401`).                                                                                                                      | **D** initially; later **P+E** per user                         | Owner death stops polling and status becomes idle elsewhere. User must request a fresh provider code. Two replicas can each create a “single” attempt in static HA.                          | Keep disabled in hosted/multi-tenant HA; also fail HA startup if static mode enables it. A future design needs durable attempt generation and a per-user poller lease/fence. Device IDs, codes, authorization codes, and tokens never go to Redis.                                                                                                                               |
| OpenCode OAuth/native credential mutation | Attempt Map contains a live local executor handle, code-delivery channel, readiness Promise, and credential namespace (`integrations/opencode/auth-service.ts:39-50,237-299`). Get/code/cancel require that local handle (`auth-service.ts:308-392`). Serialization Maps are local, while containment fence files are explicitly local-state-only for paths that reject remote/multi-replica execution (`native-state-coordinator.ts:9-10,70-130`; `executor-tracking.ts:28-54`). | **P+E+A+D**                                                     | Wrong replica returns not found. Owner death loses code/cancel handle; local process may be ambiguous and later mutation must fail closed.                                                   | Disable OpenCode auth and native-state mutation in HA. Supporting it requires per-credential-namespace lease/fence, deterministic routing to the live handle, and an authoritative execution substrate or shared owner-specific filesystem contract. Codes and credentials never go to Redis.                                                                                    |
| GitHub App installation state             | Random one-time state is bound to admin user+tenant in a local 10-minute Map (`services/github-install-state.ts:1-23,28-74`) and deleted on consume (`github-install-state.ts:80-107`). Callback has no auth header; possession of state is the proof (`services/github-app-setup.ts:270-308`).                                                                                                                                                                                   | **P+D**                                                         | Callback to a peer or after owner death rejects the install state and forces restart. Polling affinity generally does not affect a third-party redirect.                                     | Store a hash of state with tenant/admin/expiry and atomic delete/consume in PostgreSQL; no lease is needed for the current display-only callback. Until then, disable setup flow in HA. Raw state never goes to Redis.                                                                                                                                                           |
| External one-time launch                  | Daemon keeps no pending state. It exchanges code with configured service credential, verifies signed assertion/JWKS, derives tenant only from signed claims, and upserts in that tenant before issuing runtime tokens (`auth/launch-auth.ts:478-586,673-727`). The issuer owns one-time consumption.                                                                                                                                                                              | safely stateless **R**                                          | Any replica can handle it. Death after upstream consumes the code but before response leaves the browser unable to replay that same code; it needs issuer idempotency or a fresh link.       | Supported if every replica has identical launch config/JWT secret and the issuer contract accepts the crash gap. Decide whether fresh-link retry is sufficient or issuer exchange must be idempotent. Launch code/assertion/service credential never go to Redis.                                                                                                                |
| Auth/launch rate limit                    | `express-rate-limit` uses its default in-memory store, explicitly described as solo/team (`register-routes.ts:469-505`); the same limiter guards launch (`register-routes.ts:543-559`).                                                                                                                                                                                                                                                                                           | **L** only as best effort; HA needs external/shared enforcement | Death resets buckets; N replicas multiply allowed attempts. Affinity makes one client's bucket steadier but is bypassable and not a fleet quota.                                             | Because Redis is fanout-only, require trusted ingress/WAF fleet rate limiting or add a PostgreSQL-backed limiter. Do not silently claim the local limiter is HA enforcement.                                                                                                                                                                                                     |

## Adjacent callback, prompt, and local registry audit

| Registry/path                                                                                                                                            | Classification                                                                            | HA result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion callback `completionCallbackDispatches` Promise Map (`apps/agor-daemon/src/services/tasks.ts:120-128,1004-1055`)                              | **L+R**                                                                                   | Safe coalescer only. Correctness is deterministic durable queued Task admission plus durable callback metadata (`docs/internal/session-task-queue-ha-2026-08-06.md:31-43`). A competing daemon converges at PostgreSQL dispatch admission.                                                                                                                                                                                                                                                                                                                  |
| Widget `inFlightResolutions` Map (`apps/agor-daemon/src/widgets/submissions.ts:109-147`)                                                                 | **L+R**, with a domain-specific durable claim                                             | Safe coalescer only. `WidgetResolutionStore` owns `pending -> resolving` with opaque token and refuses automatic replay of ambiguous external effects (`apps/agor-daemon/src/widgets/resolution-store.ts:21-32,40-64,104-128`). Existing tenant/branch prompt authorization is explicit (`widgets/submissions.ts:90-107,150-181`).                                                                                                                                                                                                                          |
| Artifact runtime logs/status/waiters/query Promise and session grants (`apps/agor-daemon/src/services/artifacts.ts:175-229,1483-1582,1885-2037`)         | **L+A**; retryable, but initially unsupported for synchronous HA semantics                | Per-viewer keying protects secret-derived output, but browser status POST/query response hitting a peer cannot resolve the owner's Promise and the request times out. Owner death loses logs, status, just-once grants, and queries. Durable Artifact CRUD remains supported. Runtime query/wait APIs need deterministic owner routing or explicit best-effort retry semantics; do not persist or Redis-fanout secret-derived DOM/log/env values. Any generalized pending record must capture tenant as well as artifact/user.                              |
| Gateway listeners and streaming buffers (`apps/agor-daemon/src/services/gateway.ts:645-679,2762-2840,2932-3007`)                                         | live connector **E+A+D**; buffers are mostly **L** but can lose/duplicate external output | Every daemon currently discovers and starts every enabled listener. Connector handles, Teams conversation references, GitHub last-message buffers, Slack stream handles/throttles are local. Owner death stops that listener and loses transient stream/buffer state; other replicas may already have duplicate listeners. Disable listeners in initial HA. A later branch needs a tenant/channel lease/fence and provider-event/outbound idempotency; no fleet leader. Durable prompt admission remains PostgreSQL-safe once an inbound event is admitted. |
| Branch legacy managed-process Map and health timers (`apps/agor-daemon/src/services/branches.ts:129-149,1963-2089`; `services/health-monitor.ts:75-107`) | outside this transport branch, but blocks a broad “all features HA” claim                 | Environment lifecycle is generally delegated to executor/webhook paths, while the legacy local process fallback and every-daemon health timers remain process-local. The HA activation branch must either scope the supported environment mode or schedule a separate environment-owner audit.                                                                                                                                                                                                                                                              |

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

| Resource                                         | Polling stickiness sufficient?                                                 | Required routing                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| One Engine.IO socket, including upgrade          | **Yes**, for transport correctness while the connection lives.                 | Sticky cookie/source routing; reconnect may choose another replica.                                               |
| Browser ↔ terminal executor ↔ `terminals.create` | **No.** These are independent connections and a service request.               | Disable initially, or tenant/user lease plus deterministic application owner routing.                             |
| Task executor heartbeat/Stop                     | **No owner routing should be required.**                                       | Fix shared token validation; any daemon reads/writes PostgreSQL. Realtime is optional latency.                    |
| Stateful MCP                                     | **No.** It is keyed by `Mcp-Session-Id`, not Engine.IO.                        | Disable initially, or deterministic header-based owner routing with explicit reinitialize-on-owner-loss contract. |
| OAuth/GitHub third-party callback                | **No.** Redirects need not carry the originating affinity cookie.              | Shared atomic PostgreSQL state or disable.                                                                        |
| OpenCode code/cancel handle                      | **No.**                                                                        | Per-namespace lease/fence plus deterministic live-owner routing, or disable.                                      |
| Artifact runtime query response                  | Usually **no**; the browser POST is independent of the original agent request. | Owner-bearing opaque request routing, or best-effort timeout/retry.                                               |

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
7. noninteractive Task permission modes until durable permission replay lands;
8. web terminal, stateful MCP, GitHub setup/device flows, OpenCode native-state
   mutation, gateway listeners, and synchronous artifact runtime introspection
   disabled with startup validation or explicit unsupported errors; MCP OAuth
   additionally requires its offline schema cutover and one stable shared
   `AGOR_MASTER_SECRET` across the cohort.

This topology tolerates loss of an idle API replica and, with the executor
credential prerequisite implemented on this branch, lets a detached executor
reconnect and recover durable Task control through another new-version replica.
It does **not** promise that an in-flight HTTP/Socket.IO request receives its
ACK, that arbitrary provider side effects are exactly once, or that stateful
streams survive their owner.

Without the P0 branches, the only honest multi-process deployment is
active-passive at ingress (one daemon serving traffic at a time) or stateless
read/API experimentation with Task execution and all listed process-affine
features disabled. Running two current daemons active-active is unsafe because
startup remains standalone/destructive and realtime delivery remains
replica-local. Executor authentication is no longer issuer-local after the
migration and compatible fleet replacement, but that single prerequisite does
not make the overall deployment HA-safe.

## Prerequisite branch list

Ordered by activation dependency, not estimated size:

1. **HA activation and startup contract (P0).** Add an explicit shared-Postgres
   mode; refuse SQLite; select `shared_postgres`; require stable secrets and
   instance diagnostics; keep current standalone defaults; fail startup for
   unsupported enabled features. Do not infer HA merely from PostgreSQL.
2. **Shared executor credential authority (P0) — ✅ implemented on this branch.**
   PostgreSQL fingerprint registry with random JWT JTI, tenant, user,
   Session/Task/branch/purpose, expiry, revocation, and atomic bounded-use
   validation. First auth, peer reauth, competing use, revocation, expiry,
   retention, cross-tenant RLS, and wrong-scope coverage are present. SQLite
   retains its local Map. PostgreSQL execution is env-gated and still requires
   a review environment with `AGOR_TEST_POSTGRES_URL`.
3. **Realtime fanout and room hardening (P0).** Socket.IO Redis adapter plus
   readiness; Engine.IO ingress contract; explicit Feathers event bridging or
   native task/session rooms; tenant-qualified native user/presence rooms;
   logout/auth-replacement cleanup; no global OAuth/presence emits. Two-daemon
   negative/positive tests.
4. **Task permission reconnect replay (P1).** Task-private decision delivery,
   durable read-after-gap on reauth, server-derived decider identity, and
   permission-mode HA gate until complete.
5. **Terminal ownership (P1, required only to enable terminal).** PostgreSQL
   tenant/user lease + generation fence, deterministic owner routing, remote
   socket targeting, readiness/adoption redesign, duplicate retirement, and
   lease-expiry kill tests. Decide whether PTY payload may traverse Redis.
6. **Stateless-only MCP HA gate (P1).** Reject stateful initialization and
   follow-up methods in HA; publish the supported client contract. A later
   branch may add deterministic lossy ownership, but not shared SDK objects.
7. **Transient callback state (P1/P2) — MCP OAuth ✅ implemented on this
   branch; GitHub setup remains pending.** MCP OAuth uses a forced-RLS,
   tenant/user/server/mode-bound PostgreSQL attempt state machine, hashed
   one-time state, OAuth-specific sealed material, current-attempt and grant
   generations, explicit ambiguous exchange outcomes, atomic grant-success,
   database-coordinated rotating-token refresh, strict protocol/egress checks,
   and durable UI refetch. The daemon no longer uses the origin-only
   authorization-code cache and all OAuth hints are tenant-qualified. GitHub
   setup still needs its own PostgreSQL one-shot callback state before HA use.
8. **Process-affine native integrations (P2).** Keep Codex device auth and
   OpenCode OAuth/native mutations off. If product requires them, add their own
   per-user/per-namespace leases and authoritative owner/containment contracts.
9. **Gateway/environment/artifact follow-ups (P2).** Per-channel gateway leases
   and provider idempotency; explicit environment ownership support matrix;
   owner routing or documented best-effort semantics for artifact runtime
   query/status.
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
- Executor credential control now requires the signed tenant/user/Session/Task/
  branch scope to exactly match a forced-RLS PostgreSQL authority row. Its Task
  control channel implementation remains process-local and needs the separate
  realtime prerequisite.
- Stateful MCP has the strongest existing binding in this audit: immutable
  tenant+user+optional Session plus fresh per-request auth/access recheck. Its
  problem is ownership/liveness, not authorization.
- Terminal auth binds user but the native room does not bind tenant. Branch
  permission is checked at tab creation, not on every byte. Fleet work must not
  broaden that capability.
- MCP OAuth callback state is now stored under a trusted tenant and atomically
  consumed through an exact hashed-state RLS capability; tenant/user/server/
  mode binding is persisted and rechecked. GitHub callback state still needs
  the same treatment before HA use. Neither path may accept tenant identity
  from callback query/body.
- OpenCode's namespace and Codex attempt key already include trusted tenant/user
  identity, but local Maps do not serialize that ownership across replicas.
- MCP OAuth native hints now use tenant-qualified user/workspace rooms with
  auth lifecycle cleanup, and the UI treats them only as prompts to refetch
  durable truth. Other user/presence rooms still require their own fanout
  audit. Global emit is not a shared-mode shortcut.
- Artifact local maps use artifact+user UUIDs and currently rely on globally
  unique IDs. Any persisted or routed successor must explicitly capture tenant
  and reauthorize visibility.
- Every PostgreSQL migration/claim branch above needs at least: same-resource
  race proof, stale-fence rejection, wrong-tenant negative proof using the same
  logical ID/token where feasible, and SQLite compatibility proof.

## Focused questions for Max

1. May the first advertised HA mode explicitly disable web terminal, stateful
   MCP, interactive permission prompts, GitHub OAuth setup, Codex device auth,
   OpenCode auth/native mutations, gateway listeners, and synchronous
   artifact runtime introspection? If not, which one blocks launch and should be
   the first domain-specific owner/lease branch?
2. Is “active Task may fail when its daemon dies during an unacknowledged
   mutation, but a detached executor otherwise reconnects” an acceptable
   initial contract? If not, which executor mutations require stable operation
   IDs/read-after-timeout rather than the present fail-safe at-most-once policy?
3. For stateful MCP, is deterministic owner routing plus `404 -> initialize a
new MCP session` acceptable, or is stateful-session continuity across owner
   death a hard requirement? The latter is a materially larger protocol/runtime
   redesign.
4. Can production ingress guarantee Engine.IO polling stickiness and fleet-wide
   auth/launch rate limits, or must both be implemented inside Agor/PostgreSQL?
5. Is Redis approved to see ephemeral Socket.IO payload bytes that may contain
   transcript text or terminal input/output, provided it is private/TLS/ACL'd
   and nonpersistent? If terminal bytes are excluded, terminal must stay
   owner-local/deterministically routed rather than use generic room fanout.
6. For one-time external launch, is forcing the user to obtain a fresh launch
   link after daemon death in the post-consume/pre-response gap acceptable, or
   must the issuer expose an idempotent exchange result keyed by code/request?
7. Can executor-authority rollout require a maintenance drain and all-at-once
   daemon cohort replacement? Mixed old/new daemons cannot share authorities,
   and securely backfilling raw tokens from old process Maps is not possible.
8. On launcher exit, if PostgreSQL is unavailable the revocation attempt now
   fails visibly and authentication stays closed during the outage, but the row
   can become usable again after recovery until expiry. Should a follow-up bind
   Task-token validation to active durable Task runtime state/add a durable
   revocation retry, or is the current 24-hour maximum lifetime acceptable for
   initial HA?

## Test decision for this branch

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

The MCP OAuth prerequisite adds focused migration, cryptography, protocol,
egress, daemon authorization/realtime, UI durable-refetch, and CLI cutover
tests. Its env-gated PostgreSQL tests use independent clients/authority
instances for cross-daemon callback claims, latest-attempt/configuration fences,
atomic token-success rollback, forced-RLS cross-tenant denial, expiry,
crash-to-ambiguous cleanup, encrypted storage, rotating refresh concurrency,
owner loss, and losing-`invalid_grant` protection. The final branch report must
record the concrete non-superuser/NOBYPASSRLS run rather than treating skipped
PostgreSQL tests as evidence.
