# Migrating from `strict`/`insulated` to `sandbox`

Operator runbook for moving a self-hosted, multi-user Agor deployment off the
Unix-account isolation modes (`strict`, `insulated`) onto the filesystem-sandbox
mode (`unix_user_mode: sandbox`).

> This is an operator-reviewed reference procedure, not a one-command upgrade or
> rollback mechanism. There is no published 0.24 bridge release: perform the
> conversion as an offline 0.24.7 → 0.25.1 cutover using the scripts from the
> 0.25.1 source tree. Design + threat model:
> [`context/explorations/executor-sandboxing.md`](../explorations/executor-sandboxing.md).
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
- **Groups and ACLs stay in place.** The forward conversion changes only inode
  owners. It does not run `chgrp`, `chmod`, or `setfacl`, which retains useful
  strict-mode recovery metadata while making the daemon the effective owner.

## Prerequisites

1. Linux daemon host with `bubblewrap` 0.12.0 or newer installed **and
   unprivileged user namespaces working** — the #1 thing that silently breaks
   on hardened kernels. Agor also functionally verifies `--bind-fd`; both are
   required security boundaries, not optional Codex features.
   Verify functionally (not just "is bwrap on PATH"):
   ```bash
   agor doctor          # look for a green "unprivileged userns" row
   # or directly:
   bwrap --unshare-user --ro-bind / / --dev /dev --proc /proc -- true && echo OK
   ```
   If blocked on Ubuntu 24.04+: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
2. The daemon must run **as the user you will chown everything to** (e.g.
   `agorpg`). Note it — you'll pass it as `--daemon-user`.
3. While still running 0.24.7, inventory nested mount points and all ways the
   daemon can run (systemd, foreground, supervisor, container, and so on).
4. Drain queued/running work, stop **every** daemon connected to the database,
   and take tested database, deployment-config, and storage backups. For
   volume-backed deployments, take an application-consistent volume snapshot.
5. Install the 0.25.1 software without starting its daemon. Run
   `agor db migrate --offline-cutover` from 0.25.1 and verify
   `users.filesystem_home` exists. An old 0.24.7 daemon must never run against
   the advanced migration watermark.
6. Use the migration scripts from the same 0.25.1 source tree. The apply path
   refuses to run while its configured systemd service is active, but it cannot
   prove that foreground, alternate-service, or containerized daemons stopped.

## Procedure

All scripts live in `scripts/`, require Linux/GNU userland, and are **dry-run by
default**. `find -xdev` deliberately does not cross nested mount points; migrate
any inventoried mounted subtree separately.

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

# Drain work and stop the daemon. First create the recovery artifacts and stop
# at the explicit pre-ownership checkpoint:
sudo --preserve-env=DATABASE_URL scripts/strict-to-sandbox-migration.sh \
  --prepare-only \
  --data-home /absolute/agor-data \
  --config /absolute/config.yaml \
  --daemon-user agorpg \
  --tenant-id default \
  --expected-user-count 42

# Verify/preserve the manifest, config backup, ownership plan, and progress
# journal. Then cross the ownership boundary deliberately:
sudo --preserve-env=DATABASE_URL scripts/strict-to-sandbox-migration.sh \
  --apply --resume \
  --data-home /absolute/agor-data \
  --config /absolute/config.yaml \
  --daemon-user agorpg \
  --tenant-id default \
  --expected-user-count 42
```

Steps it performs (in order):

1. Verifies the schema, tenant-visible user count, host identities, config, and
   every resolved home; any missing/unsafe path aborts.
2. Re-runs pre-flight against those exact homes.
3. Writes a non-overwritable compressed ownership manifest, preserves the
   operator config, and freezes a hash-bound ownership plan and progress
   journal. `--prepare-only` exits here; `--resume` verifies and reuses them.
4. Sets every `filesystem_home` in one transaction and verifies the row mapping.
5. Changes owners to the daemon in mount-bounded, restartable units. Repository
   roots, worktree repository buckets, and user homes are independent units.
   Groups are preserved and no explicit mode or ACL rewrite occurs. Completed
   units are synced to the journal; an interrupted unit alone is repeated.
6. Verifies every migration root is daemon-owned.
7. Atomically flips `execution.unix_user_mode: sandbox`.

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

- **Fast:** set `execution.unix_user_mode: simple`; RBAC remains always enabled.
  Disable the web terminal and restart. Ownership already matches the daemon.
  Filesystem and tool-home isolation are degraded until sandbox is restored.
- **Full:** stop every 0.25.1 daemon and restore the complete pre-upgrade
  database, configuration, and storage backup before starting 0.24.7. Retain
  the ownership manifest as forensic recovery data, but do not treat it as an
  automatic rollback tool or replay one `chown` process per inode. Preserved
  branch/repo groups and ACLs reduce recovery work, but the old daemon cannot
  safely run against the 0.25.1 migration watermark.

## Known behavior changes to expect

- **RBAC is already on.** Non-owner sessions on
  a branch whose `others_fs_access` is `read` will mount the branch **read-only**;
  `none` rejects the spawn with a clear error. Owners are unaffected (`write`).
  Decide up front whether shared branches should default to `write`.
- **Prompting another user's Session** is allowed only for a branch-home
  Session when both sharing switches permit it. The conversation and branch
  SDK state are shared, while execution home and credentials come from the
  actual prompter. Execution-home Sessions are never shareable.
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
