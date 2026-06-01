# Daemon git-operation audit (2026-05-24)

**Status:** audit / read-only. No code changes proposed in this branch — only a phased migration plan and a documented "must stay" set so the next attempt doesn't re-litigate the boundary.
**Scope:** every `simple-git` call site, `git`-CLI shell-out, and `fs.rm`/`fs.read` against `~/.agor/repos/` or `~/.agor/worktrees/` inside `apps/agor-daemon/src/**`.
**Companion docs:** [`context/explorations/daemon-fs-decoupling.md`](../../context/explorations/daemon-fs-decoupling.md) (broader FS decoupling, §1.1 inventory), [`context/explorations/executor-expansion.md`](../../context/explorations/executor-expansion.md) (the target executor command surface), [`context/explorations/clone-redesign.md`](../../context/explorations/clone-redesign.md) (storage_mode='clone' vs 'worktree' that the executor commands now branch on).

---

## TL;DR

- **5 distinct violations** in 5 daemon files. All cleared the previous worktree→branch rename, none reintroduced by it.
- **0 must-stay-in-daemon** git operations on managed dirs. Every read or write against `~/.agor/repos/` or `~/.agor/worktrees/` has a viable executor replacement; the "chicken-and-egg" cases (initial clone, branch lifecycle, archive/delete) **already** spawn the executor — they're not violations.
- **0 direct `simple-git` imports in the daemon.** The wrapper is in `packages/core/src/git/index.ts` (1689 lines, one canonical `import { simpleGit }`). Daemon reaches simple-git only transitively via `@agor/core/git` exports. **This reframes the experiment** (see §4) — the move is not "daemon → executor," it is "daemon stops importing the simple-git-backed exports of `@agor/core/git`," and we never had to touch a `package.json`.
- **Experiment confirms scope (§4).** Aliasing the daemon's simple-git-backed imports to non-existent names and running `pnpm typecheck` from `apps/agor-daemon/` produced **exactly 11 errors in exactly the 5 files** named in §2-B, on exactly the 9 symbol-import sites. No hidden transitive uses. No spillover to executor / CLI / core. Working tree was reset before commit.
- **The hot path violation is `services/files.ts:73`** — `git ls-files -z` runs in-process on every keystroke in the prompt `@`-autocomplete. That's the highest-impact category-B move because it executes per UI character and routes through the daemon's uid.
- **Top 3 to move first:** (1) `services/files.ts` `git ls-files`, (2) `utils/realign-repo-origin.ts` `ensureGitRemoteUrl` writes to `.git/config`, (3) `services/repos.ts:1049` `deleteRepoDirectory`/`deleteBranchDirectory` (fs.rm of managed dirs).

The daemon shell-outs to `git` exactly once and not against a managed dir: `setup/build-info.ts:73` runs `git rev-parse --short HEAD` against the daemon's own source tree at startup. Not a violation.

---

## 1. Architectural direction (re-stated for future readers)

The target end-state, per Max: **the daemon never touches `~/.agor/repos/` or `~/.agor/worktrees/`. The executor does.** The daemon's job is database / auth / API / WebSocket / orchestration. The executor's job is filesystem and git, inside the uid namespace appropriate for the branch.

Concretely:

- Daemon owns: `~/.agor/config.yaml`, `~/.agor/agor.db`, REST/WebSocket, FeathersJS services, MCP HTTP, executor spawns. Pure-string git helpers (URL parsing, slug derivation, ref validation, env-var construction) are fine in daemon — they don't touch disk.
- Executor owns: every read or write inside `~/.agor/repos/<slug>/` or `~/.agor/worktrees/<repo>/<branch>/`. Spawned per-task via `spawnExecutor` / `spawnExecutorFireAndForget` (`apps/agor-daemon/src/utils/spawn-executor.ts`), runs under the appropriate Unix uid (`asUser`-resolved by RBAC mode).
- `simple-git` itself: lives in `packages/core/src/git/index.ts`. The desired end-state is that **only `packages/executor/**` and the user-facing CLI invoke the simple-git-backed exports**. The daemon can keep importing the pure helpers (`extractRepoName`, `buildGitConfigParameters`, `isLikelyGitToken`, etc.) since they never spawn git.

This audit applies the rule **call-site by call-site**, not import-by-import. A daemon file that imports `extractRepoName` from `@agor/core/git` is fine; one that imports `getGitState` is not, because the latter shells out under daemon uid.

---

## 2. Inventory — every daemon-side import of `@agor/core/git`

Static analysis (`git grep "from '@agor/core/git'" apps/agor-daemon/src/`):

| File:line                                                       | Imported symbol                                      | Reaches `simple-git`?                         | Touches `~/.agor/repos`/`worktrees`?                                           | Category                  |
| --------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| `apps/agor-daemon/src/index.ts:41`                              | `buildGitConfigParameters`                           | No — pure string assembly                     | No                                                                             | **C — fine**              |
| `apps/agor-daemon/src/services/users.ts:32`                     | `isLikelyGitToken`                                   | No — regex                                    | No                                                                             | **C — fine**              |
| `apps/agor-daemon/src/services/repos.ts:30-36`                  | `extractRepoName`, `getBranchPath`, `getReposDir`    | No — pure strings                             | No                                                                             | **C — fine**              |
| `apps/agor-daemon/src/services/repos.ts:32-36`                  | `getDefaultBranch`, `getRemoteUrl`, `isValidGitRepo` | Yes (via `createGit`)                         | Path is **user-supplied** (local repo registration only)                       | **D — ambiguous, see §3** |
| `apps/agor-daemon/src/services/repos.ts:1049` (dyn import)      | `deleteRepoDirectory`, `deleteBranchDirectory`       | No simple-git; uses `fs.rm`                   | **YES — rm -rf inside `~/.agor/repos/<slug>` and `~/.agor/worktrees/<r>/<b>`** | **B — move**              |
| `apps/agor-daemon/src/services/zone-trigger.ts:87` (dyn import) | `getGitState`, `getCurrentBranch`                    | Yes                                           | **YES — `branch.path`**                                                        | **B — move**              |
| `apps/agor-daemon/src/services/files.ts:10`                     | `createGit` → `git.raw(['ls-files', '-z'])`          | Yes                                           | **YES — `branch.path`**                                                        | **B — move (hot path)**   |
| `apps/agor-daemon/src/mcp/tools/sessions.ts:773` (dyn import)   | `getGitState`, `getCurrentBranch`                    | Yes                                           | **YES — `branch.path`**                                                        | **B — move**              |
| `apps/agor-daemon/src/utils/realign-repo-origin.ts:3,31`        | `ensureGitRemoteUrl`                                 | Yes (`git config --get-all`, `--replace-all`) | **YES — `repo.local_path = ~/.agor/repos/<slug>`, writes `.git/config`**       | **B — move**              |

Daemon shell-outs to `git` (`grep -E "spawn\('git'\|execFileSync\('git'\|execSync\('git\b\|exec\('git\b"`):

| File:line                                     | Command                      | Cwd                                              | Category                                                                                |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `apps/agor-daemon/src/setup/build-info.ts:73` | `git rev-parse --short HEAD` | The daemon's **own** source dir (cwd at startup) | **A — must stay**: this is the daemon stamping its own build SHA. Not the managed dirs. |

Daemon `child_process` usage that is **not** a git shell-out:

- `apps/agor-daemon/src/utils/spawn-executor.ts:24` — spawns the executor itself (correct).
- `apps/agor-daemon/src/services/terminals.ts:21,654` — Zellij PTY spawn for the web terminal.
- `apps/agor-daemon/src/services/claude-cli-integration.ts:37` — Claude-CLI spawn helpers.
- `apps/agor-daemon/src/utils/unix-group-init.ts:14` — `groupadd` / `chgrp` / `setfacl` via sudoers.
- `apps/agor-daemon/src/register-routes.ts:760` — `pkill -f` against stale Claude processes (not a git op).

None of these are git ops; they're all listed for completeness so a future "grep `child_process` in daemon" doesn't re-litigate them.

### 2.1 Filesystem path uses (`getReposDir`, `getBranchesDir`, `getBranchPath`, literal `'.agor/worktrees'`)

| File:line                                                 | Use                                                                                | Touches dir?                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/agor-daemon/src/services/repos.ts:237`              | `path.join(getReposDir(), expectedRepoName)` for the placeholder DB row            | No — just builds a string                                 |
| `apps/agor-daemon/src/services/repos.ts:661`              | `getBranchPath(repo.slug, data.name)` for the placeholder DB row                   | No — string                                               |
| `apps/agor-daemon/src/services/branches.ts:556, 586, 724` | Comments mentioning `getBranchesDir()` (explaining why daemon doesn't impersonate) | No — comments only                                        |
| `apps/agor-daemon/src/services/branches.ts:709`           | `existsSync(branch.path)` to gate unarchive                                        | **Yes — read-only probe**                                 |
| `apps/agor-daemon/src/services/terminals.ts:657`          | `fs.existsSync(symlinkPath)` to pick web-terminal cwd                              | Probe of the per-user symlink, not the managed dir itself |
| `apps/agor-daemon/src/mcp/tools/repos.ts:157`             | Literal `~/.agor/repos/<slug>` in a docstring                                      | No — docstring                                            |

The two `existsSync` probes are read-only and only inform a routing decision (rebuild branch / pick cwd); they don't read content, don't write, don't spawn git. They could move to the executor too but the cost/benefit is poor — they're cheap, they don't surface uid-leak risk, and removing them would require an RPC round-trip per check. Mark as **D — ambiguous**, lean keep.

---

## 3. Per-call-site categorization

### Category A — Must stay in daemon

| Call site                                                                                                                | Why                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/agor-daemon/src/setup/build-info.ts:73` (`git rev-parse --short HEAD` against daemon source)                       | Daemon is stamping its own build identity. No executor exists yet, no managed dir involved. Already constrained to `currentDir` (the daemon's installed source).                                          |
| `apps/agor-daemon/src/index.ts:155` (`buildGitConfigParameters`)                                                         | Pure string assembly to set `GIT_CONFIG_PARAMETERS` env var for every subsequent spawn. Doesn't spawn git, doesn't read disk. Must happen daemon-side because it sets the env that the executor inherits. |
| All `getReposDir()` / `getBranchPath()` / `extractRepoName()` / `isLikelyGitToken()` / `validateGitRef()` uses in daemon | Pure helpers. No FS, no spawn.                                                                                                                                                                            |

### Category B — Should move to executor

| Call site                                              | Operation                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                | Move target                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/agor-daemon/src/services/files.ts:73-84`         | `git ls-files -z` inside `branch.path` for `@`-autocomplete                                                      | **Hot path** — runs on every keystroke. Daemon-uid `git` against a worktree the user owns has dubious-ownership semantics already handled there with `safe.directory` retry — that retry is itself evidence the operation is in the wrong place. Routes through the daemon uid which may not match the worktree owner under strict mode. | `branch.files.list` executor command (or a long-lived `branch-probe` executor pinned per branch — see §6 open Qs).                                                                                                             |
| `apps/agor-daemon/src/utils/realign-repo-origin.ts:31` | `ensureGitRemoteUrl(repo.local_path, ...)` writes `.git/config` under `~/.agor/repos/<slug>`                     | This is the **only `.git/config` write** the daemon does. Fired from `repos.after.patch` hook (line 724 of `register-hooks.ts`) and from `tasks.after.patch` on terminal transitions (`services/tasks.ts:241`). Already best-effort fire-and-forget — wrapping in a tiny `git.repo.realign-origin` executor command is straightforward.  | New `git.repo.realign-origin` executor command.                                                                                                                                                                                |
| `apps/agor-daemon/src/services/zone-trigger.ts:87-89`  | `getGitState(branch.path)` + `getCurrentBranch(branch.path)` at zone-trigger session creation                    | Snapshot of branch state for session attribution. Currently in-daemon-uid.                                                                                                                                                                                                                                                               | Daemon already calls into the executor for session bootstrap — fold the snapshot read into the spawn payload, or call a `branch.inspect` executor probe.                                                                       |
| `apps/agor-daemon/src/mcp/tools/sessions.ts:773-775`   | Same `getGitState` + `getCurrentBranch` from MCP `sessions.spawn` tool                                           | Same as above.                                                                                                                                                                                                                                                                                                                           | Same.                                                                                                                                                                                                                          |
| `apps/agor-daemon/src/services/repos.ts:1049-1083`     | `deleteRepoDirectory(repo.local_path)` and `deleteBranchDirectory(branch.path)` from `repos.remove` cleanup path | These are `fs.rm -rf` against managed dirs. The sister "branch delete" path at `services/branches.ts:592` (`command: 'git.branch.remove'`) is already executor-routed. **Repo delete is the gap.**                                                                                                                                       | New `repo.delete` executor command (or extend `git.branch.remove` to handle the cascading repo-level rm). Per `daemon-fs-decoupling.md` §1.1 row "Branch dir cleanup" — already flagged as the entry point that needs to move. |

### Category C — Already in the right place (sanity confirmations)

- All branch create/update/delete that mutate the worktree directory: spawn executor with `git.branch.add` / `git.branch.remove` / `git.branch.clean` from `services/branches.ts:475, 564, 594, 754` and `services/repos.ts:854`.
- Initial repo clone: `services/repos.ts:261` spawns `git.clone`. Daemon never invokes `cloneRepo()` from `@agor/core/git` directly — the import at line 30 is unused at runtime (`extractRepoName` from the same group is what's actually called); confirmed by `grep cloneRepo apps/agor-daemon/src` returning only comments.
- Unix group / ACL / chgrp: routed through `unix.sync-branch` / `unix.sync-user` executor commands (`register-hooks.ts:865, 894, 1545, 1593, 1974`, `services/branch-owners.ts:260, 291`).
- Web-terminal PTY spawn: `services/terminals.ts:688` spawns `zellij.attach` executor command.

### Category D — Genuinely ambiguous

| Call site                                                                                                                                                                                       | Why ambiguous                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/agor-daemon/src/services/repos.ts:88-103, 488, 502, 520` — `getRemoteUrl(path)`, `isValidGitRepo(path)`, `getDefaultBranch(path)` from `deriveLocalRepoSlug()` and `addLocalRepository()` | Called against a **user-supplied local path that is NOT inside `~/.agor/`** (`addLocalRepository` registers an existing git repo wherever the user keeps it). The literal "touches `~/.agor/repos/` or `~/.agor/worktrees/`" rule doesn't trigger. **But** it's still daemon-uid git execution against a path the daemon may not own, with the same uid / dubious-ownership / safe.directory concerns. Recommend: defer. A user-supplied path is the user's problem; moving this to the executor requires deciding which uid to run as for a path that hasn't been registered with any Unix group yet. |
| `apps/agor-daemon/src/services/branches.ts:709` (`existsSync(branch.path)`), `services/terminals.ts:657` (`fs.existsSync(symlinkPath)`)                                                         | Read-only stat probes used to route decisions. Cheap, no uid-leak risk, but technically touches the dir. Lean: keep — the cost/benefit of an RPC round-trip is poor and there's no security exposure from a read-only stat.                                                                                                                                                                                                                                                                                                                                                                            |

---

## 4. The simple-git move "experiment" — reframed, then executed

The hard rules said: "attempt the move in the worktree, see what breaks, do not commit." Two problems forced a reframe (this is the stop-and-report trigger called out in the brief):

1. **The wrapper is in `packages/core`, not `apps/agor-daemon`.** `simple-git` is declared as a dependency of `@agor/core` only (`packages/core/package.json`) and of the `agor-live` meta-package that bundles the published binary. The daemon never imports `simple-git` directly — confirmed by `git grep "from 'simple-git'"` returning four files, all under `packages/core/src/git/`. The proposed experiment "remove simple-git from daemon's package.json" is a no-op because it isn't there.
2. **Removing it from `@agor/core` would cascade-break the executor too,** which is exactly what we want to keep.

So instead I did the variant the brief explicitly authorized: **break exactly the daemon imports of simple-git-backed symbols, leave executor / CLI / core-internal alone, run typecheck, count errors.** Implementation: in each of the five daemon files identified in §2-B, I aliased the simple-git-backed imports to `<symbol>__MOVED` (a name `@agor/core/git` does not export), then ran `pnpm typecheck` from `apps/agor-daemon/`. The edits were reverted before committing — `git status --short` shows only the new doc.

**Result: 11 typecheck errors across exactly the 5 files predicted, on exactly the 9 daemon symbol-import sites the static analysis enumerated. Zero downstream surprises.**

```
src/services/files.ts(10,10):                error TS2305  createGit
src/services/repos.ts(32,3):                 error TS2724  getDefaultBranch
src/services/repos.ts(33,3):                 error TS2305  getRemoteUrl
src/services/repos.ts(35,3):                 error TS2724  isValidGitRepo
src/services/repos.ts(1049,15):              error TS2339  deleteRepoDirectory
src/services/repos.ts(1049,64):              error TS2339  deleteBranchDirectory
src/services/zone-trigger.ts(87,11):         error TS2339  getGitState
src/services/zone-trigger.ts(87,44):         error TS2339  getCurrentBranch
src/mcp/tools/sessions.ts(773,15):           error TS2339  getGitState
src/mcp/tools/sessions.ts(773,48):           error TS2339  getCurrentBranch
src/utils/realign-repo-origin.ts(3,10):      error TS2724  ensureGitRemoteUrl
```

(Static imports surface as `TS2305` / `TS2724`. Dynamic-import call sites surface as `TS2339` because TypeScript looks up the property on the imported module's inferred type rather than re-resolving the module specifier.)

No errors anywhere in `packages/executor/`, `apps/agor-cli/`, `packages/core/` — which matches the expectation that those layers legitimately use the simple-git-backed surface. No errors in any daemon file besides the five enumerated in §2-B. No hidden third-party imports of the simple-git-backed exports via the daemon's transitive code.

**So the move is bounded, mechanical, and exactly the size §2 predicted.** Five files, ~3 eng-days for the phased plan in §5.

If we wanted to enforce the boundary mechanically going forward, the cleanest mechanism is **a deep-import split inside `@agor/core`**:

- `@agor/core/git/pure` — exports: `validateGitRef`, `isLikelyGitToken`, `buildWorktreeAddArgs`, `parseHostFromGitUrl`, `buildGitConfigEnv`, `buildGitConfigParameters`, `buildAuthHeaderEnv`, `categorizeGitError`, `redactGitEnv`, `extractRepoName`, `getReposDir`, `getBranchesDir`, `getBranchPath`. Daemon may import.
- `@agor/core/git/exec` — exports: `createGit`, `createGitForRemote`, `cloneRepo`, `addSafeDirectoryBestEffort`, `getCurrentBranch`, `getDefaultBranch`, `getCurrentSha`, `isClean`, `getRemoteUrl`, `ensureGitRemoteUrl`, `createBranch`, `createBranchAsClone`, `restoreBranchFilesystem`, `listGitWorktrees`, `removeGitWorktree`, `cleanBranch`, `pruneGitWorktrees`, `hasRemoteBranch`, `getRemoteBranches`, `getGitState`, `deleteBranch`, `isValidGitRepo`, `isGitRepo`. Daemon must **not** import. `deleteRepoDirectory` / `deleteBranchDirectory` go here too (no simple-git but they `fs.rm` inside managed dirs).
- A lint rule (`eslint-no-restricted-imports`) on `apps/agor-daemon/src/**` forbids `@agor/core/git/exec`.

This is a refactor, not a "move." It's the right shape but not part of this audit — proposed in §5 as Phase 5.

---

## 5. Recommendation — phased move plan

Ordered by ratio of impact to effort. **Each phase is its own PR.**

### Phase 1 — `services/files.ts` `git ls-files` → executor (highest impact)

- **Why first:** it runs per UI keystroke. Even if the rest of this audit's items stay, moving this one removes the visible "daemon shells out to git inside a worktree" pattern from the hottest path.
- **Sketch:** new executor command `branch.files.list { branchPath, search }` → returns the same `{ path, type }[]`. The dubious-ownership / safe.directory dance in `files.ts:79-87` disappears because the executor already runs as the branch owner.
- **Cost:** ~1 day. New executor handler + payload type + replace the in-process `createGit` with an RPC.
- **Gotcha:** this hits the daemon → executor latency budget. The current in-process call is sub-ms. An RPC round-trip will be 10s of ms. Acceptable for typing latency, but verify under real network on hosted.

### Phase 2 — `realign-repo-origin.ts` → executor command

- **Why:** the only `.git/config` write in the daemon. Already fire-and-forget so it tolerates an RPC well.
- **Sketch:** new `git.repo.realign-origin { repoId, expectedUrl }` command. The two callers (`tasks.ts:241`, `register-hooks.ts:724`) just swap `ensureRepoOriginAlignedById` for a `spawnExecutorFireAndForget`.
- **Cost:** ~0.5 day.

### Phase 3 — `repos.remove` filesystem cleanup → executor command

- **Why:** the last `fs.rm -rf` of managed dirs in the daemon. Branch-level rm is already in the executor (`git.branch.remove`). Aligning the repo-level rm closes the gap.
- **Sketch:** new `repo.delete { repoId, branchPaths[] }` command. Or extend `git.branch.remove` to chain a repo-dir rm when `repo.cleanup=true`. Note the existing safety guard in `deleteRepoDirectory` (path containment check against `getReposDir()`) must move with the function.
- **Cost:** ~0.5 day. Must preserve the "fail-fast partial deletion" error reporting at `services/repos.ts:1062-1095`.

### Phase 4 — `getGitState` + `getCurrentBranch` at session create (zone-trigger + MCP sessions.spawn) → executor probe

- **Why:** two call sites, identical signature. A small probe consolidates them.
- **Sketch:** new `branch.inspect { branchPath } → { sha, ref, clean }` executor probe, or fold into the existing `spawnExecutor(session-bootstrap)` payload so the executor reports back via the session row instead of being asked synchronously.
- **Cost:** ~0.5 day.

### Phase 5 — Mechanical enforcement: split `@agor/core/git` into `…/git/pure` + `…/git/exec`

- **Why last:** only worth doing once the daemon stops importing `…/git/exec`, otherwise the split is just churn. After phases 1–4, only the addLocalRepository D-category remains, which is ambiguous on purpose.
- **Sketch:** physical file split + re-export shim + ESLint `no-restricted-imports` rule on `apps/agor-daemon/src/**`.
- **Cost:** ~0.5 day. No behavior change; pure refactor + lint.

**Aggregate effort: ~3 eng-days for phases 1–5, sequenceable.** Independent PRs.

---

## 6. The "must stay" set — documented so future audits don't re-litigate

| Call site                                                                        | Why it stays                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `setup/build-info.ts:73` (`git rev-parse` against daemon source)                 | Daemon stamping its own SHA. No executor exists yet at startup. Not a managed dir.                                                |
| `index.ts:155` (`buildGitConfigParameters`)                                      | Pure-string env-var construction. Must run before the first executor spawn so the env is in `process.env`.                        |
| `services/users.ts:32` (`isLikelyGitToken`)                                      | Pure regex. Used for token-validation at user-input time; daemon must validate before storing.                                    |
| `services/repos.ts` imports of `extractRepoName`, `getBranchPath`, `getReposDir` | Pure strings used to compute placeholder DB row paths before the executor spawn. The executor patches the row with the real path. |
| `branches.ts:709` and `terminals.ts:657` `fs.existsSync` probes                  | Read-only stat used to route decisions (rebuild vs. attach). No uid-leak risk, cheap, no benefit to RPC.                          |

---

## 7. Open questions for Max

1. **`addLocalRepository` git reads (category D).** `getRemoteUrl`, `isValidGitRepo`, `getDefaultBranch` against a user-supplied path that is **not** inside `~/.agor/`. The dir-scope rule doesn't trigger, but the daemon-uid concern does. Defer or move? My read: defer — the user-supplied path predates any Agor uid namespace, so there's no obvious "right" uid to run as. Confirm.
2. **`branch.files.list` latency vs. correctness trade.** Moving `git ls-files` to an executor RPC turns sub-ms calls into 10–50ms. For autocomplete, that's the difference between "instant" and "perceptible." Worth a feature-flagged rollout, or just do it?
3. **`branch.inspect` probe vs. cache in DB.** The cleaner pattern is to cache `branch.last_observed_sha` / `last_observed_ref` on the DB row and let the executor refresh it on every task boundary — then daemon never even probes. Worth pushing to that target now, or one phase at a time?
4. **Phase ordering: leapfrog Phase 5?** If the answer to "should the daemon `@agor/core/git` import surface be lint-enforced?" is yes, Phase 5 could come first and force the rest. I lean against — splitting before the call sites move just adds re-export shims that get deleted in the same week.

---

## 8. Cross-references

- [`context/explorations/daemon-fs-decoupling.md`](../../context/explorations/daemon-fs-decoupling.md) — §1.1 "Daemon FS touchpoint inventory" has the broader FS picture (~35 touchpoints, 13 files). Rows "Repo + branch directories (the big ones)" in §1.1 overlap directly with this audit: `services/repos.ts:238, 489, 641, 701, 713`, `utils/realign-repo-origin.ts:31`, `services/branches.ts:706`, `services/zone-trigger.ts:87-89`, `mcp/tools/sessions.ts:775-777`, `services/files.ts:73-84`, `services/repos.ts:1098-1142`. The daemon-fs-decoupling doc is the parent — this audit is the git-only slice with a concrete migration order.
- [`context/explorations/executor-expansion.md`](../../context/explorations/executor-expansion.md) — target executor command surface. Phases 1–4 here propose new command names (`branch.files.list`, `git.repo.realign-origin`, `repo.delete`, `branch.inspect`) that fit the namespace already in flight (`git.clone`, `git.branch.{add,remove,clean}`, `unix.{sync-branch,sync-user}`, `zellij.attach`).
- [`context/explorations/clone-redesign.md`](../../context/explorations/clone-redesign.md) — explains the `storage_mode='worktree'|'clone'` enum that the executor `git.branch.*` commands now branch on. None of this audit's recommendations interact with that split — the proposed new commands operate on `branch.path` regardless of storage mode.
- [`docs/internal/credential-leak-defenses-2026-05-11.md`](./credential-leak-defenses-2026-05-11.md) — context for `realign-repo-origin.ts`'s existence (defense-in-depth against token-in-URL leaks). The realign behavior MUST be preserved across the Phase 2 move; the executor command needs the same `[SECURITY]` log line on drift.

---

## 9. Notes for the next auditor

- The worktree → branch rename (commit `2ed5cefd`) did **not** introduce any new violations. The five category-B sites pre-date that refactor.
- On-disk paths still use `worktrees/` (`~/.agor/worktrees/<repo>/<branch>`). `storage_mode='worktree'` is still the enum literal. Both refer to the git-worktree primitive and are correct; do not "fix" these in a follow-up.
- If you re-grep `@agor/core/git` in daemon and find new imports beyond the eight in §2, classify the new symbol first (pure vs. simple-git-backed) — adding a pure helper import is fine, adding a simple-git-backed one is the regression.
- The `cloneRepo` import at `apps/agor-daemon/src/services/repos.ts:30` looks like a violation but is a false positive — the symbol is never called (only `extractRepoName` from the same import group is). Worth deleting in a janitorial pass, but separate PR.
