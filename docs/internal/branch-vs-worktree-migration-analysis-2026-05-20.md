# Branch / Worktree Migration Analysis — 2026-05-20

**Status:** Design / position paper. **No code changes in this worktree.**
**Author:** Claude (Opus 4.7) for Max
**Decision asked:** Pick one of A / B / C / D and authorize the first one or two follow-up PRs.

---

## TL;DR

**Recommendation: Model C now, Model D within two release cycles.** Make isolated clones the new default for what we today call a "Worktree," keep native `git worktree` as a power-user opt-in behind an `execution.branch_storage` config knob, and **plan the worktree-mode removal up front** (~6–8 weeks out, behind a 1-cycle deprecation alias). Rename **Worktree → Branch** in the UI and as MCP-tool aliases in parallel — that's a cheap, independent quality-of-life win.

Why C-now: every git-state-spillover incident we've shipped a defense for in the last quarter (credential leaks across sibling worktrees; per-user remotes baked into shared config; `core.sshCommand` cross-contamination; the in-flight `git-extraheader-refactor` belt-and-braces work) **goes away structurally** under isolated clones. The Layer A/B/C stack in [`credential-leak-defenses-2026-05-11.md`](./credential-leak-defenses-2026-05-11.md) exists to compensate for state-sharing that isolated clones don't have in the first place.

Why D within two cycles: dual code paths are a maintenance tax we should treat as a debt, not an architecture. Model B (clone-mode as a permanent peer of worktree-mode) is explicitly rejected for this reason. The point of shipping C is to *de-risk the migration*, not to canonize two modes.

Why disk cost is solved: with `git clone --reference <local-base-cache> --dissociate` (or `--filter=blob:none` where the remote supports partial clone), the per-branch disk overhead drops from "full repo" to "working tree + a few MB of refs." On our largest base repo today (`apache/superset` at 1.16 GB pack), 200 branches under naïve cloning would cost ~232 GB more than today's worktree model; under `--reference --dissociate` it costs **a few hundred MB total**, dominated by the per-branch working tree, **not** by `.git`. The "clones are too expensive" intuition is a pre-2017 one; modern git options make it a non-issue.

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

`.git` overhead per representative repo (`du -sm <repo>/.git` for base clones at `~/.agor/repos/<slug>/`):

| Repo | `.git` size | Why it matters |
|---|---|---|
| `apache/superset` | **~1.5 GB** (1.16 GB pack-size from `count-objects -vH`) | The worst-case live customer-scale repo we have. |
| `agor-openclaw` | 865 MB | |
| `apache/airflow` | 604 MB | Large OSS, deep history. |
| `preset-io/agor` | 323 MB | This repo. |
| `preset-io/manager` | 108 MB | Typical product repo. |
| Median across 20 live repos | ~150 MB | Most repos are smaller than the headline. |

Working-tree size per branch (sampled from 3 active `preset-io/agor` worktrees):

| Branch | Working-tree size |
|---|---|
| `design-worktree-to-branch-and-clone-model` | 110 MB |
| `address-issue-1140-impersonation-abstraction` | 108 MB |
| `analyze-daemon-fs-decoupling` | 109 MB |

Branch counts (live, per-repo):

| Repo | Branch count |
|---|---|
| `preset-io/agor` | **504** |
| `apache/superset` | 349 |
| `preset-io/superset-shell` | 160 |
| `preset-io/agor-assistant-private` | 78 |
| `preset-io/manager` | 59 |

#### Disk cost: today vs. naïve clones vs. `--reference --dissociate`

For `apache/superset` at 1.16 GB pack + 349 active branches:

| Strategy | Cost | Per-branch overhead |
|---|---|---|
| **Today (git worktree)** | 1 × 1.16 GB pack + 349 × working-tree | `.git` overhead = **~0 per branch** (gitdir pointer is kB). Working tree dominates. |
| **Naïve `git clone`** | 349 × (1.16 GB pack + working-tree) | **+1.16 GB per branch** = **+405 GB total** vs today |
| **`git clone --reference <local-base> --dissociate`** | 1 × 1.16 GB base cache + 349 × (working-tree + ~few-MB independent refs + objects-needed-for-branch) | **~few MB per branch** of independent objects ([git docs](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---dissociate)). Working tree still dominates. |
| **`git clone --filter=blob:none`** (partial) | 349 × (small commit/tree-only refs + working-tree + blobs-as-needed) | **~tens of MB per branch.** Lazy blob fetch on demand. Requires server-side support (GitHub.com: yes; some self-hosted: no). |
| **`git clone --depth N`** (shallow) | 349 × (small refs + working-tree) | **Smallest.** But `git log` past N commits doesn't work, can't push some operations cleanly. Not for general use. |

**Bottom line:** with `--reference --dissociate` (or partial clone on supported remotes), per-branch overhead is **dominated by the working tree, not by `.git`.** The naïve-clone "10–100× disk" warning from `credential-leak-defenses-2026-05-11.md` §3.2 (Option 2 evaluation) **only applies to naïve clones**; it's not the design we'd ship.

**Recommended default:** `--reference <local-base-cache> --dissociate`. Rationale:
1. Independent — base cache can be GC'd or moved without breaking child clones.
2. Cheap — copies only the objects the branch ref actually needs.
3. Available on any git ≥ 2.3 (no server-side support required, unlike partial clone).
4. Composes with `--filter=blob:none` later if we want even cheaper.

Escape hatches per config:
- `branch_storage.clone_mode: "reference-dissociate" | "reference" | "full" | "partial-blobless" | "shallow"` (operator can choose per env).
- `branch_storage.shallow_depth: <N>` for `shallow` mode.

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

For each:
1. `git clone --reference <base-cache> --dissociate <remote> <new-clone-path>` (or copy strategy from existing worktree, see §6).
2. `git checkout <branch-ref>` to match current state.
3. If the worktree has uncommitted changes: `git stash apply` / copy diff over after clone. (See §6 risk handling.)
4. Update DB record `worktrees.path` if path changes; otherwise atomically swap dir contents.
5. Detach old `git worktree` (`git worktree remove <name>` on the old base).

**Per-branch migration:** ~2–10 minutes (mostly working-tree copy / `--reference` setup), scriptable in parallel.

**Risk windows:**
- **In-flight sessions** during migration. Need a per-branch lock (block session start; let active sessions finish; migrate; unlock). Alternative: do migration as a planned maintenance window (daemon down, batch-migrate, daemon up). Recommended: planned maintenance for the bulk run, online migration as a backstop for branches that come in late.
- **Uncommitted working-tree state.** Most worktrees have some dirty state (`fs.statSync` and `git status` differ from committed). Migration must preserve it, not lose it. Strategy: rsync working tree from old worktree to new clone, then `git checkout` the right ref, then validate file diffs match. We have `git status`-equivalent capture in `packages/core/src/git/index.ts:1268-1309` (`getGitState`) for the lock/release fences.

**Engineering effort:** ~3–5 eng-days to write the migration tool + 1 maintenance window of ~30 min for the bulk pass. Not weeks.

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

Recommended default: **`git clone --reference <local-base-cache> --dissociate <remote> <branch-path>` followed by `git checkout <ref>`.**

The local-base-cache is exactly today's base clone at `~/.agor/repos/<slug>/` — repurposed from "host of all worktrees" to "objects-only reference cache." It's not user-visible state anymore; the daemon keeps it fresh via periodic `git fetch --all`, and individual branches never write to it.

Knobs (in `~/.agor/config.yaml`):

```yaml
execution:
  branch_storage:
    mode: clone               # clone | worktree (worktree deprecated as of N+1, removed N+3)
    clone_strategy: reference-dissociate   # see table below
    shallow_depth: 0           # for clone_strategy=shallow only; 0 = full
    base_cache_refresh_seconds: 300  # how often to `fetch --all` into base cache
```

| `clone_strategy` | What it does | Per-branch `.git` overhead | When to use |
|---|---|---|---|
| `reference-dissociate` (default) | Clone with `--reference <base-cache> --dissociate`. Independent objects after creation. | Few MB | **Default.** Independent + cheap. |
| `reference` | Clone with `--reference <base-cache>` (no dissociate). Cheapest, but base cache becomes load-bearing — pruning it breaks every branch referencing it. | < 1 MB | Power-user mode where disk is precious and operator commits to never running `git gc` on the base cache. |
| `full` | Plain `git clone`, no reference. Each branch is fully self-contained. | Full pack size | Operators who want zero coupling between base cache and branches — at the cost of `.git`-per-branch disk. |
| `partial-blobless` | `git clone --filter=blob:none`. Lazy blob fetch. | Tens of MB | Modern git ≥ 2.20, server-side partial-clone support (GitHub.com: yes). Optional. |
| `shallow` | `git clone --depth <N>`. Limited history. | Smallest | Ephemeral PR-style branches that don't need history. Not safe as default — `git log` past N is broken. |

**Risk of `reference-dissociate`:** if the base cache is missing or corrupted at clone time, the clone fails. Daemon must ensure the base cache exists before issuing clones — straightforward to add as a precondition in `services/repos.ts`'s `createWorktree`.

**Risk of `reference` (no dissociate):** as above, plus the base cache becomes part of every branch's object graph. `git gc` / repacking the base cache while a branch is being committed-to → object corruption in the branch. **Hence we default to `--dissociate`** to break the link.

---

## 6. Migration of existing worktrees

One-time tool: `agor branches migrate --to clone [--dry-run]`.

For each worktree record in DB:

1. **Lock** the worktree (block new session starts; let active sessions finish or refuse if `--force-stop`).
2. **Snapshot** working-tree state: `git status --porcelain=v2 --untracked-files=all` from the old worktree. Capture diff vs HEAD.
3. **New clone**: `git clone --reference <base-cache> --dissociate <remote> <new-path-temporary>`.
4. **Checkout** the branch ref: `git checkout <ref>` in the new clone.
5. **Apply diff**: rsync uncommitted working-tree changes from old worktree to new clone (preserve dirty state). Validate `git status` post-rsync matches snapshot.
6. **Atomic swap**: rename old worktree dir aside, move new clone into place, update DB `worktrees.path` and `worktrees.storage_mode` columns.
7. **Detach old**: `git worktree remove <old-name>` on the base repo's worktrees list (cleanup `.git/worktrees/<name>/`).
8. **Unlock**.

Failure handling:
- Per-branch failure rolls back to old worktree (atomic swap is reversible until step 7).
- Bulk failure: maintenance window pause; resume on retry.
- The DB gets a new column `worktrees.storage_mode ENUM('worktree','clone')` so partial-migration state is queryable.

**Estimated effort:** 3–5 eng-days for the tool + tests + one-time runbook + the storage_mode column migration. The migration itself is ~30–60 min for ~1,500 worktrees if parallelized 4–8 wide.

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
