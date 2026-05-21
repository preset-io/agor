# Branch / Worktree Migration Analysis — 2026-05-20

**Status:** Design / position paper. **No code changes in this worktree.**
**Author:** Claude (Opus 4.7) for Max
**Decision asked:** Pick one of A / B / C / D and authorize the first one or two follow-up PRs.

---

## TL;DR

**Recommendation: Model C now, Model D within two release cycles.** Make isolated clones the new default for what we today call a "Worktree," keep native `git worktree` as a power-user opt-in behind an `execution.branch_storage` config knob, and **plan the worktree-mode removal up front** (~6–8 weeks out, behind a 1-cycle deprecation alias). Rename **Worktree → Branch** in the UI and as MCP-tool aliases in parallel — that's a cheap, independent quality-of-life win.

Why C-now: every git-state-spillover incident we've shipped a defense for in the last quarter (credential leaks across sibling worktrees; per-user remotes baked into shared config; `core.sshCommand` cross-contamination; the in-flight `git-extraheader-refactor` belt-and-braces work) **goes away structurally** under isolated clones. The Layer A/B/C stack in [`credential-leak-defenses-2026-05-11.md`](./credential-leak-defenses-2026-05-11.md) exists to compensate for state-sharing that isolated clones don't have in the first place.

Why D within two cycles: dual code paths are a maintenance tax we should treat as a debt, not an architecture. Model B (clone-mode as a permanent peer of worktree-mode) is explicitly rejected for this reason. The point of shipping C is to *de-risk the migration*, not to canonize two modes.

Why disk cost is solved: the working tree (clean tracked files) is the irreducible cost — identical in worktree-mode and clone-mode. The "clones are massive" intuition collapses once you stop measuring `.git/objects` overhead in the wrong column. Apache Superset's clean tracked-source is **75 MB**; the 1.16 GB pack is what holds a decade of history. With `git clone --reference <local-base-cache>` (no `--dissociate`), per-branch `.git` is a few MB — branches share the daemon-owned base cache as an immutable object store while keeping their own `.git/config`, refs, and credentials surfaces. `--filter=blob:none` is the alternative for true per-branch independence with lazy blob fetch from origin (modest network tax on `git blame` / old-ref access; works on GitHub.com).

**Critical correction from an earlier draft of this doc:** `--dissociate` is **not** the recommended default. It instructs git to copy all objects reachable from the cloned refs out of the reference, which for any feature branch off `main` in a deep repo means copying essentially the full pack history. For Superset that's ~1.16 GB per branch — same as a naïve clone. The cheap independence is at the **config layer** (which is where every leak vector lives), not the **object layer** (which we're happy to share with the daemon-owned base cache).

Why now, not later: PR #1209 (`analyze-daemon-fs-decoupling`) and the in-flight `design-ui-daemon-executor-segmentation` both converge on "**isolated FS state per execution unit.**" Migrating to clones is the same primitive. Doing it now lets all three lines of work share one mental model; doing it later means re-doing the impersonation/Unix-group/FS-decoupling work twice.

---

## 1. Evidence: incidents that go away under isolated clones

Mined from the credential-leak doc, the clone-redesign exploration, the impersonation work, and the FS-decoupling analysis.

| Incident / hardening work | Root cause (shared-state form) | Closed structurally by clones? | Surface today |
|---|---|---|---|
| **Credential-leak across sibling worktrees** (the 2026-05-11 audit; Layer A in `credential-leak-defenses-2026-05-11.md`) | A token written into `[remote "X"] url = …` of base repo's `.git/config` is **read by every worktree of that base** — `worktree.<name>.git` only isolates HEAD/index, not `remote.*`, `branch.*`, `http.*`. | **Yes — completely.** Each branch has its own `.git/config`. Layer A's `transfer.credentialsInUrl=die` and `ensureGitRemoteUrl` self-heal become belt-and-braces, not load-bearing. | Hard-stop + self-heal stack in `packages/core/src/config/security-resolver.ts`, `packages/core/src/git/index.ts`, `apps/agor-daemon/src/utils/realign-repo-origin.ts`. |
| **Per-user remotes baked into shared base config** (the 2026-05-11 cleanup across 3 tainted base repos) | Agent process running `git remote add` lands in the shared base — visible to every other worktree. | **Yes — completely.** Per-branch `.git/config`; no shared base. | `ensureGitRemoteUrl()` daemon-side realigner. |
| **`core.sshCommand` cross-contamination** (`fix-onboarding-clone-ssh-and-silent-fail`) | `core.sshCommand` written into base `.git/config` during onboarding clone applies to every worktree spawned off it. Currently overridden only on daemon-issued git ops, not on agent-issued ones. | **Yes — completely.** Each branch has its own `core.*`. | `createGit()` per-process override (vector 11 of credential-leak threat model). |
| **`http.extraheader` persistence risk** (the `git-extraheader-refactor` ship) | Refactor exists because the *previous* mechanism wrote tokens into base config. Per-process env-var delivery only works because daemon controls every git invocation; agent-side breakouts (e.g. `gh auth login` from inside an agent shell) still write into the shared base. | **Yes — completely.** Agent-side breakout lands in branch-local config; doesn't reach siblings. | `packages/core/src/git/index.ts:351-419` (`createGit()`). |
| **Impersonation sudo-wrapping complexity** (PRs #1141, #1143; `address-issue-1140-impersonation-abstraction`) | Worktree-mode requires the daemon process to be in *both* the per-repo group `agor_rp_*` and the per-worktree group `agor_wt_*` to manipulate either's files. The per-repo group exists *only because the base `.git/` is shared*. | **Mostly — see §1.1.** With clones, the per-repo group can be retired entirely; only the per-branch group remains. Cuts one of the two groups + the cross-group sudo-wrap dance. | `packages/core/src/unix/group-manager.ts`, `apps/agor-daemon/src/utils/unix-group-init.ts`. |
| **`allowUnsafeCredentialHelper` escape hatch** (PR #1099) | Added because users hit credential-helper-store collisions across worktrees of the same base. | **Partially — see §1.1.** Removes one shape of collision (the cross-worktree one); same-worktree-different-agent collision still possible. | `security.allow_unsafe_credential_helper` config flag. |
| **Daemon FS-decoupling wall** (PR #1209, §2.1–§2.3) | The hardest topology question is "where does the env-process / executor live, and who owns the worktree FS." Today's `gitdir:` pointer model means the worktree's `.git` always reaches back into the daemon-owned base — making clean executor-pod isolation harder. | **Yes — opens the door.** A clone is self-contained; mounting it into an executor pod is a normal volume mount with no "but its `.git` is a pointer into another volume" caveat. | `context/explorations/daemon-fs-decoupling.md`, `context/explorations/executor-isolation.md`. |
| **Unix-group fragility (one group per worktree + one per repo)** | Two groups per branch instead of one; alignment drift is a recurring bug (the `2026-05-11` cleanup; `analyze-daemon-group-refresh` worktree existence). | **Yes — collapses to one group per branch.** | `packages/core/src/unix/group-manager.ts:20-51` (`getWorktreeUnixGroup`). |

### 1.1 What clones DON'T close

Honesty about the limits:

- **Same-branch, same-uid leaks.** If an agent persists a token into its branch's `.git/config`, the *next* agent on the *same* branch sees it. Clones reduce blast radius from "all worktrees of base" to "one branch." Layer A.5 (`ensureGitRemoteUrl`), Layer C (per-uid isolation), and the heartbeat scan are still needed for this narrower case.
- **Per-uid homedir leaks** (`~/.config/gh/hosts.yml`, `~/.git-credentials`, `~/.netrc`, vectors 6/7/9 in the credential-leak threat model). These are uid-scoped, not repo-scoped — clone vs worktree is irrelevant. Layer C (per-user Unix UIDs) is the only structural fix.
- **Per-repo OAuth/token state on the GitHub side.** A push from any branch under user `alice` is authenticated as `alice`. Clones don't change who's authorized to push; they just remove one shared-config side channel.

The credential-leak threat model has 11 vectors. Clones close or sharply de-fang **vectors 1, 2, 3, 4, 8, 11** (everything that lands in `.git/config`). Per-uid isolation (Layer C, already in flight) is still required for vectors 5–7, 9, 10. **Clones are a structural complement to Layer C, not a replacement.**

---

## 2. Cost model: what migration actually costs

Numbers from the local Agor instance (max@preset.io's machine), 2026-05-20.

### 2.1 Disk space — the headline number

The single biggest framing error in disk-cost discussions is treating "the size of `~/.agor/repos/<slug>/`" as if it's all `.git`. It's not. Most of what's there is either build artifacts (`node_modules`, generated docs, compiled output) or git's full pack history. Only `git ls-files | xargs du` gives you the **clean tracked source** — which is always materialized regardless of clone strategy.

Measured live (`du --exclude=.git` for working tree, `count-objects -vH` for pack):

| Repo | Clean tracked source (irreducible) | `.git` pack history | `.git` total | Build/ignored bloat |
|---|---|---|---|---|
| `apache/superset` | **75 MB** | 1.16 GB | 1.7 GB | 2.6 GB (in working tree, on top of tracked) |
| `preset-io/agor` | ~hundreds of MB | 184 MB | 324 MB | up to 9 GB with `node_modules` |
| `preset-io/manager` | (not measured separately) | small | 108 MB | — |

Branch counts (live, per-repo):

| Repo | Branch count |
|---|---|
| `preset-io/agor` | **504** |
| `apache/superset` | 349 |
| `preset-io/superset-shell` | 160 |
| `preset-io/agor-assistant-private` | 78 |
| `preset-io/manager` | 59 |

#### Per-branch disk cost: every strategy, on Superset (349 branches)

The working tree is identical in every column — 75 MB of tracked files at the branch's tip, plus whatever the developer installs/builds on top (`node_modules`, etc.) which is also strategy-independent. The interesting column is `.git` overhead.

| Strategy | Working tree | `.git` overhead per branch | × 349 branches | Operational caveat |
|---|---|---|---|---|
| **Today (git worktree)** | 75 MB tracked | ~0 (gitdir pointer file) | 1.16 GB shared base + 26 GB working trees | Shared `.git/config` — the entire reason we're migrating |
| **`--reference` (no dissociate)** ✓ default | 75 MB tracked | **~few MB** (alternates pointer + own refs) | 1.16 GB base cache + ~28 GB working trees + ~few GB refs | Base cache must not be aggressively pruned (`git gc --no-prune` OK; `git gc --prune=now` can corrupt branches) |
| **`--filter=blob:none --single-branch`** ✓ alt | 75 MB tracked | **~tens of MB** (commit graph + trees, no extra blobs) | ~35 GB total | Blob access (e.g. `git blame`, `git checkout <old-ref>`) triggers network fetch from origin. Requires partial-clone-capable remote (GitHub.com: yes). |
| **`--depth 1 --single-branch`** | 75 MB tracked | ~50–80 MB (tip's blobs compressed in pack) | ~44–54 GB total | `git log` past 1 commit broken; can't rebase against old history; can't push some operations cleanly |
| **`--reference --dissociate`** ✗ rejected | 75 MB tracked | **~1.16 GB** (copies all reachable objects out of reference) | **~430 GB** total | Independent but as expensive as a naïve clone |
| **Naïve `git clone`** ✗ rejected | 75 MB tracked | ~1.16 GB | ~430 GB total | No reason to choose this over `--reference` |

**Bottom line:** the cheap, functional options are `--reference` (small `.git`, depends on local base cache) or `--filter=blob:none` (small `.git`, depends on origin remote for lazy blob fetch). **`--dissociate` is the trap** — it copies full reachable history per branch and turns a cheap operation into an expensive one. Naïve clone is no worse than dissociate but no better either.

**Recommended defaults:**

- **Self-hosted (most installs):** `--reference <local-base-cache>` (NO `--dissociate`). Base cache lives at the existing `~/.agor/repos/<slug>/` location. Daemon owns it as immutable infrastructure: `fetch --all` periodically; never `gc --prune=now`. Object-store coupling to a daemon-owned cache is fine — every leak vector we're closing is at the `.git/config` layer, not the object layer.
- **Hosted / cloud:** `--filter=blob:none --single-branch --branch <branch>`. True per-branch object independence; blobs lazy from origin. Trade slight network tax (rare in steady state) for not needing a per-pod local base cache.

Escape hatches per config:

```yaml
execution:
  branch_storage:
    mode: clone                    # clone | worktree (worktree deprecated as of N+1)
    clone_strategy: reference      # reference | partial-blobless | shallow | full | reference-dissociate
    shallow_depth: 0               # shallow only; 0 = full
    base_cache_refresh_seconds: 300
    base_cache_gc_prune: false     # gates `gc --prune=now` on base; default false (safe with reference)
```

### 2.2 Clone speed

| Operation | Today (`git worktree add`) | `git clone --reference <local>` | Notes |
|---|---|---|---|
| New branch off `main` | < 1s (creates gitdir pointer + checkouts working tree) | < 5s typical, < 30s worst-case for huge repos | Local disk → local disk. The `--reference` skips object transfer; only working-tree materialize remains. |
| New branch off remote-only ref | Same as above + network fetch | Same | Comparable. |
| Working-tree materialization | Same on both — bound by tree size | Same | Identical cost. |

Speed is **not** a meaningful differentiator. Move on.

### 2.3 Operations complexity

**Worktree mode today** requires the daemon to:
- Maintain a per-repo bare-ish clone at `~/.agor/repos/<slug>/`.
- Run `git worktree add` for every branch; track per-branch gitdir pointers in `.git/worktrees/<name>/`.
- Maintain **two** Unix groups per branch: `agor_rp_<repo-id>` (for the shared base) and `agor_wt_<wt-id>` (for the branch dir). Users in `others_can: all` need to be in **both**.
- Run cross-cutting POSIX ACLs to coordinate the two groups (`packages/core/src/unix/group-manager.ts:20-51`).
- Belt-and-braces credential hardening to compensate for shared `.git/config` (Layer A of credential-leak defenses).
- The base repo's `.git/config` is daemon-managed *and* a target for accidental writes from any agent on any worktree.

**Clone mode** collapses to:
- One self-contained `.git` per branch (no shared base config).
- **One** Unix group per branch (`agor_wt_<wt-id>` only — or rename to `agor_br_<br-id>` post-rename).
- POSIX ACL setup unchanged but applies to one directory, not two.
- No belt-and-braces credential hardening required at the shared-state layer (per-uid Layer C still needed for homedir leaks; that's orthogonal).
- The local-base-cache (used by `--reference`) is read-only from the daemon's perspective after initial materialization; it has no writable shared config surface.

This is a **simplification, not a complication.** The "one of N branches needs both groups + shared base" footgun goes away.

### 2.4 Migration of existing branches

506 `preset-io/agor` worktrees + ~349 `apache/superset` + ~160 `superset-shell` + … ≈ **1,347 live worktrees in the local installation**, and similar order of magnitude on production.

The migration is **in-place**: we never move the worktree's files. We only swap its `.git` gitdir-pointer file for a fresh `.git/` directory built by `git clone --no-checkout --reference`. Full procedure in §6.

**Per-branch migration:** ~5–30 seconds. Local-disk-only, no working-tree materialization needed.

**Risk windows:**
- **In-flight sessions** during migration. Per-branch lock (block new session start; respect existing session locks; let active sessions finish or refuse if `--force-stop`). Bulk run prefers planned maintenance for tidiness; online migration is the fallback for stragglers.
- **Uncommitted working-tree state.** Preserved automatically — the worktree's files never move; only `.git` swaps. `git status` post-swap is identical to pre-swap. Validated as a step in the procedure.

**Engineering effort:** ~3–5 eng-days to write the migration tool + 30–60 min for the bulk pass.

### 2.5 UI / API / MCP rename

Surface counts (from explore agent + grep):

| Surface | "worktree" count | Effort |
|---|---|---|
| MCP tool names with `agor_worktrees_*` prefix | **8 tools** in `apps/agor-daemon/src/mcp/tools/worktrees.ts` (`get`, `list`, `create`, `update`, `set_zone`, `archive`, `unarchive`, `delete`) | Alias new `agor_branches_*` names alongside old; deprecation period 1–2 minor versions. |
| UI strings/labels (TS/TSX) | ~1,343 occurrences across 379 files in `apps/agor-ui/src/` | Codemod-able. Single PR. Risk: low (test snapshots). |
| Component / file names (e.g. `WorktreeCard.tsx`, `NewWorktreeModal.tsx`) | ~10 files | Mechanical rename. |
| DB tables (`worktrees`, `worktree_owners`, columns `worktree_id`, etc.) | All over the schema | **DEFER.** Not in scope of this migration. Schema rename is a separate, riskier follow-up; aliases at the API layer are sufficient. |
| `WorktreeId` branded type | Throughout `packages/core/src/types/` | **DEFER.** Internal rename can lag the UI rename by 1+ release. |

**The DB schema rename is out of scope.** "Branch" is a name change at the user-facing layer (UI, MCP aliases, public API names). The schema, the branded types, and the internal var names can stay as `worktree` for now and rename later without coupling to the storage-model change.

---

## 3. Four options

### Model A — Status quo. Keep `git worktree`. Don't migrate.

| | |
|---|---|
| **Pros** | Zero migration work. No code churn. |
| **Cons** | Keep paying for state-spillover bugs — credential leaks, per-user remote contamination, `core.sshCommand` cross-contamination, the Layer A defenses we've already shipped. Impersonation complexity (two Unix groups per branch, sudo-wrap dance) stays. Executor-pod isolation aspiration stays blocked. |
| **Verdict** | **Reject.** Defenses we've shipped are belt-and-braces against a state-sharing model that we don't need to keep. The Layer A stack alone is 4+ files and ongoing maintenance burden. |

### Model B — Add clone-mode as an opt-in alongside `git worktree`. Keep both forever.

| | |
|---|---|
| **Pros** | Gradual. Users on one mode are unaffected by changes to the other. No deprecation needed. |
| **Cons** | **Dual code paths forever.** Bugs hide in the less-traveled path; tests double; behavior diverges over time. Every git op in `packages/core/src/git/index.ts` (the `createWorktree` / `removeWorktree` / `listWorktrees` cluster, ~10 functions) gets a "which storage mode" switch. The same applies to `services/repos.ts`, `services/worktrees.ts`, executor handlers, Unix group setup. |
| **Verdict** | **Reject.** This is the model the hard rules call out as "the maintenance tax kills us." Codebase carries two implementations of the same primitive in perpetuity. We've seen this anti-pattern before (SQLite + Postgres for `agor.db`; mostly OK because Postgres is gated to hosted, but only one of the two gets daily prod traffic). For branches, both modes would get prod traffic from day one because every existing branch is on worktree-mode. |

### Model C — Make isolated-clone the new default. Keep `git worktree` as a power-user opt-in. Plan its removal.

| | |
|---|---|
| **Pros** | New branches don't have the shared-state problem from day one. Existing branches keep working. Opt-in worktree mode lets users who already have a `git worktree`–optimized workflow keep it during the migration. **Dual code paths exist but only for a known, bounded period** — explicit deprecation plan from the start, not "forever." |
| **Cons** | Still dual code paths during the deprecation window. Migration of existing branches eventually still needs to happen. |
| **Verdict** | **Adopt now.** It's the right shipping intermediate state. The key to making this NOT Model B is **shipping with the deprecation plan in the same PR.** No clone-mode merge without a written `branch_storage_mode: worktree` removal date (T+8 weeks default; behind 1-cycle deprecation alias). |

### Model D — Full migration. Deprecate `git worktree` entirely. Single code path.

| | |
|---|---|
| **Pros** | Single code path. All state-spillover bugs gone structurally. Executor-pod isolation unblocked (the PR #1209 / `executor-isolation` story converges here). One Unix group per branch instead of two. The credential-leak Layer A defenses become "defense in depth" instead of load-bearing. |
| **Cons** | One-time migration of existing worktrees (see §2.4). Brief operational toil. Users who rely on `git worktree` as a feature (object dedup across branches, prefer-worktree commands) lose the affordance. |
| **Verdict** | **The target state.** Ship within 2 release cycles of C. Combined with `--reference --dissociate`, disk costs stay near-flat. |

---

## 4. Recommendation

**Adopt Model C now. Ship Model D within 2 release cycles. Reject A, reject B.**

Phased rollout:

1. **Now (Cycle N):** Land Model C — clone-mode behind `execution.branch_storage.mode = "worktree" | "clone"` (default still `worktree`; opt-in clone for testing). Same PR includes the **deprecation plan** in `apps/agor-docs/pages/guide/worktrees.mdx`: clone-mode default in Cycle N+1, worktree-mode removal in Cycle N+2.
2. **Cycle N+1:** Flip the default. Existing branches stay on whatever mode they were created with (read DB record). New branches default to clone. Worktree mode survives as `branch_storage.mode = "worktree"`.
3. **Cycle N+2:** Migration utility ships. Operators run `agor migrate --branches-to-clone` once. Worktree-mode creation path removed; only migration-utility can still read worktree-mode records (one-way door, on purpose).
4. **Cycle N+3:** Worktree-mode code removed entirely. Storage path is clone-only.

### What sells D over forever-C

The temptation is to stop at C and call it good. Resist. Reasons:

- **Code-path mass matters.** Each of the ~10 git-ops functions in `packages/core/src/git/index.ts` carrying a `storageMode` branch is a permanent tax on every future contributor. The cost compounds.
- **Behavior divergence over time is inevitable.** When clone-mode gets a new flag (say `--filter=blob:none` exposure), worktree-mode doesn't. Six months in, the modes have asymmetric features and the "they should behave identically" invariant we currently document breaks silently.
- **The whole point of this redesign is to remove a primitive that no longer pays its rent.** Keeping it as a "power-user opt-in" forever means we never get the win we set out for.

The exception: **if a hard production blocker emerges** during the clone-mode rollout that we can't fix in clone-mode and only worktree-mode handles (e.g. specific git-LFS or submodule edge case), we extend the deprecation. The plan is "remove worktree-mode in N+2 unless something we don't know yet says otherwise" — not "remove no matter what."

---

## 5. Clone optimization choices

Recommended self-hosted default: **`git clone --reference <local-base-cache> <remote> <branch-path>` followed by `git checkout <branch>`.** No `--dissociate`.

The base cache is exactly today's base clone at `~/.agor/repos/<slug>/` — repurposed from "host of all worktrees" to "objects-only reference cache." After migration the daemon owns it as **append-only infrastructure**: periodic `git fetch --all` to keep it fresh, never `git gc --prune=now`, never `git repack -d` in a way that drops unreachables. Individual branches never write to it.

The state-isolation we care about (configs, remotes, credentials, ssh command, hooks) lives in each branch's own `.git/`. The object store is happy to be shared with the daemon's base cache — no leak vector lives there.

Hosted / cloud default: **`git clone --filter=blob:none --single-branch --branch <branch> <remote> <branch-path>`.** Truly independent. Blobs lazy-fetched from origin on access.

| `clone_strategy` | What it does | Per-branch `.git` | Coupling | Default for |
|---|---|---|---|---|
| `reference` ✓ | `--reference <base-cache>`. Alternates point at base; nothing copied. | Few MB | Base cache must outlive branch + not aggressively pruned | **Self-hosted** |
| `partial-blobless` ✓ | `--filter=blob:none --single-branch`. Lazy blob fetch from origin. | Tens of MB | Origin remote must support partial clone (GitHub.com yes) | **Hosted** |
| `shallow` | `--depth <N>`. Truncated history. | Smallest | Self-contained but `git log` past N broken | Ephemeral / CI-style |
| `full` | Plain clone. Full pack copied. | ~repo pack size | Self-contained | Operators who want zero coupling |
| `reference-dissociate` | `--reference --dissociate`. Copies reachable objects out of reference. | ~repo pack size | Self-contained | **Not recommended** — same disk cost as full clone |

**Risk: base-cache pruning under `reference`.** If an operator runs `git gc --prune=now` on the base cache and removes an unreachable object that some branch's `.git/objects/info/alternates` still depends on, that branch loses access to those objects. The daemon's base-cache management routine must:

1. Never call `git gc --prune=now` on the base cache.
2. If GC is needed, use `git gc --no-prune` (compresses without dropping unreachables).
3. Surface a config knob `branch_storage.base_cache_gc_prune` (default `false`) so operators have to explicitly opt in to pruning.

**Recoverable failure mode:** if the base cache is somehow corrupted or pruned, `git repack -ad --local` in each affected branch materializes the needed objects locally (essentially a deferred `--dissociate` per-branch). Possible but painful; the discipline above prevents it from ever being needed.

**Risk: hosted partial-clone fallback.** If the origin remote disappears (network partition, repo deletion), `partial-blobless` branches lose access to non-materialized blobs. Mitigation: most working-set blobs are already materialized (they're the tracked files on disk); only archeology operations (`git blame` on old commits, `git checkout <old-ref>`) need network. Acceptable.

---

## 6. Migration of existing worktrees — the de-worktreefication procedure

There is **no native `git worktree --dissociate` command.** Git ships no first-class way to convert a worktree into a standalone clone. The two sharing mechanisms — worktree's `commondir` and clone's `--reference`'s `alternates` — are different files, and `--dissociate` only knows how to break alternates.

But the conversion is mechanically straightforward and can be done **in-place without moving the working tree at all**, because `git clone --no-checkout` builds just the `.git/` infrastructure and never touches the working tree. We swap one worktree's `.git` file (the `gitdir:` pointer) for a fresh `.git/` directory and we're done.

### Procedure (per branch)

Pre-conditions (validated by the migration tool):

- The worktree's `.git` file exists and contains `gitdir: <path-to-base>/.git/worktrees/<name>`.
- The base repo is reachable at the path the `gitdir:` line points to.
- The worktree has no in-flight session (lock held).

Steps:

```bash
# 1. Snapshot state for validation
cd "$worktree"
BRANCH=$(git symbolic-ref --short HEAD)            # or git rev-parse for detached
HEAD_SHA=$(git rev-parse HEAD)
REMOTE_URL=$(git remote get-url origin)
STATUS_BEFORE=$(git status --porcelain=v2 --untracked-files=all)

# 2. Build a fresh .git/ infrastructure in a temp dir, NO checkout.
#    --no-checkout means the temp dir's working tree stays empty — we only care about .git/.
git clone --no-checkout --reference "$BASE_CACHE" \
          --single-branch --branch "$BRANCH" \
          "$REMOTE_URL" "/tmp/agor-migrate-$WT_ID/"

# 3. Confirm the new clone's HEAD matches what the worktree was at.
NEW_HEAD=$(git -C "/tmp/agor-migrate-$WT_ID" rev-parse HEAD)
[ "$NEW_HEAD" = "$HEAD_SHA" ] || abort "HEAD drifted during migration"

# 4. Atomic swap: replace the gitdir pointer with the real .git/.
mv "$worktree/.git" "$worktree/.git.gitdir-pointer.bak"
mv "/tmp/agor-migrate-$WT_ID/.git" "$worktree/.git"

# 5. Validate the worktree's git state is unchanged.
STATUS_AFTER=$(cd "$worktree" && git status --porcelain=v2 --untracked-files=all)
diff <(echo "$STATUS_BEFORE") <(echo "$STATUS_AFTER") || rollback

# 6. Detach from base. Cleans up base/.git/worktrees/<name>/.
git -C "$BASE" worktree remove --force "$WT_NAME" || \
  rm -rf "$BASE/.git/worktrees/$WT_NAME" && git -C "$BASE" worktree prune

# 7. Update DB record + commit.
psql -c "UPDATE worktrees SET storage_mode='clone' WHERE worktree_id='$WT_ID'"

# 8. Clean up backup.
rm "$worktree/.git.gitdir-pointer.bak"
```

Rollback if step 5 or step 6 fails:

```bash
rm -rf "$worktree/.git"  # the new .git
mv "$worktree/.git.gitdir-pointer.bak" "$worktree/.git"   # restore old gitdir pointer
# Base repo still has the worktree entry; nothing to undo there.
```

### Why this is clean

1. **The working tree never moves.** Inotify-watching processes, the developer's open editor, in-progress builds in `dist/` — none of them see file-mtime churn.
2. **Uncommitted state is preserved automatically.** We don't rsync, we don't apply diffs. Git's view of "what's dirty" is computed from index + worktree contents — the worktree contents don't change, so the dirty state is identical post-swap.
3. **`.git/objects/` for the new clone is empty** (because `--reference` writes only alternates, no copy). Disk-cost-neutral.
4. **Atomic at the right boundary.** The only window of inconsistency is between step 4 (`mv` the pointer aside) and the end of step 4 (`mv` new `.git` into place). Both are atomic per-directory `rename(2)` calls on the same filesystem; a crash between them leaves the gitdir-pointer backup, and recovery is "rename it back."
5. **`git worktree prune` cleans up base.** Even if the explicit `git worktree remove` fails (e.g. base has a stale lock), `prune` notices the gitdir file is gone and removes the orphan entry.

### Per-branch cost

- Roughly 5–30 seconds per branch (single-branch clone with reference is fast; no working-tree materialization).
- I/O bound on `mv` (same filesystem; cheap).
- Network: zero if the base cache already has all the objects (which it should after a `fetch --all` immediately prior).

### Bulk migration

`agor branches migrate --to clone [--dry-run] [--parallelism N]`:

1. Pre-flight: `git fetch --all` on every base cache so they're fresh; verify base caches exist for every distinct repo in the worktree set.
2. Snapshot DB: `SELECT * FROM worktrees WHERE storage_mode='worktree'` → migration set.
3. Per-worktree lock (block new session creation; respect existing session locks).
4. Run the procedure above with `--parallelism N`. Recommended `N=4` (limited by base-cache concurrent-read safety, which is solid in modern git).
5. Resume-safe: on rerun, only worktrees with `storage_mode='worktree'` get touched.
6. Idempotent: if a worktree's `.git` is already a directory (not a file), skip it as "already migrated."

For Max's local instance (~1,347 worktrees across ~20 repos): estimated 30–60 minutes for the bulk pass at `N=4`.

### Schema add

```sql
ALTER TABLE worktrees ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'worktree'
  CHECK (storage_mode IN ('worktree', 'clone'));
```

Existing rows default to `'worktree'`. New rows post-PR-4 default to `'clone'`. Migration tool flips per-row to `'clone'` as each branch is converted.

### Engineering estimate

**3–5 eng-days** for the migration tool + tests + the storage_mode column migration + a runbook. The conversion procedure itself is ~80 lines of shell or Node; the resilience (locking, parallelism, resume, dry-run, rollback) is the bulk of the work.

---

## 7. Naming: Worktree → Branch

**Why now (independent of the storage change):**

- "Worktree" is ambiguous. To git users it means the native primitive; to Agor users it means "a feature branch with its own dev env." We use it in the latter sense, but the term-collision causes confusion in support channels and in product copy.
- "Branch" is universal. Everyone — git users, non-git users, PMs, designers — understands "branch." It maps 1:1 to the GitHub branch (which is how customers think about the unit of work).
- The rename is independent of the storage migration. We can ship the rename first (faster, lower-risk) and the storage change behind it — or vice versa. They don't depend on each other.

**Rename plan:**

| Layer | Change | When |
|---|---|---|
| UI strings | "Worktree" → "Branch" in labels, modals, tooltips, drawer titles | This worktree's parallel PR (PR 6 below) |
| UI component names | `WorktreeCard.tsx` → `BranchCard.tsx`, etc. | Same PR (codemod) |
| MCP tool names | Add `agor_branches_*` as aliases for `agor_worktrees_*`. Both work for 1–2 minor versions. Deprecation log on old names. | Same PR |
| Public API endpoint paths | `/api/worktrees/*` continues to work; `/api/branches/*` added as alias. Deprecate old in 2 minor versions. | Same PR |
| DB schema (`worktrees` table, `worktree_id` columns, etc.) | **Do NOT rename.** Stays as `worktrees`. | Never, in this round |
| Branded type `WorktreeId` | **Do NOT rename.** Stays. | Defer to a future "internal rename" PR if ever |
| Filesystem path (`~/.agor/worktrees/<slug>/<name>/`) | **Do NOT rename.** Filesystem layout stays. | Never, in this round |

The DB schema, branded types, and on-disk paths are explicitly **out of scope** for the rename. The user-visible vocabulary changes; the internal vocabulary stays. This is the standard pattern for low-risk renames — invest the surface-visible win, defer the costly internal sweep.

---

## 8. Phased delivery + next-step PRs

Sequenced so the lowest-risk pieces land first.

| # | PR | Risk | Dependency | When |
|---|---|---|---|---|
| **PR 1** | **`feat(config): branch_storage config + storage-mode column`** — Adds `execution.branch_storage` config block (default `mode: "worktree"`, no behavior change). Adds `worktrees.storage_mode ENUM('worktree','clone') DEFAULT 'worktree'` schema column + migration. Adds operator docs in `multiplayer-unix-isolation.mdx` and `worktrees.mdx`. No code-path changes. | **Low** — additive only | None | Cycle N, week 1 |
| **PR 2** | **`feat(branch): clone-mode storage path`** — Implements clone-mode behind the config flag. Clone-strategy default `reference-dissociate`. Includes parity test suite against existing worktree-mode for: create, remove, list, env-start, session-prompt, agent-edit-commit-push. Does not flip default. | **Medium** — new code path | PR 1 | Cycle N, weeks 2–4 |
| **PR 3** | **`feat(branch): per-branch Unix group simplification under clone-mode`** — In clone-mode, drop the per-repo `agor_rp_<id>` group from the user-group-set. Members of `others_can: all` only need the per-branch `agor_wt_<id>` group. Worktree-mode unchanged. | **Medium** — touches Unix isolation | PR 2 + `address-issue-1140-impersonation-abstraction` landed | Cycle N, week 5 |
| **PR 4** | **`feat(branch): flip default to clone`** — Default `branch_storage.mode = "clone"`. Existing branches keep `storage_mode = 'worktree'`; new branches get `'clone'`. Deprecation warning when `mode: "worktree"` is explicitly set. | **Medium** — behavior change for new branches | PR 2 + PR 3 | Cycle N+1, week 1 |
| **PR 5** | **`feat(branch): migration utility`** — `agor branches migrate --to clone`. Includes lock, snapshot, atomic swap, rollback. Tested against representative worktree shapes (clean, dirty, with submodules, with LFS files). | **High** — touches user data | PR 4 | Cycle N+1, weeks 2–3 |
| **PR 6** | **`feat(ui): rename Worktree → Branch in UI + MCP-tool aliases`** — Independent of the storage migration. UI strings, component file names, MCP tool name aliases (both `agor_branches_*` and `agor_worktrees_*` work; old emits deprecation warning). | **Low** — surface-only | None (parallel) | Cycle N, any week |
| **PR 7** | **`refactor(branch): remove worktree-mode storage path`** — After deprecation period expires. Removes the `mode: "worktree"` config option and the worktree-mode code path. Worktrees still in DB with `storage_mode = 'worktree'` blocked from session creation until migrated. | **Medium** — removes a feature | PR 5 + 1 cycle of operator deprecation notice | Cycle N+2, week 1 |
| **PR 8** | **`refactor(branch): remove worktree-mode DB code`** — Final cleanup. `storage_mode` column becomes implicit (DEFAULT 'clone', or dropped). | **Low** | PR 7 | Cycle N+3 |

**"Ship today" candidates** (PRs that don't block on this design doc landing — they can start the moment Max signs off):

- **PR 1** (config + schema) — fully additive, no behavior change. Safe.
- **PR 6** (UI rename) — independent of storage. Safe.

Everything else is sequenced.

---

## 9. Risks + open questions

### 9.1 Risks

1. **`--reference --dissociate` edge cases.** If the base cache is missing on first clone, the clone fails. Mitigation: daemon pre-flight checks base cache existence + freshness before issuing clone; auto-creates if absent.
2. **In-flight session migration.** Migrating a branch while a session is mid-task is risky. Mitigation: lock-wait pattern in the migration tool + a planned maintenance window for the bulk pass.
3. **Submodule + LFS handling.** Worktree mode's behavior with `.gitmodules` and Git LFS is well-trodden; clone mode needs explicit testing. Add to PR 2's parity test suite.
4. **Disk-space pathologies on `--reference` mode.** If users run `git gc` on the base cache while many `mode: reference` (without dissociate) branches exist, they corrupt objects. Mitigation: default to `--dissociate`; document the no-gc rule for `mode: reference`.
5. **MCP-tool alias deprecation window mismatch.** External integrations using `agor_worktrees_*` need a real deprecation window — 1 minor version is too short. Recommend 2 minor versions + telemetry on usage of old names.
6. **DB schema rename pressure.** Once users see "Branch" everywhere in the UI but the DB still says `worktrees`, there will be pressure to rename the schema too. Resist this in scope. Schema rename is a separate, dangerous PR that doesn't need to happen at all (compare: most apps have `users` table and call them "members" or "accounts" in UI without harm).

### 9.2 Open questions

1. **Default `clone_strategy` for hosted vs self-hosted.** Hosted may want `partial-blobless` (lazy blob fetch) since storage costs there are operator-paid. Self-hosted default `reference-dissociate` makes sense for local disk efficiency. Decide before PR 4.
2. **Local-base-cache placement.** Today the base clone lives at `~/.agor/repos/<slug>/` and is also the worktree-base. Post-migration, it's *only* the reference cache. Do we move it (e.g. `~/.agor/object-caches/<slug>/`) or keep the path for backward compat? Recommend keeping the path; let the on-disk identity be a "this is the reference cache" semantic in code, not a path change.
3. **Migration trigger.** Auto-migrate on daemon startup (with operator confirmation) or require explicit `agor branches migrate`? Recommend explicit. Auto-migration on startup is the kind of thing that goes wrong on first contact with reality.
4. **`storage_mode` UI surface.** Do we show it in the branch detail UI ("Storage: Native worktree" / "Storage: Clone")? Probably yes for the deprecation window — gives users an obvious place to see what they're on and migrate.
5. **Does the per-repo `agor_rp_*` Unix group go away entirely, or stay for the local-base-cache?** The base cache still has files; technically a group governs them. But no user other than the daemon ever reads/writes there. Recommend: keep `agor_rp_*` but limit membership to daemon-user only. Mid-migration, this is the smallest change.
6. **What happens to `gitdir:` workflows like `git worktree list` on the base cache after migration?** Nothing — the base cache is just an objects-only repo, no `.git/worktrees/` entries. The `git worktree` commands continue to be available for users who shell into the daemon and want to use them on their own (we don't intercept native git).

### 9.3 Coordination with in-flight worktrees

- **PR #1209 `analyze-daemon-fs-decoupling`** — clone-mode is the "isolated FS state per execution unit" primitive that PR #1209's hosted-env-pod design assumes. Land clone-mode before or alongside hosted env-pods so they don't have to design around the `gitdir:` complication.
- **`design-ui-daemon-executor-segmentation`** — same as above. Executor isolation is much cleaner when the volume is a self-contained clone vs. a `gitdir:` pointer into another volume.
- **`address-issue-1140-impersonation-abstraction`** — clone-mode reduces the per-branch Unix-group set from 2 to 1, which simplifies the impersonation abstraction's job. **Sequence: #1140 lands first**, then PR 3 picks up the reduced group set.
- **`design-git-config-leak-defenses` (Layer A, shipped)** — the Layer A defenses become "defense in depth" once clones land. Don't remove them; they still cover same-branch leaks. But the threat-model doc should be updated post-PR 7 to reflect that vectors 1, 2, 3, 4, 8, 11 are now structurally closed instead of behaviorally mitigated.
- **`git-extraheader-refactor`** (shipped) — same posture as Layer A; remains valuable for in-process credential delivery but no longer load-bearing for cross-branch isolation.

---

## 10. Decision asked

1. ✅ / ❌ — **Adopt Model C now, Model D within 2 release cycles.** (Pick one of A/B/C/D.)
2. ✅ / ❌ — **Default clone strategy: `--reference --dissociate`.**
3. ✅ / ❌ — **Rename Worktree → Branch in UI + MCP-tool aliases (PR 6), independent of storage migration. Defer DB schema rename indefinitely.**
4. ✅ / ❌ — **Sequence: PR 1 (config + schema column) + PR 6 (rename) can start immediately; PR 2 onward sequenced as in §8.**
5. ✅ / ❌ — **Worktree-mode removal target: Cycle N+2 (after one cycle of deprecation notice + one cycle of clone-default).**

If yes on all five, the next concrete action is to authorize PR 1 + PR 6 to start. The other PRs are stage-gated on the same decision but don't need separate sign-off.

---

_End of analysis. No code in this worktree._
