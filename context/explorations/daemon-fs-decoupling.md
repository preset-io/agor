# Daemon Filesystem Decoupling

**Status:** 🔬 Exploration / design. **Phase 1A (config hygiene, §1.5) is shipping in this PR** (H1–H4). Phase 1B and Phases 2–4 are still position-paper. **H5 (CLI config separation) is split to a follow-up worktree** to keep Phase 1A focused and reviewable.
**Created:** 2026-05-16
**Companion exploration docs:** [`executor-expansion.md`](./executor-expansion.md), [`executor-isolation.md`](./executor-isolation.md), and the user-facing [`containerized-execution`](../../apps/agor-docs/pages/guide/containerized-execution.mdx) guide.

---

## TL;DR

**The daemon is much closer to FS-free than the prompt assumed, but the gap is concentrated in three places that all reduce to the same root: the daemon believes it shares a filesystem with the worktrees it manages.** That belief is encoded in (a) artifact landing, (b) upload handling, and (c) environment spawning — the third being the one that hits the ACL/`--watch` wall.

**Recommended target: Option D — a hybrid where the daemon stays single-host FS-coupled for self-hosted / `unix_user_mode: simple`, and becomes FS-free in hosted multi-tenant deployments by treating worktrees as remote resources owned by per-worktree executor pods.** Local watch-mode envs survive in self-hosted (single host, single uid namespace) and are explicitly _not supported_ on hosted — long-lived watch envs in hosted become **remote env pods that share the worktree volume with the executor, not with the daemon**. This avoids the ACL coordination problem Max already hit, keeps the self-hosted UX intact, and gives hosted a clean horizontal scale story.

**Estimated to v1 of hosted-ready posture: ~15 eng-weeks**, with the easy slice (config hygiene + Postgres-only + log centralization + artifact-via-executor + upload-via-executor) ~4–5 weeks, and the hard slice (env-pod model, executor-as-volume-owner) ~10 weeks.

**Phase 1A — Config hygiene — shipped in this PR (H1–H4).** Daemon stays the only authority on `~/.agor/config.yaml`; executor stops reading it directly (resolved-slice payload); shutdown sentinel + secret bootstrap degrade gracefully on read-only mounts (capability-driven, no deployment-mode flag). H5 (CLI config separation) is split to a follow-up worktree. See §1.5.

---

## 1. Today's reality

### 1.1 Daemon FS touchpoint inventory

The daemon process (only `apps/agor-daemon/src/**`) directly touches the FS in the following places. **Touchpoint count: ~35 distinct call sites, in ~13 files.**

#### Config + secrets

| Touchpoint                                       | R/W | Frequency                | File:line                                                              | Decoupling path                                                                                                                                            |
| ------------------------------------------------ | --- | ------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.agor/config.yaml` (load)                     | R   | startup-once             | `index.ts:135-139` via `packages/core/src/config/config-manager.ts:60` | Already mostly env-overrideable (`AGOR_HOME`, `AGOR_DATA_HOME`, `PORT`, etc.). For hosted: load from env + ConfigMap / DB-backed Config service. **Easy.** |
| `~/.agor/config.yaml` (write JWT secret)         | W   | startup-once if absent   | `index.ts:502-506`                                                     | Persist in DB (`auth_state` row) or require operator-provided secret in hosted.                                                                            |
| `~/.agor/config.yaml` (write AGOR_MASTER_SECRET) | W   | startup-once if absent   | `startup.ts:329`                                                       | Same.                                                                                                                                                      |
| `~/.agor/admin-credentials`                      | W   | first-run-once           | `setup/first-run-admin.ts:67`                                          | Stdout/log in hosted; no file.                                                                                                                             |
| `~/.agor/daemon-shutdown-clean.flag` (sentinel)  | R/W | shutdown + startup       | `startup.ts:57-83`                                                     | DB row (`daemon_runs`) or drop the feature in containers (k8s restart counts are already known).                                                           |
| Auth file (used by check-auth)                   | R   | per-request rate-limited | `services/check-auth.ts:128`                                           | Mostly already DB-driven; this is a fallback path — fine in simple mode, irrelevant in hosted.                                                             |

#### Database (SQLite file mode)

| Touchpoint        | R/W | Frequency     | File:line                                                           | Decoupling path                                                                                                |
| ----------------- | --- | ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `~/.agor/agor.db` | R/W | every request | `setup/database.ts:31-127` via `packages/core/src/db/client.ts:286` | **Already solved.** Postgres path exists today (`packages/core/src/db/client.ts:293`). Hosted = Postgres-only. |

#### UI / build artifacts (read-only, optional)

| Touchpoint                      | R/W  | Frequency    | File:line                   | Decoupling path                                                                                                                   |
| ------------------------------- | ---- | ------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| UI bundle `dist/ui/` existsSync | R    | startup-once | `index.ts:425-456`          | Don't ship the UI from the daemon in hosted — serve via separate static host (Cloudfront, Vercel, etc.). Already a planned split. |
| Static assets                   | R    | startup-once | `index.ts:462-469`          | Same.                                                                                                                             |
| `.build-info`                   | R    | startup-once | `setup/build-info.ts:53-65` | Inject as env var at image build.                                                                                                 |
| `git rev-parse --short HEAD`    | exec | startup-once | `setup/build-info.ts:73`    | Same — env var.                                                                                                                   |

#### Repo + worktree directories (the big ones)

| Touchpoint                                                        | R/W | Frequency                       | File:line                                                                                                 | Decoupling path                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | --- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.agor/repos/<slug>/` existsSync, isValidGitRepo, listWorktrees | R   | per-request                     | `services/repos.ts:238, 489, 641, 701, 713`                                                               | These reads exist to **orient before delegating to executor**. In a daemon-FS-free world, the orient step needs to become an executor probe (`git.repo.inspect`) or come from cached DB state.                                      |
| `~/.agor/repos/<slug>/.git/config` (realign origin)               | W   | per-request                     | `utils/realign-repo-origin.ts:31`                                                                         | Already small — move to executor (`git.repo.realign-origin`). One day.                                                                                                                                                              |
| `~/.agor/worktrees/<r>/<wt>/` existsSync                          | R   | per-request                     | `services/worktrees.ts:706`, `services/repos.ts:701`, `services/zone-trigger.ts:87-89`                    | Replace with `worktree.filesystem_status` cached in DB, refreshed by executor probe. Today this is already partly done — PR #1109 added "FS-drift detection" but it's still daemon-side.                                            |
| `~/.agor/worktrees/<r>/<wt>/` git state read                      | R   | per-task creation               | `mcp/tools/sessions.ts:775-777`, `services/zone-trigger.ts:87-89` (`getGitState()`, `getCurrentBranch()`) | Snapshot SHA/ref. Move to executor probe or cache in DB at create/refresh time.                                                                                                                                                     |
| Worktree dir contents (`git ls-files`)                            | R   | per-request (file autocomplete) | `services/files.ts:73-84`                                                                                 | `services/files.ts` runs `git ls-files` in-process via simple-git. Tiny op, but it's the daemon-touches-worktree pattern. Route through executor (`worktree.files.list`).                                                           |
| Worktree dir cleanup                                              | W   | per-delete                      | `services/repos.ts:1098-1142`                                                                             | Already executor-routed for `git.worktree.remove`; the `deleteRepoDirectory` path uses `fs.rm` via core helpers — already done as `sudo -u` shell wrapper, but the entry point is daemon-side. Move into executor as `repo.delete`. |

#### Artifacts (the surprise — pure daemon FS writes)

| Touchpoint                                                                       | R/W | Frequency     | File:line                         | Decoupling path                                                                                                   |
| -------------------------------------------------------------------------------- | --- | ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `<worktree>/.agor/artifacts/<name>/agor.artifact.json` sidecar read              | R   | per-request   | `services/artifacts.ts:172-200`   | Cache sidecar metadata in DB; if missing, executor probe.                                                         |
| `<worktree>/.agor/artifacts/<name>/` recursive land (mkdir + writeFile per file) | W   | per-land      | `services/artifacts.ts:717-812`   | **Pure FS write done in-daemon-process.** Move to executor as `artifact.land(artifactId, worktreePath, subpath)`. |
| `<worktree>/.agor/artifacts/<name>/` rm                                          | W   | per-overwrite | `services/artifacts.ts:775`       | Same — executor.                                                                                                  |
| Recursive readdir of artifact folder (introspection)                             | R   | per-request   | `services/artifacts.ts:1758-1794` | Same — executor probe.                                                                                            |

#### Uploads

| Touchpoint                                                                          | R/W | Frequency  | File:line                 | Decoupling path                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --- | ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<worktree>/.agor/uploads/`, `/tmp/agor-uploads/`, `~/.agor/uploads/` mkdir + write | W   | per-upload | `utils/upload.ts:118-260` | Either move write into executor, or stage to S3 / object store and have executor pull on demand. Easier for hosted: **object store from day one**. |

#### Terminals

| Touchpoint                                             | R/W  | Frequency    | File:line                       | Decoupling path                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---- | ------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tmp/agor-env-<userId>.sh` writeFileSync + sudo chown | W    | per-attach   | `services/terminals.ts:104-119` | Move env-file creation **into the impersonating boundary** (executor / `zellij.attach` payload). Today the env file is written by the daemon (as `agorpg`) and chowned to the target user via sudo — a privileged daemon-side operation that wouldn't survive a multi-pod split. |
| `which zellij` execSync                                | exec | startup-once | `services/terminals.ts:54`      | Move check to executor health probe.                                                                                                                                                                                                                                             |

#### Other daemon→FS exec / spawn paths

| Touchpoint                    | R/W  | Frequency    | File:line                                                     | Decoupling path                                                                                                        |
| ----------------------------- | ---- | ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `spawn(executor)` from daemon | exec | per-task     | `utils/spawn-executor.ts:329-412`, `register-services.ts:787` | Already the right pattern; in hosted, the spawn becomes `kubectl run` / pod template (see `executor-expansion.md` §6). |
| `existsSync(executor binary)` | R    | startup-once | `utils/spawn-executor.ts:25, 196`                             | Replace with image-bundled binary path.                                                                                |

#### Environments (the watch-mode wall)

| Touchpoint                                                                 | R/W    | Frequency                              | File:line                                                                                        | Decoupling path                                                                                                                         |
| -------------------------------------------------------------------------- | ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnEnvironmentCommand()` — long-lived child process spawned from daemon | exec   | per-env-start; lifetime = env lifetime | `services/worktrees.ts:1013-1170` → `packages/core/src/unix/environment-command-spawn.ts:8, 231` | **In-daemon-process child process. Its uid/cwd/inotify all assume the daemon shares the worktree FS.** This is the hardest one. See §3. |
| `environment.log` write                                                    | W      | continuous                             | `services/worktrees.ts:1007` (log file path joined relative to worktree)                         | Move to executor / env-pod stdout, captured by k8s.                                                                                     |
| `process.kill(pid)` from daemon                                            | signal | per-env-stop                           | `services/worktrees.ts:1166`                                                                     | Requires daemon and env to share PID namespace — true today, not in pods. Replace with executor / env-pod RPC.                          |

### 1.2 Where the daemon already isn't FS-coupled

A material chunk of the work is done. The executor (`packages/executor/src/`) already handles 10 commands via `spawnExecutor` from `utils/spawn-executor.ts`:

| Command                  | Daemon caller                      | Status       |
| ------------------------ | ---------------------------------- | ------------ |
| `prompt` (SDK execution) | session/task creation paths        | Fully routed |
| `git.clone`              | `services/repos.ts:262`            | Fully routed |
| `git.worktree.add`       | `services/worktrees.ts:731`        | Fully routed |
| `git.worktree.remove`    | `services/worktrees.ts:477, 592`   | Fully routed |
| `git.worktree.clean`     | `services/worktrees.ts:562`        | Fully routed |
| `unix.sync-worktree`     | `register-hooks.ts:862, 891, 1926` | Fully routed |
| `unix.sync-repo`         | (inferred)                         | Fully routed |
| `unix.sync-user`         | `register-hooks.ts:1518, 1566`     | Fully routed |
| `zellij.attach`          | `services/terminals.ts:400`        | Fully routed |
| `zellij.tab`             | in-executor                        | Fully routed |

The **gap list** (operations daemon does directly today, candidates for executor):

1. **Artifact landing** (`services/artifacts.ts:717-812`) — pure FS, zero DB. Should be `executor:artifact.land`.
2. **Upload write** (`utils/upload.ts`) — pure FS. Should be either `executor:upload.stage` or punted to object store entirely.
3. **Terminal env-file write + chown** (`services/terminals.ts:104-119`) — should fold into `zellij.attach` so the impersonating side writes its own env file.
4. **Realign repo origin** (`utils/realign-repo-origin.ts`) — small, but a daemon-side `.git/config` edit. Should be `executor:git.repo.realign-origin`.
5. **`git ls-files` for file autocomplete** (`services/files.ts:73-84`) — read-only, but daemon-side. Should be `executor:worktree.files.list` (or just give up the file picker for hosted).
6. **Worktree FS-drift probes** (existsSync of `worktree.path`) — replace with `executor:worktree.probe` or a cached `filesystem_status` column.
7. **Environment lifecycle** (`spawnEnvironmentCommand`, `process.kill`, env log file) — the big one; see §3.

### 1.3 Database state

The daemon writes its own DB. SQLite via libsql today, Postgres supported via `packages/core/src/db/client.ts:293` and `schema-factory.ts:59`. **Hosted should be Postgres-only**, full stop. Then the daemon's only "filesystem dependency" for DB is the connection string — operator concern, not architectural.

### 1.4 What `executor-expansion.md` already committed to

The existing exploration doc (Max, 2025-12-17) **already articulates this exact picture** under "Target Architecture": daemon never touches `AGOR_DATA_HOME`, executor as single isolation boundary, JSON-over-stdin, `kubectl run` for remote. The `getAgorDataHome()` / `AGOR_DATA_HOME` / `paths.data_home` plumbing is **already implemented** in `packages/core/src/config/config-manager.ts:623-759`. The shell exists. The execution is partial.

What was _not_ delivered:

- Artifact + upload + env paths still daemon-FS-coupled.
- No remote-execution template surface — `spawnExecutor` is still local-only `child_process.spawn`.
- No DB-backed config service.

### 1.5 Config-system specifics (the Phase-1 scope)

The daemon FS touchpoint table treats `~/.agor/config.yaml` as one row, but the actual situation across the topology has texture worth pulling out, because **the config story is the cleanest, smallest, most landable slice of work** and is what this worktree intends to take on first.

#### Position

1. **The daemon is the only authority on config.** It loads `~/.agor/config.yaml` on first use, caches in memory, and stat-validates the file on every subsequent read (cheap; nanoseconds). `saveConfig()` invalidates the cache so writes are visible immediately.
2. **`~/.agor/config.yaml` should be readable only by the daemon user.** Other processes (executor, UI, CLI) MUST NOT read it directly.
3. **Executor and UI ask the daemon for any config they need**, via the existing Feathers connection / a small `/config-for-*` surface.
4. **CLI gets its own config**, separate from the daemon's. CLI config holds only what the CLI needs to find and authenticate against a daemon (URL + auth state from `agor login`). If no default daemon is reachable, the CLI prompts the user for the URL on first use and stores the answer.

This is the right shape regardless of which topology option (A/B/C/D) we end up with — none of these decisions depend on the env-pod question.

#### Today's reality (verified)

| Process                        | What it reads from `config.yaml` today                                                                                   | File:line                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon                         | Everything; per-request `loadConfig()` in 10+ hot paths                                                                  | `services/worktrees.ts:107,206,1639`, `services/artifacts.ts:1123,1233`, `services/terminals.ts:195,327`, `register-routes.ts:3118,3185`, `mcp/tools/proxies.ts:131,154`, `services/config.ts:62,70,153` |
| Executor                       | SDK credentials, OpenCode URL, GitHub token, git config                                                                  | `executor/handlers/sdk/claude.ts:35`, `executor/handlers/sdk/opencode.ts:56`, `executor/handlers/sdk/copilot.ts:36`, `executor/commands/git.ts:392`                                                      |
| Executor (under impersonation) | **Tries to read but fails** — mode 0600 + different uid. Daemon hand-picks credentials into env vars as a workaround     | `utils/spawn-executor.ts:265-289` ("Add DAEMON_URL to env so executor doesn't try to read config.yaml")                                                                                                  |
| CLI                            | `daemon.port` / `daemon.base_url` to find the daemon; credentials and other config via the same `loadConfig()` machinery | `packages/core/src/config/config-manager.ts:337-412` (`getDaemonUrl()`, `getDaemonBaseUrl()`)                                                                                                            |

The comment in `spawn-executor.ts:265-266` is the smoking gun: this gap is **already biting**, has already been worked around for the credentials path, but the executor still does direct disk reads everywhere else.

#### Phase-1A hygiene work — shipped in this PR

H1–H4 are landing together in this worktree. H5 (CLI config separation) is split to a follow-up worktree to keep the review surface focused.

| #      | Work item                                                                                                                                                                                                                                                         | Status     | Files touched                                                                                                                                                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H2** | **Stat-validated cache for `loadConfig()` / `loadConfigSync()`** — daemon's hot paths (10+ per request) skip the YAML re-parse when the file hasn't changed. `saveConfig()` invalidates so writes are visible on next read. Async and sync paths share the cache. | ✅ Shipped | `packages/core/src/config/config-manager.ts` (+ 6 cache tests)                                                                                                                                                                               | First because every later item benefits — `loadConfigSync()` in `spawn-executor.ts` (H1) is now negligible cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **H1** | **`resolvedConfig` payload slice — executor stops reading `config.yaml`**                                                                                                                                                                                         | ✅ Shipped | `packages/core/src/config/resolved-config-slice.ts`, `apps/agor-daemon/src/utils/build-resolved-config-slice.ts`, executor handlers + `config.ts` (env-only `getDaemonUrl`) (+ 8 contract tests in executor and daemon)                      | Daemon resolves a strict subset of `AgorConfig` (`execution.permission_timeout_ms`, `opencode.serverUrl`, `daemon.host_ip_address`) — shape lives in `@agor/core` so both producer and consumer type-check the same schema. Embeds in `BasePayloadSchema.resolvedConfig`. The executor's `getDaemonUrl()` is now env-only (no config.yaml fallback); source-level tests pin the contract. Daemon-side credential env routing in `spawn-executor.ts:270-289` is unchanged — `resolvedConfig` complements that channel, it does not replace it.                                                                                                               |
| **H4** | **Shutdown sentinel logs once and degrades silently**                                                                                                                                                                                                             | ✅ Shipped | `apps/agor-daemon/src/startup.ts`                                                                                                                                                                                                            | The write path already swallowed errors; this commit adds a single log line so operators debugging crash classification on read-only AGOR_HOME deployments have signal. Read path keeps its silent catch (correct semantics, noisy if logged).                                                                                                                                                                                                                                                                                                                                                                                                              |
| **H3** | **Capability-driven secret resolution** for `AGOR_JWT_SECRET`, `AGOR_MASTER_SECRET`, `AGOR_ADMIN_PASSWORD`                                                                                                                                                        | ✅ Shipped | `apps/agor-daemon/src/setup/persisted-secret.ts` (shared JWT+MASTER helper), `apps/agor-daemon/src/index.ts`, `apps/agor-daemon/src/startup.ts`, `apps/agor-daemon/src/setup/first-run-admin.ts` (+ 9 tests across helper + admin-bootstrap) | Order: (1) env var → use it, don't touch FS; (2) persisted value → use it; (3) path writable → generate + persist; (4) fail-fast with concrete remediation naming both the env-var and writable-config escape hatches. No mode flag. JWT secret gained env-var precedence (previously ignored). MASTER_SECRET gained fail-fast message. JWT + MASTER share `resolvePersistedSecret()`. Admin bootstrap is structurally different (factory-with-rollback inside `bootstrapFirstRunAdmin`) so it doesn't use the helper; it gained an `AGOR_ADMIN_PASSWORD` env-var path with the stderr banner pointing at the env var when no credentials file was written. |

| **H5 (split)** | **CLI gets its own config file** — `~/.agor/cli.yaml` from `agor login`; CLI stops reading the daemon's `config.yaml`; first-use prompts for URL when no default is reachable. | 📋 Follow-up worktree | `apps/agor-cli/src/`, possible refactor in `packages/core/src/config/config-manager.ts` | Most substantive item. Migration shim for existing single-host installs. Risk: CLI UX regression. Worth its own PR. |

**Phase 1A actual cost:** roughly 1.5 eng-days across the four items, including the Codex-review-driven follow-up pass that closed the `getDaemonUrl()` fallback, fixed two cache regressions (validation-bypass on the sync path and mutable shared state), and extracted the resolved-slice schema into `@agor/core` plus the persisted-secret helper into its own daemon-side module. Significantly faster than the ~5.25-day estimate because the existing code was closer to capability-driven than the analysis assumed — H4 was nearly a no-op and H1's surface was smaller than first thought.

**Order landed:** H2 → H1 → H4 → H3, then a single review-driven cleanup commit covering the cache + executor-contract + DRY items above.

#### Out of scope for Phase 1

- Moving non-config FS work (artifacts, uploads, env-spawning) to the executor — that's Phase 1 in the larger plan (§4), but **after** the config work because the executor's payload contract changes in H1 and we want one round of payload-schema churn, not two.
- Anything topology-shaped (`EnvironmentRuntime` interface, env-pods, k8s templates).
- DB-backed config service. The position above is that daemon-owns-the-file is fine; we don't need to put config in the DB.

---

## 2. The ACL/`--watch` wall

### 2.1 Precise problem statement

Take three actors:

- **Daemon** — runs as Unix user `agorpg` (or whatever `daemon.unix_user` is set to). Long-lived process.
- **Executor / agent** — spawned per-task, may impersonate user `alice` (per `strict` mode) or shared `agor_executor` (per `insulated` mode). Short-lived.
- **Env process** (e.g. `vite dev`, `nodemon`) — long-lived child, currently spawned by the **daemon** via `spawnEnvironmentCommand` from `packages/core/src/unix/environment-command-spawn.ts`. Runs as whichever user `spawnEnvironmentCommand` was told to impersonate.

All three need read+write to the same worktree dir at `$AGOR_DATA_HOME/worktrees/<repo>/<wt>/`.

**Today's scheme** (`packages/core/src/unix/group-manager.ts:185-240`):

- Worktree dir is owned by a per-worktree group `agor_wt_<id>`.
- DEFAULT POSIX ACLs (`setfacl -d -m g:agor_wt_<id>:rwX`) ensure new files inherit group write.
- Users with `others_can: all` permission are `usermod -aG`'d into the group.
- Setgid bit + ACL mask (`m::rwX`) round out the scheme.

This works **on a single host** because:

1. There is one uid namespace (kernel-shared).
2. There is one `/etc/group` (or one NSS source).
3. `setfacl` / `chown` succeed because `sudo` is available locally and one box owns the FS.

It breaks under any topology where:

1. **Daemon and env-process live in different pods.**
   The daemon's `process.kill(pid)` on `services/worktrees.ts:1166` requires shared PID namespace. The env's stdout / stderr piping back to the daemon's `environment.log` write requires the daemon to share the FS. Neither holds across pods.

2. **inotify / `chokidar` / `fsevents` don't fan out cleanly across NFS or EFS.**
   `vite --watch` watches the worktree directly. On a single host: kernel inotify → done. On EFS: events may only fire on the writer side. An agent writing from a _different_ pod via the same EFS volume may not deliver inotify events to the env pod. Vite's `usePolling: true` fallback works but burns CPU.

3. **uid/gid locality.**
   uid 1001 inside pod A is not the same human as uid 1001 inside pod B unless an NSS source (LDAP/sssd) bridges them. `apps/agor-docs/pages/guide/containerized-execution.mdx:90-180` already mandates this for the executor model — it's a real, hard prereq, not a footnote.

4. **Daemon needs to set ACLs via sudo on the volume.**
   In `unix_user_mode: strict`, the daemon does `sudo setfacl ...` against the worktree path. If the daemon doesn't see the worktree path (because it's a different pod's volume), it can't run setfacl. So either the daemon retains FS access to the worktree volume just to run ACL prep, or ACL setup moves into the executor (which `unix.sync-worktree` already does today — that's the right shape).

### 2.2 Why this is the load-bearing constraint

The single hardest question in hosted-Agor topology is: **where do `--watch`-mode env processes run, and who owns their FS view?**

If they run on the daemon's host → daemon stays FS-coupled, end of story.

If they run anywhere else → you need either:

- **(a)** a shared FS with cross-pod ACL coordination + inotify-poll fallback (Option B), or
- **(b)** an env-pod that owns the worktree volume itself, with the daemon as RPC client only (Option C / D), or
- **(c)** no local watch mode at all, every env is "remote" (Option C strict).

Options (b) and (c) are escape hatches that avoid the wall. (a) is what Max already hit, and bouncing off it the first time is evidence enough.

### 2.3 What `address-issue-1140-impersonation-abstraction` is doing

In flight, parallel worktree. Issue #1140 was about avoiding unnecessary `sudo` wraps in `simple` mode; the abstraction work is centralizing impersonation into the executor boundary (so daemon doesn't itself touch `sudo -u`). **That work is a prerequisite for any of the topology options below** because the env-spawn path (`spawnEnvironmentCommand` calls `runAsUser.buildSpawnArgs()` from `packages/core/src/unix/run-as-user.ts`) is itself a daemon-side impersonation. Until impersonation is unified through the executor, you can't move env spawning out of the daemon without re-implementing impersonation in two places.

---

## 3. Topology variants

Four options. I will commit to one in §4.

### Option A — Minimal decoupling (status quo+)

**Shape:** Daemon stays single-host. Postgres-only. Config from env+ConfigMap. Logs to stdout. Artifact / upload landing moves to executor for hygiene. UI served separately.

- **What changes:** Postgres-only path enforced; `AGOR_HOME` becomes env-only (no `~/.agor/config.yaml` writes); log centralization; `executor:artifact.land`, `executor:upload.stage`, `executor:worktree.probe`; UI bundle out of daemon image.
- **What stays the same:** Daemon and all worktrees on one host (or one pod with a big EBS). `vite --watch` works because everything is local. `spawnEnvironmentCommand` keeps running in the daemon. ACLs stay single-host.
- **Wins:** Quick. Low risk. Closes the obvious hygiene gaps from the inventory. Hosted is single-pod-per-tenant — viable for small/medium customers.
- **Loses:** No horizontal scale per tenant. Daemon pod is a SPOF. Vertical limits hit fast (many concurrent watch envs eating one pod's CPU/RAM).
- **Effort:** ~3–4 eng-weeks.
- **Risk:** Low.
- **Scale ceiling:** One pod per customer; vertical only. Good for "early hosted" but not for "agor at scale."

### Option B — Daemon FS-free, shared volume for envs

**Shape:** Daemon stateless except DB. Executor pods own FS ops. Worktree dirs on EFS, mounted into daemon + every executor + every env-pod. Watch envs are long-lived executor variants.

- **What changes:** Everything in Option A, plus: env-pod model, EFS-or-equivalent persistent volume mounted into daemon and executors, cross-pod ACL/group coordination via NSS (sssd/LDAP), inotify-poll fallback for watchers, per-worktree volume scheduling.
- **Wins:** Horizontal scale. Clean separation. Matches the `executor-expansion.md` vision.
- **Loses:** **Re-inherits the wall.** Cross-pod uid namespacing is hard. ACL changes need to propagate (EFS cache coherency). inotify-over-NFS is unreliable; falling back to polling adds load. Volume orchestration is gnarly — each worktree needs an EBS or each cluster shares one big EFS (back-pressure risk).
- **Effort:** 3–4 months. Multiple unknowns.
- **Risk:** High. Some of these are open problems for the entire industry, not just for Agor.
- **Scale ceiling:** Horizontal in theory; the EFS pool becomes the new bottleneck.

This is the option Max walked off from last time. **Do not pick this unless you're willing to spend a quarter on volume orchestration.**

### Option C — Daemon FS-free, remote-env-only

**Shape:** Daemon stateless except DB. Executor pods are short-lived, own per-task ephemeral FS (clone-on-start, push-on-end, no persistent worktree). Long-running watch envs become **separate env-pods** that own their worktree EBS volume and **don't share it with the daemon at all**. Daemon talks to env-pods via RPC (start/stop/tail-logs/exec-in-env).

- **What changes:** Everything in A, plus: per-task ephemeral executor pods that clone the worktree's branch, do their work, push back to the bare repo, and exit. **Long-lived watch envs become "env-pods" with one volume each.** Agent operations that need to interact with the env's current state RPC into the env-pod ("run this command in the env's cwd" or "open a terminal session attached to the env's cwd") — they do not share FS with the daemon.
- **Wins:** No shared FS, no cross-pod ACL, no inotify-over-NFS. Clean horizontal. Hosted scale story is real.
- **Loses:**
  - **Local-dev story.** A user running `agor` against their own laptop can't get the env-pod model. (Mitigation: keep Option A as the self-hosted shape.)
  - **Latency for short-lived ops.** Spinning up an ephemeral pod for every git op is heavy. Mitigation: warm pool, or daemon-cached metadata + larger units of work.
  - **Agent live access to env files** is mediated by RPC to the env-pod, not a shared mount. Slightly more code, more roundtrips.
  - **Worktree volume per env** scales linearly with worktree count. Could be one PV per worktree (clean, expensive) or one big EFS partitioned (cheap, brings back coordination).
- **Effort:** 2–3 months.
- **Risk:** Medium. The architecture is clean; the implementation churn is real (every place that currently assumes a local FS for a worktree becomes RPC-shaped).
- **Scale ceiling:** Horizontal, clean. Bottleneck shifts to RPC throughput and env-pod startup.

### Option D — Hybrid (self-hosted = A, hosted = C)

**Shape:** Same codebase, two deployment shapes.

- **Self-hosted:** Option A. Single pod, local FS, watch envs are direct daemon children. Today's UX preserved.
- **Hosted:** Option C. Daemon FS-free, env-pods own worktree volumes, executor-only FS access.

The split happens at one layer: the `EnvironmentRuntime` abstraction (today: `spawnEnvironmentCommand`). Self-hosted implementation = `child_process.spawn`. Hosted implementation = `kubectl apply / RPC to env-pod`. Same DB schema, same API surface for sessions/tasks/artifacts.

- **Wins:** Keeps the self-hosted UX intact (today's user gets vite-with-inotify free). Hosted gets clean horizontal scale. **Forces a clean interface** (`EnvironmentRuntime`) that's better code regardless.
- **Loses:** Two code paths, two test matrices. Some features (e.g. "agent edits file → vite picks it up") behave differently in self-hosted vs hosted (in hosted, the edit goes via RPC to the env-pod's FS). This is conceptually OK but the UI / agent has to be unaware (or aware) consistently.
- **Effort:** 4–5 months (Option C plus the abstraction layer to keep both alive).
- **Risk:** Medium. The interface boundary is the risk.
- **Scale ceiling:** Self-hosted = Option A's ceiling; hosted = Option C's ceiling.

---

## 4. Recommendation

**Adopt Option D, but sequence it as A → C-for-hosted → D consolidation.**

Specifically:

1. **Ship Option A first (~4 weeks).** Easy wins, ship hygiene. Self-hosted users see no change.
2. **Then build hosted as Option C (~8 weeks).** Treat self-hosted and hosted as different deployment shapes from day one. **Don't try to make a single binary do both.** The `EnvironmentRuntime` interface is the seam.
3. **Final consolidation as Option D (~2 weeks).** Document the two deployment shapes; both are first-class.

### Why D over the others

- **Not B.** Max already hit the wall there. Cross-pod ACL + inotify-over-NFS is solvable but in eng-quarters, not eng-weeks. The wall is real and structural, not a skill issue. Burning months on a shared-volume model means competing with EFS, NFS, and POSIX semantics in their own arena.
- **Not C alone.** Self-hosted users want vite-with-inotify on their laptop, agent edits live-reloading, etc. Forcing them to spin up an env-pod model on their MacBook is a regression. The local-dev experience is part of why Agor is interesting and we shouldn't break it for a hosted scale win.
- **Not A alone.** Single-pod-per-tenant has a ceiling that hits with mid-sized customers (5+ concurrent watch envs, 10+ concurrent agents). Hosted will hit it.
- **D acknowledges reality:** these are two different products with the same core (DB schema, API, agent model). The deployment is what differs.

### Phased delivery plan

#### Phase 1A — Config hygiene (the §1.5 work, ~8 eng-days)

This is what this worktree intends to take on first. See §1.5 for the H1–H5 breakdown. No behavior change for existing self-hosted users.

#### Phase 1B — Other FS hygiene (~3 eng-weeks, follow-up worktrees)

The remaining hygiene work, sequenced after Phase 1A because the executor payload schema (touched by H1) is more stable once the config slices are in place.

| Work item                                                                                                                           | Files touched                                                               | Eng-weeks | Risk                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- | ------------------------------------------------- |
| **Postgres-only enforced for hosted**                                                                                               | `setup/database.ts`, `db/client.ts`, deployment manifests                   | 0.5       | Low — Postgres support exists                     |
| **Artifact landing → executor** — new `artifact.land` payload type, move `services/artifacts.ts:717-812` body into executor handler | `services/artifacts.ts`, `packages/executor/src/handlers/artifact.ts` (new) | 1.0       | Medium — must preserve sidecar metadata semantics |
| **Upload write → S3 / object store** (hosted-only; self-hosted keeps local)                                                         | `utils/upload.ts`, new `storage` adapter                                    | 1.0       | Medium                                            |
| **Realign-repo-origin → executor** — `executor:git.repo.realign-origin`                                                             | `utils/realign-repo-origin.ts`, executor                                    | 0.25      | Low                                               |
| **Drop daemon's `git ls-files` autocomplete** (or route via executor)                                                               | `services/files.ts`                                                         | 0.25      | Low — degraded UX in hosted only                  |
| **UI bundle removed from daemon image**                                                                                             | `index.ts`, build scripts                                                   | 0.25      | Low                                               |

**Subtotal: ~3 eng-weeks. All landable as discrete PRs.**

#### Phase 2 — "EnvironmentRuntime interface" (1–2 weeks)

Extract the abstraction. Don't change behavior yet.

| Work item                                                                                                                                                                                            | Eng-weeks |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Define `EnvironmentRuntime` interface: `start(worktree, command) → handle`; `stop(handle)`; `tailLogs(handle, since) → AsyncIterable`; `kill(handle)`; `attachTerminal(handle, cwd) → ZellijHandle`. | 0.5       |
| Implement `LocalProcessEnvironmentRuntime` as today's `spawnEnvironmentCommand` behind that interface.                                                                                               | 0.5       |
| Wire `services/worktrees.ts:start/stop/restart` through it.                                                                                                                                          | 0.25      |
| Tests + docs.                                                                                                                                                                                        | 0.5       |

**Subtotal: ~1.5 eng-weeks.** Pure refactor. No user-visible change. Self-hosted behavior identical.

#### Phase 3 — "Hosted env-pods" (6–8 weeks, the hard part)

This is the option C build.

| Work item                                                                                                                                                                                                                                                                | Eng-weeks                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `KubernetesEnvironmentRuntime` — `start()` issues `kubectl apply` for a per-env Deployment + Service; `stop()` deletes; `tailLogs()` streams via `kubectl logs --follow`.                                                                                                | 2.0                                               |
| Per-worktree volume scheduling: one EBS PVC per worktree (or one big EFS partitioned — pick one; recommendation: per-worktree EBS for clean failure isolation, accept the cost).                                                                                         | 1.5                                               |
| Env-pod image: includes git, the relevant runtimes (node/python/etc — pick a baseline + customer extends), the agor-executor CLI for in-env ops.                                                                                                                         | 1.0                                               |
| RPC channel: daemon → env-pod for "exec in env" / "attach terminal" / "land artifact in env" / etc. Probably an authenticated WebSocket the env-pod opens back to the daemon (mirroring how executor connects today).                                                    | 1.5                                               |
| Executor pods that are _not_ env-pods: short-lived per-task `kubectl run` for `git.clone`, `git.worktree.add`, etc. These don't need a persistent volume — they take a volume claim from the worktree's env-pod (if it exists) or attach the worktree EBS directly.      | 1.5                                               |
| Agent ↔ env-pod live FS: agent runs inside the env-pod (or in a peer pod that mounts the same EBS). **Decision: keep agent + env in the same pod for hosted.** Avoids cross-pod FS sharing for the live edit case entirely. Worktree's "agent" and "env" are co-located. | 0.5 — design only; impl folded into env-pod build |
| Migration: existing self-hosted users unaffected. Hosted is opt-in via deployment manifest selection.                                                                                                                                                                    | 0.5                                               |

**Subtotal: ~8 eng-weeks.** Major.

#### Phase 4 — "Consolidate to Option D" (~1 week)

| Work item                                                                              | Eng-weeks |
| -------------------------------------------------------------------------------------- | --------- |
| Docs: `containerized-execution.mdx` updated to describe both shapes.                   | 0.25      |
| Operator picks `runtime: local-process` or `runtime: kubernetes` in deployment config. | 0.25      |
| Test matrix: ensure both modes run a baseline test suite.                              | 0.5       |

**Subtotal: ~1 eng-week.**

### Where the ACL wall remains under D

In **self-hosted Option A path:** unchanged from today. Single host, single uid namespace. The wall doesn't apply.

In **hosted Option C path:** the agent and the env-process **share a pod** (same uid namespace, same FS). The daemon never mounts the worktree volume at all — it only knows the EBS handle and tells the cluster to attach it to the right env-pod. **Daemon ↔ FS is decoupled.** Cross-pod ACL coordination is unnecessary because the daemon doesn't share the FS.

The thing that _replaces_ the wall is "operator must set up a k8s cluster with PVCs and a node group capable of mounting them." This is real work but it's _standard_ operator work, not a novel coordination problem.

### What we lose (honest)

1. **Self-hosted multi-user with strict Unix isolation will continue to need single-host setfacl ACLs** for the foreseeable future. Option D doesn't help self-hosted scale past one host. (If we ever need multi-host self-hosted, you're back at Option B.)
2. **Per-task ephemeral executor pods are slower than subprocess spawn** by ~5–15 seconds. Hosted gets a small latency tax on every prompt. Mitigation: warm pool of executor pods, or larger-grained work units, or "session-pinned" pods that survive between turns.
3. **One volume per worktree is expensive at scale.** A customer with 200 worktrees has 200 EBSs. Mitigation: archive idle worktrees (detach EBS, retain bare repo only).
4. **The Sandpack / local "live preview" stories** that assume daemon-FS access need a UI-side reshuffle. Probably modest.
5. **Two-mode complexity.** Operators pick one. Self-hosted tooling and hosted tooling diverge slightly. Acceptable tax.

---

## 5. Effort estimate

| Phase                                | Eng-weeks         | Risk       |
| ------------------------------------ | ----------------- | ---------- |
| 1A — Config hygiene (this worktree)  | ~1.5 (8 eng-days) | Low        |
| 1B — Other FS hygiene                | ~3                | Low–Medium |
| 2 — `EnvironmentRuntime` abstraction | 1.5               | Low        |
| 3 — Hosted env-pods (Option C build) | 8                 | High       |
| 4 — Consolidate                      | 1                 | Low        |
| **Total to v1 hosted-ready**         | **~15**           | —          |

**Hard-risk items:**

- **Per-worktree volume orchestration.** EBS provisioning, attach/detach, cleanup of orphaned PVCs after worktree deletion, cost reporting. (Phase 3, ~2 weeks of the budget.) The first incident here will be a "we leaked $4K of EBS" post-mortem if we're not careful.
- **Env-pod RPC channel auth + reconnect.** The current executor↔daemon WebSocket is short-lived and pre-authed via session token. Env-pods are long-lived. Token rotation, reconnect-after-pod-restart, and ensuring the daemon's view of "env state" doesn't drift from the pod's actual state — this is a multi-week subsystem on its own. (Phase 3, ~1.5 weeks.)
- **Agent + env co-location in one pod.** Means the pod needs both the agent SDK image _and_ the user's chosen runtime (node, python, etc.). Image size, image variants per customer-language preference, "what if customer wants their own custom env image" — this is its own product surface. (Phase 3, ~1 week, plus ongoing.)
- **Self-hosted regression risk during Phase 2.** Extracting `EnvironmentRuntime` is a refactor but it touches the long-lived child-process model. One bad refactor and watch-mode breaks for every self-hosted user. Strong tests required.

### Where the prior "complexity wall" sits and how this avoids it

Max's wall was: ACL + shared-FS coordination for cross-pod env access. That's Option B's problem, not Option D's.

Option D's `hosted` shape **does not share FS between daemon and env-pod**. The daemon owns DB, the env-pod owns the worktree volume, and they talk via RPC. ACL coordination is internal to the env-pod (which is a single pod with one uid namespace) and is exactly today's single-host scheme.

The wall is avoided by changing the question: not "how do we coordinate POSIX ACLs across many pods?", but "how do we ensure one pod owns one worktree's filesystem?" The latter is k8s scheduling, not POSIX semantics.

---

## 6. What I'd want to know to be more confident

These would shift the recommendation if their answers were surprising.

1. **What % of hosted users will actually use long-lived watch envs?** If the answer is "few — most just want a session that runs an agent for a turn and exits", Option C's env-pod model is overbuilt. A pure ephemeral-executor model (no env-pods at all) might suffice.
2. **Is Postgres performance under the daemon's current query patterns actually OK?** The codebase tested Postgres but most production usage is SQLite. Worth a load test before committing hosted to PG-only.
3. **How does Codex / Gemini SDK behave in a per-task ephemeral container?** Claude SDK is tested in subprocess mode. The other two may have surprises (caching, persistent auth state, etc.).
4. **What does the existing `address-issue-1140-impersonation-abstraction` worktree actually deliver?** If it lands the executor-as-impersonation-boundary in full, Phase 2 gets cheaper. If it scope-creeps or stalls, we're paying for that in Phase 1.
5. **Customer ask for self-hosted multi-host?** If real, Option D's hosted-only horizontal scale story doesn't help them and we're back at B. Worth asking the early hosted-ish customers what they actually want.

### Experiments worth running before committing to Phase 3

- **Prototype** a single env-pod against a real EBS PVC, with an executor RPC channel, on EKS. Measure: pod startup time, RPC latency, EBS attach time, agent prompt → response time. Time-box to 1 week. **If pod startup > 30s consistently, the model needs warm pools and the Phase 3 budget grows by 1–2 weeks.**
- **Postgres at-scale load test** against the daemon's busiest endpoints (gateway events, message inserts, task creation under heavy concurrency). Time-box to 3 days.
- **Pull `services/artifacts.ts:land()` into executor as a one-off PR**, see how it goes. This is the smallest unit of "move FS work to executor" and will surface any executor↔daemon contract gaps for the larger Phase 1 moves.

---

## Appendix A — Daemon FS touchpoint table (consolidated)

Same as §1.1, presented in the table format the prompt requested:

| #   | Touchpoint                               | R/W               | Frequency        | Current owner | Decoupling path                                   | Phase |
| --- | ---------------------------------------- | ----------------- | ---------------- | ------------- | ------------------------------------------------- | ----- |
| 1   | `~/.agor/config.yaml` (load)             | R                 | startup-once     | daemon        | env+ConfigMap                                     | 1     |
| 2   | `~/.agor/config.yaml` (write secrets)    | W                 | startup-once     | daemon        | DB row or operator-provided                       | 1     |
| 3   | `~/.agor/admin-credentials`              | W                 | first-run        | daemon        | stdout in hosted                                  | 1     |
| 4   | `daemon-shutdown-clean.flag`             | R/W               | shutdown+startup | daemon        | DB or drop in containers                          | 1     |
| 5   | `~/.agor/agor.db` (SQLite file)          | R/W               | every-req        | daemon        | Postgres-only for hosted                          | 1     |
| 6   | UI bundle `dist/ui/`                     | R                 | startup          | daemon        | separate static host                              | 1     |
| 7   | `.build-info` + `git rev-parse`          | R                 | startup          | daemon        | env var at image build                            | 1     |
| 8   | `~/.agor/repos/<slug>/` probe reads      | R                 | per-req          | daemon        | executor probe + DB cache                         | 2/3   |
| 9   | `.git/config` realign-origin             | W                 | per-req          | daemon        | executor                                          | 1     |
| 10  | `~/.agor/worktrees/<r>/<wt>/` existsSync | R                 | per-req          | daemon        | DB cache + executor probe                         | 2/3   |
| 11  | Worktree git-state read                  | R                 | per-task         | daemon        | executor probe                                    | 3     |
| 12  | `git ls-files` autocomplete              | R                 | per-req          | daemon        | executor or drop in hosted                        | 1     |
| 13  | Repo dir cleanup `fs.rm`                 | W                 | per-delete       | daemon        | executor                                          | 1     |
| 14  | Artifact sidecar read                    | R                 | per-req          | daemon        | DB cache + executor                               | 1     |
| 15  | Artifact land (mkdir + writeFile)        | W                 | per-land         | daemon        | **executor `artifact.land`**                      | 1     |
| 16  | Artifact rm (overwrite)                  | W                 | per-land         | daemon        | executor                                          | 1     |
| 17  | Artifact recursive readdir               | R                 | per-req          | daemon        | executor                                          | 1     |
| 18  | Upload write (3 destinations)            | W                 | per-upload       | daemon        | object store + executor                           | 1     |
| 19  | `/tmp/agor-env-<uid>.sh` write + chown   | W                 | per-attach       | daemon        | fold into `zellij.attach`                         | 2     |
| 20  | `which zellij` execSync                  | exec              | startup          | daemon        | executor health probe                             | 1     |
| 21  | Executor binary existsSync               | R                 | startup          | daemon        | image-bundled path                                | 1     |
| 22  | `spawn(executor)` (local-only)           | exec              | per-task         | daemon        | template / `kubectl run` for hosted               | 3     |
| 23  | `spawnEnvironmentCommand` env child      | exec (long-lived) | per-env          | daemon        | `EnvironmentRuntime` interface; env-pod in hosted | 2/3   |
| 24  | `environment.log` continuous write       | W                 | continuous       | daemon        | env-pod stdout, k8s captures                      | 3     |
| 25  | `process.kill(env pid)`                  | signal            | per-stop         | daemon        | env-pod RPC                                       | 3     |

(Some sub-touchpoints from §1.1 collapsed into "Repo dir cleanup" / "probe reads" for readability.)

---

## Appendix B — Coordination note

`address-issue-1140-impersonation-abstraction` (in flight) overlaps Phase 2 of this plan. Specifically, the `EnvironmentRuntime` interface extraction depends on impersonation being fully owned by the executor — otherwise `LocalProcessEnvironmentRuntime` has to re-implement `runAsUser.buildSpawnArgs()` and we end up with two impersonation surfaces again. **Don't start Phase 2 until #1140 lands.** Phase 1 hygiene work can proceed in parallel since none of it touches impersonation.

---

_End of analysis._
