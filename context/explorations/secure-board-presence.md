# Secure navbar board presence

Status: implemented for review on `restore-secure-board-presence`

This is the security and rollout contract for restoring board names/navigation
to the global navbar facepile without undoing the tenant-isolation fix in
[PR #2520](https://github.com/preset-io/agor/pull/2520). It also records the
separate cursor audit; cursor and navbar presence share authentication and
some payload types, but they do not share subscription rooms or lifecycle.

## Revision and behavior history

| Revision                                                                                          | Date       | Behavior                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a2aea0e1537dfc6c29454aa35a2addf4bab21ae2`                                                        | 2025-10-16 | Introduced live board cursor tracking and presence indicators.                                                                                                                                                                |
| `243b3368de11fcd09000683f33e1f4e7f082a54e` ([#324](https://github.com/preset-io/agor/pull/324))   | 2025-11-22 | Made the navbar facepile global, displayed a user's active board, and made the avatar navigate to that board.                                                                                                                 |
| `6d70cbbce1a86964a1bb97fa0b091ad8091dac62` ([#1299](https://github.com/preset-io/agor/pull/1299)) | 2026-05-30 | Isolated high-frequency cursor rendering from the global facepile and added explicit board cursor-room reconnect.                                                                                                             |
| `e57798a47d54b50bccf19ae7386132688464af6e` ([#2520](https://github.com/preset-io/agor/pull/2520)) | 2026-08-23 | Fixed WebSocket tenant isolation. Finding WS-10 identified tenant-wide board identity as a private-board leak and intentionally removed `boardId` from `presence-updated`.                                                    |
| `ed5b075a74e64c0c31f638f2c78c54d5915c7b2b`                                                        | 2026-08-26 | Branch base at investigation start. Facepile still showed tenant-online peers, but every remote peer was boardless; the current user was inserted locally with the route board. Cursors remained board-scoped and functional. |
| `bb89f7cf1db21ce23bd35d0ff80b64d9a7f0f3b5`                                                        | 2026-08-26 | Exact latest `origin/main` used for the initial integration/review; the intervening MCP/auth changes do not alter the #2520 presence behavior.                                                                                |
| `0269325274e6bf7b7b31ef5c572122363cd9f1e3`                                                        | 2026-08-27 | Current `origin/main` used for the post-review rebase. Its #2569 package-budget change does not alter presence or cursor behavior.                                                                                            |

The #2520 PR had no review comments or issue discussion that superseded its
audit document. Its squash history contains the audit work and the explicit
`fix(ui): support boardless tenant presence` change. The security rationale was
valid: the original navbar contract sent a private board ID through the tenant
channel before any recipient board authorization.

The managed deployment observed during investigation reported Agor `0.25.2`,
build `add0c0c0ddd2d237bc64a00f87e4f7412e192e85` (built 2026-08-24). That
revision is after #2520 and before current `main`, so it has the same intentional
boardless regression. No authenticated second-persona browser fixture was
available on that environment; production-shaped Socket.IO, PostgreSQL/RLS,
and two-replica Redis fixtures cover the transport behavior.

## Product and information contract

1. A browser can publish a board association only after the daemon proves that
   the authenticated user can currently view the canonical, non-archived
   board.
2. A browser can receive a board association only after the daemon separately
   proves that the authenticated recipient can currently view that board.
3. Tenant-wide presence can reveal only the already-approved tenant directory
   identity and online activity. It carries no board ID, board name, cursor,
   email, secret, or resource membership.
4. The client supplies a desired board ID, cursor coordinates, or desired
   subscription set—never a user ID, tenant ID, connection ID, or authoritative
   timestamp. The server derives those from immutable handshake authority and
   creates a random `presenceId` per connection.
5. Missing, foreign-tenant, private, and archived board IDs are silently
   omitted from a valid full-set association subscription. The acknowledgement
   does not expose accepted counts or denial reasons.
6. Board/user/RBAC changes that may revoke passive access disconnect the
   affected tenant's sockets on every replica. Archive now has the same
   eviction classification as deletion/access changes. Reconnect must
   reauthenticate and rebuild every subscription.
7. One connection leaving removes only its random presence instance. Clients
   fold remaining instances by user, so another tab/device continues to show.
8. Presence and cursor maps and board subscription sets have explicit bounds;
   cursor and online entries also expire.

The facepile resolves display identity from the already-authorized tenant user
directory and board names from the already-authorized board list. Native
presence packets contain only `userId`, random `presenceId`, server time, and—on
an authorized board room only—`boardId`.

### Role behavior

The association admission deliberately calls hooked `boards.find`, matching
the navbar's board list:

- members and ordinary admins receive only boards visible through normal board
  visibility;
- superadmins are also visibility-scoped when `execution.allow_superadmin` is
  false (the hosted/no-ambient default);
- an explicitly configured `allow_superadmin: true` retains the documented
  superadmin bypass inside the tenant;
- tenant authority always comes from the signed/static handshake context, so
  no role has ambient cross-tenant access.

There is a pre-existing role nuance outside this restoration: individual
`boards.get` hooks treat admin/superadmin as board administrators, while
`boards.find` applies visibility scoping (subject to the superadmin flag).
Cursor-room admission continues to use the established `boards.get` contract;
the navbar association does not widen itself to that get-only authority. A
product decision to remove board-admin get authority would be a separate RBAC
change, not a presence transport shortcut.

## Protocol

### Rooms

Every dynamic component is canonical base64url under the existing v2 room
prefix; Redis prefixes are never authorization.

| Purpose                  | Room                                                  | Admission                                                                                  |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tenant online status     | `tenantChannelName(tenantId)`                         | authenticated user, tenant derived from connection authority                               |
| Navbar board association | `boardPresenceAssociationRoomName(tenantId, boardId)` | bounded full-set `presence:subscribe-boards` -> scoped `boards.find` with `archived:false` |
| Live cursor              | `boardPresenceRoomName(tenantId, boardId)`            | `presence:watch-board` -> hooked `boards.get`, canonical ID, non-archived                  |

The navbar never joins cursor rooms for every visible board. This avoids
delivering high-frequency coordinates to a low-frequency global consumer.

### Browser-to-daemon

1. The navbar computes at most 512 non-archived board IDs already returned by
   its board query, prioritizing the route board.
2. It sends the full desired set with `presence:subscribe-boards` on mount,
   route/list change, successful Socket.IO reconnect, and Feathers
   reauthentication.
3. Starting any route/list/focus/reconnect synchronization immediately sends a
   boardless `presence:heartbeat`. Only after that exact latest generation
   returns `{ok:true}` may a visible, focused tab request its current board. A
   hidden/blurred tab always requests `null` and remains tenant-online without a
   board.
4. Heartbeats repeat every 15 seconds. Route/focus transitions run
   immediately. Unmount sends `presence:leave` and an empty full set.
5. The cursor consumer independently watches only its rendered board and
   sends finite, bounded coordinates at at most ten samples per second. Cursor
   traffic can refresh tenant liveness for rolling compatibility, but it never
   publishes a navbar board association.

The browser keeps at most one association acknowledgement outstanding and
coalesces route/list/focus churn to the latest desired set. It tracks the latest
successfully acknowledged generation and keeps every periodic heartbeat
boardless while a newer generation is pending, rejected, rate-limited, or timed
out. A five-second Socket.IO acknowledgement timeout releases the callback when
an older daemon does not implement the event.

### Daemon publication

For an accepted heartbeat, the daemon emits:

- `presence-updated {userId,presenceId,timestamp}` to the tenant room; and
- only when board publication is authorized,
  `presence-updated {...,boardId}` to the board-association room.

These operations are structurally separate: cursor moves call only the
tenant-liveness publisher, while a board-bearing heartbeat requires a completed
`boards.find` subscription generation. Cursor/get authority is never accepted
as fallback publisher authority. Per-socket token buckets bound cursor samples,
board-bearing heartbeats, cursor admission, and non-empty association changes.
Association synchronization retains only one authorization read plus the latest
desired set, and in-flight cursor grants count against the room cap.

Every valid full-set generation immediately retracts the publisher's current
board association and invalidates its prior publication grant, independently
of whether the recipient room set changed. Only that generation's successful
`boards.find` result restores board-bearing heartbeat authority. A slow,
superseded, failed, or rate-limited generation therefore converges to boardless
liveness rather than reusing an older grant.

Every full-set synchronization first emits board-scoped `presence-left` for a
published association. Disconnect, logout, bounded impersonation-token expiry,
explicit leave, or revocation emits a board removal and a tenant removal for
that one `presenceId`. A client therefore cannot retain a stale association by
reordering the same visible boards or omitting the follow-up heartbeat.

The daemon rate-limits unchanged low-frequency publication to once per ten
seconds. All timestamps are server-generated. An ordinary user socket
intentionally remains authoritative across routine short-lived REST access
token rotation; it is retired by logout, password/user/RBAC invalidation, or
transport loss. Impersonated/machine capabilities retire at bearer expiry.

### Client convergence

The UI keys passive state by `presenceId`, with a temporary per-user fallback
for boardless #2520 packets during rolling deployment. It then folds instances
to one facepile entry and the newest cursor per user. Exact leaves cannot erase
a sibling tab. Transport disconnect clears the entire local passive cache
before reconnect rebuilds it.

Remote cursors expire at five seconds without a sample. Online presence expires
after five minutes as a final loss/outage bound; explicit lifecycle events are
normally immediate. Oldest insertion is evicted if an instance map reaches its
hard cap.

## HA and revocation

`presence-updated`, `presence-left`, `cursor-moved`, and `cursor-left` use the
audited native Redis allowlist. The Socket.IO Redis adapter carries the complete
room target, so the tenant-and-board-qualified room—not the Redis deployment
prefix—prevents cross-tenant/cross-board fanout.

Authorization-changing board, branch, grant, group membership, user, archive,
and delete hooks send the existing server-side HA invalidation. Each replica
clears local authorization state before disconnecting matching tenant sockets.
Socket.IO room membership disappears with the connection and fresh admission
reruns current service/RLS authorization. Additive grants use cache-only
invalidation and the browser's next board-list/full-set sync can add the room.

Redis loss remains fail closed under realtime v3: readiness fails, local
authorization capabilities are cleared, transports close, and no notification
replay is trusted. Reconnect after Redis health returns performs a new
authenticated handshake and full subscription sync.

## Cursor verdict

The cursor feature was not removed by #2520. It remained protected by a
tenant-and-board-qualified room, a hooked board read on admission, a per-socket
authorized-board set on publication, Redis native-event allowlisting, and
tenant-wide HA invalidation.

This audit additionally hardens cursors by:

- canonicalizing the board returned by `boards.get` and rejecting archived
  boards;
- rejecting non-finite or extreme coordinates and replacing caller timestamps
  with server time;
- adding server-generated `presenceId` to move/leave packets so one tab cannot
  erase another tab's cursor;
- making cursor leave edge-triggered: only the board of the last accepted,
  rate-limited move can emit one leave, so repeated leave packets cannot amplify
  Redis fanout;
- bounding cursor-room grants and client cursor instances; and
- retaining the existing five-second stale-cursor expiry and clearing all
  passive state on transport disconnect.

Cursor association and navbar association remain separate. A cursor subscriber
learns a coordinate only for the board it is actively rendering; a navbar
subscriber learns only a low-frequency board association for boards in its
authorized list.

## Rolling deployment

The change is additive under the existing versioned room namespace:

- old #2520 UI + new daemon is secure but boardless: its cursor traffic refreshes
  tenant liveness only and cannot publish into association rooms;
- new UI + old #2520 daemon is secure but boardless because subscription and
  heartbeat events are ignored; bounded acknowledgement timeouts prevent the
  old replica from retaining browser callbacks;
- new publisher/subscriber pairs on upgraded replicas work through Redis;
- `presenceId` has a client fallback for old boardless packets, but exact
  multi-tab leave semantics begin after reconnect to an upgraded daemon.

Operators should roll all daemons, then refresh/reconnect clients. Never mix a
pre-#2520 daemon that still puts `boardId` on tenant-wide presence with this
release: that old packet is the original information leak and no client-side
redaction can repair its publication boundary.

## Residual risks and decisions

- Redis is a trusted private data plane; Socket.IO adapter packets are not
  independently signed or encrypted. Compromise of Redis or a daemon is beyond
  room-level isolation.
- Presence is ephemeral, at-most-once realtime state. A transport outage can
  delay disappearance until the bounded client expiry; it is not a durable
  audit log.
- Routine browser access-token expiry does not tear down a healthy user socket
  by design. Short-token expiry alone is therefore not revocation; explicit
  logout and authorization/password/user mutations are.
- Tenant-online visibility is preserved from the post-#2520 product. If a
  workspace requires hiding online status as well as board identity, that needs
  an explicit tenant policy rather than an incidental presence-room change.
- The 512-board subscription cap prioritizes the current board. A user with
  more visible boards may see some remote peers as online without board
  association until their relevant board enters the bounded set.

## Adversarial coverage

The focused unit and environment-gated integration suites cover:

- two tenants using the same resource shape and forged tenant metadata;
- shared, private, foreign, missing, and archived board IDs;
- member/admin/superadmin behavior under no-ambient superadmin configuration;
- indistinguishable full-set acknowledgement for inaccessible IDs;
- server-derived identity, connection ID, time, and cursor validation;
- full-set transition, explicit leave, logout, token expiry, disconnect,
  archive/delete/RBAC eviction, reconnect, and stale expiry;
- two same-user tabs for both facepile and cursors;
- cursor and board-association coexistence; and
- real two-replica Redis delivery, cross-tenant non-delivery, cache clearing,
  revocation, reconnect, and fail-closed denial after revocation.

The PostgreSQL and Redis suites remain explicitly environment-gated for local
runs so they do not pretend to exercise absent services. Required PR CI
provisions disposable Redis and runs the two-replica file explicitly with
`AGOR_TEST_REDIS_URL`, while the dedicated PostgreSQL/RLS workflow provisions
its own database, so both real adapter paths are exercised on every relevant
head.
