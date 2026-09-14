# Redis/realtime daemon HA foundation

**Date:** 2026-08-09
**Status:** constrained active-active implementation candidate on `8d5d9ed3`; pre-PR review findings and operator-contract gaps remain open

## Decisive primary-source conclusions

- Socket.IO documents `@socket.io/redis-adapter` 8.3 as compatible with Socket.IO 4.3.1+, supporting inter-server communication and broadcast acknowledgements but not connection-state recovery. Installed versions are adapter 8.3.0 and Socket.IO 4.8.3. The adapter uses Redis Pub/Sub and requires caller-owned pub/sub clients: <https://socket.io/docs/v4/redis-adapter/>.
- Socket.IO still requires affinity when Engine.IO polling is enabled; otherwise a polling request can reach a process that does not own the session ID and return HTTP 400. Its nginx example uses consistent source-IP hashing, upgrade headers, and a proxy timeout above `pingInterval + pingTimeout`: <https://socket.io/docs/v4/using-multiple-nodes/>.
- The adapter documentation warns about node-redis subscription restoration and explicitly offers ioredis. ioredis documents `retryStrategy`, `autoResubscribe`, `lazyConnect`, and `maxRetriesPerRequest`: <https://github.com/redis/ioredis>.
- Feathers channels are arrays of local connection objects; publishers return local/combined channels, may transform data per connection, and are the application authorization layer: <https://feathersjs.com/api/channels>. Direct Socket.IO sends bypass those secure dispatch mechanisms: <https://feathersjs.com/api/socketio>.
- nginx's WebSocket proxy contract requires explicit `Upgrade`/`Connection` forwarding: <https://nginx.org/en/docs/http/websocket.html>.

## Stale assumptions corrected after merged prerequisites

- A Redis adapter does not replicate Feathers `app.channel` membership or publication. The explicit `serverSideEmit` bridge is required and re-enters only the receiving replica's Feathers transport dispatcher after local authorization.
- Executor-session credentials are no longer a local-Map blocker on PostgreSQL. The merged authority stores only a SHA-256 bearer fingerprint/JTI plus exact tenant/user/type/purpose/session/task/branch/expiry/revocation/use facts. SQLite intentionally retains local authority and HA refuses SQLite.
- The composition root now selects `taskRuntimePolicy: shared_postgres` in explicit HA instead of hard-coding standalone.
- PostgreSQL Session queue, scheduler, Task runtime reconciliation, Knowledge embedding indexing, and audited gateway listener foundations are now enabled. No central controller or leader exists; database claims, generations, leases, and occurrence identities fence work.
- Agor-managed permission callbacks now use transient task-private delivery to a live executor. The executor commits the Message/Task outcome and a lost click remains pending for manual resend. This deliberately does not provide durable read-after-gap/replay. Gemini/Codex provider-native confirmation modes remain gated because they do not use Agor's permission handler.
- `shared_filesystem` is topology-specific. It is required for `shared-local` local executors, not for the intended Cloud `external` executor topology. It proves shared workspace paths only; the checked-in Compose volume does not keep an executor process alive when its daemon container is lost.
- Executor storage is now a separate, general execution-substrate contract under
  `execution.executor_storage`. HA requires explicit user-home, branch-workspace, and
  base-repository guarantees. The Compose smoke topology mounts a shared Unix home plus a nested,
  stable shared Agor state/workspace volume. That supports auth-file import/logout with simple mode's existing
  shared-credential semantics, but does not make the device poller durable. The intended Cloud
  assertion is persistent-per-user home,
  persistent-per-branch workspace, and unavailable base repository.
- `base_repository: unavailable` is accepted only with clone-only branch policy because native
  worktrees retain a `.git` pointer into the base repository. `allow_shallow_clones: false` is a
  separate full-history policy rather than a mount requirement.
- Raw global `sessions created` Socket.IO broadcasts were stale and bypassed tenant/RBAC publication. Fork/spawn now use correctly shaped Feathers events. `repo:cloneError` is tenant-room scoped and skips rather than falling back to global delivery.
- Redis relay data must use `context.dispatch` when an after hook redacts the event; relaying raw `data` would bypass Feathers dispatch redaction.
- The Redis publisher is fail-fast (`enableOfflineQueue: false`, no unfulfilled-command resend, bounded request retries), while the subscriber retains automatic resubscription. Gap traffic is discarded rather than replayed after recovery.
- Native cross-replica Socket.IO packets pass through the typed `emitHaNativeSocketEvent` inventory. Other room/global emits are explicitly local, and `check:realtime-boundaries` prevents a new raw cluster broadcast from bypassing that decision.
- Auth-resolved HA requires `executor_storage.user_home: persistent-per-user`. HA Codex credential mutation additionally requires the operator assertion `executor_storage.user_home_locking: cross-replica-flock`; local-only filesystem locking leaves that capability gated.
- HA without external-launch authentication requires an explicit `AGOR_ADMIN_PASSWORD`, preventing replicas from racing through the process-local generated credential-file bootstrap path.

## Activation and lifecycle contract

1. `deployment.mode` is the only activation boundary; standalone ignores `REDIS_URL`.
2. HA validates PostgreSQL, profile `constrained-active-active`, stable env secrets, execution topology, Engine.IO affinity, disabled terminal/local managed-env modes, Redis URL/prefix, positive timeouts, and bounded reconnect delay.
3. Connect independent ioredis publisher/subscriber clients before constructing/listening on Socket.IO. Failure within the startup window aborts boot without logging the URL.
4. Attach adapter namespace `${keyPrefix}:socket.io` and the Feathers relay listener.
5. Readiness requires PostgreSQL plus ready pub/sub clients, attached adapter, and non-draining state. Liveness is process/event-loop only.
6. On Redis loss, readiness becomes 503 while liveness stays 200. Durable mutations are not rolled back and missed notifications are not replayed.
7. On recovery, ioredis auto-resubscribes and readiness returns only after both clients report ready. Clients refetch PostgreSQL state.
8. Graceful shutdown marks Redis runtime draining before waiting on workers, then stops reconciler/queue/gateway/scheduler, closes Engine.IO transports in reconnectable form, and bounded-quits Redis.

## Publication and secret boundary

The Feathers relay envelope is `{version, tenantId, path, event, method?, id?, data}`, JSON-only and capped at 512 KiB. Origin publication uses the after-hook `dispatch` projection. A receiving replica validates the envelope, resolves the named tenant, reruns branch/user visibility using its own repositories/connections, then calls the installed Feathers transport dispatcher directly without re-entering the publisher (no relay loop).

Redis prefixes are operational deployment isolation only. Tenant IDs and application publication rules are authorization. Redis itself is a trusted private data plane: adapter messages are not signed/encrypted/authenticated.

### Exact event inventory

- Native cross-replica packets: `cursor-moved`, `cursor-left`, `presence-updated`, `presence-left`, tenant-scoped `repo:cloneError`. Board-bearing presence targets only an authorized tenant-and-board association room.
- Socket-local: `server-info`.
- MCP OAuth: `oauth:open_browser` is deliberately exact-socket local; durable
  attempt completion/disconnection is projected as tenant-qualified
  `oauth:completed` / `oauth:disconnected` hints through the Socket.IO Redis
  adapter. PostgreSQL remains the result authority if a hint is missed.
- Disabled at startup: every terminal/PTy packet.
- Feathers relay: ordinary tenant-authorized CRUD/custom events including Message/transcript streaming and executor `tasks.termination_requested`. Receiving replicas re-authorize.
- Hard deny list: authentication/refresh/check-auth, session-token and API-key/key-resolution paths, external launch, MCP OAuth/token paths, Codex/OpenCode auth, terminals, Artifact `agor-query`.

Never deliberately place bearer/API/executor/MCP/terminal tokens, OAuth/PKCE/device credentials, GitHub install state, external-launch credentials, Artifact environment/grants, or secret-derived results in Redis. The Compose Redis disables RDB and AOF, but lack of persistence is not a security control.

Native cursor presence obtains an authenticated, tenant-scoped `boards.get` before room join. Navbar board association uses a separate full-set subscription authorized through `boards.find`; unavailable IDs are silently omitted. Cursor emit and board-bearing heartbeat publication each require the corresponding server-owned grant. Auth replacement/logout clears every tenant/user/board native room. Tests cover tenant-A/tenant-B same-ID non-delivery, Feathers receiver-side tenant/RBAC reauthorization, denied Redis paths, redacted dispatch, and unauthorized board joins.

## Merged-foundation support matrix

| Foundation/surface                                | Status and fence                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executor JWT authority                            | Enabled on PostgreSQL; fingerprint/JTI row and exact claims are durable. Old/unrecorded token cohorts fail closed.                                                                                                                                                                                                                                                  |
| Task execution                                    | Enabled for Claude, Copilot, and OpenCode interactive modes through transient task-private delivery, plus Gemini yolo, Codex `never`, and current Cursor. Gemini/Codex provider-native confirmation modes still reject 503 because Agor has no handler for those prompts.                                                                                           |
| Permission decisions                              | Enabled with a live executor and retryable UI. The click is tenant/Session/Task scoped and relayed through the private executor room; the executor commits the Message/Task outcome before returning to the provider. Delivery is intentionally non-durable: a lost click leaves the Message pending so the user can resend it.                                     |
| Session queue                                     | Enabled; all-daemon bounded discovery, database dispatch claim elects launcher.                                                                                                                                                                                                                                                                                     |
| Completion callbacks/widgets                      | Callback Task identity/admission and widget resolution ownership are durable. Two-repository PostgreSQL races elect one callback dispatch/widget effect after admission. The source-completion-to-callback-admission gap is not replayed after owner death; ambiguous widgets remain `resolving`.                                                                   |
| Scheduler                                         | Enabled; deterministic occurrence identity and PostgreSQL admission/fencing.                                                                                                                                                                                                                                                                                        |
| Task runtime reconciler                           | Enabled with shared-PostgreSQL policy. Detached executor reconnect/heartbeat can land on another daemon only when the execution substrate survives the owner and its callback URL routes to the fleet; the checked-in shared-local Compose smoke stack does not prove that handoff.                                                                                 |
| Knowledge embedding indexer                       | Enabled; PostgreSQL claim generation/token fences provider work and writes.                                                                                                                                                                                                                                                                                         |
| Gateway                                           | Slack/GitHub/Shortcut listener ownership enabled with PostgreSQL lease/occurrence fencing. Teams/unimplemented providers fail closed. Provider outbound crash gaps remain documented.                                                                                                                                                                               |
| Stateless MCP and process-affine auth/setup flows | Stateless MCP, durable MCP OAuth, and PostgreSQL-backed GitHub setup are enabled. MCP OAuth browser admission remains exact-socket local, while callbacks and completion projection are fleet-routable. OpenCode setup and Codex device polling remain blocked. Codex auth-file check/import/logout is admitted only with a consistent declared executor user home. |
| Web terminal                                      | Startup blocked; no PTY bytes in Redis.                                                                                                                                                                                                                                                                                                                             |
| Managed environments                              | Lifecycle control remains webhook-only. Health observation is enabled on every replica with bounded discovery and PostgreSQL per-branch lease/token plus lifecycle-generation result fencing; capability status reports `environmentHealthMonitor: true`.                                                                                                           |
| Artifact synchronous runtime introspection        | Blocked; durable metadata remains.                                                                                                                                                                                                                                                                                                                                  |
| Static tenant                                     | Runnable Compose smoke variant. Auth-resolved multi-tenant is contract-tested but not end-to-end certified.                                                                                                                                                                                                                                                         |
| External execution topology                       | Requires a command template, an HTTP(S) `daemon.public_url` for executor callbacks, and no shared daemon FS assertion. Cloud infrastructure reachability/certification remains.                                                                                                                                                                                     |
| Executor storage contract                         | HA now requires explicit `user_home`, `branch_workspace`, and `base_repository` assertions. Cloud target is per-user/per-branch persistence with no base checkout; clone-only config is enforced, while historical-row audit and metadata-only remote repo registration remain follow-ups.                                                                          |

## Ingress/Cloud checkpoint

The Compose nginx has two upstreams: round-robin REST and source-IP-consistent `/socket.io/`. This supports polling and upgrade but can concentrate users behind one NAT onto one daemon. Its single process also carries a coarse shared per-IP limiter for authentication/refresh/launch and upstream-address access logging. Docker health gates initial nginx startup only: static open-source nginx upstreams do not consume later Docker health changes, so `/readyz: 503` alone does not remove a still-listening daemon from this smoke ingress. Cloud must prefer supported cookie/connection affinity for only the Socket.IO path, preserve upgrade headers, set idle timeout above 85 seconds, remove unready pods, leave REST unsticky, and implement quotas at a shared edge/WAF. A live WebSocket never migrates; after daemon loss the client establishes and reauthenticates a new connection.

The production image serves `/ui/` from the daemon, but browser authentication and Socket.IO still
carry an `Origin` header. `AGOR_HA_PUBLIC_ORIGIN` is therefore wired into both replicas as
`AGOR_BASE_URL` and `CORS_ORIGIN`; the `.agor.yml` variant derives the exact external origin from
the managed environment host and port. A harness probe verifies that this origin is reflected by
the credentialed CORS response. Reusing an existing Compose project also reuses its PostgreSQL
volume: `AGOR_ADMIN_PASSWORD` is first-run-only and does not reset an already changed admin
password.

The Agor-managed smoke variant deliberately converges on the repository-wide development login
`admin@agor.live` / `admin`. It sets `AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN=true` together with
`AGOR_ADMIN_PASSWORD=admin` and `NODE_ENV=development`; first-run bootstrap refuses that escape
hatch in production mode. This is development ergonomics, not a production HA credential policy.

## Verification record

Authorized branch-only Compose evidence observed on 2026-08-09:

- a clean PostgreSQL volume migrated successfully and both named daemons eventually became ready with distinct instance and boot IDs; the default-board tenant/slug race was fixed with an atomic conflict-safe insert. An independent SQLite probe exposed the concurrent first-admin insert race; the bootstrap now converges on the winning row and a formal concurrent test covers it. Deployments that omit `AGOR_ADMIN_PASSWORD` can still make the losing replica restart if it loses the credentials-file `O_EXCL` race before the winner inserts;
- nginx distributed ordinary `/health` requests across `daemon-a` and `daemon-b`; an Engine.IO polling connection upgraded to WebSocket through the source-IP-affine `/socket.io/` upstream;
- an authorized Feathers `boards.created` event and a tenant-qualified native `cursor-moved` event crossed A -> B once within the harness's bounded duplicate-observation window. An unauthenticated socket received neither event and its board-room join returned `{ok:false}`;
- stopping the selected socket owner caused an authenticated client to reconnect and reauthenticate to the survivor, while new ingress HTTP continued after passive upstream failure. Restarting the daemon restored two ready replicas;
- stopping Redis changed both `/readyz` endpoints to 503 while both `/livez` endpoints stayed 200. Restarting Redis restored readiness and a new cross-replica Feathers event;
- restarting a daemon while Redis was stopped repeatedly failed before listen with `HA startup failed: required Redis fanout plane is unavailable`; starting Redis let the restart policy recover it to ready;
- Redis `PUBSUB CHANNELS` showed only the configured `agor-ha-feat-daemon-ha-redis:socket.io-*` operational namespace for this stack;
- startup logs on both replicas showed `shared_postgres` Task reconciliation and distinct structured `distributed-work.task-queue`, scheduler, gateway-listener, and Knowledge embedding indexer loop diagnostics. This proves activation, not occurrence-level background-work correctness; the merged PostgreSQL multi-worker tests remain the correctness evidence;
- four authenticated stateless MCP initialize requests through nginx alternated between both daemon upstreams, returned 200, and issued no `Mcp-Session-Id`; authenticated GET returned the endpoint-wide 405 response;
- a 30-request authentication burst through the single Compose ingress produced 21 application 401 responses and 9 edge 429 responses. This verifies the example's coarse per-IP limiter, not a credential-aware or multi-ingress Cloud quota.
- the Agor-managed `ha` variant rebuilt from source and reported healthy through its configured `/readyz` check. Both daemons mounted `agor-ha-user-home` at `/home/agor` and the historical `agor-ha-home` at `/home/agor/.agor`; non-secret markers written on daemon A were observed and removed on daemon B;
- a managed-stack upgrade initially renamed the sole `/home/agor/.agor` volume while retaining PostgreSQL. Existing Repo rows still referenced absolute paths in the historical volume, so a real `private-bananaboy` worktree creation failed with `Cannot use simple-git on a directory that does not exist`. The corrected topology keeps that historical volume mounted at the same path and adds the executor-home volume above it. The failed branch was repaired through the normal archive/unarchive materialization path, its file API returned 200, and a repository invariant now clears stale `error_message` values when filesystem status recovers;
- the same live repair exposed a stale startup credential-scrub query that sent `archived: {$in: [true, false]}` even though the validated Branch API accepts only an exact boolean. Reconciliation now omits that filter, intentionally fetching active and archived rows; focused executor coverage proves both paths are scrubbed. After rebuilding the managed variant, both replicas ran `git.managed-credentials.reconcile` without the former `validation failed` post-start error;
- authenticated Codex capability probes reported `codexCredentialFiles: true` and `codexDeviceAuth: false`. A deliberately empty auth document reached import validation and returned 400 rather than the HA feature gate, while device polling returned the explicit `503 HA_FEATURE_UNSUPPORTED/codexDeviceAuth` response. No credential was written;
- both daemon logs reported the explicit environment-monitor disable gate and contained no `Health Monitor initialized` record. Shared Task runtime and queue-loop diagnostics appeared on both replicas;
- the production source image contained no provider agent CLI or credential home, so a live agent Task was not fabricated. A new PostgreSQL-gated daemon integration instead constructs two queue workers and two `TasksService` instances on independent PostgreSQL clients, makes both observe the same admitted queued Task, and proves one durable dispatch/Session projection. The executor-token suite now also exercises reconnect, peer revocation, and one-use contention through two independent Feathers authentication apps and PostgreSQL clients.
- the stale, unreachable `TaskRuntimePolicy: disabled` branch was removed. The composition root now has exactly the tested `standalone` and `shared_postgres` choices; feature-specific HA gates remain separate and explicit.

Commands/results:

- `pnpm install --lockfile-only` — passed and regenerated `pnpm-lock.yaml` from the resolved manifests;
- final core config/deployment/bootstrap review suites — 138/138 passed;
- final daemon HA/security review suites — 304/304 passed (including Redis, Socket.IO, publication, startup, health, hook, MCP, and first-admin gates);
- focused callback/widget/MCP/HA contracts — 70/70 passed;
- PostgreSQL scheduler, Task queue/runtime, Knowledge indexer, and gateway-listener HA suites — 26/26 passed. The gateway run found and fixed a core repository self-barrel runtime import that hid listener constants behind a circular/stale module path;
- PostgreSQL executor-token authority, daemon Task queue/reconciliation, and daemon Knowledge indexer suites — executor coverage includes peer issuance/authentication/reconnect, bounded concurrent use, revocation, expiry, scope, and tenant checks; the focused queue/token/reconciler run passed 13/13;
- `pnpm --filter @agor/core typecheck` and daemon `tsc --noEmit --customConditions source` — passed;
- multitenancy, daemon-filesystem, agentic-tool, short-ID, and agor-live dependency boundary checks — passed;
- `docker compose ... config` — resolved two explicit daemons, migrate, PostgreSQL, Redis, and nginx; nginx also passed by running healthy in the stack;
- `AGOR_HA_INTEGRATION=1 pnpm test:ha:docker` and `AGOR_HA_INTEGRATION_FAILURES=1` — both passed all applicable harness assertions. During hardening, a post-Redis-recovery assertion failed after resources had been created; the new `finally` path restored the stack and removed the new API key/boards. Ten older pre-hardening harness boards were then removed through the authenticated API, leaving zero matching test resources.
- after the executor-storage/Codex routing change, the focused core config suites passed 138/138, the daemon startup/health/HA/hook/Codex/spawn suites passed 179/179, the UI branch-storage form suite passed 4/4, the production source image compiled successfully, and both normal and failure-injection Compose harnesses passed with the stack restored healthy.

The PostgreSQL callback race uses two repository instances and distinct tenant scopes: stable callback admission converges on one Task and peer claimers elect one dispatch. Widget races similarly elect one `pending -> resolving` owner. There is still no durable scanner for daemon death after the source Task completion commit but before callback Task admission; this is reported as `completionCallbackPreAdmissionRecovery: false` rather than hidden.

The live negative test is anonymous/static-tenant containment, not a real two-tenant certification: this static deployment exposes no safe tenant-provisioning API with which the harness could deterministically create two authenticated tenant cohorts. Namespace isolation across two simultaneously running deployments, an actual provider executor process, and a scheduled/indexing occurrence remain PostgreSQL/contract evidence rather than this smoke run. Gateway lease ownership/takeover is PostgreSQL-test evidence; the Compose run did not contact a real provider.

## Remaining slices

- End-to-end auth-resolved multi-tenant deployment and negative delivery under a real multi-tenant login cohort.
- Audit historical active worktree rows before admitting a `base_repository: unavailable` Cloud cohort; change remote repo registration from a claimed durable base clone to metadata-only/ephemeral inspection.
- Certify the remaining provider credential helpers against the persistent-per-user home contract. Codex auth-file check/import/logout now route through trusted executor identity variables; the device-code poller remains separately and deliberately blocked.
- Optional durable permission decision read-after-gap/replay if manual resend after a lost transient click is not an acceptable long-term UX.
- Keep the activated PostgreSQL MCP OAuth/DCR authority in the HA regression matrix; externalize Codex/OpenCode auth ownership, terminal, and Artifact runtime state. GitHub App install state is also durable on PostgreSQL and enabled in constrained HA.
- Production Cloud ingress implementation/certification and a defined edge/fleet quota strategy.
- Prove the configured external-executor callback URL is reachable in Cloud, and cover task execution/reconnect in the live harness.
- Make concurrent first-admin bootstrap converge without relying on a losing replica restart.
- Provider-specific gateway outbound uncertainty closure (or explicit operator SLO acceptance).
- Decide whether any realtime stream needs durable cursors; current contract requires refetch after a missed Redis window.
