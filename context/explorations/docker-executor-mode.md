# Docker-Backed Executor Mode — Feasibility & Design

**Status:** 🔬 Exploration / design-only (no code written)
**Author:** design pass for Max
**Date:** 2026-08-14
**Related:** [[executor-expansion]], [[daemon-fs-decoupling]], [[executor-isolation]], [[web-terminal-ownership-ha]], [[clone-redesign]], [[task-runtime-state]], `apps/agor-docs/content/guide/containerized-execution.mdx`

> **⚠️ Superseded for the local use case — read [[executor-sandboxing]] first.** After this
> analysis, the recommended isolation for **local / self-hosted** is **OS-level sandboxing**
> (`@anthropic-ai/sandbox-runtime`: bubblewrap/Seatbelt), which avoids this doc's three blockers
> (daemon→root Docker authority, a Stop/containment refactor, an image lifecycle) and preserves the
> pgid Stop model. **This doc remains the reference for the Tier-2 container / microVM / gVisor / k8s
> backends** used for hardened multi-tenant / Agor Cloud, reached via the `executor_backend` /
> `executor_command_template` seam.

> TL;DR recommendation up front (details in §14): **Do not add `docker` as a fifth
> `unix_user_mode`.** Docker is an execution _substrate_, not an identity policy, and
> Agor already models that split. Build a **first-class local Docker executor
> _backend_** on the existing `spawn-executor.ts` seam and the existing
> `executor_command_template` / `executor_storage` contracts, driven by the Docker
> Engine API (no shell interpolation), gated to **clone storage**, and composed with
> `delegated`/`strict` for identity rather than replacing them. Ship it as a
> **local instantiation of the already-documented containerized-execution path**, not
> a parallel concept. Proceed to a narrow POC; several blockers below need Max's
> decision first.

---

## 0. Why this doc exists / correcting the framing

The proposed intuition ("add a `docker` unix mode that wraps the executor invocation
in a container, mount home + branch, keep the same stdout/sentinel + socket behavior")
is directionally reasonable but rests on two assumptions that the current code
contradicts:

1. **There is no single "stdout/sentinel + socket" behavior to preserve uniformly.**
   The prompt/task path is a **persistent Feathers Socket.IO client** back to the daemon.
   The stdout sentinel (`AGOR_EXECUTOR_RESULT `) is used **only** for one-shot commands
   (git probes, file ops). Zellij PTY I/O rides a **third** channel (a Socket.IO room).
   A Docker mode must preserve all three, and each has a different container implication.

2. **"Wrap the executor invocation in a container" already exists as a config path.**
   `execution.executor_command_template` (`packages/core/src/config/types.ts:458-505`)
   ships with a **Docker example in its docstring** and a k8s example, is wired through
   `spawnExecutorWithTemplate` (`apps/agor-daemon/src/utils/spawn-executor.ts:504`), and
   is documented at length in `containerized-execution.mdx`. What does **not** exist:
   a shipped executor **image**, a **local** first-class launcher (the template path runs
   `sh -c <template>` — shell interpolation), and containment/Stop parity for containers.

So the real question is **not** "can we make `docker run … executor …` work" (we can, today,
via a template) but: _should local Docker isolation be a new identity mode, or a
first-class, safe, well-contained instantiation of the existing substrate axis — and does
it actually simplify Agor while preserving Stop correctness, tenant boundaries, and the
Cloud direction?_

---

## 1. Current architecture, mapped exactly

### 1.1 The single execution chokepoint

Every execution surface funnels through **one module**:
`apps/agor-daemon/src/utils/spawn-executor.ts`
(`spawnExecutor` / `spawnExecutorFireAndForget` / `runExecutorCommand` /
`startInteractiveExecutor`). This module decides _local subprocess_ vs _templated_:

- `spawnExecutor()` (`:368`) → if `executorCommandTemplate` set → `spawnExecutorWithTemplate()`
  (`:504`, runs `spawn('sh', ['-c', command])`); else `spawnExecutorLocal()` (`:434`).
- Local spawn: `child_process.spawn('node', [executorPath, '--stdin'], { detached: !win32 })`
  (`:468-472`); JSON payload written to **stdin** then closed (`sendExecutorPayload`, `:405`).
- `findExecutorPath()` (`:320`) honors `AGOR_EXECUTOR_PATH`, else bundled `../executor/cli.js`.

**This is the seam a Docker backend plugs into.** It is small, already has a substrate
fork, and already carries `asUser`, `preparedEnv`, `templateVariables`, cwd, and lifecycle
callbacks (`onSpawn`/`onExit`).

### 1.2 `unix_user_mode` semantics (identity policy — the "who")

Type: `packages/core/src/config/types.ts:329` — `'simple' | 'delegated' | 'insulated' | 'strict'`.
Central resolver: `packages/core/src/unix/user-manager.ts:436 resolveUnixUserForImpersonation`
returns `{ unixUser, reportedUnixUser, reason }`:

| Mode        | `unixUser` (daemon sudo-impersonates?) | `reportedUnixUser` (identity to substrate) | Username required?          |
| ----------- | -------------------------------------- | ------------------------------------------ | --------------------------- |
| `simple`    | `null`                                 | `null`                                     | no (shares daemon identity) |
| `delegated` | `null` (no sudo, no groups)            | user's `unix_username`                     | **yes** — fail-loud         |
| `insulated` | `executor_unix_user` (shared)          | `executor_unix_user`                       | no                          |
| `strict`    | session creator's `unix_username`      | same                                       | **yes** — fail-loud         |

- Fail-loud at session **create** time: `assertUnixUsernameSatisfiesMode` (`user-manager.ts:374`),
  paired predicate `unixUserModeRequiresUsername` (`config-manager.ts:1529`, strict+delegated).
- `resolveExecutionSecurityMode` (`config-manager.ts:1505+`) treats **only insulated/strict**
  as `unixIsolationEnabled` (groups, fs isolation, daemon unix_user).

**Key insight:** `unixUser` (local sudo) and `reportedUnixUser` (identity handed to the
substrate via `{unix_user}`) are _already separate fields_. `delegated` is precisely the mode
that says "identity is real, but the daemon does not enforce it — the substrate does."
**A Docker backend is the substrate that consumes `reportedUnixUser`.** This is the seam that
makes Docker compose with identity instead of being a new identity mode.

### 1.3 How identity/HOME/env/credentials are derived (per prompt task)

`apps/agor-daemon/src/register-services.ts` (`createExecuteHandler`, ~`:855-1280`):

- `:956` resolve impersonation from `session.unix_username`; `:962` `asUser`; `:963`
  `executorHomeDir = getHomedirFromUsername(...)`; `:1111` `asUser`; `:1124`
  `templateVariables.unix_user = reportedUnixUser`.
- Env assembled by `createUserProcessEnvironment` (`packages/core/src/config/env-resolver.ts:359`):
  allowlist of `process.env` (`ALLOWED_ENV_VARS`, `:25-107`), per-tool credential merge
  (`:240-258` — a Codex spawn never sees `ANTHROPIC_API_KEY`), strips `NODE_OPTIONS`/`LD_PRELOAD`
  (`filterEnv`), decrypts user env vars from `users.data.env_vars`.
- Secrets across the sudo boundary go through a **0600 env-file** owned by `asUser`
  (`packages/core/src/unix/{secret-env,user-env-file}.ts`), sourced then `rm -f`'d inside the
  impersonated shell — never in argv/`/proc/<pid>/cmdline`.
- Auth back to the daemon is a **task-scoped JWT** (not env): minted at `register-services.ts:914`
  (`sessionTokenService.generateToken`), claims at `session-token-service.ts:245` (`type=executor-session`,
  `purpose=executor-task`, `session_id/task_id/branch_id/tenant_id`, `aud=RUNTIME_JWT_AUDIENCE`),
  passed in the stdin payload as `sessionToken`, validated by claim-the-authority-row
  (`validateAndConsume`, `:101`), revoked on launcher exit (`register-services.ts:1239`).

### 1.4 The three executor↔daemon channels

| Channel                                              | Used by                                                              | Transport                                                                                                                   | Container implication                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Socket.IO / Feathers**                             | prompt tasks (results, messages, permission, heartbeat, termination) | persistent WebSocket to `daemonUrl` (payload + `DAEMON_URL` env; fallback `http://localhost:${PORT\|\|3030}`)               | **`localhost` ≠ host inside a container** — must reach host gateway                 |
| **stdout sentinel** `AGOR_EXECUTOR_RESULT `          | one-shot commands (git/file/env/unix)                                | `console.log(prefix+json)` (`executor-output.ts`), parsed `spawn-executor.ts:564`; settle on **`close`** not `exit` (#2222) | `docker run -i` proxies stdout via docker CLI — must verify flush semantics survive |
| **Socket.IO terminal room** `tenant/…/terminal/<id>` | `zellij.attach` PTY                                                  | executor emits `terminal:output`; long-lived, does **not** exit on sentinel                                                 | same host-reachability constraint; long-lived container                             |

### 1.5 Stop / containment / termination evidence (the hard part)

- Cooperative: daemon publishes a task-scoped `termination_requested`; executor aborts its
  `AbortController`, then `reportTerminationComplete` (`index.ts:265`).
- Fallback containment: `apps/agor-daemon/src/executor-tracking.ts:259-380` — `SIGTERM` to
  **`-pgid`**, 3s grace (`DEFAULT_EXECUTOR_TERM_GRACE_MS`), then `SIGKILL`, 2s. Under impersonation:
  `sudo -u <asUser> /bin/kill -- -<pgid>`.
- **"Termination evidence" = verified process-group absence**, gated by `/proc/<pid>/stat` start-identity
  (field 22) + `/proc/sys/kernel/random/boot_id`, so a recycled PID is never mistaken for the same
  process. Non-Linux → `unverified`.
- Durable fences under `~/.agor/runtime/executor-containment-fences/` (0600 fsync'd JSON);
  restart is **never** containment proof; ambiguous records fail closed.
- `TaskRuntimeReconciler` (`services/task-runtime-reconciler.ts`) is the DB-driven, cross-daemon
  reaper (`dispatch_timeout`/`heartbeat_stale`/`termination_stranded` → `requestExecutorTermination`).
- **Templated mode already weakens this:** `startInteractiveExecutor` **rejects** templates (local
  containment only); process-group + `/proc` identity are meaningless across a container PID namespace;
  the config `executor_command_nonzero_may_have_dispatched` (`types.ts:518`) exists precisely because a
  nonzero template launcher may still have dispatched remote work. Templated mode leans on the
  **heartbeat reconciler**, not signals.

**→ Docker containment cannot reuse pgid/`/proc`. It must become container-lifecycle-based**
(`docker stop` → `docker kill` → `docker rm`; evidence = `docker inspect .State.Running=false` /
`.State.ExitCode`; the fence records **container id/name**, not pid/pgid). This is a new, first-class
containment interface — the single largest correctness item.

### 1.6 Branch/repo storage & path assumptions

- Path: `getBranchPath` → `$AGOR_DATA_HOME/worktrees/<repoSlug>/<branchName>`
  (`config-manager.ts:1791`); base repo at `~/.agor/repos/<slug>/` (`:1759`).
- **Two storage modes** (`branch.ts:362-388`, `config/types.ts:596-633`):
  - `worktree` (default): the branch's `.git` is a **`gitdir:` pointer into the base repo**
    (`~/.agor/repos/<slug>/.git/worktrees/…`); object store + `.git/config` live **outside** the
    branch dir. **Mounting only the branch dir breaks git.**
  - `clone`: self-standing `git clone`, own real `.git/`, self-contained — **mount-safe**.
- Hosted multi-tenant **already forbids worktree** and forces clone-only when
  `executor_storage.base_repository: unavailable` (`config/deployment.ts:398-413`, `repos.ts:659-664`).

### 1.7 Which surfaces cross the identity boundary (what a Docker backend must cover)

| Surface                  | Path                                      | Impersonates today                                    | Long-lived?   |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------- | ------------- |
| Task executor (prompt)   | `spawnExecutor`                           | insulated→exec user; strict→user                      | yes (socket)  |
| Terminal (zellij PTY)    | `spawnExecutorFireAndForget`              | insulated→exec user; strict→user                      | yes (PTY)     |
| Environment / dev-server | `spawnExecutor` (`environment.lifecycle`) | **insulated+strict only**                             | maybe (watch) |
| Files browse/read/write  | `runExecutorCommand`                      | **strict only** (+templated delegated)                | no (one-shot) |
| git clone / worktree add | executor `git.*`                          | daemon-user process; per-user _credentials_ in strict | no            |

Nothing in the daemon reads the host FS directly for these; all go through the executor. A Docker
backend that only covers "prompt tasks" leaves terminals, environment, and file ops on the old path —
acceptable for a POC, but the design must state it explicitly (see §12 non-goals).

### 1.8 Existing Docker/image/build reality

- `docker/Dockerfile` multi-stage: `base` (node:22-slim + git/zellij/gh/pnpm, **no agentic CLIs**;
  creates `agor` + unprivileged `agor_executor` users), `development` (`agor-dev`), `production`,
  `production-source` (**what CI ships**, `agor-live` bundle = daemon+cli+executor+core+ui), `…-ha`.
  **No `agor-executor` image stage exists.** The executor is bundled inside `agor-live`.
- `ghcr.io/preset-io/agor-executor:latest` appears **only** in config docstrings + `containerized-execution.mdx`
  — aspirational, no build recipe, no k8s/helm manifests in-repo.
- CI (`.github/workflows/build-image.yml`) builds **`linux/amd64` only** (no multi-arch); Zellij + `gh`
  are pinned to x86_64.
- `docker-compose.override.yml:27-29` sets `apparmor=unconfined, seccomp=unconfined`
  **because Codex uses a nested user-namespace sandbox** — locking down the executor container can
  break Codex's own sandbox. **Real constraint.**
- Managed agentic tools: `agor install [--sync]` pins `@agor-live/<tool>@<agorVersion>` into
  `~/.agor/agentic-tools/<version>/<tool>/` (`agentic-integrations.ts`, `apps/agor-cli/src/commands/install.ts`);
  `AGOR_MANAGED_AGENTIC_TOOLS=1` selects managed vs workspace SDKs. This is the reproducible mechanism
  for baking pinned CLIs into an executor image.
- `.agor.yml` environment variants (`ha`, `docs`, `full`, `sqlite`, …) are **docker-compose commands that
  containerize _Agor-under-development_** — a different axis from Agor's own executor substrate (see §7).

---

## 2. Conceptual boundary: is `docker` a unix mode, a backend, or both?

**It is an execution backend/topology, orthogonal to identity policy.** Agor's own type system
already encodes this separation:

- **Identity ("who runs")** → `unix_user_mode` + `reportedUnixUser`.
- **Substrate ("where/how it runs")** → `executor_command_template` + `executor_storage`
  (an explicit "operator assertion about the execution substrate, not a mount instruction" —
  `types.ts:507-514`).

Folding Docker into `unix_user_mode` (as a fifth value) would **conflate the two axes** and produce
contradictions: What identity does `docker` mode run as? Does `docker` imply per-user, shared-executor,
or daemon identity inside the container? Can you have "docker + strict per-user" vs "docker + shared"?
The moment you ask these, you have re-derived the two-axis model — so keep them separate.

**Recommended placement (naming):** introduce an explicit **executor backend selector**, e.g.

```yaml
execution:
  executor_backend: local # local (default) | docker | template
  unix_user_mode: delegated # identity axis — unchanged
  docker: # backend-specific block, only read when backend=docker
    image: ghcr.io/preset-io/agor-executor:<pinned>
    # …mounts, network, limits (see §4, §7)
```

- `local` = today's `spawnExecutorLocal`.
- `template` = today's `executor_command_template` (unchanged; the generic hosted/k8s hook).
- `docker` = **new first-class local backend** (typed Docker Engine API, no `sh -c`), which is
  effectively a safe, well-contained, batteries-included _specialization of `template`_ for a single
  host with a local Docker daemon.

Identity inside the container is derived from the identity axis: `--user <uid>:<gid>` from
`reportedUnixUser` (via `getUidGidFromUsername`) when the mode supplies one; daemon-uid otherwise.
So the supported combinations are `docker + simple` (container as daemon uid — still a strong
sandbox), `docker + delegated` (container as per-user uid, no host accounts needed — **the sweet spot**),
and `docker + strict/insulated` (container as the host account uid, redundant with Docker's own boundary).

---

## 3. Feasibility of preserving the executor protocol

| Concern                             | Verdict             | Notes / required work                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stdin payload delivery**          | ✅ works            | `docker run -i` + write JSON to container stdin, close (same as `--stdin` today). Keeps secrets out of argv/`docker inspect`.                                                                                                                                                                                                                                                                                                      |
| **stdout sentinel + flush**         | ⚠️ verify           | `AGOR_EXECUTOR_RESULT ` flows through docker's stdout proxy. The #2222 "settle on close" fix must still hold with docker's stream teardown. Needs a runtime smoke test (feasible; §13).                                                                                                                                                                                                                                            |
| **Socket.IO callback base URL**     | ⚠️ **blocker-ish**  | Container must reach daemon. `localhost` fallback is wrong inside a container. Required: set `DAEMON_URL` to a container-reachable value — `http://host.docker.internal:PORT` with `--add-host=host.docker.internal:host-gateway` (Linux ≥ engine 20.10; confirmed engine 29.3.1 here), or `--network=host` (Linux only, weakens isolation), or bind daemon to a known bridge IP. Daemon must compute and inject this per-backend. |
| **task-scoped JWT**                 | ✅ works            | Already in stdin payload; unaffected by substrate. Container reaches daemon over the same authenticated Socket.IO.                                                                                                                                                                                                                                                                                                                 |
| **long-lived zellij.attach**        | ✅ feasible         | Long-lived container with `-i`; PTY stays inside; terminal room over Socket.IO. But adds a per-terminal container lifecycle + the host-reachability + owner-affinity constraints from [[web-terminal-ownership-ha]]. Recommend **deferring terminals** to a later phase.                                                                                                                                                           |
| **Stop/Abort + evidence**           | ⚠️ **primary work** | New container-lifecycle containment interface (§1.5). Cooperative abort still works over Socket.IO; fallback becomes `docker kill` + `docker inspect` evidence; fence records container id.                                                                                                                                                                                                                                        |
| **exit codes / signals / timeouts** | ⚠️                  | `docker run` propagates container exit code (128+signal on kill). `executor_command_nonzero_may_have_dispatched` semantics apply (a failed `docker run` may still have connected back). Timeouts unchanged (heartbeat reconciler).                                                                                                                                                                                                 |
| **daemon restart / orphans**        | ⚠️                  | Orphan reaping must enumerate containers by **label** (`agor.task_id`, `agor.tenant_id`, `agor.daemon_boot_id`) via `docker ps --filter label=…`, not pgid. Restart reconciliation lists labeled containers and cross-checks the DB.                                                                                                                                                                                               |
| **concurrent tasks**                | ✅                  | Per-session single-flight is unchanged (DB dispatch claim). N sessions → N containers. Need a concurrency cap + resource limits (§10).                                                                                                                                                                                                                                                                                             |
| **idempotent cleanup**              | ✅ w/ care          | `docker rm -f` is idempotent; `--rm` for one-shot; reconciler sweeps orphaned labeled containers.                                                                                                                                                                                                                                                                                                                                  |

**Net:** protocol preservation is **feasible**, with two must-solve items (daemon URL reachability,
container containment) and one verify item (stdout flush). None are blockers to a POC; all are
blockers to production.

---

## 4. Mounts & identity (least authority)

Design principle: **mount the least, require clone storage, never mount the base repo, never mount `~/.agor`.**

| Mount                                         | Recommendation                                                                                                     | Rationale                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Branch working dir**                        | `-v <branchPath>:<branchPath>:rw` (path-identical so DB-recorded paths + git internals resolve)                    | The one thing the agent must write.                                                                                                                                                                                                                                            |
| **Base repo (`~/.agor/repos`)**               | **Do not mount.** Require `storage_mode=clone`.                                                                    | Worktree `.git` pointer escapes the mount (§1.6); mounting the base repo exposes _all_ branches' objects/config → cross-branch/tenant disclosure. Clone mode is self-contained. Reuse the existing `base_repository: unavailable` → clone-only gate (`deployment.ts:398-413`). |
| **User home**                                 | Per-user named volume mounted at container `$HOME` (e.g. `agor_home_<uid>` → `/home/agor`), **not** the host home. | Persists tool caches/creds per user without exposing host `~/.agor/config.yaml`, `agor.db`, JWT secret. Matches `executor_storage.user_home: persistent-per-user`.                                                                                                             |
| **`~/.agor/config.yaml`, `agor.db`, secrets** | **Never mount.**                                                                                                   | These are the daemon's trust root. Executor gets credentials via env-file/token, not the config file.                                                                                                                                                                          |
| **Managed agentic tools**                     | Baked into the image (preferred) _or_ mounted read-only from `~/.agor/agentic-tools/<version>`                     | Baking = reproducible + offline; mounting = smaller image but couples host layout + version drift. Prefer bake with pinned version (§7).                                                                                                                                       |
| **`/tmp`, workdir**                           | container-private `tmpfs` for `/tmp`; cwd = branch mount                                                           | Least authority; no host `/tmp` sharing.                                                                                                                                                                                                                                       |
| **SSH agent / git creds / sockets**           | **Opt-in only**, never by default                                                                                  | Forwarding `SSH_AUTH_SOCK` into a container running hostile agent output is a credential-exfil vector. Prefer per-user git credentials injected via the existing secret-env-file mechanism, scoped to the task.                                                                |

**Identity / UID-GID:**

- `--user <uid>:<gid>` from `reportedUnixUser` when the identity axis supplies one; else daemon uid
  (still isolated by the container). Add `git config --global --add safe.directory <branchPath>` in the
  entrypoint (mount owner uid may differ from container uid).
- **Rootless Docker / Podman:** user-namespace remapping changes on-disk ownership of volumes; the
  per-user named-volume approach tolerates this better than host bind mounts. Document rootless as a
  supported-but-different ownership model.
- **macOS/Windows (Docker Desktop):** bind-mount performance + uid mapping differ; `host.docker.internal`
  works natively (no `--add-host` needed); `--network=host` is unavailable. Path-identical mounts still work.

**Answer to "must the base repo be mounted?": No — require clone storage and it is never needed.**
This is also the mode hosted already mandates, so it aligns Cloud and local.

---

## 5. Threat model

**What Docker improves over `strict`:**

- **Kernel-namespace isolation** (pid/mount/net/ipc/uts) + cgroup resource limits — strictly stronger
  than `sudo -u` process separation. A compromised agent can't see host processes, other tenants'
  mounts, or the daemon's files even if it escapes the intended cwd.
- **No host Unix account per user, no sudoers, no password sync** (§11) — removes an entire class of
  misconfiguration/privilege-escalation surface that `strict`/`insulated` carry.
- **Blast-radius containment**: fork bombs / disk fills are bounded by `--pids-limit`, `--memory`,
  `--cpus`, `--storage-opt`.

**What Docker does _not_ improve, or worsens:**

- **The Docker socket is root-equivalent.** The daemon (or whatever runs `docker`) gains
  root-equivalent authority on the host. If the _daemon_ is the thing calling Docker, a daemon
  compromise → host root. This is a **net-new escalation path** vs `simple`. Mitigations: rootless
  Docker/Podman; a narrow broker; never mount `/var/run/docker.sock` **into** the executor container.
- **Image trust / supply chain**: must pin **immutable digests** (`@sha256:…`), `--pull=never` after a
  verified pull, and treat the image as part of the release. A mutable `:latest` tag is a supply-chain
  hole.
- **Secrets exposure**: keep secrets out of `-e` flags and argv (visible in `docker inspect` / `ps`).
  Deliver via **stdin payload** (already how env is passed) or an in-container env-file; the task JWT
  stays in stdin.
- **Network policy**: default `--network` bridge + egress is wide open. Container reaching the daemon
  must not also mean the agent can reach the daemon's _other_ ports or the metadata endpoint
  (169.254.169.254). Consider an egress allowlist and blocking link-local.
- **Codex sandbox interaction**: Codex's nested user-namespace sandbox needs relaxed seccomp/apparmor
  (`compose.override`). Running Codex inside a locked-down executor container may require
  `--security-opt seccomp=…` tuned per tool — a correctness _and_ security tension to resolve per tool.
- **Privilege flags**: **never** `--privileged`, add `--no-new-privileges`, drop all caps
  (`--cap-drop=ALL`), read-only rootfs where possible, no extra devices.

**Verdict:** **Docker-per-task is a stronger sandbox than `strict` for the agent-escape threat**, _if and
only if_ (a) the Docker control plane is not itself reachable from the agent, (b) images are
digest-pinned, (c) no base-repo/host-home/daemon-config mounts, and (d) the daemon→Docker authority is
acknowledged and, ideally, rootless. Under the daemon-calls-rootful-Docker deployment, it _adds_ a
daemon→host-root escalation path that `simple` lacks — so it improves the _agent_ threat while shifting
the _daemon-compromise_ threat. That trade-off must be stated to operators.

---

## 6. Implementation strategies compared

| #   | Strategy                                                                                                         | Shell interp?                     | Containment fidelity                                        | Verdict                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| A   | Direct `docker run --rm` via `sh -c`                                                                             | ❌ **yes** (argv building)        | poor (pgid of `docker` client ≠ container)                  | reject — interpolation + weak Stop                      |
| B   | **Docker Engine API** (dockerode / raw `/var/run/docker.sock` HTTP) — typed create/start/attach/wait/kill/remove | ✅ none                           | **best** (explicit container id, `wait`, `inspect`, `kill`) | **recommend**                                           |
| C   | Shipped **non-interpolating wrapper** invoked via `executor_command_template`                                    | ✅ if wrapper takes JSON on stdin | medium (still spawns a client process)                      | acceptable fallback / reuses existing path              |
| D   | Docker Compose                                                                                                   | ❌                                | poor (compose lifecycle mismatch per-task)                  | reject for per-task                                     |
| E   | Rootless **Podman/containerd**                                                                                   | ✅ (API)                          | good                                                        | **support as a variant of B** (better security posture) |
| F   | Existing `executor_command_template` as-is                                                                       | ❌ (`sh -c`)                      | weak (already relaxed)                                      | keep for k8s/hosted; **not** the local UX               |

**Recommendation: Strategy B (typed Docker Engine API) behind the `spawn-executor.ts` seam**, with the
same code path abstracted so **E (Podman)** is a drop-in (both speak the Docker API). This gives:
no shell interpolation, a real container id for first-class containment, `inspect`-based termination
evidence, and label-based orphan reaping. Keep **C/F** available for k8s/hosted (unchanged). The new
backend is essentially "what a careful operator would put in `executor_command_template`, but typed,
contained, and shipped."

Dependency note: adding a Docker API client (dockerode or a thin fetch-over-socket) is the only new
runtime dependency; it lives daemon-side only, never in the executor.

---

## 7. Image strategy

**Must be in the image:** node runtime matching the executor, the **executor bundle** (same version as
daemon — mixed versions unsupported, `containerized-execution.mdx:1046`), git, ripgrep, the managed
agentic CLIs (claude/codex/gemini/opencode/…), zellij (only if terminals are in scope), CA certs.

**Agentic tools — bake, don't mount (recommended):** run `agor install --sync` at image build with
`AGOR_MANAGED_AGENTIC_TOOLS=1` and a pinned `AGOR_VERSION`, producing
`~/.agor/agentic-tools/<version>/…` inside the image. Reproducible, offline-capable, version-aligned by
construction. Mounting from the host coupling is the fallback for air-gapped/self-hosted who pre-populate.

**Version alignment:** the image tag must encode the Agor release; daemon refuses to launch a Docker
backend whose image digest/version label ≠ its own (a `doctor`/startup check). This mirrors the managed-tool
version pinning already in place.

**Multi-arch:** current CI is amd64-only; Docker Desktop on Apple Silicon needs arm64. Requires `buildx`
multi-platform + arch-aware zellij/`gh` fetches. **Scope decision for Max** (amd64-only POC is fine).

**Config schema & validation (backend block):**

```yaml
execution:
  executor_backend: docker
  docker:
    image: ghcr.io/preset-io/agor-executor@sha256:<digest> # digest required in prod
    pull_policy: missing # never | missing | always
    network: host-gateway # host-gateway | host | <named>
    home_volume: persistent-per-user
    resources: { memory: 2g, cpus: 2, pids_limit: 512 }
    security: { no_new_privileges: true, cap_drop: [ALL], read_only_rootfs: false }
    extra_mounts: [] # opt-in, validated, never base repo / ~/.agor
```

Validation: refuse `worktree` storage; refuse secrets in `extra_mounts`/`-e`; require digest in
non-dev; verify image version label == daemon version; probe Docker reachability at startup.

**Doctor/readiness:** extend `agor doctor` with: docker daemon reachable, image present + version match,
`host.docker.internal` resolvable from a throwaway container, a round-trip smoke (spawn container →
Socket.IO connect → sentinel → clean exit).

**Should a repo `.agor.yml` `start` command ever build this image?** **No.** That conflates the
_application-under-development environment_ (what `.agor.yml` variants are — they run the app-under-test
in compose) with _Agor's execution substrate_ (a platform concern). The executor image is a platform
artifact built by Agor's release pipeline / `agor doctor --build`, not by a branch's environment lifecycle.
A `docker` **`.agor.yml` variant** is still fine and useful (for dev-environments), but it is a _different
thing_ from `executor_backend: docker` and the doc should keep the names distinct to avoid exactly this
confusion.

---

## 8. Compatibility matrix

| Deployment                             | Docker backend?         | Notes                                                                                                                                      |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux native Docker (rootful)          | ✅ primary              | `--add-host=host.docker.internal:host-gateway`; acknowledge daemon→host-root authority                                                     |
| Docker Desktop macOS/Windows/WSL       | ✅ (dev)                | `host.docker.internal` native; no `--network=host`; bind-mount perf caveats; needs arm64 image on Apple Silicon                            |
| Rootless Docker / Podman               | ✅ preferred security   | uid remap changes volume ownership; per-user named volumes tolerate it; Podman via same API (Strategy E)                                   |
| Self-hosted single daemon              | ✅                      | the target sweet spot; replaces `strict`/`insulated` for most                                                                              |
| Local HA / same host (`shared-local`)  | ⚠️                      | container labels must include `daemon_boot_id`; owner-affine terminal rules from [[web-terminal-ownership-ha]] still apply                 |
| Multi-host HA                          | ❌ (use `template`/k8s) | local Docker daemon is single-host; this is the k8s `executor_command_template` domain                                                     |
| Agor Cloud k8s                         | ➖ orthogonal           | Cloud uses `template` (kubectl), not local Docker; but the **image** and **containment interface** are shared, so this work de-risks Cloud |
| Managed private cloud                  | ➖                      | as k8s                                                                                                                                     |
| Web terminal & branch Files            | ⚠️ deferred             | terminals long-lived + owner-affine; Files one-shot; both later phases                                                                     |
| Migration from simple/delegated/strict | ✅ smooth via delegated | `docker + delegated` needs only `unix_username` per user (already required by delegated), **no host accounts**                             |

---

## 9. Persistence & lifecycle

- **User home**: per-user named volume; cleanup on user delete (tenant-scoped). Never the host home.
- **Container lifetime**: **one-shot per task** (`--rm`) for prompt tasks — cleanest isolation, matches
  "ephemeral" recommendation in [[executor-isolation]] Q1 and the fire-and-forget model. Terminals (later)
  are long-lived by nature.
- **Caches**: survive in the per-user home volume (npm, tool caches) — the perf mitigation for cold starts.
- **Branch archive/delete while a container runs**: the reconciler + label sweep must `docker rm -f`
  containers for a deleted branch; DB terminal-state immutability (from [[task-runtime-state]]) prevents a
  late container from reviving a task.
- **Multiple sessions/tasks on one branch**: N containers sharing the branch mount rw — same-branch write
  concurrency is already bounded by per-session single-flight, but two sessions on one branch could still
  race on files (true today too; not worsened).
- **Audit/observability**: container labels + `docker events` give a clean audit trail; add container id
  to task telemetry; `agor doctor` reports orphaned labeled containers.

---

## 10. Performance

- **Cold start**: image pull is the tail risk — mitigate with `pull_policy: missing` + digest pin +
  pre-pull at daemon startup/`doctor`. Warm container create/start is ~100-500ms (acceptable vs current
  sub-100ms local spawn; comparable to the `sudo -u` path's overhead).
- **Per-task container**: create+start+attach+wait+rm overhead per prompt. For chatty one-shot commands
  (git/file probes) this is **too heavy** — keep one-shot commands on the local path initially, or use a
  warm per-branch/per-user container that one-shots exec into (later optimization).
- **Disk amplification**: overlay2 layers + per-user home volumes. Cap with `--storage-opt` and volume
  quotas; document expected footprint.
- **Socket/stdout overhead**: unchanged protocol; one extra network hop via host-gateway (negligible on
  loopback/bridge).
- **Practical defaults**: `memory: 2g`, `cpus: 2`, `pids_limit: 512`, concurrency cap = min(CPU-2, N);
  reject new containers past the cap (queue, don't thrash).

---

## 11. How we got here (why strict/insulated exist) & what Docker could delete

From [[executor-expansion]], [[daemon-fs-decoupling]], [[rbac-and-unix-isolation]], [[env-var-access]],
[[git-remote-credential-spillover]], [[web-terminal-ownership-ha]]:

**Why strict/insulated exist:** credential isolation (one session must not read another's API keys /
env / SSH), per-user OS identity + auditability (`ps` shows the real owner), filesystem protection via
per-branch groups, and git-credential spillover containment. These are real multi-tenant requirements
that `simple` cannot meet.

**Known pain of strict/insulated:** sudoers management (one bad rule = escalation), per-user Unix account
provisioning (manual `ensure-user`), password sync, home-dir ownership/chown dance, per-branch group
lifecycle/cleanup, and — decisively — **they do not scale horizontally**: PTYs/Zellij are owner-local,
and the ACL/watch coordination wall means multi-pod shared-FS is unsupported ([[daemon-fs-decoupling]],
[[web-terminal-ownership-ha]]).

**Cloud direction:** already containers — `executor_command_template` (kubectl), ephemeral per-task
executor pods, `runAsUser/fsGroup` from `{unix_user_uid/gid}`, `delegated` mode handing identity to the
substrate, clone-only storage, daemon trending FS-free. **The local Docker backend is the single-host
sibling of the Cloud pod model** — same image, same containment interface, same clone-only assumption.

**What a Docker backend lets Agor delete later (for deployments that adopt it):** host Unix account
provisioning, the sudoers file, password sync, per-branch Unix groups, and the `sudo -u` + secret-env-file
machinery — replaced by `--user uid:gid` + kernel namespaces. **What it does NOT replace:** app-layer RBAC,
credential _scoping_ (env-resolver per-tool isolation), git-config scrubbing, the task JWT, the
Stop/heartbeat/containment _contract_ (only its enforcement mechanism changes), and identity itself
(`delegated` still needs `unix_username`).

---

## 12. Recommended phased plan

**POC (smallest provable slice).** `executor_backend: docker` for **prompt tasks only**, **clone storage
only**, `docker + simple` (container as daemon uid) or `docker + delegated` (container as `--user uid:gid`).
Strategy B (Docker Engine API). Branch mount + per-user home volume; no base repo, no host home, no
`~/.agor`. `host.docker.internal` daemon URL. Container-lifecycle containment (`kill`+`inspect`+label
fence). One-shot commands, terminals, environment, Files **stay on the local path**.
**Success criteria:** spawn → Socket.IO connect → stream a real Claude/Codex turn → cooperative Stop →
verified `docker inspect` absence → task terminal; orphan container reaped after daemon restart; no secret
in `docker inspect`; a hostile prompt cannot read `~/.agor/config.yaml` or another branch.

**Phase 1 — config & types:** `executor_backend` selector + `docker` block + validation (clone-only,
digest-required-in-prod, version-match). No behavior change when `local`.

**Phase 2 — launcher & containment interface:** typed Docker backend behind `spawn-executor.ts`; new
`ContainmentStrategy` abstraction (process-group vs container) so `executor-tracking.ts` /
`termination-coordinator.ts` / fences are substrate-agnostic; reconciler learns label sweeps.

**Phase 3 — image + doctor:** new `executor` Dockerfile target (bundle + `agor install --sync` pinned),
release-pipeline build, `agor doctor` reachability/version/round-trip checks. (Multi-arch = optional.)

**Phase 4 — tests & dev environment:** unit/contract tests for the containment strategy; a runtime smoke
(spawn a real container, assert sentinel + Socket.IO + Stop); a **dev harness** to exercise it locally —
note this is Agor's substrate, so it's a `config.yaml`/`agor doctor --build` affordance, _not_ a
`.agor.yml` variant.

**Phase 5 — coverage expansion (separate decisions):** one-shot commands (warm exec vs per-call), Files,
environment lifecycle, then terminals (long-lived + owner-affinity per [[web-terminal-ownership-ha]]).

**Explicit non-goals (v1):** multi-host HA (that's k8s `template`); replacing k8s `executor_command_template`;
terminals/Files/environment through Docker; worktree storage; network egress policy (Phase 5+);
non-Docker runtimes beyond "Podman should drop into Strategy B."

**Likely file-level change map (no code here):**

- `packages/core/src/config/types.ts` — `executor_backend`, `AgorDockerBackendSettings`.
- `packages/core/src/config/config-manager.ts` / `deployment.ts` — resolve backend; clone-only + version + reachability validation.
- `apps/agor-daemon/src/utils/spawn-executor.ts` — backend fork (`local`/`docker`/`template`); daemon-URL-for-container computation; label + stdin plumbing.
- **new** `apps/agor-daemon/src/executor-backends/docker.ts` — typed Engine-API create/start/attach/wait/kill/remove.
- `apps/agor-daemon/src/executor-tracking.ts` + `termination-coordinator.ts` — `ContainmentStrategy` interface; container-inspect evidence; container-id fences.
- `apps/agor-daemon/src/services/task-runtime-reconciler.ts` — label-based orphan sweep.
- `packages/core/src/unix/id-lookups.ts` — reuse/extend `getUidGidFromUsername`.
- **new** `docker/executor.Dockerfile` + release pipeline entry; `agor doctor` checks in CLI.
- Docs: fold into `apps/agor-docs/content/guide/containerized-execution.mdx` (local-Docker section), not a new concept page.

---

## 13. Local Docker capability probe (read-only, performed)

- Engine **29.3.1**, API 1.54, **rootful**, overlay2, cgroup v2 (systemd), `linux/amd64`, Debian 12.
- `host-gateway` add-host is supported on this engine (≥ 20.10) → `host.docker.internal` viable on Linux.
- Existing images include `agor-dev` (4.78GB), plus externally-built `agor-executor:review-1` and
  `agor-cloud-executor-*` (~1.93GB) — **not defined in this repo** (no Dockerfile/CI builds them), so a
  cloud-side executor image already exists out-of-tree; an in-repo build recipe is the gap.
- Did **not** start privileged containers, alter global Docker state, or build images.

---

## 14. Recommendation

**Proceed — but as a first-class local executor _backend_ on the existing substrate axis, not as a fifth
`unix_user_mode`.** Rationale: it composes cleanly with the identity model Agor already has (`delegated`
consumes it perfectly), it is the single-host sibling of the Cloud pod direction (shared image + shared
containment interface → de-risks Cloud), and it can _delete_ the sudoers/host-account/password-sync/
per-branch-group complexity for deployments that adopt it, while preserving RBAC, credential scoping, the
task JWT, and the Stop/heartbeat contract. For the **agent-escape** threat it is a stronger sandbox than
`strict`.

Recommend a **narrow POC** (prompt tasks, clone-only, `docker + delegated`, Engine API, one-shot/terminals
left on the local path) before committing to the containment-interface refactor.

**Blockers / open decisions for Max:**

1. **Docker authority model.** Is the _daemon_ allowed to hold root-equivalent Docker access (rootful),
   or must this be rootless/Podman or a brokered control plane? This decides the security story and §5's verdict.
2. **Containment interface refactor.** Are we willing to abstract `executor-tracking`/fences into a
   substrate-agnostic `ContainmentStrategy`? Without it, Stop correctness for containers is not achievable.
   (This is the biggest engineering item.)
3. **Storage.** Accept **clone-only** for Docker mode (no base-repo mount)? (Strongly recommended;
   already hosted's rule.)
4. **Image ownership.** Does the executor image become a **release artifact** (built + digest-pinned +
   version-gated by Agor's pipeline)? Multi-arch now or amd64-only POC?
5. **Codex-in-container.** Accept per-tool seccomp/apparmor relaxations for Codex's nested sandbox, or
   scope the POC to Claude first?
6. **Scope of coverage.** Is "prompt tasks only" an acceptable v1, with terminals/Files/environment
   explicitly deferred (and thus a _mixed_ substrate during migration)?

**When to defer instead:** if the answer to (1) is "the daemon must never touch Docker" and no rootless/
broker path is acceptable, or if the containment-interface refactor (2) can't be funded, then **defer** and
keep pushing the `executor_command_template` (k8s/hosted) path — the local ergonomics aren't worth a
half-contained Stop.

**When to just use the existing template:** operators who already run k8s/hosted should use
`executor_command_template` today (it works, with the known weaker-containment caveats); the Docker backend
is specifically to give **self-hosted single-host** users container isolation without hand-writing a template
or provisioning host Unix accounts.
