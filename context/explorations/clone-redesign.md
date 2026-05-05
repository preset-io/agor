# Per-user git auth & impersonated clone

**Status:** Plan / draft for review
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

### 1. `git.clone` is impersonated like `git.worktree.add`

Pass `asUser = resolveGitImpersonationForUser(db, userId)` to the `spawnExecutorFireAndForget` call at `repos.ts:213`. Same shape as the existing call at line 715.

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

`payload.env` is no longer the cred channel. Drop the `env: userEnv` from the spawn payloads.

## File-by-file change list

### Daemon

- `apps/agor-daemon/src/services/repos.ts`
  - Line 213-247 (`cloneRemoteRepository`): pass `asUser`. Remove `env: userEnv` from payload.
  - Line 715-743 (`createWorktree`): remove `env: userEnv` from payload. Already passes `asUser`.
  - Add hook on `repos.create` (or `finalizeClone` custom method) that calls daemon-side `initializeRepoGroup` when RBAC enabled.
  - Add hook on `worktrees.patch({ filesystem_status: 'ready' })` (or `finalize` method) that calls daemon-side `initializeWorktreeGroup` when RBAC enabled.

- `apps/agor-daemon/src/services/users.ts` (or new `creds` service)
  - New custom method `getGitEnvironment({ userId })` → returns the user's full resolved env post-`filterEnv`. Auth: requesting executor's session JWT must match `userId`, OR be a service-account JWT. Use existing `resolveUserEnvironment` internally.

- `apps/agor-daemon/src/utils/spawn-executor.ts`
  - No required changes; the `asUser` path already works. Optionally tighten the impersonation whitelist (line 270-285) to drop `GITHUB_TOKEN` since we're not relying on that path anymore.

- `apps/agor-daemon/src/services/worktree-groups.ts` (or wherever the helpers live)
  - Move `initializeRepoGroup` / `initializeWorktreeGroup` callers from executor to daemon. The helpers themselves stay in `@agor/core/unix` — just the *call sites* move.

### Executor

- `packages/executor/src/commands/git.ts`
  - `resolveGitCredentials()`: replace with `fetchUserGitEnvironment(client, userId)` — Feathers RPC. Falls back to empty env if call fails (logs warning).
  - `handleGitClone`: remove direct `initializeRepoGroup` call (it's daemon-side now). Repo create call stays. Add a `finalizeClone` RPC at the end if the privileged work needs an explicit trigger.
  - `handleGitWorktreeAdd`: remove direct `initializeWorktreeGroup` call. Patch-to-ready stays — daemon hook does the privileged work.
  - Drop the HTTPS→SSH fallback logic from `cloneRepo` (see core changes).

- `packages/executor/src/cli.ts`
  - Optional: keep the `payload.env → process.env` apply gated to prompt only (current behavior). Don't generalize it — we want creds to flow via Feathers, not env, going forward.

### Core

- `packages/core/src/git/index.ts`
  - Remove `isAuthRelatedGitError` and the HTTPS→SSH fallback block in `cloneRepo`.
  - Keep token URL injection (still used).
  - Keep `createGit` / `writeGitCredentialsFile` (still used).

### Tests

- Delete `packages/core/src/git/clone-fallback.test.ts` (covers behavior we're removing).
- Add: integration test that exercises `git.clone` impersonated end-to-end against a real local fixture repo (no network). Verify file ownership ends up correct after daemon-side group init.
- Add: unit test for `users.getGitEnvironment` permission check (executor with user A's JWT cannot fetch user B's env).

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

Suggested commit shape, layered for review:

1. **Add `users.getGitEnvironment` Feathers method.** Auth check, unit tests.
2. **Plumb env fetch into executor `git.clone` and `git.worktree.add`.** Drop `payload.env` creds from daemon → executor.
3. **Move `initializeRepoGroup` / `initializeWorktreeGroup` to daemon-side hooks.** Drop direct calls from executor.
4. **Pass `asUser` to `git.clone` spawn.**
5. **Docs updates.**

PR title: `fix(git): per-user impersonated clone & cred plumbing in strict mode`
PR body: explain the credential-leak issue this fixes, the model after the change, and migration notes.

## Out of scope (future work)

- User Settings → GitHub UI pane.
- Sync user tokens to per-user `~/.git-credentials` for xterm.js manual git.
- Per-op transport policy (HTTPS / SSH preference).
- Touching simple/insulated mode credential paths.
