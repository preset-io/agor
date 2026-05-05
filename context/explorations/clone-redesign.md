# Per-user git auth & impersonated clone

**Status:** Implemented (PR #1088)
**Branch:** `feat/per-user-impersonated-clone`
**Supersedes:** #1069 (the HTTPS→SSH fallback approach — see "Why not fallback" below)

---

## Goal

Make git operations in Agor honor the requesting user's identity and credentials, end-to-end, in strict mode. Eliminate accidental "everyone uses daemon-user's `gh auth`" credential leakage. Keep simple/insulated mode behavior unchanged.

## Non-goals

- Don't touch simple/insulated mode behavior. In those modes, daemon-user identity is *the* team identity by design — that's documented as the trade.
- Don't add a transport-policy / per-op fallback / multi-remote system (rejected: too much complexity for the value).
- Don't try to make HTTPS→SSH fallback work. Drop the existing fallback logic.
- Don't ship a "User Settings → GitHub" UI in this PR (separable polish).

## Why not fallback (context for #1069)

PR #1069 added an HTTPS→SSH fallback inside `cloneRepo()`. Two problems:

1. **Doesn't compose past clone.** Once `git clone git@…` runs, that SSH URL is baked into `.git/config` as `[remote "origin"]`. Every subsequent `fetch`/`push`/worktree-add uses the on-disk URL, not `repos.remote_url`. So the fallback fixes one moment in time and creates a permanent footgun for users who don't have SSH agents (e.g. anyone in strict mode).
2. **Hides the real bug.** Today's prod private clones in strict mode work because the daemon Unix user has `gh auth login` configured globally — so every Agor user implicitly clones as that one identity. That's a credential-leak shape, not an architectural feature. This PR fixes the leak.

## Current state (summary)

- `git.clone` runs as daemon user (no `asUser` at `apps/agor-daemon/src/services/repos.ts:213`). In prod it works because daemon-user has `gh auth login`, which silently authenticates every clone for every Agor user.
- `git.worktree.add` runs impersonated (`asUser` at `apps/agor-daemon/src/services/repos.ts:715`).
- `payload.env` is shipped from daemon (resolved per-user via `resolveUserEnvironment(userId)`) but **only applied to `process.env` inside `handlePromptPayload`** (`packages/executor/src/cli.ts:139-154`). Non-prompt commands ignore it. So per-user creds don't actually reach git ops.
- The strict-mode env whitelist in `apps/agor-daemon/src/utils/spawn-executor.ts:270-285` does not include `GITHUB_TOKEN` / `SSH_AUTH_SOCK`. Confirms `payload.env → process.env` is the only intended path for these — and it's wired up only for prompt.
- `initializeRepoGroup` / `initializeWorktreeGroup` (privileged chgrp/setfacl) run inside the executor today. In strict mode the executor has the privileges because it runs as daemon user. If we move clone to impersonated, those calls lose their privileges.

## Proposed architecture

Three things change together:

### 1. `git.clone` runs through the same impersonation helper as `git.worktree.add`

Pass `asUser = resolveGitImpersonationForUser(db, userId)` to the `spawnExecutorFireAndForget` call at `repos.ts:213`. Same shape as the existing call at line 715.

**Why "process identity stays daemon user" is intentional:** the impersonation helper currently always returns `getDaemonUser()` (see `apps/agor-daemon/src/utils/git-impersonation.ts`). This is *not* a stub — it's a deliberate constraint introduced by commit 38c80184. Parent dirs like `/home/agorpg/.agor/worktrees/` are owned by `agorpg:agorpg` 0755; running git as another Unix user can't create subdirectories there. The reason we still route through `sudo -u <daemon>` is to force a fresh `initgroups()` so newly created `agor_wt_*` groups become visible — the daemon process itself has stale group memberships from startup.

**What strict-mode actually buys:** the credential identity (the GitHub token, env vars, etc.) is per-user via the Feathers RPC below; the process identity stays daemon-user out of necessity. That decouples auth from impersonation in a way that's safe regardless of the parent-dir ownership situation. If we ever flip the parent dirs to be world-writable or per-user-owned, the helper can start returning the real user — no other code has to change.

### 2. Privileged Unix work moves out of the executor and into the daemon

Today the executor calls `initializeRepoGroup(...)` / `initializeWorktreeGroup(...)` directly. After the move, the executor only does git + creates the DB record via Feathers; the daemon does chgrp/setfacl in a hook on `repos.create` (or a new `repos.finalizeClone` custom method), and similarly for worktrees.

Privilege boundary becomes:

| Tier | Process | Operations |
|---|---|---|
| User identity | Impersonated executor | git clone, git worktree add, git fetch/push (uses user's creds) |
| System identity | Daemon process | chgrp, setfacl, group init, useradd, etc. |

### 3. Executor pulls per-user env via Feathers at op time

New service method on the daemon: `users.getGitEnvironment({ userId })` (or reuse the `resolveUserEnvironment` shape). Returns the user's **full resolved env**, post-`filterEnv` (existing process-hijack filter from `@agor/core/config`). Auth via session JWT (executor already has one); only the user themselves or a service-account JWT can fetch.

Why pass everything (not whitelist): the long tail of git-relevant env is too long and project-specific to whitelist confidently — `GH_TOKEN`/`GITHUB_TOKEN` is the obvious pair, but proxy vars (`HTTPS_PROXY`/`NO_PROXY`), TLS overrides (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`), git author/committer identity, custom token names for self-hosted forges, LFS flags etc. all belong here, and corporate setups are where the weird ones live. Passing everything is also consistent with how `prompt` sessions already get user env (`cli.ts:139-154`).

Executor calls this just before invoking `cloneRepo` / `createWorktree`, applies the returned values to `options.env` for that single call (NOT to `process.env` globally). The merged env reaches simple-git via the spawn config in `createGit` (`packages/core/src/git/index.ts:266-271`); git ignores keys it doesn't recognize, so passing the full user env is harmless.

**Logging discipline:** the existing `[git.clone] Credentials: ...` log line only emits *which keys* were resolved, never values. Keep that discipline — passing arbitrary user env in means we must not dump values anywhere.

**Failure mode is intentionally loud.** `fetchUserGitEnvironment` does *not* swallow RPC errors. If we returned `{}` on RPC failure, the daemon user's ambient credentials (e.g. `gh auth login` configured globally for `agorpg`) would silently authenticate the clone as the daemon's identity — the exact cross-user leak this PR is built to prevent. Prefer a clean failure that surfaces "credentials not configured" over a silent fallback.

**Inherited credential helpers are reset.** `createGit` prepends `-c credential.helper=` whenever per-user env is supplied. Without that reset, git would still consult helpers from the daemon user's `~/.gitconfig` after our token-based helper, leaking daemon-user identity for any user who hasn't configured their own `GITHUB_TOKEN`. The empty assignment clears the helper list before we add ours.

`payload.env` is no longer the cred channel. Drop the `env: userEnv` from the spawn payloads.

## File-by-file change list

### Daemon

- `apps/agor-daemon/src/services/repos.ts`
  - **Done** — `cloneRepository`: pass `asUser`, remove `env: userEnv`, add `userId` to params, add `initializeUnixGroup` custom method.
  - **Done** — `createWorktree`: remove `env: userEnv`, add `userId` to params, remove `daemonUser`/`creatorUnixUsername`/`repoUnixGroup` (daemon resolves internally).

- `apps/agor-daemon/src/services/worktrees.ts`
  - **Done** — added `initializeUnixGroup` custom method for daemon-side group init.

- `apps/agor-daemon/src/services/users.ts`
  - **Done** — `getGitEnvironment({ userId })` custom method. Auth: service-account JWTs can fetch any user's env; user JWTs can only fetch their own.

- `apps/agor-daemon/src/register-services.ts`
  - **Done** — registered `getGitEnvironment`, `initializeUnixGroup` in methods arrays for users, repos, and worktrees services.

- `apps/agor-daemon/src/utils/unix-group-init.ts` (new file)
  - **Done** — daemon-side `initializeRepoUnixGroup` and `initializeWorktreeUnixGroup` using `@agor/core/unix` utilities.

- `apps/agor-daemon/src/utils/spawn-executor.ts`
  - No changes needed — `asUser` path already works, `GITHUB_TOKEN` already not in whitelist.

### Executor

- `packages/executor/src/commands/git.ts`
  - `resolveGitCredentials()`: **Done** — replaced with `fetchUserGitEnvironment(client, userId)` Feathers RPC.
  - `handleGitClone`: **Done** — calls `repos.initializeUnixGroup` RPC instead of direct shell commands.
  - `handleGitWorktreeAdd`: **Done** — calls `worktrees.initializeUnixGroup` RPC instead of direct shell commands.
  - HTTPS→SSH fallback: N/A — PR #1069 was never merged, code doesn't exist in this branch.

- `packages/executor/src/cli.ts`
  - `payload.env → process.env` stays gated to prompt only (unchanged).

- `packages/executor/src/payload-types.ts`
  - **Done** — added `userId` to both `GitClonePayloadSchema` and `GitWorktreeAddPayloadSchema`.

### Core

- `packages/core/src/api/index.ts`
  - **Done** — added `UsersService.getGitEnvironment`, `ReposService.initializeUnixGroup`, `WorktreesService.initializeUnixGroup` to `AgorClient` types.

- `packages/core/src/git/index.ts`
  - No changes needed — PR #1069 HTTPS→SSH fallback was never merged.

### Tests

- `clone-fallback.test.ts`: N/A — doesn't exist in this branch.
- **Done** — unit tests for `users.getGitEnvironment` permission checks (`users.git-env.test.ts`): service-account access, self-access, cross-user denial, unauthenticated rejection, internal bypass, decrypted env var retrieval, nonexistent user handling.

### Docs

- `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`: document the strict-mode auth model — each user must configure their own GitHub token in user settings.
- `CLAUDE.md` "Feature Flags" section: add a note under each mode describing the auth identity used for git ops (daemon-user for simple/insulated, per-user for strict).
- `context/explorations/clone-redesign.md`: this doc.

## Open questions / decisions

- **Service identity escape hatch.** Audited: all current `git.*` executor spawns originate from user-driven service handlers and have a `userId`. No system-level git ops in the codebase today. Decision: defer the `execution.service_unix_user` config knob until a need appears.
- **Bootstrapping.** First-time strict-mode user has no `GITHUB_TOKEN` configured. Today they "just work" because daemon-user `gh auth` covers them. After this change, they get a clear "no creds configured" error on their first private clone. Decision: error path only for this PR. UI affordance is followup.
- **SSH support.** The new `SSH_AUTH_SOCK` / `SSH_AGENT_PID` / `GIT_SSH_COMMAND` env forwarding from #1069 is dropped in this redesign. Agent sockets are per-Unix-session and don't transfer across `sudo -u`; HTTPS+token is the supported path. Anyone who really wants SSH end-to-end can configure SSH keys for their per-user Unix account directly (independent of Agor).
- **Credential storage on disk for terminal use.** When user sets a token in Agor UI, do we also write it to their per-user `~/.git-credentials` (or run `gh auth login --with-token`) so the xterm.js modal works? Probably yes, but separate concern with its own security review. Defer to a followup PR.
- **`payload.env` for non-cred env vars.** Anything else flowing through `payload.env` today besides creds? Need to audit `resolveUserEnvironment` callers. If yes, decide whether those still go through payload or also move to a Feathers fetch.

## Rollout / migration

- Schema changes: none (no new tables/columns).
- Backwards compat: existing repos already cloned have correct on-disk state. New behavior only affects future clones / worktree creates.
- Config changes: none required. Strict mode users may need to add a `GITHUB_TOKEN` in user settings if they were relying on daemon-user `gh auth`.
- Deprecation/removal of old behavior: HTTPS→SSH fallback is removed. Anyone who depended on it (unlikely, since it just shipped and is unmerged) needs to use HTTPS+token or SSH URL.

## PR composition

Actual commit shape (layered for review):

1. `feat(users): add getGitEnvironment Feathers method` — Auth check, unit tests (7 test cases).
2. `feat(executor): fetch per-user git credentials via Feathers RPC` — Replace `resolveGitCredentials()` with `fetchUserGitEnvironment()`, drop `payload.env` creds.
3. `refactor(unix): move group init from executor to daemon-side RPC` — New `repos.initializeUnixGroup` and `worktrees.initializeUnixGroup` custom methods.
4. `feat(clone): pass asUser to git.clone executor spawn` — Same impersonation pattern as `git.worktree.add`.
5. `docs: update clone-redesign exploration with implementation status` — This doc.

## Out of scope (future work)

- User Settings → GitHub UI pane.
- Sync user tokens to per-user `~/.git-credentials` for xterm.js manual git.
- Per-op transport policy (HTTPS / SSH preference).
- Touching simple/insulated mode credential paths.
