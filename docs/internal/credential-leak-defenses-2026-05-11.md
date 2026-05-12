# Credential-in-git-config: Threat Model & Defense Stack

**Date:** 2026-05-11
**Author:** Claude (Opus 4.7) for Max
**Status:** Layer A implemented in this PR; Layers B–C tracked in companion worktrees (see §6).
**Decision asked:** Approve the Layer A direction shipped here (`GIT_CONFIG_PARAMETERS` injection + `ensureGitRemoteUrl` helper) and confirm Layer B is dropped in favor of A+C.

---

## TL;DR

Agor worktrees share `.git/config` with their base repo. On a multi-tenant host this means **any agent writing a credential into a base repo's `.git/config` exposes that credential to every other agent on every other worktree off that base** — the canonical multi-tenant credential-leakage bug. An internal audit confirmed this is not theoretical; specifics are tracked off-tree.

No single defense closes the problem. We propose (and partially ship) a **three-layer stack**:

1. **Hard-stop the transfer side** — `GIT_CONFIG_PARAMETERS` injected at daemon startup and forwarded across the sudo boundary into every executor. The default pairs include `transfer.credentialsInUrl=die` (git 2.41+) plus a handful of low-breakage-risk CVE-mitigation defaults (protocol allowlist for `file://` and `ext::`, HFS/NTFS protection). The credential-in-URL guard is narrow by design — it only covers `remote.<name>.url` (vector 1), explicitly NOT `pushurl` or `branch.X.remote` per git's docs. But `remote.origin.url` is by far the most common leak target (every `gh repo clone` / `git remote add` writes there), so the high-frequency case is closed; the rest is covered by Layer A.5 (realignment) + the heartbeat scan + Layer C. **Shipped in this PR** — `security.git_config_parameters` in `~/.agor/config.yaml`, configurable via `extras` (merge with defaults) or `override` (replace defaults).
2. **Self-heal the canonical origin** — `ensureGitRemoteUrl(repoPath, "origin", expectedUrl)` realigns `remote.origin.url` to the DB's canonical value, leaving user-added remotes untouched. **Shipped in this PR** with wiring at two integration points: after every task terminal transition (so the *next* agent on any sibling worktree starts from a clean `.git/config`), and after every `repos.patch` that changes `remote_url` or signals `clone_status: 'ready'`. The helper handles the multi-value case (a key with multiple `url = …` lines, e.g. via `git config --add`) via raw `--get-all` / `--replace-all`.
3. **Eliminate the cross-user reach** with per-agent Unix UIDs so one agent literally cannot read another user's `gh` state or env-injected tokens. The `address-issue-1140-impersonation-abstraction` worktree is the implementation arm.

**Dropped from the original four-layer proposal:** filesystem ACLs on `.git/config`. The legitimate-write set turned out wider than initially scoped (agent-driven `remote add`, branch tracking, husky hooks, submodule init), and the wins were largely subsumed by Layer 1 (`die` makes the artifact useless) + Layer 3 (per-uid contains cross-user reach). The cost-benefit no longer favored an MCP-mediated write path for every `.git/config` touch.

A detection / heartbeat scan over `.git/config` files remains a useful follow-up but is its own surface (alert plumbing, cron scheduling, UI notification) — separate PR.

---

## 1. Why this matters

### 1.1 The architectural exposure

Agor's worktree model is `git worktree add` off a single base clone at `~/.agor/repos/<owner>/<repo>/`. The base repo's `.git/config` is the canonical config for *all* of its worktrees — `worktree.<name>.git` is a thin metadata directory under `.git/worktrees/<name>/`, but `remote.*`, `branch.*`, `http.*` all resolve through the shared base.

The current daemon-issued path (`packages/core/src/git/index.ts:351-419`, the `createGit()` helper, post-`git-extraheader-refactor`) is clean: tokens flow as per-process `http.extraheader` env vars, never persisted. But the leaks are not from the daemon — they are from **side channels**:

- Agent processes invoking `gh auth login` (which writes `credential.helper` or persists tokens to `~/.config/gh/`)
- Agents running `git remote add` / `git remote set-url` with token-bearing URLs
- Tools (VS Code, `gh repo clone`, manual user commands) that bake creds into URLs on the assumption they are operating in a single-user environment
- Submodule clone flows that historically required `credential.helper=store`

Once any of those write a token into `.git/config`, **every subsequent operation by any agent on any worktree** picks it up.

---

## 2. Phase 1 — Threat model: every way a token persists in git state

Below is the exhaustive list of paths a token can take into git's view of the world.

| # | Vector | Form | Persistence scope | Currently caught by | Caught by proposed stack |
|---|---|---|---|---|---|
| 1 | `[remote "X"] url = https://USER:TOK@host/…` | URL credentials | Per-repo `.git/config`, shared across all worktrees | Nothing | Option 4 (transfer hard-stop), Option 1 (ACL), Option 6 (scan) |
| 2 | `[branch "X"] remote = https://USER:TOK@host/…` (URL in a name-only key) | URL credentials, misused key | Per-repo `.git/config` | Nothing | Option 1 (ACL), Option 6 (scan). **Not** caught by Option 4 — git's `transfer.credentialsInUrl` is scoped to `remote.<name>.url` only, per [git's docs](https://git-scm.com/docs/git-config#Documentation/git-config.txt-transfercredentialsInUrl). |
| 3 | `[remote "X"] pushurl = https://USER:TOK@host/…` | URL credentials, push side | Per-repo | Nothing | Option 1, Option 6. **Not** caught by Option 4 — git explicitly excludes `pushurl` from `transfer.credentialsInUrl`. |
| 4 | `[http "https://github.com/"] extraheader = Authorization: Basic <b64>` (persisted in config, not env) | Header in config | Per-repo or global config | Nothing | Option 1 (ACL), Option 6 (extended regex) |
| 5 | `[credential] helper = store --file=<path>` + the credential file | Helper-managed plaintext store | Helper file (`~/.git-credentials` or per-repo) | Nothing | Option 6 with extended regex; Option 8 (per-uid isolation) |
| 6 | `~/.git-credentials` (default store-helper location) | Plaintext credential cache | Per-uid home dir | Nothing | Option 8 (per-uid isolation); Option 6 extended |
| 7 | `~/.netrc` (curl/git fallback, `machine HOST login X password TOK`) | Plaintext netrc | Per-uid home dir | Nothing | Option 8; Option 6 extended |
| 8 | `[url "https://USER:TOK@host/"] insteadOf = https://host/` | URL-rewrite baking | Per-repo or global | Nothing | Option 1, Option 6. **Partially** by Option 4 — only if the rewritten target lands in `remote.<name>.url`; rewrites used on argv URLs bypass the check. |
| 9 | `~/.config/gh/hosts.yml` (GitHub CLI's auth state) | Per-uid plaintext | Per-uid home dir | Nothing | Option 8 (the only complete fix); Option 6 extended for visibility |
| 10 | `.git/hooks/<name>` containing inline tokens | Hook script | Per-repo `.git/hooks/` (NOT shared across worktrees — each worktree has its own hooks dir at `.git/worktrees/<name>/hooks/`, but `core.hooksPath` could re-share) | Nothing | Option 1 if extended to hooks; Option 6 with a hooks scan |
| 11 | `core.sshCommand = ssh -i /path/to/key …` | Key path (attribution shift, not direct cred leak) | Per-repo | `createGit()` overrides it for daemon-issued ops only | Option 8 (agent ops too) |

**Coverage scoring** (used below): each defense option closes some subset of {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}. With the corrected scope for Option 4 (the `transfer.credentialsInUrl` config key only checks `remote.<name>.url`, not `pushurl` / `branch.X.remote` / argv), the recommended stack closes vector 1 hard at the transfer layer, and depends on Layer A.5 (`ensureGitRemoteUrl`) + the heartbeat scan + Option 8 for the remaining vectors.

---

## 3. Phase 2 — Defense options evaluated

Eight options on the table. Each is evaluated against: **what it closes**, **what it costs** (engineering + operational + UX), **bypass paths**, and **interaction with the in-flight worktrees**.

### 3.1 Option 1 — Filesystem ACLs on `.git/config`

**Mechanism.** Make `.git/config` (and `.git/hooks/`) owned by a uid that no agent process runs as, with mode `0644` (world-readable, owner-writable). Daemon issues a process under that uid via `sudo -u` when a legitimate config write is needed; agents must route through a daemon-mediated MCP tool to make config changes.

**Variants considered:**
- POSIX ACLs via `setfacl` — gives per-uid write deny without changing ownership. Cleaner but requires the fs to be mounted with `acl` (often true on ext4, not always on overlayfs in containers).
- `chattr +i` (immutable bit) — file becomes unwritable even by root without first clearing the bit. Heavy and brittle; rejects too much (we *do* want admin-mediated writes).
- Bind-mount `.git/config` read-only over itself — possible but cumbersome and breaks legitimate writes entirely.
- **Chosen variant: chown + mode + daemon-mediated writes.** Simple, audit-friendly, composes naturally with the in-flight impersonation work.

**Legitimate-write set.** The daemon-mediated MCP path must support, at minimum:
- `git remote add` / `git remote set-url` — already covered by `agor_repos_update` (in-flight, `fix-private-repo-clone-and-update`)
- `git config user.email` / `user.name` — set once at clone time, can be done by the daemon at create
- `git config branch.<name>.remote` / `merge` — written by `git push -u`. **This is the tricky one.** Either (a) the daemon proxies pushes that need upstream-tracking, (b) we accept that `--set-upstream` requires a daemon round-trip, or (c) we only ACL `[remote]` and `[http]` keys, not `[branch]`. Vector #2 (URL-in-`branch.X.remote`) means option (c) is insufficient — we need to cover `[branch]` too.

**Closes vectors:** 1, 2, 3, 4, 8, 10 (when extended to hooks).
**Does not close:** 5, 6, 7, 9, 11 (those live in user-homedir paths, not in `.git/config`).

**Cost.**
- High design cost: the daemon needs a stable, RBAC-aware "edit my repo config" surface. Half of it (`agor_repos_update`) is in flight.
- Medium operational cost: needs root or a dedicated daemon uid + sudoers entry. Already required for `unix_user_mode: insulated|strict`; same plumbing.
- UX cost: agents that today run `git remote add upstream <url>` directly will fail until they learn the MCP path. We document the pattern, surface a clear error message ("`.git/config` is daemon-managed — use `agor_repos_update`").

**Bypass paths.**
- Agent writes to `.git/config.lock` and races a rename — defeated by the chown (rename target inherits parent dir's owner, but the rename itself requires write on the dir; if `.git/` is daemon-owned the rename fails).
- Agent uses `git push https://TOK@host/…` directly on argv, bypassing config entirely — **this is not closed by Option 1; it's closed by Option 8 (cross-uid token reachability)**. Important: Option 1 closes the *persistence* path that creates blast-radius for *the next agent*. It does not stop a single agent from leaking its own token over the wire.

**Coordination.** **Do not ship in this PR.** Needs:
- The impersonation abstraction (`address-issue-1140-impersonation-abstraction`) to standardize how daemon-uid vs agent-uid is determined.
- An expanded `agor_repos_update` covering branch-tracking writes.
- A clear sudoers entry pattern (extend `docker/sudoers/agor-daemon.sudoers`).

This is its own worktree, probably 2–3 PRs. **This design doc is the spec.**

### 3.2 Option 2 — Independent clones per worktree

**Mechanism.** Rip out `git worktree add`; each Agor "worktree" becomes a full `git clone`.

**Coverage analysis.** Surprisingly limited. Per-worktree isolation prevents one tainted base from poisoning sibling worktrees off the same base — but each clone is still writable by the agent running in it. An agent that embeds a token in clone A's `.git/config` will still have that token persisted for the next agent assigned to clone A. The *blast radius* is reduced from "all worktrees of a base" to "one worktree". Real, but narrow.

**Closes vectors:** None completely. Reduces blast radius of 1–4, 8, 10 by ~1 order of magnitude.
**Does not close:** Anything in-clone, plus 5, 6, 7, 9, 11.

**Cost.**
- Disk: 10–100× for large repos (Superset is several GB; ten worktrees = tens of GB extra).
- Time: spinning a new worktree off main drops from seconds to minutes for big repos.
- Code: significant refactor of the worktree service, clone path, env service.

**Verdict.** Not worth the cost given that Option 1 + Option 8 close the same vectors more thoroughly with much smaller cost. **Reject.**

### 3.3 Option 3 — Wrapping git commands to force user creds

**Mechanism.** Every daemon-spawned git invocation goes through a helper that strips ambient `GITHUB_TOKEN` from the env, derives the calling user, fetches their per-user token from the encrypted store, and injects it as a per-process `http.extraheader` env var scoped to the resolved host.

**Status.** **Already shipping.** This is exactly what the `git-extraheader-refactor` worktree did (landed in main per the exploration agent). `packages/core/src/git/index.ts:351-419` is the canonical injection point. `apps/agor-daemon/src/utils/git-impersonation.ts` and `git-shell-capture.ts` wire it through. `address-issue-1140-impersonation-abstraction` (also landed) makes the gating conditional on the configured Unix mode.

**Closes vectors:** Closes nothing on its own — it changes the *delivery mechanism*, not the persistence surface. But it eliminates one whole class of *future* leaks: daemon-issued git commands will never write tokens to `.git/config` because they never know the token as anything other than a per-process env var.

**Does not close.** Agent-issued `git push` / `git remote add` / `gh auth login`. The agent is its own process; the daemon's wrapper doesn't intercept it.

**Cost.** Already paid.

**Verdict.** **Already done.** This design doc treats it as foundational. Cite it as the proof that daemon-side is clean and the remaining work is agent-side + persistence-side.

### 3.4 Option 4 — `transfer.credentialsInUrl=die` (the easy hard-stop)

**Mechanism.** Built into git 2.41+. Set it globally and **git will refuse any transfer operation (fetch / push / clone / archive / ls-remote) that uses a URL with embedded credentials**, both when the URL is on argv and when the URL is read from config (`remote.X.url`, `branch.X.remote` URL form, `url.X.insteadOf` rewrites, submodule URLs).

**Critical detail to understand.** It does not block the *write* (you can still `git remote set-url origin https://TOK@...` — that's not a transfer op). It blocks the *use*. Tainted configs become *useless* for transfer. Combined with the heartbeat scan (Option 6) that catches the write within minutes, the loop closes: an agent that taints config gets nothing out of it, and the next scan removes it.

**Three places to set it:**
1. **Per daemon-issued op** — extend `createGit()`'s injected `GIT_CONFIG_KEY_n` list (`packages/core/src/git/index.ts:387`) to include `transfer.credentialsInUrl=die`. **Already a one-line change** — see Appendix C.1.
2. **In every executor's env** — set `GIT_CONFIG_PARAMETERS="'transfer.credentialsInUrl=die'"` (single-quoted, the protocol git expects) in the env-file the daemon writes for spawn (`apps/agor-daemon/src/utils/spawn-executor.ts:295-304`). This blankets every git call the agent makes inside its sandbox.
3. **System-wide** — `git config --system transfer.credentialsInUrl die` writes to `/etc/gitconfig`. Useful for hosts where (1)+(2) don't cover every entrypoint (interactive shells, cron, etc.). Document for ops; do not require it.

**Closes vectors:** 1, 2, 3, 8 at the transfer layer (and 4 in argv form). Renders the persisted token *useless* even when the write went through. Does not close persistence-only leaks (5, 6, 7 — those are credential-helper paths, not URL paths).

**Does not close.** Persistence itself; per-uid leaks (9); hooks (10); attribution shifts (11).

**Bypass paths.** Agent uses `--config` flag on its own git call: `git -c transfer.credentialsInUrl=allow fetch https://TOK@…`. *True bypass*, but loud — it's evidence of intent, not accident. The heartbeat scan still catches the persisted artifact.

**Cost.** Two file edits, ~6 lines, fully reversible. No UX cost. Tests required (verify the env-var protocol parses correctly through simple-git's `unsafe.allowUnsafeConfigEnvCount` path — already permitted in `createGit()`).

**Verdict.** **Ship today, in a follow-up PR after this design is approved.** Highest-leverage single change in the whole stack.

### 3.5 Option 5 — Pre-push hook (per-repo guard)

**Mechanism.** Install a `pre-push` hook in every base repo's `.git/hooks/` (and worktree hooks dirs) that runs `git config --get-regexp '^(remote|branch|http|url)\.' | grep -E 'https?://[^/@]+@'` and aborts on hit.

**Bypass.** `git push --no-verify` and hook deletion (agent has write to `.git/hooks/` unless we ACL it). The hook is also worktree-scoped (each `worktree add` gets its own hooks dir), so we'd need to write it into every worktree creation path.

**Closes vectors:** 1, 2, 3, 8 — at push time, *only if the agent doesn't bypass*.

**Cost.** Low to write, high to maintain (every clone needs the hook installed; agents can delete it; `core.hooksPath` can re-point it).

**Verdict.** **Skip in favor of Option 4.** `transfer.credentialsInUrl=die` is the same idea (block the transfer) with stronger semantics, no bypass via `--no-verify`, and one config line instead of a maintained hook script.

### 3.6 Option 6 — Heartbeat scan + alert

**Mechanism.** A periodic (every 10 min? hourly?) job that:
1. Walks `~/.agor/repos/**/.git/config`, `~/.agor/worktrees/**/.git/config`, `~/.git-credentials` for any user with `unix_username` set, and (if accessible) `~/.config/gh/hosts.yml`.
2. Greps for the leak regex set: `(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}`, plus the `://user:tok@host` URL form, plus `extraheader = Authorization:`.
3. On a hit: **(a)** copy the offending file to `/tmp/git-config-leak-quarantine-<ts>/`, **(b)** scrub the offending lines via `git config --unset`, **(c)** emit a structured event the daemon surfaces in the UI (and to Slack/Discord if configured), **(d)** flag the worktree's last actor for review.

**Closes vectors:** Detects 1, 2, 3, 4, 5, 6, 8 (any text-pattern-matchable form). Does *not* prevent the leak — it bounds the window of exposure.

**Cost.**
- ~80 LOC bash or Node script.
- A daemon job-scheduler hook (we already have one — `scripts/archive-old-gateway-sessions.ts` runs on a cron-style schedule via the daemon, exact integration TBD).
- Alert channel: piggyback on existing Slack/Discord notification surfaces if present, else just a daemon log + UI notification.

**Verdict.** **Ship in the same follow-up PR as Option 4.** Detection complements prevention — even with Option 4, we want to know when an agent *tried* to persist a token.

### 3.7 Option 7 — Strip credential-bearing config keys at read time

**Mechanism.** Every git invocation gets wrapped to `git config --unset` the offending keys before the operation runs, or rewrites them on the fly via `GIT_CONFIG_COUNT/KEY/VALUE` blank overrides.

**Verdict.** Fiddly, fragile, semantically equivalent to "fail loudly via Option 4 then heal via Option 6". The combination is strictly better. **Reject.**

### 3.8 Option 8 — Per-user Unix UID isolation (the gold standard)

**Mechanism.** Each Agor user gets their own Unix uid. Agent processes spawned on that user's behalf run as that uid via `sudo -u`. Each uid has its own `$HOME`, its own `~/.config/gh/`, its own `~/.git-credentials`, its own `~/.netrc`. Cross-user filesystem reach is blocked by Unix permissions: user A's agent literally cannot read user B's tokens, regardless of what git config they end up in.

**Closes vectors:** 5, 6, 7, 9 (per-uid homedir leaks), 11 (per-uid sshCommand), plus reduces blast radius of 1, 2, 3, 4, 8, 10 to "the user who introduced the leak can re-poison their own configs, but not others'."

**Status.** **In flight as `address-issue-1140-impersonation-abstraction`** (helpers landed; full per-user impersonation gated behind `unix_user_mode: strict`). This is the existing direction; this design doc reaffirms it as the long-term anchor.

**Cost.** High and well-understood. Sudoers config, per-user account provisioning, careful audit of every "daemon as root" code path. The existing RBAC + Unix isolation guide (`context/guides/rbac-and-unix-isolation.md`) carries the design.

**Verdict.** **Continue the in-flight work.** This design doc does not change its scope; it identifies the credential-leakage threat model as one of the strongest justifications for landing strict mode by default in team deployments.

---

## 4. Phase 3 — Recommended defense stack

Three layers; Layer A ships here.

### Layer A — Shipped in this PR

| # | Deliverable | Where | Closes |
|---|---|---|---|
| A.1 | `security.git_config_parameters` config key (extras/override two-tier) + safe defaults (`transfer.credentialsInUrl=die`, `protocol.file.allow=user`, `protocol.ext.allow=never`, `core.protectHFS=true`, `core.protectNTFS=true`) + redaction-safe logging via `renderGitConfigParametersForLog`. `fsckObjects` is deliberately NOT defaulted — too prone to refusing legacy repos with technically-broken commits; operators who want it opt in via `extras`. | `packages/core/src/config/types.ts` (`AgorSecuritySettings.git_config_parameters`), `packages/core/src/config/security-resolver.ts` (`DEFAULT_GIT_CONFIG_PARAMETERS`, `getDefaultGitConfigParameters`, `resolveGitConfigParameters`, `gitConfigParameterLooksSecret`, `renderGitConfigParametersForLog`), `packages/core/src/git/index.ts` (`buildGitConfigParameters` — the protocol encoder; reuses `escapeShellArg` from `packages/core/src/unix/run-as-user.ts`) | Foundation for A.2 / A.3 |
| A.2 | Set `process.env.GIT_CONFIG_PARAMETERS` at daemon startup | `apps/agor-daemon/src/index.ts` — right after config load, before any child-process spawn | Covers daemon-direct git via `createGit()`; covers any tool that internally invokes git (husky, gh, npm postinstall) since they all inherit `process.env` |
| A.3 | Forward `GIT_CONFIG_PARAMETERS` through the `sudo -u` boundary in the spawn-executor allowlist | `apps/agor-daemon/src/utils/spawn-executor.ts` `essentialEnv` block | Covers agent-issued git too |
| A.4 | `env_keep += GIT_CONFIG_PARAMETERS` for sudo paths that don't go through the spawn-executor allowlist (defence in depth) | `docker/sudoers/agor-daemon.sudoers` | Future sudo callsites can't accidentally drop the hardening |
| A.5 | `ensureGitRemoteUrl()` primitive + `ensureRepoOriginAlignedById` / `ensureRepoOriginAlignedForRepo` daemon wrappers + 2 wiring sites | `packages/core/src/git/index.ts` (primitive, multi-value-aware), `apps/agor-daemon/src/utils/realign-repo-origin.ts` (wrappers + `realignRepoOriginAfterPatchHook` factory), `apps/agor-daemon/src/services/tasks.ts` (task-terminal-transition site), `apps/agor-daemon/src/register-hooks.ts` (`repos.after.patch` site) | 1 (self-heal), 8 (when `insteadOf` is on `origin`) |
| A.6 | Tests | `packages/core/src/git/credential-env.test.ts` (protocol encoder + real-git E2E, one git-version-gated), `packages/core/src/config/security-resolver.test.ts` (defaults, extras/override semantics, redaction), `apps/agor-daemon/src/utils/realign-repo-origin.test.ts` (wrapper + hook filter) | — |

**Closes via Layer A defaults:** vector 1 (`remote.<name>.url` with creds) at transfer time + self-heal on drift via realignment. Vectors 2/3/8 are detected (not transfer-blocked) by the heartbeat follow-up; per-uid (Layer C) covers the rest.
**Requires git 2.41+ for the `transfer.credentialsInUrl=die` enforcement.** On older git the env var is silently ignored (no harm, no help) and the other pairs (`protocol.*`, `core.protectHFS/NTFS`) still apply. The daemon logs the resolved `GIT_CONFIG_PARAMETERS` at startup (with URL userinfo redacted) so operators can confirm what's active.

### Layer B (proposed, NOT shipping) — Filesystem ACLs on `.git/config`

**Dropped.** The legitimate-write set is wider than initially scoped: agents legitimately need `git remote add upstream`, `git push -u` writes branch tracking, husky writes `core.hooksPath`, `git submodule init` syncs `.gitmodules` → `.git/config`, plus `safe.directory` edge cases. Mediating all of these through MCP is a significant lift with marginal additional coverage on top of Layer A + Layer C. The original write-block role is split between:
- Layer A.1 (`transfer.credentialsInUrl=die`) — tainted URLs become useless even when persisted
- Layer A.5 (`ensureGitRemoteUrl`) — canonical origin self-heals on the high-frequency leak target
- Layer C (per-uid isolation) — cross-user reach blocked at the OS layer

If a future incident shows residual within-user contamination is the dominant failure mode, the filesystem-ACL idea can be revived — until then, it's overkill.

### Layer C — In flight as `address-issue-1140-impersonation-abstraction`

| # | Deliverable | Status | Closes |
|---|---|---|---|
| C.1 | Per-user Unix UIDs default for team deployments | `address-issue-1140-impersonation-abstraction` in flight | 5, 6, 7, 9, 11 + blast-radius cap |
| C.2 | Sudoers patterns for strict mode on Postgres deployments | Documented in `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`; needs Postgres-specific addendum | (operational) |
| C.3 | Default `unix_user_mode: strict` for public/Railway deployments | Detection guard already exists for `allowAnonymous` in `apps/agor-daemon/src/index.ts:213-217`; extend it | Defense-in-depth |

### Heartbeat detection scan — separate follow-up PR

Originally bundled in Layer A. Carved out because the surface is its own thing: cron scheduling, alert plumbing (Slack / Discord / UI notification), quarantine action gated on a config flag. Same regex set used during the original audit. Tracking in a follow-up.

### Layer D — Discipline rules (codify, enforce in review)

1. **Never embed tokens in URLs in Agor code.** Daemon-side enforced by `createGit()` (already done). CI lint rule on the repo: grep for `://.*:.*@` in any string literal in `packages/`, `apps/`. Fail the build.
2. **Always use per-process `http.extraheader` env-var delivery.** Tested by `credential-env.test.ts`. Document in `context/concepts/security.md`.
3. **No `credential.helper=store`-style persistent helpers** anywhere in the daemon's git invocation paths or in spawned agent envs.
4. **All daemon-mediated config writes go through MCP tools** with audit logs. No silent `simple-git`-from-anywhere writes to `.git/config`.
5. **Sensitive env-file writes are 0600 + owned by target uid** (already done in `spawn-executor.ts:295-304`).

---

## 5. Defense-coverage summary

| Vector | Pre-Layer-A | After Layer A (shipped here) | After Layer C |
|---|---|---|---|
| 1 — `remote.X.url` with creds | Unprotected | Transfer-blocked (`transfer.credentialsInUrl=die`) + canonical self-heal via `ensureGitRemoteUrl` | Per-uid contained |
| 2 — `branch.X.remote` URL form | Unprotected | Detected only (heartbeat follow-up); transfer hardening does NOT cover this key per git's docs | Per-uid |
| 3 — `pushurl` with creds | Unprotected | Detected only (heartbeat follow-up); transfer hardening explicitly excludes `pushurl` per git's docs | Per-uid |
| 4 — `http.*.extraheader` persisted | Unprotected | Detected via heartbeat (follow-up PR) | Per-uid |
| 5 — `credential.helper=store` + file | Unprotected | Detected (heartbeat) | Per-uid contained |
| 6 — `~/.git-credentials` | Unprotected | Detected (heartbeat) | Per-uid contained |
| 7 — `~/.netrc` | Unprotected | Detected (heartbeat) | Per-uid contained |
| 8 — `url.X.insteadOf` token bake | Unprotected | Partial: transfer-blocked when the rewritten URL flows through `remote.X.url`; not on argv | Per-uid |
| 9 — `~/.config/gh/hosts.yml` | Unprotected | (per-uid by default) | **Closed** |
| 10 — `.git/hooks/<name>` with creds | Unprotected | Detected if heartbeat extended to hooks | Per-uid |
| 11 — `core.sshCommand` attribution | Daemon-side overridden | Same | Per-uid (agent-side too) |

---

## 6. Coordination matrix — in-flight worktrees

This design doc is the spec. The implementation lives elsewhere:

| Worktree | Status (as of 2026-05-11) | Owns | This design doc adds |
|---|---|---|---|
| `git-extraheader-refactor` | Landed | Per-process `http.extraheader` delivery, daemon `~/.gitconfig` neutralization, token-shape validation | Reaffirms as foundational. No new asks. |
| `fix-private-repo-clone-and-update` | Merged (#1155); follow-up commits in worktree | `agor_repos_update` MCP tool, clone-status surfacing, error categorization | Asks to **extend** the tool's covered fields to include `branch.X.remote/merge` (Layer B.2). Tracking issue to be filed when this design is approved. |
| `address-issue-1140-impersonation-abstraction` | Landed | `isUnixGroupRefreshNeeded()`, gated impersonation in simple mode, sudoers patterns | Reaffirms as the gating dependency for Layer B and the implementation arm of Layer C. No new asks until Layer B kicks off. |
| `fix-archive-git-clean-impersonation` | Landed | `spawnSync` over `execSync` for cleanup, symlink-safe chown/chmod, sudoers docs | Adjacent — confirms the "subprocess hygiene" pattern this stack relies on. |
| **`design-git-config-leak-defenses` (this worktree)** | This PR | The threat model + stack + Layer A spec | Becomes a `context/concepts/credential-leak-defenses.md` after approval. |

---

## 7. Open questions / follow-up tracking

For follow-up PRs:

1. **Heartbeat scan + alert (the carved-out follow-up).** Cadence (recommend hourly + manual `agor security scan`), auto-clean default (recommend read-only-detect for the first release), alert channel (re-use existing event bus + UI notification). The heartbeat is the catchall for repos this PR's per-task / per-patch realignment doesn't touch, plus the non-`remote.X.url` vectors (2, 3, 4, 5, 6, 7, 10) that `transfer.credentialsInUrl` doesn't guard.
2. **Branch-tracking writes through MCP.** If Layer B is ever revisited, the daemon would need to mediate `git push --set-upstream`. Two options: (a) wrap the push in a daemon RPC, (b) write `branch.X.remote/merge` post-push via a "fixup my tracking" RPC. (b) is simpler but racy.
3. **CI lint for credential-in-URL.** Layer D.1 needs a CI grep rule. Trivial but needs a home — extend `pnpm lint`, or new `pnpm security:check`.
4. **Public-deployment guard extension.** Today the daemon refuses to boot in `allowAnonymous` + public-bind combos (`apps/agor-daemon/src/index.ts:213-217`). Extend to refuse `unix_user_mode: simple` + public-bind once Layer C lands.
5. **Git version requirement note.** `transfer.credentialsInUrl=die` requires git 2.41+. On older git the env var is silently ignored. Consider a daemon startup warning if `git --version` reports < 2.41 (deferred — current default still applies the other protocol/fsck hardening pairs that work on older git).

---

## Appendix A — Incident evidence

Specific forensics tracked in an internal-only document. The threat model in §2 is informed by, but does not reproduce, those findings.

---

## Appendix B — Cleanup procedure (codify after this design lands)

For the operational runbook:

```bash
# 1. Find all leaks
grep -rEHn '(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+|://[^/]+:[^/]+@' \
  ~/.agor/repos/**/.git/config \
  ~/.agor/worktrees/**/.git/config

# 2. Back up before modifying
mkdir -p /tmp/git-config-leak-backup-$(date -u +%Y%m%dT%H%M%SZ)/

# 3. For each leak, unset the offending key
#    [remote "X"] url     -> git -C <repo> remote set-url X <clean-url>
#    [branch "X"] remote  -> git -C <repo> config --unset branch.X.remote
#                             (or rewrite to a remote name)

# 4. Revoke the exposed token at github.com (treat all tokens as compromised)

# 5. Re-grep to confirm clean
```

---

## Appendix C — Layer A implementation reference

Layer A is implemented in this PR. The pointers below name the canonical surfaces a reviewer / future maintainer should look at:

| Concern | File |
|---|---|
| Config type + safe defaults (`transfer.credentialsInUrl=die` + protocol allowlist + HFS/NTFS pairs; fsck deliberately not defaulted) | `packages/core/src/config/types.ts` (`AgorSecuritySettings.git_config_parameters` — `extras` / `override` two-tier) |
| `DEFAULT_GIT_CONFIG_PARAMETERS`, resolver, redaction-for-log | `packages/core/src/config/security-resolver.ts` (`getDefaultGitConfigParameters`, `resolveGitConfigParameters`, `gitConfigParameterLooksSecret`, `renderGitConfigParametersForLog`) |
| `GIT_CONFIG_PARAMETERS` protocol encoder | `packages/core/src/git/index.ts` (`buildGitConfigParameters`, reusing `escapeShellArg` from `packages/core/src/unix/run-as-user.ts`) |
| Daemon-side realignment wrappers + hook factory | `apps/agor-daemon/src/utils/realign-repo-origin.ts` (`ensureRepoOriginAlignedById`, `ensureRepoOriginAlignedForRepo`, `shouldRealignAfterRepoPatch`, `realignRepoOriginAfterPatchHook`) |
| Daemon-process env injection | `apps/agor-daemon/src/index.ts` (right after config load) |
| Sudo-boundary forward to executors | `apps/agor-daemon/src/utils/spawn-executor.ts` (`essentialEnv` allowlist) |
| Sudoers belt for ad-hoc sudo callers | `docker/sudoers/agor-daemon.sudoers` (`env_keep += "GIT_CONFIG_PARAMETERS"`) |
| Canonical-origin self-heal helper | `packages/core/src/git/index.ts` (`ensureGitRemoteUrl`) |
| Tests (unit + E2E env-var contract + realigner) | `packages/core/src/git/credential-env.test.ts` |

## Appendix D — Heartbeat scan sketch (follow-up PR)

Not in this PR. Kept here as a starting point for the next worktree that picks this up:

```ts
// scripts/scan-git-config-leaks.ts
import { glob } from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const TOKEN_RE = /(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/;
const URL_CRED_RE = /:\/\/[^/\s@]+:[^/\s@]+@/;
const HEADER_RE = /^\s*extraheader\s*=\s*Authorization:/im;

const targets = await glob(
  [
    `${homedir()}/.agor/repos/**/.git/config`,
    `${homedir()}/.agor/worktrees/**/.git/config`,
  ],
  { dot: true, suppressErrors: true }
);

const findings: { file: string; line: number; match: string }[] = [];
for (const file of targets) {
  const text = await readFile(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (TOKEN_RE.test(line) || URL_CRED_RE.test(line) || HEADER_RE.test(line)) {
      findings.push({ file, line: i + 1, match: line.replace(TOKEN_RE, '<REDACTED>') });
    }
  });
}

if (findings.length > 0) {
  // Surface via daemon event bus + log + (optionally) Slack/Discord
  // Auto-clean is gated behind a config flag — default off for the first release.
  console.error(`[security] ${findings.length} git-config leak(s) detected`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.match}`);
  process.exit(2);
}
```

Integrate as a daemon-scheduled job alongside `scripts/archive-old-gateway-sessions.ts`. Default cadence: hourly. Output channels: daemon log + UI notification (re-use the existing `app-events` bus).
