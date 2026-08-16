# Migrating from `strict`/`insulated` to `sandbox`

Operator runbook for moving a self-hosted, multi-user Agor deployment off the
Unix-account isolation modes (`strict`, `insulated`) onto the filesystem-sandbox
mode (`unix_user_mode: sandbox`).

> Status: interim guide (mostly for the Agor team's own box). As `strict` /
> `insulated` are formally deprecated this will graduate into `apps/agor-docs`.
> Design + threat model: [`context/explorations/executor-sandboxing.md`](../explorations/executor-sandboxing.md).
> User-facing setup: `apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx` → "Sandbox mode".

---

## What changes

|                  | `strict` / `insulated`                                    | `sandbox`                                               |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Isolation        | Unix uids / groups / FS perms + sudoers                   | bubblewrap mount namespace                              |
| Process identity | per-user (`strict`) or shared executor user (`insulated`) | **always the daemon user**                              |
| Per-user home    | the user's real `/home/<user>` (strict)                   | overlay from `users.filesystem_home` or canonical store |
| Branch authz     | Unix group perms                                          | RBAC-computed rw/ro/none mounts                         |
| Host plumbing    | sudoers, host accounts, `agor_wt_*` groups, password sync | none                                                    |

The accepted trade-off: you lose per-user OS identity (everything runs as the
daemon user) and SSH-into-the-box parity. Isolation is now a namespace boundary,
not a uid boundary. This targets **trusted-org multi-user**, not hostile
multi-tenant (use containers/microVMs for that).

## Risk and recovery model

- **`chown → daemon user` is aligned with the `simple` fallback.** If sandbox
  misbehaves you can drop to `unix_user_mode: simple` and keep the same
  ownership — no re-chown needed to recover availability. `simple` is a
  time-bounded degraded security mode, not an isolation-equivalent rollback.
- **No files move.** The migration sets each user's `filesystem_home` to their
  existing `/home/<unix_username>`, and the sandbox overlays it **in place**. So
  in-flight session state (`~/.claude/projects/**`, Codex `sessions/**`) is
  preserved and sessions resume normally.
- **Ownership still changes at large scale.** The migration writes a compressed,
  NUL-delimited numeric owner/group/path manifest before chowning. On trees with
  millions of inodes that artifact can still be large and is not a substitute
  for the deployment's normal volume/database backup.

## Prerequisites

1. Linux daemon host with `bubblewrap` installed **and unprivileged user
   namespaces working** — the #1 thing that silently breaks on hardened kernels.
   Verify functionally (not just "is bwrap on PATH"):
   ```bash
   agor doctor          # look for a green "unprivileged userns" row
   # or directly:
   bwrap --unshare-user --ro-bind / / --dev /dev --proc /proc -- true && echo OK
   ```
   If blocked on Ubuntu 24.04+: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
2. The daemon must run **as the user you will chown everything to** (e.g.
   `agorpg`). Note it — you'll pass it as `--daemon-user`.
3. Deploy database migrations first and verify `users.filesystem_home` exists.
4. Back up the database and deployment config. For volume-backed deployments,
   take an application-consistent volume snapshot before changing ownership.
5. Drain queued/running work and stop the daemon before `--apply`. The script
   refuses to apply while its configured systemd service is active.

## Procedure

All scripts live in `scripts/` and are **dry-run by default**.

### 1. Pre-flight: confirm home relocation is safe

```bash
sudo scripts/sandbox-home-migration-preflight.sh '/home/*' --stable-home /home/agorpg
```

Read-only; prints per-file hit counts only (never contents). It scans each
home's tool state for that home's own absolute path in three tiers:

- **AUTH/SETTINGS** (`auth.json`/`.credentials.json`/`settings.json`) — a hit
  here **blocks** (would break tool auth after relocation).
- **CWD REGISTRY** (`.claude.json` `.projects`, `config.toml` `[projects."…"]`)
  — cwd-keyed, expected, **not** a blocker.
- **SESSIONS** (`.codex/sessions/**`) — historical transcripts, cosmetic.

Exit 0 / "SAFE" means no auth/settings file hard-codes a home path that the
overlay will hide.

### 2. Migrate (dry-run, stop daemon, then apply)

```bash
# SQLite: preview every action as root so all credential files are readable.
sudo scripts/strict-to-sandbox-migration.sh \
  --data-home /absolute/agor-data \
  --config /absolute/config.yaml \
  --daemon-user agorpg

# PostgreSQL: DATABASE_URL is used through psql under the tenant's forced RLS
# scope. The expected count is mandatory on apply so a narrowed scope fails.
sudo --preserve-env=DATABASE_URL scripts/strict-to-sandbox-migration.sh \
  --data-home /absolute/agor-data \
  --config /absolute/config.yaml \
  --daemon-user agorpg \
  --tenant-id default \
  --expected-user-count 42

# Drain work, stop the daemon, repeat the exact reviewed command with --apply.
```

Steps it performs (in order):

1. Verifies the schema, tenant-visible user count, host identities, config, and
   every resolved home; any missing/unsafe path aborts.
2. Re-runs pre-flight against those exact homes.
3. Writes a non-overwritable compressed ownership manifest and preserves the
   operator config. `--resume` reuses and verifies those artifacts.
4. Sets every `filesystem_home` in one transaction and verifies the row mapping.
5. Chowns each resolved home's canonical directory and the canonical data root
   to the daemon owner (important when `/home/<user>` is a symlink).
6. Atomically flips `execution.unix_user_mode: sandbox`.

**Do not use `--teardown` on the initial migration.** PostgreSQL runs reject it
because tenant-scoped RLS cannot prove that deleting host-global groups is safe.
Keep users, groups, and sudoers until sandbox has a meaningful production soak.

### 3. Restart + verify

```bash
# restart the daemon so the new config + the filesystem_home migration apply
```

Then run one real task per agentic tool you use (**Claude, Codex, Gemini**) and,
inside a session, confirm:

- `cat ~/.agor/config.yaml` → **Permission denied / No such file** (secrets hidden)
- `ls ~` shows the user's own home; writes to the branch succeed; `git commit` works
- a sibling branch / another user's home is not visible

## Rollback

- **Fast:** set `execution.unix_user_mode: simple`, keep `branch_rbac: true`,
  disable the web terminal, and restart. Ownership already matches the daemon.
  Filesystem and tool-home isolation are degraded until sandbox is restored.
- **Full:** retain the ownership manifest as forensic rollback data, but do not
  replay one `chown` process per inode. Reconcile branch/repo permissions in
  bulk with `agor local sync-unix`, restore homes by owner in bounded batches,
  restore sudoers if removed, then return to `strict`/`insulated`.

## Known behavior changes to expect

- **RBAC turns on.** `sandbox` implies `branch_rbac: true`. Non-owner sessions on
  a branch whose `others_fs_access` is `read` will mount the branch **read-only**;
  `none` rejects the spawn with a clear error. Owners are unaffected (`write`).
  Decide up front whether shared branches should default to `write`.
- **Prompting another user's session** runs against the **owner's** home (their
  tool auth/state) — carry the same warning as before ("letting others prompt
  your session gives them your home"). Env-level credentials still come from the
  prompter via the env-resolver, not the owner.
- **Terminals** get the same sandbox treatment as prompts: per-user home overlay
  (keyed by the terminal user), RBAC-aware branch mount (ro / refused without
  write), and masked daemon secrets.
- **Repo-level git ops** (clone / realign-origin) run unwrapped as the daemon
  user — Agor's own trusted code, no branch cwd.

## Failure modes / gotchas

| Symptom                                | Cause                                                    | Fix                                                                 |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| All sessions fail to start immediately | unprivileged userns blocked on host                      | `agor doctor`; enable userns, or fall back to `simple`              |
| Tools re-prompt for auth in a session  | user had no `unix_username`/home → empty canonical store | populate `filesystem_home`, or let the user re-auth once (persists) |
| Non-owner agent can't write the branch | RBAC `others_fs_access: read` → ro mount                 | grant write on the branch, or raise the default                     |
| Migration ran as the wrong user        | daemon runs as a different user than the chown target    | re-run with the correct `--daemon-user`; daemon must own the tree   |
| PostgreSQL user count differs          | wrong tenant/RLS scope or changed user inventory         | stop; reconcile the expected count before any apply                 |
