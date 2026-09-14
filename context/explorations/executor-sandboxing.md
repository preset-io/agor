# Executor Sandboxing (bubblewrap) — Filesystem Isolation + Path to Replacing strict

> [!IMPORTANT]
> Historical design record. Host Unix impersonation, `strict`/`insulated`, POSIX
> projection, and `unix.sync-*` were removed in 0.25. Do not use the implementation
> sketches below as current guidance; see `context/guides/rbac-and-unix-isolation.md`.

**Status:** 🧪 POC implemented & validated live (opt-in, disabled by default)
**Author:** Max + pairing
**Date:** 2026-08-15
**Related:** [[docker-executor-mode]] (container/microVM/k8s substrate — Tier 2, Cloud), [[executor-expansion]],
[[rbac-and-unix-isolation]], [[git-remote-credential-spillover]], [[task-runtime-state]]

> **TL;DR.** `execution.sandbox` wraps **every** local executor spawn in **`bubblewrap`** at the
> single `spawn-executor.ts` chokepoint — one filesystem policy across **all** agentic tools,
> terminals, and git/file ops (tool-agnostic). It is a **filesystem sandbox only**: the network
> namespace is left **shared** (`--share-net`), so the executor keeps its daemon/model
> connectivity. Disabled by default; `agor init` offers a one-shot opt-in. Validated live: a real
> Codex agent gets **`Permission denied`** on `~/.agor/config.yaml`, an **empty** `~/.ssh`, and
> sibling branches hidden — while the task completes normally. The executor stays a plain host
> process tree, so the existing pgid-based Stop/containment is unchanged.
>
> **Strategic aim:** grow this into the replacement for `unix_user_mode: strict`/`insulated`,
> deleting the sudoers / host-account / password-sync / per-branch-group apparatus. See
> [§7 Path to deprecating strict](#7-path-to-deprecating-strict-mode).

---

## 1. How we got here (why bubblewrap, not SRT or Docker)

The exploration tried three substrates; the network model decided it.

- **Docker / containers** — strong isolation but the daemon would hold root-equivalent Docker
  authority, Stop/containment needs a container-lifecycle rewrite, and it adds an image lifecycle.
  Right answer for **hosted multi-tenant / Cloud** (kernel/hypervisor boundary), overkill locally.
  Kept as the Tier-2 reference: [[docker-executor-mode]].
- **`@anthropic-ai/sandbox-runtime` ("srt")** — the obvious pick (it's what Claude Code uses), and
  its config maps 1:1 to our policy. **But on Linux srt always runs the process under
  `bwrap --unshare-net`** and routes traffic through a proxy that **blocks all loopback** — which
  severs the executor↔daemon socket (`localhost:PORT`). Verified in srt's source
  (`needsNetworkRestriction = hasNetworkConfig`, network config is schema-required) and empirically
  (`allowLocalBinding`, `NO_PROXY`, `enableWeakerNetworkIsolation`, empty allowlists — all still
  `000` to the daemon). srt is designed to sandbox the _commands an agent runs_, not the agent
  runtime; Claude Code itself only wraps its Bash tool, never its own process. There is no srt
  config that lets a wrapped long-lived process reach a local service.
- **Raw `bubblewrap` (user + mount namespaces, `--share-net`; PID namespace where the host allows)**
  — bubblewrap IS the Linux engine under srt. Using it directly, we take the filesystem isolation
  (plus a PID namespace on hosts that support it) and **skip only the network namespace**, so the
  executor keeps loopback to the daemon and egress to the model API. This is the shipped approach.

**Net:** srt/whole-process-wrap and local-daemon connectivity are mutually exclusive on Linux; raw
bwrap `--share-net` sits exactly in that gap. Network egress control, if ever wanted, is deferred
to each tool's own config (Claude/Codex sandbox settings).

---

## 2. Architecture (as shipped)

One chokepoint. In `apps/agor-daemon/src/utils/spawn-executor.ts`, when `execution.sandbox.enabled`
and the spawn is **local + non-impersonated** and carries a branch work dir, the bare launch
(`node <executor> --stdin`) is replaced with `bwrap <args> -- node <executor> --stdin`.

- **Work dir = the branch**, read from `payload.params.cwd` (prompt/terminal) or `payload.cwd` — NOT
  the executor process cwd (which is the executor package dir for prompt tasks). No work dir
  (repo-level ops like `git.repo.realign-origin`) ⇒ no wrap.
- **Containment preserved:** `bwrap` stays in the executor's process group on the host, so
  `SIGTERM -pgid` + `/proc` start-identity + `boot_id` fences all still work. This is the decisive
  advantage over Docker.
- **Tool nesting avoided:** the wrap sets `AGOR_OUTER_SANDBOX=1`; Codex reads it and forces
  `sandboxMode=danger-full-access` so it does not start its own nested bwrap. One layer.

### The bubblewrap policy (pure resolver → `packages/core/src/config/sandbox-policy.ts`)

Ordering matters (bwrap applies binds left-to-right; later wins). Emitted base → writable → denials:

```
--die-with-parent --unshare-user --ro-bind / /   # all readable, nothing writable
--dev /dev --proc /proc
--tmpfs /tmp --tmpfs /var/tmp                     # task-private tmp (include.tmp)
--tmpfs <worktrees-root>                          # isolate_branches: hide ALL branches…
--bind   <branch> <branch>                        # …then re-expose only this one (rw)
--bind   <base>/.git <base>/.git                  # worktree commits (include.base_repo)
--bind-try ~/.cache ~/.config ~/.local ~/.npm ~/.claude ~/.codex ~/.gemini   # tool state (include.home=false)
--ro-bind /dev/null ~/.agor/config.yaml           # protect_secrets: mask daemon secrets…
--ro-bind /dev/null ~/.agor/agor.db
--tmpfs ~/.ssh ~/.gnupg ~/.aws ~/.config/gcloud   # …and credential dirs
--chdir <branch>
```

The daemon drops any mask whose target doesn't exist (a mask on a missing path under the read-only
root makes bwrap abort). Reads are open-by-default (system paths, node, tools all readable); only
writes are scoped and secrets masked.

**Deterministic mounts (no `.git` parsing).** The base repo git dir bound at `<base>/.git` is derived
from Agor's own DB state — `repo.local_path` for the branch's repo, resolved in `register-services`
and threaded through `payload.params.sandboxBaseRepoPath` — **not** by reading the worktree's on-disk
`.git` pointer. So a rewritten worktree origin/gitdir can't misdirect the mount, and self-standing
clones (`storage_mode: clone`, which carry their own `.git`) skip the base bind entirely. The
worktrees root is likewise a fixed `<data_home>/worktrees`, never inferred from the slug.

### Per-user home overlay (`home_mode: per_user`) — the strict-mode replacement substrate

When `home_mode: per_user`, a single `--bind` REPLACES the shared-home logic above:

```
--tmpfs /home                                          # FIRST: wipe sibling homes (leak fix)
--tmpfs <data_home>                                    # when data_home is outside passwd-home
--bind <store>  <passwd-home>                          # overlay: ~ IS the owner store (filesystem_home or canonical)
--bind <store>/tmp  /tmp                               # /tmp == ~/tmp: on-disk, per-user, persists (NOT RAM tmpfs)
--tmpfs /var/tmp                                        # small ephemeral scratch
--bind      <branch> <branch>                          # re-expose rw/ro/none per owner's RBAC fs_access
--bind      <base>/.git <base>/.git                    # re-expose base git dir for commits
--ro-bind-try <data_home>/agentic-tools …             # re-expose managed tool binaries (ro)
--ro-bind /dev/null <data_home>/config.yaml            # UNCONDITIONAL trust-root mask (covers data_home OUTSIDE ~)
--ro-bind /dev/null <data_home>/agor.db
--setenv HOME <passwd-home>  --setenv TMPDIR /tmp
--chdir  <branch>
```

When the data root is below the passwd home, the overlay hides the **entire** daemon `.agor` tree
(config.yaml, agor.db, worktrees, repos) by construction. When a hosted deployment places the data
root elsewhere, Agor explicitly masks that root before re-exposing the authorized branch, base git
dir, and managed tools. It ALSO `--tmpfs`-es the homes-parent dir (e.g. `/home`) FIRST, including
its canonical alias when the passwd home traverses symlinks, so sibling homes are not readable
through the `--ro-bind / /` (the cross-user leak fix — otherwise, once homes live at
`/home/<user>`, one owner could read another's `~/.codex/auth.json`). `~` is then a private,
persistent home per **session owner** (keyed by `session.created_by`, not the prompter): passwd-home,
`$HOME`, and `~` all agree (no `$HOME`-vs-passwd split), so passwd-consulting tools resolve it
correctly.

The overlay **source** is the owner's `users.filesystem_home` when set (the strict→sandbox migration
points it at their existing `/home/<unix_username>` so no files move), else the canonical store
`<data_home>/tenants/<tenant>/homes/<owner_id>` (or `<tenant_data_root>/homes/<owner_id>` when
filesystem multitenancy is enabled). The daemon `mkdir`s the store before spawn; a fresh
owner gets an empty home tools seed themselves, migration pre-populates it.

The branch is re-exposed **per the owner's RBAC filesystem access**: `write` → `--bind` (rw), `read`
→ `--ro-bind`, `none` → not mounted (and the spawn is rejected up front with a clear error). So the
mount namespace — not Unix groups — enforces branch authorization, computed straight from Agor's
permission service.

---

## 3. Config (as shipped) — `~/.agor/config.yaml`

Filesystem-only. Snake_case Agor knobs; no network semantics.

**The one-liner switch — `unix_user_mode: sandbox`.** This is the strict replacement operators set.
It IMPLIES the sandbox filesystem-isolation settings (resolved in memory by
`resolveEffectiveConfig`, never rewriting config.yaml): `sandbox.enabled: true`,
`sandbox.home_mode: per_user`, and `sandbox.fail_if_unavailable: true` (fails closed), with NO Unix
impersonation (runs as the daemon user). Board and branch RBAC is always enabled independently of
the execution mode — it is not something sandbox mode turns on. Explicit `sandbox.*` tunables still
apply (e.g. an explicit `home_mode: shared` or `fail_if_unavailable: false`), but `enabled` is
non-negotiable in this mode.

```yaml
execution:
  unix_user_mode: sandbox # ← replaces strict/insulated. Implies RBAC + per-user sandbox, no sudo.
  sandbox:
    enabled: false # master switch. Default OFF. Chosen at `agor init` (single y/N).
    include:
      branch: true # branch working dir writable (effectively always true)
      base_repo: true # <base>/.git writable — required for commits in worktree mode
      tmp: true # fresh task-private tmpfs at /tmp, /var/tmp
      home: false # all of $HOME writable (off; tool state dirs stay writable regardless)
    home_mode: shared # shared (daemon home, masked) | per_user (per-owner home overlay — see §2)
    preserve_canonical_home_alias: false # opt-in continuity for symlinked daemon homes
    protect_secrets: true # mask ~/.agor/{config.yaml,agor.db} + ~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud, ~/.npmrc
    isolate_branches: true # hide the worktrees root, re-expose only the current branch
    extra_allow_write: [] # escape hatch: extra writable paths
    extra_deny_read: [] # escape hatch: extra masked files
    fail_if_unavailable: false # true = refuse to run unsandboxed if bwrap missing (prod gate)
```

- `AGOR_SANDBOX_ENABLED=true` env → `execution.sandbox.enabled`; `AGOR_SANDBOX_HOME_MODE=per_user|shared`
  → `execution.sandbox.home_mode`. Both are used by the `sandbox` / `sandbox-peruser` `.agor.yml` dev
  variants and forwarded into the container via `docker-compose.yml` (in-memory resolve; config.yaml
  is never rewritten).
- `agor doctor` reports the sandbox row (enabled? `bwrap` present? Linux?).

---

## 4. Validated live (containerized dev env, real Codex agent)

With `enabled: true` in the `sandbox` `.agor.yml` variant, a real Codex session prompted to read
secrets produced (fresh, un-recallable output):

- `wc -c ~/.agor/config.yaml` → **empty**; `cat ~/.agor/config.yaml` → **`Permission denied`**
- `ls -a ~/.ssh` → **`. ..`** (empty; host keys hidden)
- `pwd` → the branch; `echo > probe.txt` → writes (branch rw); **task completed** (daemon reachable)

Also confirmed: `bwrap --unshare-user` runs inside the Docker dev container (unprivileged userns +
the auto-loaded `compose.override` seccomp/apparmor relaxation), and the wrap fires for Codex — a
tool the POC does **not** special-case — proving it is tool-agnostic.

**Per-user home overlay (`home_mode: per_user`)** was validated end-to-end by driving the actual
`buildSandboxWrap()` daemon code against real container paths + a store seeded with real Codex/Claude
tool state:

- daemon `mkdir` seeded the store; `HOME`, passwd-home, and `~` all resolved to it (no split)
- `~/.codex/auth.json` (a **file**, so home genuinely carries Codex creds) was visible → auth persists
- `~/.agor/config.yaml` and `agor.db` → **`No such file`** (hidden by the overlay, no explicit mask)
- branch re-exposed + `chdir` correct; `<base>/.git` bind **writable** (worktree commits work)
- a write to `~` landed in the **owner store**, not the daemon home → per-owner persistence

---

## 5. Threat model & guarantees

**What it stops (validated / by construction):**

- Hostile/injected agent reading daemon secrets (`jwtSecret`, `masterSecret`, API keys, `agor.db`).
- Agent reading/writing sibling branches or other tenants' work (worktrees hidden; only the current
  branch re-exposed).
- Agent reading host credential dirs (`~/.ssh`, cloud creds).
- Agent writing outside the branch/tmp (read-only root).

**What it does NOT provide (vs strict) — accepted tradeoffs:**

- **No per-user OS identity.** Everything runs as the daemon user; `ps`/file-ownership no longer
  reflect the Agor user, and SSH-into-the-box no longer maps to branch access. This was only ever
  deliverable via the host-account apparatus and never survived HA/multi-pod. The correct model is
  "Agor owns its filesystem; access only via Agor or admins."
- **Namespace boundary, not uid boundary.** A bwrap/kernel escape lands as the daemon user (strict
  would still contain it under a distinct uid). Both are kernel-enforced; bwrap escapes are rare.
  For **mutually-hostile multi-tenant**, the strong boundary remains containers/microVM/k8s
  ([[docker-executor-mode]]); sandbox targets **trusted-org multi-user** (strict's real audience).
- **Process-side isolation via PID namespace (BEST-EFFORT).** When the host allows it we
  `--unshare-pid` alongside `--unshare-user`, giving the sandbox a fresh `/proc` that shows ONLY its
  own processes (bwrap as PID 1 + the executor). The daemon and sibling executors are then
  structurally absent from the sandbox's procfs, closing the same-uid
  `/proc/<pid>/{environ,root,fd,…}` route around the filesystem masks regardless of host
  `ptrace_scope`/`hidepid`. Verified live on bare metal: without the flag the sandbox saw 704 host
  PIDs; with it, 5 (its own). Verified compatible with the pgid-based Stop/containment contract
  ([[task-runtime-state]]): a single `SIGTERM` to the executor's process group tears the whole tree
  down (bwrap PID 1 + children), and the kernel kills the namespace when bwrap exits — no leaks.
  **Caveat:** many container runtimes refuse to mount proc in a nested PID namespace ("Operation not
  permitted"), so the daemon functionally probes it (`probeBwrapPidNamespace`) and, when
  unavailable, falls back to a user+mount sandbox WITHOUT `--unshare-pid` (logging a one-time
  warning) rather than failing every task. In that fallback the process-side vector is governed by
  the host's `ptrace_scope` or — in Agor Cloud, where each tenant/user runs in its OWN container —
  by the container boundary itself, which is stronger than a PID namespace. We deliberately do NOT
  `--unshare-net` (loopback to the daemon must stay reachable).

---

## 6. Scope / limitations

- **`sandbox` isolation mode runs as the daemon user (no `asUser`).** That IS the design — the
  strict-replacement deliberately drops OS impersonation. Startup rejects `sandbox.enabled` with
  `strict`, `insulated`, `executor_unix_user`, or `executor_command_template`; those combinations
  cannot be wrapped by the daemon's local bubblewrap boundary and must not silently run unwrapped.
- **Linux only** (bubblewrap). macOS would use Seatbelt (`sandbox-exec`) — a follow-up. The daemon
  warns at startup if `unix_user_mode: sandbox` is set on a non-Linux host.
- **Per-task, branch-scoped.** Wraps prompts/terminals/commands that carry a branch work dir;
  repo-level ops (e.g. `git.repo.realign-origin`) run unwrapped (Agor's own trusted code).
- **Prompting another user's Session** is branch-home-only and runs with the
  caller's home and credentials; execution-home Sessions fail closed.
- **Not yet deleted:** the sudoers / `user-manager` sudo paths / password-sync code still SHIP as the
  `strict`/`insulated` fallback (soft-deprecated with a startup warning). Removing them is the
  fast-follow once `sandbox` has prod miles (§7 step 8).

---

## 7. Path to deprecating strict mode

Goal: `execution.sandbox` (+ app-layer RBAC + the per-user env-resolver) provides strict's
security guarantees, so `unix_user_mode: strict`/`insulated` and the entire sudoers /
host-account / password-sync / per-branch-group apparatus can be deleted.

**Why it's conceptually sound.** strict conflates _identity_ (uid the process runs as) with
_authorization_ (Unix groups/perms encoding branch access). The sandbox **decouples** them:
everything runs as the daemon user, and authorization is enforced by the **mount namespace**, which
Agor computes directly from its own RBAC config — instead of round-tripping the permission model
through Unix groups. Cleaner, and it deletes the OS plumbing.

**RBAC-aware mounting — DONE.** Per task, the executor operates on ONE branch, so we don't need
strict's whole-filesystem group model. At spawn, `register-services` asks Agor's permission service
(`BranchRepository.resolveUserAccess`) for the session owner's effective `fs_access` to the branch
and threads it to the resolver, which mounts accordingly:

- write (`all` / owner) → `--bind` (rw)
- read (`read` fs access) → `--ro-bind`
- none → not mounted; the spawn is rejected up front with a clear error.

Siblings already hidden. Credential isolation is already handled by the env-resolver (per-user,
per-tool secrets never enter a shared env). So sandbox + RBAC-mounting + env-resolver ≈ strict.

**Phased plan:**

1. ✅ Ship sandbox (filesystem-only, simple mode, opt-in) — done, validated.
   1.5. ✅ **Per-user home overlay (`home_mode: per_user`)** — done, validated end-to-end (§4). This is
   strict's _identity_ half without Unix accounts: a private, persistent `~` per session owner,
   overlaid from `filesystem_home` or the canonical store, hiding the daemon trust root + all other
   homes by construction.
2. ✅ **RBAC-aware mounting + the `unix_user_mode: sandbox` switch** — done. The mode implies
   RBAC + per-user home + fail-closed and drops impersonation (decided: no `asUser`); the branch
   mounts rw/ro/none per the owner's tier; `users.filesystem_home` lets the migration reuse existing
   homes in place.
3. **Parity tests** — a cross-user/cross-branch matrix proving sandbox+RBAC ≈ strict (mostly
   remaining formal test coverage; the mount behavior itself is unit- + live-validated).
4. **Recommend sandbox** for multi-user in the user docs; keep strict working as fallback.
5. ✅ **Migration tooling + "de-strict" recipe** — `scripts/strict-to-sandbox-migration.sh`
   (dry-run by default; `--apply`, `--teardown`). It sets each user's `filesystem_home` to their
   existing `/home/<unix_username>` (no `mv`), `chown`s the data tree + homes to the daemon user,
   flips `unix_user_mode: sandbox`, and optionally `groupdel agor_wt_*` + removes the sudoers file.
   Hosted data roots may live outside the daemon passwd home; the sandbox masks
   that root explicitly before re-exposing the authorized paths.

   **Home relocation is safe (empirically checked).** Moving each user's `~/.claude`/`~/.codex` into
   the per-owner store does not break the tools: a grep of real prod homes found tool CONFIG is
   home-path-agnostic (0 hits of the absolute `/home/<user>` in `settings.json` / `credentials` /
   `config.toml` / `auth.json`); `.claude.json` `projects:{}` keys are branch/cwd paths, not the home
   path; only Codex `sessions/` transcripts embed the old absolute path (historical, non-blocking).
   The overlay presents the store at the passwd home, so no path preservation or passwd-faking is
   needed. The migration overlays each existing home in place; it does not copy
   or move tool state.

   **Pre-flight before relocating** — `scripts/sandbox-home-migration-preflight.sh` (read-only; prints
   only per-file hit counts, never contents). It scans every home's tool state for that home's own
   absolute path in three tiers: AUTH/SETTINGS (`auth.json`/`.credentials.json`/`settings.json` — a
   hit blocks), CWD REGISTRY (`.claude.json` `.projects`/`.githubRepoPaths`, `config.toml`
   `[projects."…"]` — cwd-keyed, expected, non-fatal), SESSIONS (historical, cosmetic). A migration
   requires zero auth/settings blockers. In Agor the executor cwd is the branch (re-exposed at its
   real path), so cwd registries do not imply that a tool home itself is path-dependent.

6. ✅ **Soft-deprecate** — the daemon logs a deprecation warning on `strict`/`insulated` startup
   pointing to the migration script (`apps/agor-daemon/src/startup.ts`).
7. **Hard-deprecate** — refuse to start in those modes (or auto-map → `sandbox` with a loud warning).
8. **Delete** — remove sudoers, `unix/run-as-user`, the sudo paths in `unix/user-manager`, password
   sync, and per-branch group lifecycle. The payoff. **Deliberately held for a fast-follow** until
   `sandbox` has real prod miles (keeps a fallback through the Agor Cloud rollout).

**`unix_user_mode` after this:** local collapses toward `simple` + `sandbox` on/off. `delegated` /
`executor_command_template` remain the identity-to-substrate hand-off for hosted/k8s
([[docker-executor-mode]]).

---

## 8. File map (implemented)

- `packages/core/src/config/types.ts` — `AgorSandboxSettings` incl. `home_mode`.
- `packages/core/src/config/sandbox-policy.ts` — pure `resolveBwrapArgs()` (shared + `per_user` overlay branches); `.git`-pointer parser removed (+ tests).
- `packages/core/src/config/config-manager.ts` — `AGOR_SANDBOX_ENABLED` → `enabled`, `AGOR_SANDBOX_HOME_MODE` → `home_mode` (in `resolveEffectiveConfig`).
- `apps/agor-daemon/src/register-services.ts` — resolves authoritative `repo.local_path` (→ `sandboxBaseRepoPath`) + per-owner store path (→ `sandboxHomeStore`) into `payload.params`.
- `apps/agor-daemon/src/utils/spawn-executor.ts` — wrap at `spawnExecutorLocal` (keys on `payload.params.cwd`); threads `sandboxBaseRepoPath`/`sandboxHomeStore`.
- `apps/agor-daemon/src/utils/sandbox-wrap.ts` — `buildSandboxWrap()`: takes authoritative paths (no disk parsing), `mkdir`s the per-user store, resolves, drops missing-target masks, emits `bwrap …`.
- `packages/executor/src/sdk-handlers/codex/prompt-service.ts` — `AGOR_OUTER_SANDBOX` → `sandboxMode=danger-full-access` (no nesting).
- `apps/agor-cli/src/commands/doctor.ts` + `src/lib/sandbox-diagnostics.ts` — `agor doctor` sandbox row (bwrap check) (+ tests).
- `apps/agor-cli/src/commands/init.ts` — one-shot enable prompt.
- `docker/Dockerfile` — `bubblewrap` in the dev image.
- `docker-compose.yml` + `.agor.yml` — `AGOR_SANDBOX_ENABLED` + `AGOR_SANDBOX_HOME_MODE` passthrough + `sandbox` / `sandbox-peruser` dev variants.
- `packages/core/src/config/types.ts` — `UnixUserMode` adds `'sandbox'` (the strict-replacement switch).
- `packages/core/src/config/config-manager.ts` — `unix_user_mode: sandbox` derivation (implies RBAC + enabled per-user sandbox + fail-closed) + `AGOR_SANDBOX_HOME_MODE` env.
- `packages/core/src/unix/user-manager.ts` — `resolveUnixUserForImpersonation` `case 'sandbox'` (no impersonation, like `simple`).
- `packages/core/src/{types/user.ts,db/schema.{sqlite,postgres}.ts,db/repositories/users.ts}` + `drizzle/{sqlite/0086,postgres/0083}_add_user_filesystem_home.sql` — `users.filesystem_home` (overlay source override).
- `packages/core/src/types/opencode-auth.ts` — `OpenCodeCredentialIsolation.mode` adds `'sandbox'`.
- `apps/agor-daemon/src/startup.ts` — `sandbox` startup banner + `strict`/`insulated` soft-deprecation warning.
- `scripts/sandbox-home-migration-preflight.sh` — read-only pre-flight for the per-user home relocation (three-tier home-path scan; hit counts only, no contents).
- `scripts/strict-to-sandbox-migration.sh` — the strict→sandbox migration (dry-run default; sets `filesystem_home` in place, chowns, flips the mode, optional OS-plumbing teardown).

## 9. Non-goals (v1)

Network egress control (left to tool configs); impersonated/`strict` spawns; macOS/Seatbelt;
Windows; multi-host HA / hostile multi-tenant (that's the container/k8s Tier-2 path).
