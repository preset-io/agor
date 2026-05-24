# Daemon HA / Horizontal Scaling — Options Analysis

**Status:** Design / position paper. **No code in this PR.**
**Date:** 2026-05-24
**Author:** Claude (Opus 4.7) for Max
**Branch:** `design-daemon-ha-options` (head: `776a1088`)

**Companion / prerequisite docs:**
- [`context/explorations/daemon-fs-decoupling.md`](../../context/explorations/daemon-fs-decoupling.md) — PR #1209. The daemon-⊥-worktree-FS boundary work. **The single biggest gating dependency for real HA.**
- [`design-worktree-to-branch-and-clone-model/docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md`](../../../design-worktree-to-branch-and-clone-model/docs/internal/branch-vs-worktree-migration-analysis-2026-05-20.md) — clone-mode migration (Model C → D). Reduces per-branch coupling; orthogonal to HA but cleans the surface.
- [`design-reconnection-and-state-refresh/docs/internal/reconnection-and-state-refresh-design-2026-05-24.md`](../../../design-reconnection-and-state-refresh/docs/internal/reconnection-and-state-refresh-design-2026-05-24.md) — sister design. Sticky-session HA intersects with reconnect semantics.
- [`analyze-distributed-federated-agor-mode/docs/internal/distributed-agor-feasibility-2026-05-19.md`](../../../analyze-distributed-federated-agor-mode/docs/internal/distributed-agor-feasibility-2026-05-19.md) — distributed/federated mode. A different problem, but uses the same executor-RPC seam.

---

## 1. TL;DR

Running **2+ daemons behind a load balancer** is achievable today with **two changes plus one config**: (a) **sticky sessions** at the LB so each WS client lands on a fixed daemon and per-daemon worktree files stay coherent, (b) **`@socket.io/redis-adapter` or Postgres-LISTEN/NOTIFY pub-sub** so service-event broadcasts (`app.publish()` → `app.channel('authenticated')`) fan out across instances, and (c) **a Postgres advisory lock** wrapping the scheduler tick and the session-turn lock so cron/queue side effects don't double-fire. That's the **minimum viable HA tier**. Everything else (worktree FS sharing, executor pooling, multi-region, leaderless schedulers) is structurally blocked on the **`daemon-fs-decoupling`** work in PR #1209 — until that lands, "HA" really means "redundant frontends in front of a still-singleton FS owner per worktree."

**Recommended target:** **T0 (sticky sessions) + T1 (Postgres LISTEN/NOTIFY backplane) + T3 (advisory-lock leader for scheduler & queue drainer)**, on **shared Postgres**, with **shared JWT secret**. No Redis, no new infra. **~2–3 weeks of focused work**, mostly mechanical. Don't pursue T4 (shared worktree FS / leaderless daemons) until `daemon-fs-decoupling` lands.

**Bottom-line constraint:** the daemon is currently architected as the single owner of `~/.agor/worktrees/` (`packages/core/src/config/config-manager.ts:373-395`) and `processes: Map<WorktreeID, ManagedProcess>` (`apps/agor-daemon/src/services/worktrees.ts:73`). Two daemons on different hosts can't both own the same worktree. Sticky session per *worktree* is the necessary glue until the executor-as-volume-owner topology lands.

---

## 2. Constraints (load-bearing first)

1. **Minimize operational complexity.** Max's framing. Use Postgres LISTEN/NOTIFY before reaching for Redis. Use Postgres advisory locks before reaching for Zookeeper/etcd. Don't add infra that isn't already in the stack.
2. **Don't rewrite the daemon.** Multiplayer-on-one-daemon works well today. The HA story must thread through the existing Feathers + socket.io + Drizzle topology.
3. **Self-hosted must keep working unchanged.** The single-host SQLite path is the dominant deployment shape today (see §3.4 below). Any HA layering must be opt-in.
4. **No new SPoFs to replace the daemon SPoF.** Adding Redis to solve "the daemon is a SPoF" creates a Redis SPoF unless Redis is itself HA. Picking Postgres-native pub-sub avoids this; we already need Postgres HA for the data tier.
5. **Be honest about what `daemon-fs-decoupling` blocks.** Real horizontal scale (any daemon can serve any worktree) is downstream of PR #1209. This doc proposes what we can do *before* that lands and what we should defer until *after*.

---

## 3. Investigation findings

All file:line citations are exact as of `776a1088`.

### 3.1 WebSocket transport

| Component | Location |
|---|---|
| Library | `socket.io ^4.8.3` (`apps/agor-daemon/package.json:40`) |
| Integration | `@feathersjs/socketio` re-exported from `packages/core/src/feathers/index.ts:40` |
| Server init | `apps/agor-daemon/src/setup/socketio.ts:233-712` (full config); attached at `apps/agor-daemon/src/index.ts:558` |
| Handshake auth | `apps/agor-daemon/src/setup/socketio.ts:272-347` — JWT verify on connect; supports user tokens + service tokens (executor) |
| Active connections counter | `apps/agor-daemon/src/setup/socketio.ts:268-269, 659-662` (in-process int, no shared registry) |

**Broadcast model — three patterns coexist:**

1. **Feathers `app.publish()` → `app.channel('authenticated')`** (the workhorse). All service-event broadcasts (sessions/messages/tasks/boards/etc.) route through this single global channel. See `apps/agor-daemon/src/register-hooks.ts:1618-1634`:
   ```ts
   app.publish((data, context) => {
     ...
     return app.channel('authenticated');
   });
   ```
   Sockets join `'authenticated'` on `app.on('login')` (`apps/agor-daemon/src/setup/socketio.ts:739-747`), leave on `app.on('logout')` (`:750-757`).

2. **`app.service(...).emit(event, data)`** — custom non-CRUD events (`tasks failed`/`queued`/`created`, `messages permission_resolved`, `boards patched`, `board-comments patched`, `session-mcp-servers created`, etc.). Flows through the same publish pipeline. See `apps/agor-daemon/src/register-routes.ts:1201,1339,1383,2274,2598,2624,3048,3067,3185,3202` and `register-hooks.ts:2177,2191,2205,2238`.

3. **Direct `app.io.emit()` / `app.io.to(room).emit()`** — bypasses Feathers entirely. Used for OAuth prompts, terminal I/O, and `sessions created` events:
   - `apps/agor-daemon/src/register-services.ts:1149,1151,1252,1254,1256` (OAuth)
   - `apps/agor-daemon/src/register-routes.ts:663,689` (`app.io.emit('sessions created', ...)`)
   - `apps/agor-daemon/src/register-routes.ts:811` (terminal tab)
   - `apps/agor-daemon/src/setup/socketio.ts:573,592,603,631,653` (terminal I/O relay between executor and browser via `user/<userId>/terminal` channel; format validated `:202-210`)

**Rooms:**
- `authenticated` — global, all logged-in sockets on *this* daemon.
- `user:<userId>` — per-user room, autojoined on connection (`apps/agor-daemon/src/setup/socketio.ts:192-194, 372, 685`).
- `user/<userId>/terminal` — per-user terminal pipe. Service sockets can join any user's terminal; user sockets only their own (`apps/agor-daemon/src/setup/socketio.ts:516-525`).

**Cross-instance fanout:** **none**. `@socket.io/redis-adapter` is not installed; no `LISTEN`/`NOTIFY`; no custom event bus (`grep` for `EventEmitter|mitt|tinyemitter` found nothing load-bearing in `apps/agor-daemon/src/`). **A `sessions created` event emitted on daemon A is invisible to clients on daemon B.** This is the single biggest concrete defect for multi-instance.

### 3.2 In-process state inventory

Worth-coordinating items (classified per the prompt's tiers):

| Item | Location | Holds | Classification |
|---|---|---|---|
| `executorProcesses` | `apps/agor-daemon/src/executor-tracking.ts:11` | session_id → {pid, startedAt} for SIGTERM on stop | **STICKY-WORKABLE** (PID is meaningful only on the daemon that spawned it; sticky-by-session works) |
| Worktree `processes` | `apps/agor-daemon/src/services/worktrees.ts:73` | WorktreeID → ManagedProcess (env dev-server child) | **STICKY-WORKABLE** (daemon owns the worktree FS and its child processes; only that daemon can start/stop it) |
| `executorTerminals` | `apps/agor-daemon/src/services/terminals.ts:322-329` | UserID → {sessionName, activeWorktrees, startedAt} for Zellij | **STICKY-WORKABLE** (`pgrep`-based adoption can re-attach across restarts on the *same host*) |
| `sessionTurnLocks` | `apps/agor-daemon/src/register-routes.ts:843` | session_id → mutex; serializes prompt + queue-drainer | **NEEDS SHARED LOCK** (per-daemon `Map`; two daemons can both decide "session idle → spawn next task") |
| Scheduler tick | `apps/agor-daemon/src/services/scheduler.ts:142-146` | `setInterval` evaluating cron-like worktree schedules | **NEEDS LEADER** (two daemons → duplicate scheduled sessions) |
| Health monitor | `apps/agor-daemon/src/services/health-monitor.ts:88-102` | `setInterval` per worktree, polls dev-server `/health` | **STICKY-WORKABLE** (idempotent HTTP probe; benign double-write to `last_health_check`) |
| Session-token map | `apps/agor-daemon/src/services/session-token-service.ts:31-32` | JWT tokens for executor↔daemon | **PER-INSTANCE OK** (executor connects to *its* daemon; sticky-by-session covers this) |
| Artifact runtime maps | `apps/agor-daemon/src/services/artifacts.ts:234-268` | Console logs, sandpack errors, runtime grants | **PER-INSTANCE OK** (ephemeral; widget loses pulse on its daemon, that's fine) |
| OAuth flow map | `apps/agor-daemon/src/register-services.ts:968-978` | pending OAuth handshakes, 10 min TTL | **STICKY-WORKABLE** (already TTL'd; cross-daemon flow handoff is bounded loss) |
| GitHub install-state | `apps/agor-daemon/src/github-install-state.ts:36-49` | CSRF nonces, 10 min TTL | **STICKY-WORKABLE** (same — bounded loss across daemons) |
| Tool registry | `apps/agor-daemon/src/mcp/tool-registry.ts:61,64` | Built once at startup | **PER-INSTANCE OK** (deterministic) |

### 3.3 Singletons / scheduled work

| Job | File:line | Cadence | If both daemons run it… |
|---|---|---|---|
| Scheduler tick (worktree cron) | `services/scheduler.ts:142-146` | 30 s | Both spawn the same scheduled session twice |
| Session turn-lock / queue drainer | `register-routes.ts:843` + `register-hooks.ts` IDLE hook | event-driven (after session patches to IDLE) | Both spawn next queued task — duplicated execution under the same `task.id` is *probably* safe because the executor takes a session lock, but at the boundary it's a race |
| Health monitor per-worktree | `services/health-monitor.ts:88-102` | 5 s | Idempotent; chatty DB writes, benign |
| Session-token cleanup | `services/session-token-service.ts:201-206` | 1 hr | Each daemon's own map — fine |
| OAuth flow cleanup | `register-services.ts:968-978` | 1 min | Each daemon's own map — fine |
| Install-state purge | `github-install-state.ts:42-49` | 1 min | Same — fine |
| Claude-CLI watcher per session | `services/claude-cli-watcher.ts:323` | per-session poll | Only the spawning daemon has the watcher; sticky-by-session covers this |
| Claude-CLI integration watchdog | `services/claude-cli-integration.ts:314` | per-session, ~100 ms | Same |

### 3.4 Filesystem state — **the load-bearing constraint**

- Worktrees live at `~/.agor/worktrees/<repo>/<name>/` (`packages/core/src/config/config-manager.ts:380-395`, override via `AGOR_DATA_HOME` `:516-530`).
- Base clone cache at `~/.agor/repos/<repo>/` (`:373-378`), used as `--reference` hint when creating per-branch clones (`packages/core/src/git/index.ts:1143-1160`).
- Dev-server child processes are tracked in `worktrees.ts:73` `processes: Map<WorktreeID, ManagedProcess>`. PID is also persisted to `environment_instance.process` on the worktree row (`services/worktrees.ts:1149-1243`) — so a different daemon *could* read the PID, but killing a stale PID from a different host is unsafe.
- Worktree creation writes files via the daemon's Unix uid (`unix_user_mode` aside) — the path is owned `agorpg:agorpg 0755` on shared-tenant installs to prevent multi-user directory creation (per `context/explorations/clone-redesign.md:43`).
- The clone-mode migration (`design-worktree-to-branch-and-clone-model`, **partially shipped** as of `1b502084` "feat(branch): allow self-standing clones at create-time") reduces *cross-branch* coupling (each branch has its own `.git/`), but does **not** change the host-locality story. Clones still live on whichever daemon's disk they were created on.

**Implication:** two daemons on different hosts cannot serve the same worktree without either (a) shared storage (NFS/EFS) or (b) the executor-as-volume-owner topology proposed in `daemon-fs-decoupling.md` Option D. The intermediate is **worktree affinity** at the load balancer: a request that touches worktree W is routed to the daemon that owns W's FS. This works for both REST and WS as long as the LB can key on something stable (session cookie, header, URL).

### 3.5 External dependencies in the stack

| Dep | Status | Cite |
|---|---|---|
| Postgres | **Optional, configured** | `packages/core/src/db/schema-factory.ts:63-94` (dialect resolution); `docker-compose.yml` (PG behind `profiles: ['postgres']`); SQLite is the default. |
| Redis | **Not present** | Zero hits across `apps/agor-daemon/src/**` for `redis|Redis|@socket.io/redis-adapter`. |
| Message queue (BullMQ, Kafka, NATS) | **Not present** | Zero hits. |
| `LISTEN`/`NOTIFY` / advisory locks | **Not present** | Zero hits. |
| Helm chart / k8s manifests | **Not present** | None in tree. Only `docker/Dockerfile` + `docker-compose.yml`. |
| Service discovery | **Not present** | The daemon assumes it's the only instance. |

**Postgres is the one big gun already loaded.** It has `LISTEN`/`NOTIFY`, advisory locks, row-level locking, and `SKIP LOCKED` — together those cover ~90% of what a Redis-or-equivalent buys you, at zero new infra cost. The fly in the ointment: `LISTEN`/`NOTIFY` payloads are capped (≤8000 bytes) and have no replay; high-frequency or large-payload broadcasts (streaming-message events) would need to chunk or fall back to row-poll-on-NOTIFY (`NOTIFY` is the wake-up, then the listener reads the actual data from a table).

### 3.6 Auth surface across instances

- JWT is HS256 with a shared secret read from `app.get('authentication').configuration.secret` (`apps/agor-daemon/src/register-routes.ts:243`), bootstrapped to `~/.agor/config.yaml` on first run (`apps/agor-daemon/src/index.ts:502-506`).
- Access-token TTL: **15 min** (`register-routes.ts:252`); refresh TTL: **30 days** (`:253`).
- **For HA:** the secret must be the same across all daemon instances. Today's bootstrap-on-first-run path is per-daemon-machine; an HA deployment must inject the secret via env var or shared config (this is plumbing, not architecture). `daemon-fs-decoupling.md` §1.5 already proposes operator-provided secrets in hosted mode.
- No KMS / no per-instance key derivation. JWTs are stateless: as long as the secret is the same, a token signed by A verifies on B.

### 3.7 Reconnection semantics (today)

From the companion `reconnection-and-state-refresh-design-2026-05-24.md`:
- socket.io client config: `reconnection: true`, `reconnectionDelay: 1000`, `reconnectionDelayMax: 5000`, `reconnectionAttempts: ∞` (`packages/core/src/api/index.ts:907-923`).
- On reconnect, two listeners fire: (1) re-auth socket with JWT (`apps/agor-ui/src/hooks/useAgorClient.ts:216`), (2) call `resync()` on reactive sessions (`packages/client/src/reactive-session.ts:360`).
- **For HA:** if reconnect lands on a *different* daemon, `resync()` rehydrates from DB — that's fine for *data*. But for in-flight ephemeral state (terminal streams, artifact runtime), the new daemon has no record. Sticky sessions sidestep this by keeping reconnects on the same daemon when possible; on daemon death, the failover daemon starts clean.

---

## 4. What "HA daemon" means here

There are multiple things that phrase could mean. I'm picking the cheapest definition that delivers real value:

**Target:** *Survive losing one daemon instance with bounded user impact.* Defined as:
- A planned restart / rolling deploy of daemon A causes its clients to disconnect, reconnect to daemon B, lose ~zero unsynced state (everything important is in DB), and continue.
- An unplanned crash of daemon A loses the in-flight ephemeral state on A (active terminal frames, mid-stream messages already chunked) but all *durable* state is intact.
- Worktrees owned by a dead daemon are *unavailable* until they're reassigned (manual or automatic). **Not zero-downtime per-worktree** — that's T4 territory.
- REST throughput scales linearly with N daemons.

What this is **explicitly not**:
- Per-worktree zero-downtime. That requires shared worktree FS or executor-pod-owns-volume (T4).
- Cross-region multi-master. Not in scope.
- Failing over an in-flight LLM stream to another daemon. Not in scope; reconnect + reissue is the contract.

---

## 5. Options matrix

Tiers stack (each adds to the previous). Costs are best estimates, not commitments.

| Tier | What it gives you | Code impact | Infra impact | New failure modes |
|---|---|---|---|---|
| **T0 — Sticky sessions** | Multiple daemons behind LB, each owns a partition of worktrees. WS broadcasts are correct *within* a partition. | LB config; tiny daemon config (`instance_id`); CLI/admin command to rebalance | LB cookie or header affinity; shared Postgres (already supported) | Losing daemon A drops A's WS clients (they reconnect to B). Worktrees on A are unavailable until reassigned. **No cross-instance broadcasts** (acceptable when each session is partitioned to one daemon). |
| **T1a — PG `LISTEN/NOTIFY` backplane** | Service-event broadcasts fan out across daemons. A `sessions created` on A reaches subscribers on B. | New `pubsub.ts` module: wraps `app.publish()` to also `NOTIFY` on a channel; each daemon `LISTEN`s and re-publishes locally. Drop-in at `register-hooks.ts:1618-1634`. | None — already on Postgres. | NOTIFY payload ≤8000 bytes (chunk or "NOTIFY then SELECT"); no replay (a daemon offline during a NOTIFY misses it; clients reconnect & `resync()` fixes this). |
| **T1b — Redis adapter (alternative to T1a)** | Same — `@socket.io/redis-adapter` does the fanout natively, no daemon code change. | One-line in `apps/agor-daemon/src/setup/socketio.ts:558` to attach the adapter. | **Adds Redis.** Single Redis is a SPoF; Redis Sentinel/Cluster pushes us into infra we don't currently run. | Adapter outage = silent loss of cross-instance broadcasts. Higher op cost than T1a. |
| **T2 — Postgres advisory-lock leader** | Scheduler tick and queue-drainer hot path run on exactly one daemon at a time. Auto-failover on leader death (lock released → contender acquires). | Wrap `scheduler.start()` (`services/scheduler.ts:142`) and the queue drainer (`register-hooks.ts` IDLE hook) with `SELECT pg_try_advisory_lock(<key>)`; release on shutdown. Optional: heartbeat row in DB for observability. | None. | Brief gap during leader transition (≤ tick interval). Lock-key collisions (use distinct keys per workload). Connection-lifetime quirks: `pg_advisory_lock` is session-scoped — if the daemon's PG connection drops, the lock releases — which is the *correct* behavior here. |
| **T3 — Per-session/per-worktree DB lock** | Even *without* a global leader, sessions and worktrees can't be double-driven. Replaces in-memory `sessionTurnLocks`. | Replace `sessionTurnLocks: Map` (`register-routes.ts:843`) with `pg_advisory_xact_lock(hashtext('session:' || id))` inside `withSessionTurnLock`. | None. | Slight latency on lock acquisition; deadlock potential if not careful with order (mitigate by single lock per critical section). On SQLite installs, no-op (single daemon, lock unneeded). |
| **T4 — Shared worktree FS / leaderless** | Any daemon can serve any worktree. True horizontal scale. | Massive. Requires `daemon-fs-decoupling` Option D (executor-as-volume-owner) or shared NFS/EFS with careful POSIX semantics. | EFS / NFS / RWX volumes; or per-worktree executor pods with their own volumes (the PR #1209 path). | Shared-FS quirks (NFS locking, dirty caches), pod-orchestration ops, IAM for volume mounts. **The biggest op-cost item; not justified yet.** |

### 5.1 Why T1a over T1b

**Postgres LISTEN/NOTIFY wins on op cost.** Postgres is already in the stack for any team install (and `daemon-fs-decoupling` §1.5 confirms the hosted direction is Postgres-mandatory). Redis would be net-new. Failure modes are also better understood: a NOTIFY lost during a daemon restart is paved over by client reconnect + `resync()` (already the contract per `design-reconnection-and-state-refresh`). The 8000-byte cap matters for two event shapes today:

- **Message streaming chunks** (`messages/streaming`, `streaming:*` events) — already chunked, individual frames are tiny.
- **`sessions created` / `tasks created`** — full row payload could exceed 8000 bytes if `messages` are eagerly included. The mitigation is the standard one: `NOTIFY` carries just the ID, listener re-reads via Drizzle and re-publishes locally.

If we ever hit a real performance ceiling on `LISTEN/NOTIFY` (say, sustained > 10k events/sec, which is far beyond current load), Redis adapter is a drop-in replacement at that point.

### 5.2 What sticky-session affinity actually looks like

The LB needs to know **what to be sticky on**. Two reasonable options:

1. **Cookie-based session affinity** (simplest). The LB issues a cookie on first request, pins the client to a daemon. Works for both REST and WS. Survives the WS upgrade because the cookie is set on the initial HTTP request. Standard in nginx (`sticky cookie`), AWS ALB, Traefik, etc.
2. **Header-based affinity keyed on `worktree_id`** (more correct, more LB config). The LB inspects the request's worktree (URL path or header) and routes to the daemon assigned to that worktree. Requires the LB to read a daemon→worktree assignment table; not standard.

Recommend **option 1** for v1. The assignment of "client → daemon" is sticky-but-arbitrary; whichever daemon a client lands on becomes the owner of the worktrees that client creates. To rebalance, you migrate worktree ownership (cordon daemon, move FS, retarget). This is fine for v1; we don't need automatic rebalancing.

For WS clients specifically, socket.io supports cookie-based sticky on the long-poll fallback transport too (the `io` and `connect.sid` cookies). Setting `transports: ['websocket', 'polling']` (already configured per `setup/socketio.ts:247-261`) keeps this working.

### 5.3 What sticky-session affinity does **not** solve

It pins a *client* to a daemon. It does **not** pin a *worktree* to a daemon. If two users open the same worktree from different clients, they may land on different daemons, and the second daemon doesn't own the worktree FS or the dev-server process. The mitigation is one of:

- **App-level redirect**: if daemon B receives a request for a worktree owned by daemon A, return a `307 X-Agor-Owner: daemon-A` redirect for REST, and reject WS with a structured error the client uses to reconnect with affinity header. This is ~50 LoC.
- **Inter-daemon RPC**: daemon B proxies the request to A. Higher complexity, higher latency, not recommended for v1.

The redirect approach is the cheapest correct answer and matches how Couchbase, Vitess, and other shard-aware systems handle this.

---

## 6. Recommendation

### 6.1 Minimum viable HA (ship this first)

**T0 + T1a + T2 + T3**, on **shared Postgres**, with **shared JWT secret via env var**.

Concretely:
- LB with cookie-sticky session affinity in front of N daemons (N=2 to start).
- Each daemon `LISTEN`s on a `daemon-broadcast` Postgres channel; the global publish hook in `register-hooks.ts:1618-1634` is wrapped to also `NOTIFY` on event emit. Listener re-emits locally to `app.channel('authenticated')`.
- Scheduler tick (`services/scheduler.ts:142`) and queue drainer (`register-hooks.ts` IDLE handler) acquire `pg_try_advisory_lock(<workload_key>)` at start; release on shutdown.
- `sessionTurnLocks` (`register-routes.ts:843`) replaced by `pg_advisory_xact_lock(hashtext('session:'||id))` inside the existing `withSessionTurnLock` wrapper. SQLite installs no-op (single daemon, can't multi-instance anyway).
- JWT secret moved from on-disk bootstrap to env-var-required-in-prod (`daemon-fs-decoupling.md` already proposes this; do it as part of this work).
- Worktree-not-owned-here returns `307 Location: <owner-daemon>` for REST, structured error for WS clients to use a one-shot affinity-override cookie.

**Code impact, rough:**
- `apps/agor-daemon/src/setup/pubsub.ts` — new, ~200 LoC.
- `apps/agor-daemon/src/register-hooks.ts:1618-1634` — wrap publish.
- `apps/agor-daemon/src/services/scheduler.ts:142` — leader lock.
- `apps/agor-daemon/src/register-routes.ts:843` — replace in-memory Map with PG advisory lock.
- `apps/agor-daemon/src/index.ts` — add `daemon_instance` table row on boot (heartbeat + ownership claim).
- A new `worktree_owner_daemon_id` column on `worktrees` (already partly implied by `environment_instance.process`).
- Helm/docker example with shared Postgres + LB config.

**Estimate:** 2–3 eng-weeks. Single-host installs (SQLite, default) are entirely unchanged — every new code path is gated on `dialect === 'postgresql' && daemon_instance_count > 1`.

### 6.2 Recommended target (next phase)

After the minimum lands and we have observability:
- Add `daemon_instances` table for explicit registry (heartbeat, version, capabilities, owned worktrees).
- Admin command to drain a daemon (mark it as not-accepting-new-worktrees, migrate existing worktree assignments to peers).
- Liveness-based failover: if a daemon misses N heartbeats, its worktrees get reassigned (with caveats — see §7).

### 6.3 What we are **not** recommending yet

- **No Redis.** T1a covers it.
- **No shared worktree FS.** T4 is blocked on `daemon-fs-decoupling`.
- **No automatic worktree migration.** Manual rebalance via admin tool for v1.
- **No leaderless scheduler / queue.** Advisory-lock leader is simpler, well-understood, and fast-failover.

---

## 7. The worktree-storage problem (dedicated section)

This is the section that decides whether anything beyond §6.1 is possible.

**Today:** worktrees are host-local files. Two daemons cannot both own one. The only escape hatches are:

- **(a) Sticky-by-worktree.** Each worktree has exactly one owner daemon. T0–T3 in §5 work fine within this model. **This is what I'm recommending.**
- **(b) Shared filesystem.** NFS/EFS/RWX volume mounted to all daemons. Works, but POSIX semantics over network FS are a known minefield: `git` is famously sensitive to NFS quirks (pack file rename races, lock files, dirty page caches). Also, dev-server child processes are still spawned by *some* daemon's process tree; if daemon A dies, its children get reparented to init but B can't introspect them — so this only solves the *data* half of the problem.
- **(c) Executor-as-volume-owner.** Each worktree's executor pod owns its own volume; daemons are stateless coordinators. This is the `daemon-fs-decoupling.md` Option D direction (~10 eng-weeks per that doc). Once it lands, the daemon becomes nearly leaderless for worktree operations, and HA becomes "just run more daemons."

**Cross-reference:** the clone-mode migration (`design-worktree-to-branch-and-clone-model`) does **not** change which host the worktree FS lives on; each branch having its own `.git/` reduces *cross-branch* contamination but is orthogonal to HA. **Worth noting** because the renaming/cloning work might *feel* like it touches HA — it doesn't.

**My recommendation:** ship sticky-by-worktree (T0). Defer shared-FS / leaderless to *after* PR #1209 lands. If HA becomes urgent before that, the sticky-by-worktree model is sufficient for "survive a daemon restart with bounded user impact" — which is what the target in §4 commits to.

---

## 8. Phased rollout

Each phase ships behind a config flag; single-host installs see no behavior change.

**Phase 1 — Sticky sessions, no backplane (1 week).**
- LB config + `daemon_instance_id` config var + `307` redirects for misrouted worktrees.
- Verify: 2 daemons behind nginx, each client gets pinned, REST throughput scales.
- **Useful on its own:** doubles REST capacity for read-heavy traffic.
- **Known limitation:** WS broadcasts still partitioned.

**Phase 2 — Postgres LISTEN/NOTIFY pub-sub (3–5 days).**
- New `pubsub.ts` module; wrap `app.publish()`.
- Verify: event emitted on daemon A is observed by socket on daemon B.
- **Known limitation:** scheduler still double-fires.

**Phase 3 — Advisory-lock leader (2–3 days).**
- Wrap scheduler tick + queue drainer.
- Verify: kill leader → contender acquires within tick interval.

**Phase 4 — Per-session advisory lock (2 days).**
- Replace `sessionTurnLocks` with `pg_advisory_xact_lock`.
- Verify: rapid concurrent `/sessions/:id/prompt` from clients pinned to different daemons can't both spawn executors.

**Phase 5 — Observability (3 days).**
- `daemon_instances` table + heartbeat + admin UI for "who owns what."
- Verify: graceful drain works; killing a daemon shows correct partition in UI.

**Total: ~2–3 calendar weeks.** Each phase is independently shippable and rollback-safe.

---

## 9. Open questions for Max

1. **Hosted vs self-hosted scope.** Is HA being designed for the hosted Preset deployment, or for self-hosted teams running their own daemon? The hosted target is Postgres-mandatory and we control infra; self-hosted has to keep working on SQLite. I've assumed the recommendation is "hosted gets HA; self-hosted stays single-daemon" — confirm?
2. **What's the actual capacity ceiling we're trying to bust?** The recommended T0+T1a+T2+T3 stack gets us "tolerate losing one daemon" and "scale REST horizontally." It doesn't get us "5x more concurrent worktrees on the same hardware." If the goal is the latter, the bottleneck is more likely worktree FS / executor sprawl than the daemon process itself, and the fix is `daemon-fs-decoupling`, not HA.
3. **JWT secret distribution.** Today it bootstraps to `~/.agor/config.yaml`. HA needs the same secret on every daemon. Are we OK requiring an env var (`AGOR_JWT_SECRET`) in HA mode, or do we want shared-config-via-DB? Env var is much simpler.
4. **Sticky-session granularity.** Cookie-stick-the-client (simpler, recommended) vs sticky-by-worktree (more correct, more LB config). Confirm cookie-sticky is the v1 choice.
5. **What's "bounded user impact" precisely?** Specifically: when a daemon dies, do we want (a) clients reconnect to peer, peer rejects worktree requests until manual rebalance, OR (b) automatic worktree reassignment with potential dev-server restart on the new host? (a) is much simpler and what I'd recommend for v1.
6. **The `daemon-fs-decoupling` timeline.** When PR #1209's Option D ships, T4 (true leaderless) becomes feasible. Should this doc explicitly call out "revisit after #1209 lands" as a roadmap item, or do we treat T0–T3 as the permanent steady state for multi-daemon installs?

---

## 10. Out of scope

- **Distributed / federated Agor** (executor on user's machine, daemon hosted). Different problem entirely; see `analyze-distributed-federated-agor-mode/docs/internal/distributed-agor-feasibility-2026-05-19.md`. The HA work here is a prerequisite for that, not a substitute.
- **Multi-region active-active.** Postgres `LISTEN/NOTIFY` doesn't cross regions. If we ever need geo-distributed daemons, we'll need a different backplane (Redis Cluster, NATS, etc.). Not in scope.
- **Per-message ordering guarantees across daemons.** Today's single-daemon ordering is per-socket; multi-daemon broadcasts via `LISTEN/NOTIFY` are per-channel-FIFO but not globally ordered. Acceptable for the current event semantics (each message is self-describing with `id` and `created_at`).
- **Failing over in-flight LLM streams.** When a daemon dies, in-flight streaming completions die with it. Client reconnects, sees the task as `FAILED` or stuck, retries. This is the cost of not having executor-as-volume-owner yet. Not in scope.
- **HA for the executor itself.** Out of scope. Executors are per-session; if the executor dies, the task fails. Resilience is at the daemon/canvas layer.
- **HA for the MCP HTTP endpoint.** Stateless POST; rides the same LB as REST. No additional design needed.
- **Database HA.** Assumed (Postgres primary + standby is operator's problem; we don't do anything special for it).

---

## Appendix A — Cite index

For quick reference during review.

| Claim | Cite |
|---|---|
| socket.io version | `apps/agor-daemon/package.json:40` |
| Feathers socketio re-export | `packages/core/src/feathers/index.ts:40` |
| Socket.io server init | `apps/agor-daemon/src/setup/socketio.ts:233-712` |
| Handshake auth (JWT) | `apps/agor-daemon/src/setup/socketio.ts:272-347` |
| Global publish → 'authenticated' | `apps/agor-daemon/src/register-hooks.ts:1618-1634` |
| Channel join on login | `apps/agor-daemon/src/setup/socketio.ts:739-747` |
| Direct `app.io.emit('sessions created', ...)` | `apps/agor-daemon/src/register-routes.ts:663,689` |
| Terminal I/O relay | `apps/agor-daemon/src/setup/socketio.ts:558-655` |
| Worktree `processes` Map | `apps/agor-daemon/src/services/worktrees.ts:73` |
| Executor processes Map | `apps/agor-daemon/src/executor-tracking.ts:11` |
| `sessionTurnLocks` Map | `apps/agor-daemon/src/register-routes.ts:843` |
| Scheduler tick | `apps/agor-daemon/src/services/scheduler.ts:142-146` |
| Health monitor | `apps/agor-daemon/src/services/health-monitor.ts:88-102` |
| Worktree path resolution | `packages/core/src/config/config-manager.ts:373-395` |
| Dialect resolution | `packages/core/src/db/schema-factory.ts:63-94` |
| JWT secret | `apps/agor-daemon/src/register-routes.ts:243` |
| Access / refresh TTL | `apps/agor-daemon/src/register-routes.ts:252-253` |
| socket.io client reconnect config | `packages/core/src/api/index.ts:907-923` |
| Clone-mode migration status | commit `1b502084` ("feat(branch): allow self-standing clones at create-time") |

---

_End._
