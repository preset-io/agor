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

1. Handshake JWTs require the runtime issuer/audience, a bounded `exp`, and an
   exact Bearer token. Conflicting `auth.token` and Authorization-header tokens
   are rejected.
2. Required-from-auth tenant identity comes only from signed claims. A raw
   handshake header/query/auth field is never tenant authority. If a configured
   signed claim and canonical `tenant_id` disagree, authentication fails.
3. User lookup runs in the claimed tenant. Ordinary access and impersonation
   JWTs check `tokens_valid_after`; an already-issued task-executor credential
   is instead a bounded launch lease and remains valid until task terminality,
   explicit revocation, or expiry. Service tokens must also satisfy the
   reserved subject/purpose contract.
4. There is no anonymous namespace connection or post-connect login bootstrap.
   The verified strategy result is synchronously finalized as a non-enumerable,
   immutable connection authority before Socket.IO accepts the connection.
   The authority contains the principal kind and trusted tenant; executor
   principals additionally retain only an exact task identifier (when the
   credential is task-scoped), a revocation generation, and a token
   fingerprint. The same finalizer installs a frozen, enumerable
   Feathers identity projection (`authenticated`, verified payload without the
   bearer, redacted user, and tenant), so service hooks consume the established
   connection authority instead of re-verifying mutable credential state. A
   live connection cannot replace that authority, even after retirement.
5. The same authority supplies the Feathers connection tenant used by service
   hooks and every native Socket.IO authorization decision. Raw handshake
   fields, `socket.data`, and authentication responses are not competing
   identity sources. Restricted terminal executors receive no Feathers identity
   projection at all. `configureChannels` consumes the finalized authority once
   on connection. Asynchronous board joins recheck that authority after their
   authorization await.
6. Machine and impersonation sockets are disconnected at JWT `exp`. An
   ordinary browser access token is an admission credential: routine 15-minute
   rotation updates the bearer used by the next handshake without interrupting
   a healthy immutable connection, open terminal, or subscriptions. Natural
   reconnect still verifies the latest token and rejects stale/expired tokens.
   Password/role/token and revocation-capable RBAC
   mutations emit a post-commit tenant authorization-invalidation signal,
   propagated to every Redis replica, which clears cached decisions,
   disconnects that tenant's sockets, and forces fresh authentication and
   joins. Additive grants and non-ACL resource changes use a cache-only form of
   the same distributed signal so they cannot interrupt the operation that
   created them. Full eviction includes permission-source/default-policy
   changes, filesystem-access reductions, and board/user deletion, not only
   direct grant edits.
7. Socket.IO transport auto-reconnect remains enabled for browser and executor
   clients. Server-side connection-state recovery is deliberately not enabled:
   every replacement namespace connection performs the full authenticated
   handshake and rebuilds only its authorized rooms/subscriptions. In HA mode,
   losing either required Redis client clears replica-local authorization
   caches, retires terminal capabilities, and closes Engine.IO transports;
   admission resumes only after both Redis clients are ready, preserving
   automatic reconnect without accepting a socket on a partitioned fanout
   plane.

## Room / channel authorization matrix

Logical names are shown below. The implementation encodes every dynamic tuple
component with canonical base64url and uses versioned prefixes; callers never
construct authorization by concatenating raw IDs.

| Room/channel or stream               | Constructor/owner                                                  | Who may join                                                                                                                                               | Join authorization owner                                                                                                                                                 | Publisher / event authorization                                                                                                                                                                                          | HA and cleanup                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Feathers `authenticated`             | `configureChannels`                                                | Full user/service handshake; never anonymous, terminal executor, or task executor                                                                          | immutable connection authority                                                                                                                                           | only an intermediate set; publisher always intersects tenant                                                                                                                                                             | transport disconnect removes membership; reconnect rebuilds from new authority                                                     |
| Tenant channel                       | `tenantChannelName`                                                | user/full service with trusted tenant                                                                                                                      | immutable authority derived from signed claim or static config                                                                                                           | required tenant resolution; missing/conflict returns no recipients                                                                                                                                                       | Redis Feathers relay re-authorizes; disconnect/invalidation clears membership                                                      |
| Tenant-user channel                  | `tenantUserChannelName`                                            | current user only                                                                                                                                          | immutable authority, never payload user ID                                                                                                                               | OAuth per-user events and user-scoped delivery                                                                                                                                                                           | versioned room; disconnect/reconnect cleanup                                                                                       |
| Board presence                       | `boardPresenceRoomName`                                            | authenticated non-executor user with current `boards.get` access                                                                                           | `presence:watch-board` calls the hooked boards service, then rechecks live identity                                                                                      | cursor packets require the board in the socket's authorized set; room is tenant-qualified                                                                                                                                | native Redis allowlist; unwatch/logout/invalidation/disconnect remove capability                                                   |
| Navbar board association             | `boardPresenceAssociationRoomName`                                 | authenticated user for each non-archived board returned by scoped `boards.find`                                                                            | `presence:subscribe-boards` invalidates the prior publisher grant, then reauthorizes a bounded, rate-limited, latest-wins desired set and silently omits unavailable IDs | board-bearing heartbeats require the latest completed find-scoped publisher grant; cursor/get authority has no fallback; tenant heartbeat carries no board; packet contains only user/presence/board IDs and server time | native Redis allowlist; every new generation retracts the prior association; logout/invalidation/disconnect emit removal and evict |
| Board Feathers audience              | `resolvePublishScope(kind=board)`                                  | not directly client-joinable                                                                                                                               | `BoardRepository.canView` per receiving connection                                                                                                                       | boards/cards/objects/comments resolve board ID and current board visibility; missing board is service-only                                                                                                               | receiving replica re-authorizes; delete uses pre-delete visibility snapshot                                                        |
| Session stream                       | `sessionStreamRoomName`                                            | authenticated delegated user with current session/branch view; normally used by browsers                                                                   | `session-streams.create` plus session/branch hooks                                                                                                                       | every chunk intersects the current tenant channel and current branch visibility                                                                                                                                          | disconnect clears room; client re-announces after accepted reconnect; ACL eviction disconnects                                     |
| Executor task                        | `executorTaskRoomName`                                             | only an executor-session token whose signed task claim equals the authenticated result                                                                     | awaited `RuntimeJWTStrategy` finalizer commits authority; `configureChannels` owns membership                                                                            | task/message private control events target the tenant-qualified task room                                                                                                                                                | disconnect/revocation clears room; reconnect revalidates token and relay envelope keeps tenant/task scope                          |
| Terminal attachment                  | `terminalChannelName`                                              | current user for own allocated terminal, or restricted terminal-executor token matching tenant/user/terminal/branch/boot and live process-local attachment | terminal allocation server capability plus immutable connection scope; generic `join` repeats checks                                                                     | browser input/resize goes only to active local executor socket; executor output/lifecycle requires scoped token and live attachment                                                                                      | PTY payloads are `.local`; only qualified lifecycle metadata crosses replicas; reconnect/disconnect fences duplicates              |
| Branch/session/task/message services | central realtime policy + `RealtimeAccessCache`                    | not client-joinable except session stream above                                                                                                            | branch repository / session derivation                                                                                                                                   | current branch visibility; malformed or unresolved parent narrows to service-only                                                                                                                                        | relay v3 re-authorizes on each replica; branch removal carries a pre-delete snapshot                                               |
| Artifact events                      | artifact audience                                                  | not directly joinable                                                                                                                                      | branch visibility, or creator/admin for null-branch artifacts                                                                                                            | CRUD uses artifact audience; `agor-query` is requester-socket only and never enters Redis                                                                                                                                | requester query is local; metadata relay is re-authorized                                                                          |
| Knowledge events                     | knowledge publisher                                                | not directly joinable                                                                                                                                      | namespace/document permission resolver                                                                                                                                   | per-document/per-namespace readers; query/edit RPC results suppressed                                                                                                                                                    | safe envelope and receiving-replica resolution                                                                                     |
| Tenant catalogs                      | tenant channel                                                     | current tenant user/full service                                                                                                                           | trusted tenant context                                                                                                                                                   | only declared services; credential fields are projected/redacted before publish                                                                                                                                          | relay v3; missing tenant never becomes global                                                                                      |
| Gateway                              | no raw client room                                                 | none                                                                                                                                                       | authenticated service hooks and gateway tenant scope                                                                                                                     | gateway RPC is silent; `gateway-channels` configuration is declared tenant-wide                                                                                                                                          | Feathers relay only, no caller-named room                                                                                          |
| OAuth notification                   | tenant or tenant-user helper; exact local socket for bootstrap URL | no explicit client join                                                                                                                                    | authenticated initiating connection and durable tenant/user flow                                                                                                         | shared grant -> tenant; per-user grant -> tenant-user; authorization URL -> exact local socket only                                                                                                                      | completion hint may cross Redis; credential/control-plane service responses never do                                               |
| Repo clone error                     | tenant helper                                                      | current tenant                                                                                                                                             | trusted tenant params captured at operation start                                                                                                                        | tenant-qualified native event                                                                                                                                                                                            | audited native Redis event                                                                                                         |
| Authorization invalidation           | internal server-side event                                         | clients cannot join/receive it                                                                                                                             | post-commit mutation hooks                                                                                                                                               | always clears matching tenant authorization caches; revocation-capable mutations also disconnect sockets and retire terminal capabilities; no resource payload                                                           | Socket.IO `serverSideEmit`, adapter-only                                                                                           |

The exhaustive service-event declaration is
`apps/agor-daemon/src/utils/realtime-publish-policy.ts`. Startup refuses to run
if a registered service lacks an explicit audience. RPC/auth/credential,
terminal, streaming-ingest, and session-stream control services declare
`none`; there is no implicit tenant or global fallback.

## Custom Socket.IO handler matrix

| Client event                                                                           | Accepted principal                         | Client-controlled values              | Decision and observable result                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence:watch-board`                                                                 | current user                               | board ID                              | hooked board get in trusted tenant; `{ok:false}` for invalid, missing, foreign, or denied                                                                                                                                                    |
| `presence:unwatch-board`                                                               | current user                               | board ID                              | derives tenant from socket and leaves only that qualified room; no acknowledgement                                                                                                                                                           |
| `presence:subscribe-boards`                                                            | current user                               | bounded full set of board IDs         | scoped `boards.find` returns only currently visible, non-archived canonical boards; missing, foreign, private, and archived IDs are silently omitted and valid requests receive the same `{ok:true}`                                         |
| `presence:heartbeat`, `presence:leave`                                                 | current user with server-owned board grant | optional board ID                     | user, tenant, connection identity, and timestamp are server-derived; tenant delivery is boardless; board identity goes only to the separately authorized board-association room; leave removes only this connection instance                 |
| `cursor-move`, `cursor-leave`                                                          | current user already authorized for board  | board ID and coordinates              | board ID must be in the socket's authorized set; moves are rate-limited; leave is edge-triggered from the last accepted move so repeated packets cannot amplify Redis fanout; unauthorized packets are ignored                               |
| `join`, `leave`                                                                        | current user or terminal-scoped executor   | encoded terminal room                 | strict parser plus exact tenant/user/terminal/branch/boot/live-attachment checks; invalid join has no acknowledgement                                                                                                                        |
| `terminal:input`, `terminal:resize`                                                    | current user already attached              | user ID, terminal ID, data            | user must equal authenticated user; terminal room and active executor must exist; input is rate limited                                                                                                                                      |
| `terminal:output`, `terminal:tab`, `terminal:exit`, `terminal:ready`, `terminal:error` | terminal-scoped executor only              | user/terminal and event data          | scope, tenant, boot, attachment ownership, and active duplicate fence are rechecked per event                                                                                                                                                |
| Feathers service methods                                                               | user or explicit service principal         | service path, method, IDs, query/data | authentication, tenant RLS, and normal role/resource hooks; a task executor is the initiating user, while executor-only capabilities additionally require exact signed task context; realtime response is independently publication-filtered |

## Findings and remediation

| ID    | Severity   | Finding on audited `main`                                                                                                                                                                                                                         | Proof / impact                                                                                                                                                      | Remediation in this change                                                                                                                                                                                                                                   |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS-01 | **High**   | Dynamic room names used delimiter concatenation. Externally assigned tenant strings were not guaranteed delimiter-free, so different tenant/user tuples were not injective.                                                                       | Unit collision cases produced the same logical room before the fix, allowing cross-tenant fanout if an authority issued the crafted tenant value.                   | Central versioned, canonical base64url component encoding and strict terminal parsing; all constructors/callers migrated.                                                                                                                                    |
| WS-02 | **High**   | Task-executor login used the creator-shaped user result and joined general authenticated/tenant/user channels before its private task channel.                                                                                                    | A task runtime token could receive ordinary tenant/service events unrelated to its task.                                                                            | Classify signed executor-session payload first; join only the tenant-qualified executor-task channel.                                                                                                                                                        |
| WS-03 | **High**   | Socket tenant resolution accepted the configured trusted header directly from the client handshake. The HTTP deployment's proxy trust boundary did not automatically protect Socket.IO auth metadata.                                             | A valid user token plus a caller-selected header could bind the socket to a different tenant in header-based configurations.                                        | Socket authentication accepts signed tenant claims only (canonical fallback included) and rejects conflicting signed claims.                                                                                                                                 |
| WS-04 | **High**   | The manual handshake JWT path accepted any correctly signed `type:service` token without the service strategy's subject/purpose checks; the canonical strategy also treated the reserved subject as a service entity before checking token type.  | A token from another runtime purpose, or a non-service token using the reserved subject, could acquire full service socket semantics.                               | Require the executor service subject/type and compatible purpose in both handshake and canonical strategy paths.                                                                                                                                             |
| WS-05 | **High**   | A Feathers publication whose tenant resolution failed returned the whole service connection set.                                                                                                                                                  | Missing tenant metadata on an internal/manual emit could become a cross-tenant global broadcast.                                                                    | Unknown/missing/conflicting tenant delivery is `[]`; conflicts never fall back to static/global behavior.                                                                                                                                                    |
| WS-06 | **High**   | Authentication was handshake-time only. JWT expiry, user token invalidation, and RBAC changes did not evict passive room membership.                                                                                                              | A tab could continue receiving authorized-before-revocation events until transport disconnect.                                                                      | Token-invalidated-at check, expiry disconnect timers, immutable authenticated handshakes, post-commit tenant eviction, and Redis-wide invalidation.                                                                                                          |
| WS-07 | **High**   | Broadly role-gated streaming ingest allowed an ordinary member to submit executor-shaped task/message progress events.                                                                                                                            | A same-tenant member could forge runtime progress and influence listeners.                                                                                          | Require a full service identity or a task-scoped executor-session token; ordinary users are denied.                                                                                                                                                          |
| WS-08 | **Medium** | Board/card/object/comment CRUD publication was tenant-wide, while private-board reads were narrower. Several standard mutations and the comment reaction/reply routes also lacked resource authorization; reaction user ID was caller-controlled. | A same-tenant non-viewer could receive or mutate private board data and attribute a reaction to another user.                                                       | Board-scoped publication with per-recipient `canView`; board/card/object/comment mutation hooks; custom comment route authorization; server-derived author/reaction identity; field projection.                                                              |
| WS-09 | **Medium** | Artifact `agor-query` runtime requests were emitted to the artifact audience and contained requester/query details, with UI-side filtering as the last boundary.                                                                                  | Other authorized artifact viewers could passively receive a request intended for one tab.                                                                           | Exact requester-connection delivery only; event is denied from Redis.                                                                                                                                                                                        |
| WS-10 | **Medium** | Tenant-wide `presence-updated` included the private board ID even though cursor rooms were board-authorized.                                                                                                                                      | Tenant peers could infer a private board identifier and user activity.                                                                                              | The #2520 mitigation removed board IDs from tenant heartbeats. The secure restoration keeps that invariant and adds a distinct board-association room authorized for both publisher and subscriber; board identity never returns to the tenant-wide channel. |
| WS-11 | **Medium** | Redis relays and delete events could be processed under a weaker mixed-version policy; a deleted private board could no longer be authorized after the row disappeared.                                                                           | Rolling replicas could disagree on delivery, and delete authorization risked widening or suppressing legitimate recipients.                                         | Relay contract bumped to v3; receiving replica rejects other versions; board and branch deletes capture pre-delete visibility snapshots. Versioned rooms make mixed room delivery fail closed.                                                               |
| WS-12 | **Low**    | The generic `leave` event accepted non-terminal adapter room names, and terminal logs included raw room/identity details.                                                                                                                         | A client could address arbitrary adapter room names (although only to remove its own membership); shared logs could retain attacker-supplied or tenant identifiers. | Restrict `leave` to strictly parsed, authorized terminal rooms and use generic/shortened operational logs; never log invalid raw room names.                                                                                                                 |
| WS-13 | **Low**    | Session-stream subscribe fell back to the caller's ID if an authorized session lookup unexpectedly returned no canonical row instead of throwing.                                                                                                 | Current services throw on inaccessible rows, but a null/partial adapter result could materialize a caller-named stream room.                                        | Require a positive canonical session ID from the hooked tenant/RBAC read; null or partial results fail closed without creating a channel.                                                                                                                    |

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
service token semantics, token invalidation/expiry, live login rejection,
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
- Tenant-wide presence never carries board IDs. Board-bearing presence is a
  separate low-frequency packet delivered only through a tenant-and-board room
  whose subscribers were returned by scoped `boards.find`; inaccessible IDs
  are omitted without counts or reason. The packet contains no email, board
  name, secrets, or caller-supplied identity. Global metrics contain only
  saturated counts; logs use shortened IDs only after successful auth and
  avoid invalid raw room names.
- Database authorization can still create coarse timing differences between a
  malformed ID and a valid-but-denied ID. No response or acknowledgement
  intentionally exposes that distinction; constant-time database behavior is
  not claimed.

## Independent review hardening

An independent Codex review found five additional authorization-lifecycle
gaps. They were fixed before merge:

1. Board objects and comments now authorize and publish against every attached
   branch/session/task/message, rather than treating access to any branch on a
   private board as access to all attached resources. Only unattached records
   use board visibility as their audience.
2. Authorization invalidation clears every replica's realtime access cache.
   Revocation-capable changes, including branch removal, additionally
   disconnect sockets before a reconnect can reuse a warm pre-revocation
   decision. Additive changes use the cache-only form. Primary-teammate changes
   capture trusted pre-mutation state: an absent or still-attached prior
   primary is cache-only, while a detached/unresolved prior primary fully
   evicts because its pointer can be the user's last board-visibility anchor.
   Branch attachment removal and filesystem-access reductions also remain
   full-eviction operations.
3. Browsers can no longer issue raw terminal-room joins. An authorized
   `terminals.create` installs the server-owned attachment capability, and an
   authorization invalidation retires the tenant's local terminal attachments.
4. Executor-session token revocation propagates only a hashed token fingerprint
   across replicas and disconnects the exact active task executor. Raw bearer
   tokens never enter Redis messages, and revocation never widens to a session
   or tenant.
5. Handshake, Feathers JWT authentication, refresh, and channel setup share one
   signed tenant-claim reconciliation rule. Contradictory canonical/configured
   tenant claims fail authentication rather than merely declining room setup.

Regression coverage includes two branches with different visibility on one
private board, warm-cache revoke/reconnect, browser terminal rejoin after
invalidation, local and cross-replica active executor revocation, and
contradictory signed claims at authentication, refresh, and handshake
boundaries.

A second review pass then found connection-ordering and identifier-resolution
edge cases. The final implementation also:

- carries the durable executor validation result through a private,
  non-enumerable admission candidate, then freezes tenant, principal kind,
  optional exact task, expiry, revocation generation, and only a token
  fingerprint into the connection's single immutable authority before the
  login acknowledgement; verified session/branch claims remain only in the
  frozen Feathers authentication projection for the few exact-scope guards;
- advances a process-local per-tenant admission generation before scanning
  sockets, so authority validation that raced a local or HA exact revocation
  cannot install a late task-room capability. No bearer/session tombstone layer
  remains;
- resolves board-comment and card short IDs inside the caller's current
  visibility predicate, then canonicalizes authorized IDs before mutation, so
  hidden collisions neither create ambiguity nor disclose full IDs;
- rejects IDs, ownership/state fields, and `parent_comment_id` on generic
  public comment creation. Only the authorized reply operation may establish a
  parent and inherit its attachments; and
- shares one domain attachment-policy descriptor between comment repository
  authorization and realtime publication, and exercises actual reconnect
  denial in the Redis HA fixture.

The executor regression uses a real Socket.IO client plus the production
Feathers `AuthenticationService`/`RuntimeJWTStrategy`, including deterministic
revocation pauses after durable authority validation and after final connection
authority commit but before Socket.IO admission.

A third review pass exercised identity replacement and generic comment mutation
fields. The final boundaries additionally:

- finalize executor authority and the canonical Feathers connection tenant
  once in the authentication lifecycle, independent of listener order;
  `configureChannels` remains the sole task-room membership owner;
- reject a post-connect tenant-A executor to tenant-B user authentication call
  without changing the original executor authority, room, or passive event
  audience; a second regression disconnects, performs a tenant-B handshake on
  the retained client object, and proves the retired tenant-A task room no
  longer delivers either private control event;
- project external comment patch to the typed `content`/`resolved` contract,
  derive edited/preview state server-side, reject generic full replacement, and
  keep reactions on their caller-bound toggle operation; and
- preserve legitimate spatial movement through a strict, author-only
  reposition operation that cannot change the comment's branch/session
  audience anchor. All comment custom mutation routes now run in the same
  tenant database/RLS scope as ordinary comment CRUD.

A fourth review pass adversarially exercised that spatial boundary itself. The
final implementation additionally:

- resolves zone parents only after the caller's current board ACL succeeds,
  returning the same `NotFound` for known hidden zones and missing resources;
- requires the immutable branch-audience precondition on every reposition and
  uses one tested UI planner for branch, zone, and free-space drags. A drop on
  another branch remains absolute rather than attempting a forbidden audience
  change or leaving an optimistic node diverged from storage;
- exposes the dynamic reposition URL through a typed client service contract,
  so callers cannot fall through to the unconstrained generic service type; and
- centralizes the tenant transaction and tenant write-freeze gate in the custom
  authenticated-route registrar. Its installed around hooks are executed
  directly in tests, replacing the ineffective static-path membership claim
  for routes registered after ordinary service hooks.

Live HA onboarding then exposed an executor reconnect failure at the boundary
between Socket.IO state and Feathers service params. The final hardening pushes
the fix into connection establishment rather than wrapping individual executor
calls:

- the browser, task executor, and terminal executor present their credential on
  every namespace handshake; the production JWT strategy installs one frozen
  principal/tenant/scope authority before `connect` or the first service call;
- native Socket.IO handlers and Feathers tenant hooks consume projections of
  that same authority. Terminal user/terminal/branch/boot scope is copied into
  the immutable authority rather than reread from mutable Feathers entity data;
- executor service guards derive session/task/branch scope only from the
  verified frozen JWT payload. The executor no longer retains and resubmits its
  raw bearer to repair missing transport claims, and the unused legacy custom
  `session-token` authentication strategy has been removed;
- the Socket.IO client factory accepts a token getter, so normal automatic
  reconnects read the latest browser token. A rejected expired-token handshake
  refreshes over REST and retries; executor reconnects reuse their exact scoped
  token and fail closed after revocation;
- the Socket.IO client deliberately omits Feathers' authentication-client
  plugin, eliminating its automatic post-connect reauthentication path. REST
  login/refresh retains the normal Feathers authentication API; and
- real production-strategy tests prove immediate tenant/user context, a
  validation-versus-revocation race, structured fail-closed handshake errors,
  rejection of live identity replacement, and automatic transport reconnect
  with freshly established authority.

Final testing against the rebuilt two-replica HA stack corrected the fixture
itself and closed one REST/Socket.IO transport asymmetry:

- the HA harness now authenticates every Socket.IO connection at the namespace
  handshake instead of issuing the removed post-connect Feathers login call;
  anonymous handshakes must fail before connection admission;
- browser access-token refresh is exercised over REST while live immutable
  sockets retain their IDs and subscriptions. Daemon failover then proves the
  reconnect handshake invokes the credential getter and verifies the latest
  token;
- nested RBAC services share one registered `requireAuth` boundary, so REST
  requests receive the same authenticated user/tenant authority that an
  admitted Socket.IO connection projects. Read-only effective-access,
  aligned-branch, and filesystem-access routes now run in tenant database scope
  as well; and
- board-owner and board-group-grant routes share one daemon-owned route
  authorization helper. Non-admin short IDs resolve inside current board
  visibility, the full authorized ID is installed before the service method,
  and hidden, foreign-tenant, missing, or visibility-ambiguous targets converge
  on one denial without masking unexpected repository failures.

The live HA fixture warms a replica's negative board ACL, adds an owner through
the other replica, proves distributed cache-only invalidation without any
socket disconnect, removes that owner, and proves full tenant eviction across
replicas while the foreign tenant remains connected. Reconnect cannot restore
the revoked board watch. The same run covers daemon failure, Redis
failure/no-replay/recovery, token rotation, cross-tenant REST/event/watch/cursor
negatives, and exact foreign/missing nested-RBAC responses.

### Executor delegation simplification

Task executors are an out-of-process extension of the initiating user, not an
independently maintained API role. The daemon therefore applies its ordinary
user role/resource hooks to their Feathers calls instead of maintaining a
second endpoint allowlist that can drift from the public client contract. This
does not make the credential a service account and does not bypass tenant RLS.

The signed task/session/branch claims remain capability context only at the
small set of boundaries that grant something an ordinary user call cannot:
task lifecycle/result mutation, private task-control rooms, streaming and
permission-result publication, provider-failure classification, plaintext SDK
credential resolution, session MCP/OAuth secret material, and the running
session's execution-identity exemption. Taskless branch/environment command
credentials cannot satisfy those boundaries and use a maximum 15-minute
lifetime because their fire-and-forget launcher has no reliable task lifecycle
on which to revoke them.

There is deliberately no polling authorization coordinator. Starting a task
establishes its execution lease. Ordinary daemon calls made during that lease
still re-run the initiating user's current authorization, and a reconnect must
revalidate the signed token and durable token authority. Exact token revocation
continues to fence connection admission and retire the corresponding task room.
Every credential issued for a task is revoked when that task becomes terminal;
session and branch deletion refuse to cascade an unfinished task out from under
that lifecycle boundary.

## Residual risks and operational requirements

1. **Do not run a mixed deployment containing the vulnerable implementation.**
   Versioned rooms and relay v3 prevent a new replica from accepting old room
   or Feathers envelopes, but they cannot retrofit authorization inside an old
   replica for clients connected directly to it. Drain old replicas and force
   reconnect during the upgrade.
2. External identity-provider suspension has no daemon callback unless it is
   reflected through Agor's user/token mutation path. An ordinary browser
   access token is an admission credential, so an already accepted socket is
   not retired merely because that bearer later expires. Deployments must
   propagate suspension into Agor's token/user invalidation path; otherwise the
   socket retains its accepted authority until its transport disconnects.
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
   their own tenant. Task executors instead use delegated user authorization;
   terminal executors are restricted capabilities. Neither may be upgraded to
   a full service token merely to bypass a normal hook.
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

- daemon suite: 251 files passed, 14 skipped; 3,313 tests passed, 87 skipped;
- latest reposition/tenant-route focused suites: 310 tests passed across daemon,
  core repository, and UI planner coverage;
- focused realtime/security suite: 12 files and 430 tests passed;
- PostgreSQL/RLS suite: 140 tests passed across 30 isolated databases, with the
  application role verified as `NOSUPERUSER` and `NOBYPASSRLS`;
- Redis/two-replica isolation fixture: passed;
- daemon, UI, and executor source typechecks: passed;
- Biome/Prettier and multitenancy, realtime, and short-ID boundary checks:
  passed.
- root `pnpm check` after the independent review hardening: passed (21/21
  typecheck tasks and 15/15 build tasks).
- managed rich-onboarding regression: board/branch/object creation and primary
  teammate selection no longer evict the initiating socket mid-RPC; focused
  invalidation, terminal, and hook coverage passed (242 tests), while
  revocation-capable mutations still require full eviction.
- authenticated-connection finalization rerun: full daemon suite passed (259
  files, 3,415 tests; 16 files/100 tests environment-gated), executor retry
  coverage passed (17/17), and multitenancy/realtime boundary checks passed.
- immutable-handshake simplification: focused daemon authentication/socket/
  publication coverage passed (288 tests across 11 files), UI reconnect/refresh coverage passed
  (32), executor reconnect coverage passed (28), core/client API coverage passed
  (122), and multitenancy/realtime boundary checks passed. This refactor is a
  net source reduction; root `pnpm check` passed all 21 typecheck tasks,
  boundary checks, and all 15 non-doc build tasks.
- post-review, post-rebase final rerun: the full daemon suite passed (261
  files, 3,427 tests; 16 files/103 tests environment-gated).
- final HA/RBAC follow-up: daemon suite passed (262 files, 3,443 tests; 16
  files/103 tests environment-gated); focused registered-hook, group-service,
  and board-route authorization coverage passed (157 tests); root `pnpm check`
  passed all typecheck, lint/boundary, and 15 non-doc build tasks; the rebuilt
  two-replica HA harness passed both with daemon/Redis failure injection and
  without failure injection.
- executor-as-user simplification: ordinary executor Feathers calls now use
  the initiating user's normal service hooks/RBAC instead of a duplicate
  endpoint allowlist or full service identity. Exact task/command claims remain
  only at executor-specific lifecycle, data-plane, secret, and callback gates;
  terminal task state revokes every task credential. The full daemon suite
  passed (263 files, 3,427 tests; 16 files/104 tests environment-gated), focused
  core/executor/UI suites passed (139/81/15), daemon/core/executor/UI source
  typechecks passed, and Biome plus multitenancy/filesystem/realtime/short-ID
  boundary checks passed. The final root `pnpm check` passed all 21 typecheck
  tasks and all 15 non-doc build tasks.
- final minimum-review hardening: 112 focused Redis lifecycle, tenant-unit,
  scheduler, repository-callback, terminal, and long-route tests passed;
  daemon/UI/client typechecks and focused formatting passed; the clean
  packaged source image built and its client pack contract passed; and the
  rebuilt two-replica HA harness passed with daemon and Redis failure
  injection. A real browser Codex session also completed before and after an
  additional Redis outage, proving authenticated UI reconnect and subsequent
  executor dispatch against the preserved tenant/user credential home.

The PostgreSQL/RLS and Redis results above were observed earlier on this audit
branch. Their disposable fixture URLs were not present for the final reviewer
remediation rerun; the corresponding suites remained environment-gated and
the new Redis authorization-cache/revocation scenarios were additionally
covered by deterministic local transport tests.

The secure board-presence follow-up subsequently provisioned disposable Redis
in the required PR workflow and added an explicit two-replica test step with
`AGOR_TEST_REDIS_URL`. Local runs may still skip the suite when Redis is absent,
but CI no longer does: the real Socket.IO adapter tests are part of required
head validation.

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
