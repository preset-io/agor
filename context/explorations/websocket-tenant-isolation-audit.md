# WebSocket / Socket.IO tenant-isolation audit

**Date:** 2026-08-21  
**Audited revision:** `dff568620da44854921a4d39418d9ede805d8c1e` (current `main` at audit start)  
**Scope:** daemon Socket.IO authentication, Feathers publications, native events,
executor/terminal channels, Redis HA relay, clients, and lifecycle cleanup.

## Security invariant

A connection may receive, address, join, enumerate, or influence only resources
in the tenant established by its current authenticated server context. A payload
ID narrows an already-authenticated capability; it never supplies tenant
identity or authorization. Missing, conflicting, expired, or stale context
fails closed.

## Threat model and resource classification

- Tenant, user, board, branch, session, task, terminal, OAuth, artifact, and
  gateway realtime state is tenant-owned or derived from a tenant-owned parent.
- The Socket.IO adapter and its Redis are trusted daemon infrastructure. Redis
  is not an authorization oracle; every relayed Feathers event is re-authorized
  by the receiving replica.
- `server-info` and saturated aggregate connection counters are intentionally
  system-global and contain no tenant/user/resource data.
- PostgreSQL RLS protects rows. It does not protect Socket.IO rooms, cached
  connections, Redis packets, terminal processes, acknowledgements, or logs;
  each of those requires its own boundary.

## Authentication and lifecycle result

1. Handshake JWTs require the runtime issuer/audience and an exact Bearer token.
   Conflicting `auth.token` and Authorization-header tokens are rejected.
2. Required-from-auth tenant identity comes only from signed claims. A raw
   handshake header/query/auth field is never tenant authority. If a configured
   signed claim and canonical `tenant_id` disagree, authentication fails.
3. User lookup runs in the claimed tenant and checks `tokens_valid_after`.
   Service tokens must also satisfy the executor subject/purpose contract.
4. Anonymous connections are permitted only as a login bootstrap. They join no
   Feathers channel or tenant room and receive only `server-info`.
5. Login replacement clears every prior Feathers/raw room, terminal
   capability, tenant value, and authorization cache before installing the new
   identity. Logout does the same. Asynchronous board joins recheck identity
   after their authorization await.
6. Every authenticated socket is disconnected at JWT `exp`; a replacement
   login replaces the timer. Password/role/token and RBAC mutations emit a
   post-commit tenant authorization-invalidation signal, propagated to every
   Redis replica, which disconnects that tenant's sockets and forces fresh
   authentication and joins. This includes permission-source/default-policy
   changes and board/user deletion, not only direct grant edits.
7. Socket.IO connection-state recovery is not enabled. A reconnect therefore
   performs a new handshake rather than restoring old rooms.

## Room / channel authorization matrix

Logical names are shown below. The implementation encodes every dynamic tuple
component with canonical base64url and uses versioned prefixes; callers never
construct authorization by concatenating raw IDs.

| Room/channel or stream               | Constructor/owner                                                  | Who may join                                                                                                                                          | Join authorization owner                                                                              | Publisher / event authorization                                                                                                     | HA and cleanup                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Feathers `authenticated`             | `configureChannels`                                                | Full user/service login; never anonymous, terminal executor, or task executor                                                                         | authentication result                                                                                 | only an intermediate set; publisher always intersects tenant                                                                        | left on login replacement/logout/disconnect                                                                             |
| Tenant channel                       | `tenantChannelName`                                                | user/full service with trusted tenant                                                                                                                 | signed claim or static config                                                                         | required tenant resolution; missing/conflict returns no recipients                                                                  | Redis Feathers relay re-authorizes; all tenant channels removed on identity change                                      |
| Tenant-user channel                  | `tenantUserChannelName`                                            | current user only                                                                                                                                     | authenticated result, never payload user ID                                                           | OAuth per-user events and user-scoped delivery                                                                                      | versioned room; identity-change cleanup                                                                                 |
| Board presence                       | `boardPresenceRoomName`                                            | authenticated non-executor user with current `boards.get` access                                                                                      | `presence:watch-board` calls the hooked boards service, then rechecks live identity                   | cursor packets require the board in the socket's authorized set; room is tenant-qualified                                           | native Redis allowlist; unwatch/logout/invalidation/disconnect remove capability                                        |
| Board Feathers audience              | `resolvePublishScope(kind=board)`                                  | not directly client-joinable                                                                                                                          | `BoardRepository.canView` per receiving connection                                                    | boards/cards/objects/comments resolve board ID and current board visibility; missing board is service-only                          | receiving replica re-authorizes; delete uses pre-delete visibility snapshot                                             |
| Session stream                       | `sessionStreamRoomName`                                            | authenticated browser with current session/branch view; task executors denied                                                                         | `session-streams.create` plus session/branch hooks                                                    | every chunk intersects the current tenant channel and current branch visibility                                                     | room cleared on logout/login; cache invalidation + tenant eviction on ACL changes                                       |
| Executor task                        | `executorTaskRoomName`                                             | only an executor-session token whose signed task claim equals the authenticated result                                                                | `configureChannels`                                                                                   | task/message private control events target the tenant-qualified task room                                                           | cleared on login/logout/disconnect; relay envelope keeps tenant/task scope                                              |
| Terminal attachment                  | `terminalChannelName`                                              | current user for own allocated terminal, or terminal-scoped service token matching tenant/user/terminal/branch/boot and live process-local attachment | terminal allocation server capability plus per-event guard; generic `join` repeats exact scope checks | browser input/resize goes only to active local executor socket; executor output/lifecycle requires scoped token and live attachment | PTY payloads are `.local`; only qualified lifecycle metadata crosses replicas; replacement/disconnect fences duplicates |
| Branch/session/task/message services | central realtime policy + `RealtimeAccessCache`                    | not client-joinable except session stream above                                                                                                       | branch repository / session derivation                                                                | current branch visibility; malformed or unresolved parent narrows to service-only                                                   | relay v3 re-authorizes on each replica; branch removal carries a pre-delete snapshot                                    |
| Artifact events                      | artifact audience                                                  | not directly joinable                                                                                                                                 | branch visibility, or creator/admin for null-branch artifacts                                         | CRUD uses artifact audience; `agor-query` is requester-socket only and never enters Redis                                           | requester query is local; metadata relay is re-authorized                                                               |
| Knowledge events                     | knowledge publisher                                                | not directly joinable                                                                                                                                 | namespace/document permission resolver                                                                | per-document/per-namespace readers; query/edit RPC results suppressed                                                               | safe envelope and receiving-replica resolution                                                                          |
| Tenant catalogs                      | tenant channel                                                     | current tenant user/full service                                                                                                                      | trusted tenant context                                                                                | only declared services; credential fields are projected/redacted before publish                                                     | relay v3; missing tenant never becomes global                                                                           |
| Gateway                              | no raw client room                                                 | none                                                                                                                                                  | authenticated service hooks and gateway tenant scope                                                  | gateway RPC is silent; `gateway-channels` configuration is declared tenant-wide                                                     | Feathers relay only, no caller-named room                                                                               |
| OAuth notification                   | tenant or tenant-user helper; exact local socket for bootstrap URL | no explicit client join                                                                                                                               | authenticated initiating connection and durable tenant/user flow                                      | shared grant -> tenant; per-user grant -> tenant-user; authorization URL -> exact local socket only                                 | completion hint may cross Redis; credential/control-plane service responses never do                                    |
| Repo clone error                     | tenant helper                                                      | current tenant                                                                                                                                        | trusted tenant params captured at operation start                                                     | tenant-qualified native event                                                                                                       | audited native Redis event                                                                                              |
| Authorization invalidation           | internal server-side event                                         | clients cannot join/receive it                                                                                                                        | post-commit mutation hooks                                                                            | disconnects matching trusted socket tenant; does not carry a resource payload                                                       | Socket.IO `serverSideEmit`, adapter-only                                                                                |

The exhaustive service-event declaration is
`apps/agor-daemon/src/utils/realtime-publish-policy.ts`. Startup refuses to run
if a registered service lacks an explicit audience. RPC/auth/credential,
terminal, streaming-ingest, and session-stream control services declare
`none`; there is no implicit tenant or global fallback.

## Custom Socket.IO handler matrix

| Client event                                                                           | Accepted principal                        | Client-controlled values              | Decision and observable result                                                                                                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence:watch-board`                                                                 | current user                              | board ID                              | hooked board get in trusted tenant; `{ok:false}` for invalid, missing, foreign, or denied                                                    |
| `presence:unwatch-board`                                                               | current user                              | board ID                              | derives tenant from socket and leaves only that qualified room; no acknowledgement                                                           |
| `cursor-move`, `cursor-leave`                                                          | current user already authorized for board | board ID and coordinates              | board ID must be in the socket's authorized set; unauthorized packets are ignored                                                            |
| `join`, `leave`                                                                        | current user or terminal-scoped executor  | encoded terminal room                 | strict parser plus exact tenant/user/terminal/branch/boot/live-attachment checks; invalid join has no acknowledgement                        |
| `terminal:input`, `terminal:resize`                                                    | current user already attached             | user ID, terminal ID, data            | user must equal authenticated user; terminal room and active executor must exist; input is rate limited                                      |
| `terminal:output`, `terminal:tab`, `terminal:exit`, `terminal:ready`, `terminal:error` | terminal-scoped executor only             | user/terminal and event data          | scope, tenant, boot, attachment ownership, and active duplicate fence are rechecked per event                                                |
| Feathers service methods                                                               | user/service/executor according to hooks  | service path, method, IDs, query/data | authentication, tenant RLS, executor scope, role and resource RBAC hooks; realtime response is independently published through the allowlist |

## Findings and remediation

| ID    | Severity   | Finding on audited `main`                                                                                                                                                                                                                         | Proof / impact                                                                                                                                                      | Remediation in this change                                                                                                                                                                      |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS-01 | **High**   | Dynamic room names used delimiter concatenation. Externally assigned tenant strings were not guaranteed delimiter-free, so different tenant/user tuples were not injective.                                                                       | Unit collision cases produced the same logical room before the fix, allowing cross-tenant fanout if an authority issued the crafted tenant value.                   | Central versioned, canonical base64url component encoding and strict terminal parsing; all constructors/callers migrated.                                                                       |
| WS-02 | **High**   | Task-executor login used the creator-shaped user result and joined general authenticated/tenant/user channels before its private task channel.                                                                                                    | A task runtime token could receive ordinary tenant/service events unrelated to its task.                                                                            | Classify signed executor-session payload first; join only the tenant-qualified executor-task channel.                                                                                           |
| WS-03 | **High**   | Socket tenant resolution accepted the configured trusted header directly from the client handshake. The HTTP deployment's proxy trust boundary did not automatically protect Socket.IO auth metadata.                                             | A valid user token plus a caller-selected header could bind the socket to a different tenant in header-based configurations.                                        | Socket authentication accepts signed tenant claims only (canonical fallback included) and rejects conflicting signed claims.                                                                    |
| WS-04 | **High**   | The manual handshake JWT path accepted any correctly signed `type:service` token without the service strategy's subject/purpose checks; the canonical strategy also treated the reserved subject as a service entity before checking token type.  | A token from another runtime purpose, or a non-service token using the reserved subject, could acquire full service socket semantics.                               | Require the executor service subject/type and compatible purpose in both handshake and canonical strategy paths.                                                                                |
| WS-05 | **High**   | A Feathers publication whose tenant resolution failed returned the whole service connection set.                                                                                                                                                  | Missing tenant metadata on an internal/manual emit could become a cross-tenant global broadcast.                                                                    | Unknown/missing/conflicting tenant delivery is `[]`; conflicts never fall back to static/global behavior.                                                                                       |
| WS-06 | **High**   | Authentication was handshake-time only. JWT expiry, user token invalidation, and RBAC changes did not evict passive room membership.                                                                                                              | A tab could continue receiving authorized-before-revocation events until transport disconnect.                                                                      | Token-invalidated-at check, expiry disconnect timers, complete live-auth replacement cleanup, post-commit tenant eviction, and Redis-wide invalidation.                                         |
| WS-07 | **High**   | Broadly role-gated streaming ingest allowed an ordinary member to submit executor-shaped task/message progress events.                                                                                                                            | A same-tenant member could forge runtime progress and influence listeners.                                                                                          | Require a full service identity or a task-scoped executor-session token; ordinary users are denied.                                                                                             |
| WS-08 | **Medium** | Board/card/object/comment CRUD publication was tenant-wide, while private-board reads were narrower. Several standard mutations and the comment reaction/reply routes also lacked resource authorization; reaction user ID was caller-controlled. | A same-tenant non-viewer could receive or mutate private board data and attribute a reaction to another user.                                                       | Board-scoped publication with per-recipient `canView`; board/card/object/comment mutation hooks; custom comment route authorization; server-derived author/reaction identity; field projection. |
| WS-09 | **Medium** | Artifact `agor-query` runtime requests were emitted to the artifact audience and contained requester/query details, with UI-side filtering as the last boundary.                                                                                  | Other authorized artifact viewers could passively receive a request intended for one tab.                                                                           | Exact requester-connection delivery only; event is denied from Redis.                                                                                                                           |
| WS-10 | **Medium** | Tenant-wide `presence-updated` included the private board ID even though cursor rooms were board-authorized.                                                                                                                                      | Tenant peers could infer a private board identifier and user activity.                                                                                              | Tenant heartbeat omits board ID; board identity remains only on board-authorized cursor events.                                                                                                 |
| WS-11 | **Medium** | Redis relays and delete events could be processed under a weaker mixed-version policy; a deleted private board could no longer be authorized after the row disappeared.                                                                           | Rolling replicas could disagree on delivery, and delete authorization risked widening or suppressing legitimate recipients.                                         | Relay contract bumped to v3; receiving replica rejects other versions; board and branch deletes capture pre-delete visibility snapshots. Versioned rooms make mixed room delivery fail closed.  |
| WS-12 | **Low**    | The generic `leave` event accepted non-terminal adapter room names, and terminal logs included raw room/identity details.                                                                                                                         | A client could address arbitrary adapter room names (although only to remove its own membership); shared logs could retain attacker-supplied or tenant identifiers. | Restrict `leave` to strictly parsed, authorized terminal rooms and use generic/shortened operational logs; never log invalid raw room names.                                                    |
| WS-13 | **Low**    | Session-stream subscribe fell back to the caller's ID if an authorized session lookup unexpectedly returned no canonical row instead of throwing.                                                                                                 | Current services throw on inaccessible rows, but a null/partial adapter result could materialize a caller-named stream room.                                        | Require a positive canonical session ID from the hooked tenant/RBAC read; null or partial results fail closed without creating a channel.                                                       |

## Adversarial validation

### PostgreSQL/RLS and real Socket.IO

`socketio-tenant-isolation.postgres.test.ts` runs with a disposable PostgreSQL
application role verified as `NOSUPERUSER` and `NOBYPASSRLS`. It creates two
tenants, three users, shared/private boards, and two signed Socket.IO clients.
It verifies:

- signed tenant claim wins over caller-supplied auth metadata;
- own-tenant shared-board joins succeed;
- foreign tenant, inaccessible private board, and nonexistent board joins all
  return the same negative acknowledgement;
- a foreign Feathers `boards.get` is indistinguishable from a missing ID;
- forged cursor and terminal-room joins create no passive delivery;
- received-event buffers on both tenants remain empty for negative probes;
- tenant A authorization invalidation disconnects A but not B; reconnect must
  authenticate and authorize again.

### Two replicas and Redis

`socketio-ha-tenant-isolation.integration.test.ts` starts two actual Socket.IO
servers with the Redis adapter. Two tenant-A sockets on different replicas and
a tenant-B observer prove that an authorized cursor crosses replicas exactly
once, tenant B receives nothing, and an authorization-invalidation signal from
one replica disconnects tenant A on both replicas without disconnecting B.

### Unit and static negatives

Focused tests cover claim/header conflicts, multiple credential sources,
service token semantics, token invalidation/expiry, live login replacement,
task-executor room restriction, room encoding/parser collisions, terminal
scope/duplicate/rate-limit cases, session-stream authorization, publish-time
RBAC, missing tenant, board delete snapshots, Redis relay v3 validation,
artifact requester-only delivery, streaming publisher identity, custom comment
field smuggling, and local/HA eviction. Static boundary checks reject new raw
realtime primitives unless explicitly audited.

## Information-leak review

- Board-watch acknowledgements deliberately collapse missing, foreign, and
  denied into `{ok:false}`. Custom board-comment routes similarly collapse
  missing/foreign/denied to a 404.
- Unauthorized cursor/terminal packets are ignored rather than returning room
  existence or membership counts. No API enumerates adapter rooms.
- Tenant-wide presence no longer carries board IDs. Global metrics contain
  only saturated counts; logs use shortened IDs only after successful auth and
  avoid invalid raw room names.
- Database authorization can still create coarse timing differences between a
  malformed ID and a valid-but-denied ID. No response or acknowledgement
  intentionally exposes that distinction; constant-time database behavior is
  not claimed.

## Residual risks and operational requirements

1. **Do not run a mixed deployment containing the vulnerable implementation.**
   Versioned rooms and relay v3 prevent a new replica from accepting old room
   or Feathers envelopes, but they cannot retrofit authorization inside an old
   replica for clients connected directly to it. Drain old replicas and force
   reconnect during the upgrade.
2. External identity-provider suspension has no daemon callback unless it is
   reflected through Agor's user/token mutation path. Such a socket is bounded
   by access-token expiry. Short access-token TTLs remain important.
3. Tenant-wide invalidation intentionally favors confidentiality over
   availability. An ACL change disconnects all sockets in that tenant; a future
   optimization may target affected users/resources only, but must preserve
   the fail-closed cross-replica fence.
4. Redis and daemon service credentials remain privileged infrastructure. A
   party able to publish arbitrary adapter packets can cause availability
   impact and impersonate a daemon; network/credential isolation and Redis ACLs
   are required. `deployment.redis.key_prefix` is the deployment trust
   namespace and must be unique across independently trusted deployments.
5. Full service accounts intentionally receive declared service events in
   their own tenant. Task and terminal executors are narrower principals and
   must not be upgraded to full service tokens.
6. Event DTO redaction is a separate layer from routing. Tenant-wide users,
   MCP server, gateway, and catalog events must keep their secret/owner-only
   projection tests even though tenant isolation is now fail closed.
7. Tenant deletion is a standalone/offline operation rather than a live daemon
   service. It does not signal socket eviction; the supported procedure must
   drain the daemon cohort before deleting tenant data.
8. Task-runtime tokens intentionally permit reconnect and are not fenced to one
   simultaneous socket; PostgreSQL authority, expiry, revocation, and exact
   tenant/session/task/branch claims bound every replay, but bearer theft within
   that window remains bearer theft. Terminal executors additionally use a
   process-local active-socket/boot fence because they control an interactive
   PTY.

## Validation commands

Observed results on the audit branch:

- daemon suite: 248 files passed, 14 skipped; 3,231 tests passed, 87 skipped;
- focused realtime/security suite: 12 files and 430 tests passed;
- PostgreSQL/RLS suite: 140 tests passed across 30 isolated databases, with the
  application role verified as `NOSUPERUSER` and `NOBYPASSRLS`;
- Redis/two-replica isolation fixture: passed;
- daemon, UI, and executor source typechecks: passed;
- Biome/Prettier and multitenancy, realtime, and short-ID boundary checks:
  passed.

```bash
pnpm --filter @agor/daemon exec vitest run \
  src/setup/socketio.test.ts \
  src/services/session-streams.test.ts \
  src/utils/realtime-publish.test.ts \
  src/realtime/redis-realtime.test.ts \
  src/register-routes.streaming-auth.test.ts \
  src/register-routes.board-comments.test.ts \
  src/register-hooks.test.ts \
  src/register-hooks.update-gating.test.ts --no-file-parallelism

pnpm test:postgres:docker
AGOR_TEST_REDIS_URL=redis://127.0.0.1:<disposable-port> \
  pnpm --filter @agor/daemon exec vitest run \
  src/setup/socketio-ha-tenant-isolation.integration.test.ts --no-file-parallelism

pnpm exec tsc -p apps/agor-daemon/tsconfig.json --noEmit --customConditions source
pnpm check:multitenancy-boundaries
pnpm check:realtime-boundaries
pnpm check:shortid
```
