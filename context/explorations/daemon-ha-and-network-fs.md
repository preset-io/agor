# Daemon HA and Network Filesystem Investigation

**Status:** 🔬 Investigation
**Companion:** [`daemon-fs-decoupling.md`](./daemon-fs-decoupling.md) — read that first; this doc builds on its analysis.

---

## TL;DR

**Can Agor run on CephFS/EFS?** Partially. `simple` mode works; `insulated`/`strict` modes break because EFS doesn't support POSIX ACLs and CephFS requires explicit `acl` mount configuration. Network FS also breaks inotify-based watch mode across pods.

**Can the daemon be HA?** Yes, but it requires the FS-decoupling work from `daemon-fs-decoupling.md` to complete. Once the daemon is stateless (Postgres + Redis pub/sub), you can run N replicas behind a load balancer.

**Do we need PVCs per branch?** No. An ephemeral pod model with `emptyDir` volumes avoids PVCs almost entirely. Git remotes are the durable store; pods clone on start, commit+push on end. A small git mirror cache (one optional PVC per repo) handles clone latency.

**Does Unix isolation matter for hosted?** No. Container boundaries replace POSIX ACLs. The entire `packages/core/src/unix/` subsystem is dead code in hosted mode.

---

## 1. Network Filesystem Compatibility

### 1.1 The constraint: `setfacl` + `sudo`

Agor's Unix isolation (`insulated` and `strict` modes) depends on POSIX ACLs. The critical code path in `packages/core/src/unix/group-manager.ts:199-239`:

```
sudo -n chgrp -R <group> <path>
sudo -n setfacl -R -m g:<group>:rwX <path>
sudo -n setfacl -R -d -m u::rwX,g:<group>:rwX,<others>,m::rwX <path>
sudo -n find <path> -type d -exec chmod g+s {} +
```

Every branch directory gets a per-branch Unix group (`agor_wt_<id>`) with recursive ACLs and default ACLs for inheritance.

### 1.2 Compatibility matrix

| Constraint | Local (ext4/XFS) | CephFS | EFS (NFS v4.1) |
|---|---|---|---|
| POSIX ACL (`setfacl`) | Yes | Yes, if `acl` mount enabled | **No** — NFS v4.1 has its own ACL model |
| `sudo` on FS host | Yes | Must be same host or privileged pod | Same |
| Single uid/gid namespace | Yes | Requires shared NSS (LDAP/sssd) across pods | Same |
| inotify / file watchers | Yes | **No** cross-client propagation | **No** cross-pod propagation; `usePolling: true` burns CPU |
| Setgid bit + group inheritance | Yes | Yes if ACLs supported | Setgid works, but without POSIX ACLs the permission scheme breaks |

### 1.3 Mode-by-mode feasibility

| Agor Mode | CephFS | EFS |
|---|---|---|
| **Simple** (no RBAC) | Likely works | Likely works |
| **Insulated** | Works if `acl` mount + single host | **Broken** — `setfacl` fails |
| **Strict** | Works if ACL + shared NSS + single host | **Broken** |

### 1.4 Conclusion

Network filesystems are viable only in `simple` mode (no Unix isolation). For isolated modes, the daemon must own the filesystem locally. This is consistent with `daemon-fs-decoupling.md` §2 ("The ACL/`--watch` wall").

**For hosted HA, this constraint is irrelevant** — container isolation replaces POSIX ACLs entirely (see §3).

---

## 2. Daemon HA: Why It Doesn't Work Today

The daemon (`apps/agor-daemon`) is a single process with two fundamentally different responsibilities:

| Responsibility | Nature | What blocks multiple replicas |
|---|---|---|
| API/DB layer (REST, WebSocket, auth, CRUD) | Stateless | SQLite is single-writer; WebSocket channels are in-memory |
| Process management (executor spawn, env lifecycle, `process.kill`) | Host-bound | Child processes tied to PID namespace; env log piping assumes same process |

Running two daemons behind a load balancer today would result in: split-brain WebSocket state, double executor spawns, and one daemon trying to `kill()` a PID it doesn't own.

---

## 3. HA Architecture: Stateless Daemon + Ephemeral Env-Pods

This builds on `daemon-fs-decoupling.md` Option D, with two changes:

1. **Ephemeral env-pods with `emptyDir`** instead of per-branch PVCs
2. **Redis pub/sub for WebSocket fan-out** across daemon replicas (not discussed in the companion doc)

### 3.1 Target topology

```
         ┌────────────────┐
         │  Load Balancer  │
         └───────┬────────┘
       ┌─────────┴─────────┐
       ▼                   ▼
 ┌───────────┐      ┌───────────┐
 │ Daemon A  │      │ Daemon B  │     Stateless API pods (N replicas)
 │ (API only)│      │ (API only)│     No FS, no sudo, no child procs
 └─────┬─────┘      └─────┬─────┘
       ▼                   ▼
 ┌─────────────────────────────────┐
 │     Postgres      +     Redis   │  Managed services (RDS, ElastiCache)
 │  (all DB state)    (WS pub/sub) │  Zero k8s-managed state
 └──────────────┬──────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│Env-Pod │ │Env-Pod │ │Env-Pod │  Ephemeral pods (emptyDir)
│Branch A│ │Branch B│ │Branch C│  Clone from git mirror or remote
│ agent  │ │ agent  │ │ agent  │  Commit+push = durable
│ vite   │ │ vite   │ │ vite   │  Pod dies = clone again
└────────┘ └────────┘ └────────┘
                │
                ▼ (optional, for clone speed)
     ┌──────────────────┐
     │  Git Mirror Pod   │  One small PVC per repo
     │  (bare repo cache)│  (or just clone from remote)
     └──────────────────┘
```

### 3.2 Component responsibilities

**Daemon pods (stateless, N replicas):**

- HTTP + WebSocket via FeathersJS
- All state in Postgres (sessions, tasks, messages, branches, boards, users)
- WebSocket cross-instance fan-out via Redis pub/sub (Socket.io Redis adapter or `@feathersjs/sync`)
- When user sends a prompt: enqueue work for the target branch's env-pod via RPC/queue — no local fork
- No filesystem. No `sudo`. No child processes. No Unix users/groups.

**Env-Pods (ephemeral, one per active branch):**

- `emptyDir` volume (node-local disk or tmpfs) — NOT a PVC
- On start: `git clone` (shallow, from mirror or remote) → `git checkout <branch>` → dependency install
- Agent (Claude/Codex/Gemini) runs inside this pod — edits are local, inotify works
- Dev server (`vite --watch`, etc.) runs inside this pod — same filesystem, same PID space
- On task completion: `git commit` + `git push` — meaningful state is durable in the remote
- On pod death: re-clone, re-checkout. Uncommitted work in interrupted tasks is lost (task marked failed).
- Session-pinned with idle TTL (e.g. 15 min) — pod stays warm between prompts, reclaimed when idle

**Git Mirror (optional, one per repo):**

- Long-lived pod with a small PVC holding a bare git mirror
- Env-pods clone from the mirror (LAN speed) instead of GitHub (internet speed)
- Reduces cold-start clone time from 30-60s to 2-5s for large repos
- Alternative: bake repo snapshot into container image, `git fetch` on start for delta only

### 3.3 Why `emptyDir` instead of PVCs

| Concern | Per-branch PVC | emptyDir (ephemeral) |
|---|---|---|
| PVC lifecycle management | Must create, attach, detach, delete per branch | Nothing to manage |
| Orphaned volumes | Must garbage-collect after branch deletion | Cannot orphan |
| AZ scheduling | Pod pinned to PVC's AZ | Pod schedules anywhere |
| Cost at scale | Linear with total branches (including idle) | Linear with concurrent active pods only |
| Clone on start | Not needed | ~2-30s depending on repo size and cache strategy |
| Uncommitted work on pod death | Survives (on the PVC) | Lost (task marked failed, user re-runs) |
| Operational complexity | High — StorageClass, provisioner, resize, backup | Near zero |

**The trade-off is startup latency vs. operational complexity.** For an infra team, this is almost always the right trade. Agents work in commit cycles (prompt → edit → commit → push), so the "lost uncommitted work" window is small and bounded by task duration.

### 3.4 Clone latency mitigation strategies

| Strategy | Cold start | Ops burden | Best for |
|---|---|---|---|
| Shallow clone from remote | 10-60s (depends on repo size + network) | None | Small repos, simple setup |
| Git mirror pod (bare cache) | 2-5s (LAN clone) | One StatefulSet per repo (small PVC) | Large repos, multiple branches |
| Repo snapshot in container image | 1-3s (`git fetch` delta only) | CI rebuilds image on push to main | Monorepos with infrequent main changes |
| Warm pod pool | ~0s (pre-cloned, assigned on demand) | Autoscaler config, idle resource cost | Low-latency SLA requirements |
| Session-pinned pods (idle TTL) | 0s for repeat prompts, full clone on first | TTL policy | Interactive development sessions |

These are composable — a likely production setup is **git mirror + session-pinned pods**: fast first clone, instant repeat prompts, automatic reclaim on idle.

---

## 4. Unix Isolation in Hosted Mode

### 4.1 Why it's not needed

The `packages/core/src/unix/` subsystem (group-manager, user-manager, symlink-manager, run-as-user) exists to prevent one user's agent from accessing another user's branch on a shared host.

In the env-pod model, branches are isolated by the container boundary:

- Pod A (Branch A) cannot see Pod B (Branch B)'s filesystem — kernel-enforced by k8s
- No shared filesystem between pods means no ACL coordination needed
- No `sudo`, no `setfacl`, no `chgrp`, no `groupadd`
- No sudoers configuration
- No NSS/LDAP for uid mapping

**`execution.unix_user_mode` should be `simple` (or irrelevant) in hosted deployments.** The RBAC layer (`execution.branch_rbac`) still applies at the API level — the daemon enforces who can prompt which branch. But OS-level enforcement is the container, not POSIX ACLs.

### 4.2 Where Unix isolation remains relevant

Self-hosted deployments where:
- Multiple humans share one server
- SSH/terminal access is provided
- Compliance requires OS-level audit trails

This is `daemon-fs-decoupling.md` Option A's territory — single host, single uid namespace, ACLs work fine.

---

## 5. WebSocket HA: Redis Pub/Sub

Not covered in `daemon-fs-decoupling.md`. Required for multi-replica daemon.

### 5.1 The problem

FeathersJS WebSocket channels are in-memory. Client connected to Daemon A won't receive events published by Daemon B. Today's broadcasting in `apps/agor-daemon/src/` (task events, message streaming, presence updates) assumes a single daemon process.

### 5.2 The solution

Socket.io has a first-party Redis adapter (`@socket.io/redis-adapter`). When a daemon instance publishes an event, the adapter broadcasts it via Redis pub/sub to all other instances, which forward to their local clients.

This is a well-trodden pattern — no custom code beyond adapter configuration. FeathersJS sits on top of Socket.io, so the adapter slots in at the transport layer.

### 5.3 What changes

- Add `@socket.io/redis-adapter` dependency
- Configure in `apps/agor-daemon/src/setup/socketio.ts` (the existing Socket.io setup)
- Provide `REDIS_URL` env var in hosted deployments
- Self-hosted (single daemon): no Redis needed, adapter not loaded

### 5.4 Effort

~1 week including testing. The adapter handles the hard parts (serialization, reconnect, missed-message recovery).

---

## 6. Relationship to `daemon-fs-decoupling.md` Phased Plan

This investigation does not replace the companion doc's phased plan. It refines Phase 3 (env-pods) and adds the Redis requirement:

| Phase | Companion doc | This investigation's refinement |
|---|---|---|
| 1A — Config hygiene | ✅ Shipped | No change |
| 1B — FS hygiene | ~3 weeks | No change |
| 2 — `EnvironmentRuntime` interface | ~1.5 weeks | No change — this is the critical seam |
| 3 — Hosted env-pods | ~8 weeks (per-branch EBS PVC) | **Simpler: ephemeral `emptyDir` + git mirror.** Removes PVC orchestration (~2 weeks savings). Adds clone-on-start logic + mirror pod (~1 week). Net: ~7 weeks. |
| 4 — Consolidation | ~1 week | No change |
| **New** — Redis pub/sub for WS | Not in companion doc | ~1 week. Can land any time after Phase 1B. |
| **Total** | ~15 weeks | **~13-14 weeks** |

The ephemeral model is slightly cheaper to build (no PVC lifecycle management, no orphan cleanup, no AZ scheduling logic) and significantly cheaper to operate.

---

## 7. Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Clone latency > 30s for large repos | Poor UX on cold start | Git mirror pod, warm pools, session-pinned TTL |
| Uncommitted work lost on pod crash | User must re-run interrupted task | Agent commit-on-completion discipline; optional WIP-commit checkpoint |
| Dependency install time (`npm install`) on each cold start | Adds to startup latency | Layer cache in container image, shared npm/pip cache volume |
| Git mirror pod is itself a small SPOF | Env-pods fall back to cloning from remote (slower, not broken) | Mirror pod is optional optimization, not required |
| Redis unavailability | WebSocket events don't fan out; each daemon serves only its local clients | ElastiCache with multi-AZ; degrade gracefully (events still work per-instance) |
| Two deployment modes (self-hosted vs hosted) to maintain | Test matrix, divergent bugs | `EnvironmentRuntime` interface is the seam; both modes share 95% of code |

---

## 8. Open Questions

1. **What's the target repo size for hosted customers?** Determines whether shallow clone alone suffices or git mirror is required from day one.
2. **What's the acceptable cold-start latency?** 5s vs 30s changes whether we need warm pools.
3. **Do we need to support long-lived uncommitted state?** If yes, the ephemeral model needs a checkpoint mechanism (periodic WIP commits to a temp branch). If no, `emptyDir` is sufficient as-is.
4. **Redis vs NATS vs Postgres LISTEN/NOTIFY for pub/sub?** Redis is the path of least resistance (Socket.io adapter exists), but Postgres LISTEN/NOTIFY avoids adding a new dependency. Worth a spike.
5. **Should the git mirror be a sidecar or a shared service?** Sidecar = simpler networking, one per node. Shared service = one per repo cluster-wide, more efficient but needs service discovery.

---

_End of investigation._
