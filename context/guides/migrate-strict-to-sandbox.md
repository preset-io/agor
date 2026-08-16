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

## Why the migration is low-risk (no full backup needed)

- **`chown → daemon user` is aligned with the `simple` fallback.** If sandbox
  misbehaves you can drop to `unix_user_mode: simple` (or set
  `sandbox.fail_if_unavailable: false`) and everything keeps working with the
  same ownership — no re-chown needed to recover. The only mode you can't
  cleanly fall back to is `strict` (per-user uids), which you're leaving anyway.
- **No files move.** The migration sets each user's `filesystem_home` to their
  existing `/home/<unix_username>`, and the sandbox overlays it **in place**. So
  in-flight session state (`~/.claude/projects/**`, Codex `sessions/**`) is
  preserved and sessions resume normally.
- **Cheap insurance instead of a backup.** The migration script writes an
  ownership manifest (`find … -printf '%u %g %p'`) before chowning — a tiny text
  file that can reconstruct prior ownership even for a multi-TB tree.

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

## Procedure

All scripts live in `scripts/` and are **dry-run by default**.

### 1. Pre-flight: confirm home relocation is safe

```bash
scripts/sandbox-home-migration-preflight.sh '/home/*'
```

Read-only; prints per-file hit counts only (never contents). It scans each
home's tool state for that home's own absolute path in three tiers:

- **AUTH/SETTINGS** (`auth.json`/`.credentials.json`/`settings.json`) — a hit
  here **blocks** (would break tool auth after relocation).
- **CWD REGISTRY** (`.claude.json` `.projects`, `config.toml` `[projects."…"]`)
  — cwd-keyed, expected, **not** a blocker.
- **SESSIONS** (`.codex/sessions/**`) — historical transcripts, cosmetic.

Exit 0 / "SAFE" means no auth/settings file hard-codes its home path. (On Agor's
prod box this passed across 40+ homes with zero auth blockers.)

### 2. Migrate (dry-run, then apply)

```bash
# Preview every action, change nothing:
scripts/strict-to-sandbox-migration.sh --daemon-user agorpg

# Execute:
scripts/strict-to-sandbox-migration.sh --daemon-user agorpg --apply
```

Steps it performs (in order):

1. Re-runs the pre-flight (aborts on blockers).
2. Writes the ownership manifest to `$AGOR_DATA_HOME/ownership-manifest-pre-sandbox.txt`.
3. For each Agor user with a `unix_username`: sets `filesystem_home` to their
   passwd home (`getent passwd`) and `chown -R <daemon-user>` that home.
4. `chown -R <daemon-user>` the whole `$AGOR_DATA_HOME` (worktrees + repos + db + config).
5. Flips `execution.unix_user_mode: sandbox` in `config.yaml`.

Add `--teardown` to also `groupdel agor_wt_*` and remove
`/etc/sudoers.d/agor-daemon`. **Recommendation: skip `--teardown` on the first
pass** — leave the Unix accounts/groups in place until sandbox is proven, then
tear down later.

Postgres note: the DB step uses `sqlite3` for the common self-hosted case. On
Postgres the script prints the `UPDATE users SET filesystem_home=…` statements
for you to run.

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

- **Fast:** set `execution.unix_user_mode: simple` (or keep `sandbox` but
  `sandbox.fail_if_unavailable: false`) and restart. Ownership already matches
  (daemon user), so nothing else to undo. You lose isolation but stay running —
  acceptable for a high-trust team while you diagnose.
- **Full (restore per-user ownership):** replay the manifest:
  ```bash
  while read u g p; do chown "$u:$g" "$p"; done < "$AGOR_DATA_HOME/ownership-manifest-pre-sandbox.txt"
  ```
  then set `unix_user_mode` back to `strict`/`insulated`.

## Known behavior changes to expect

- **RBAC turns on.** `sandbox` implies `branch_rbac: true`. Non-owner sessions on
  a branch whose `others_fs_access` is `read` will mount the branch **read-only**;
  `none` rejects the spawn with a clear error. Owners are unaffected (`write`).
  Decide up front whether shared branches should default to `write`.
- **Prompting another user's session** runs against the **owner's** home (their
  tool auth/state) — carry the same warning as before ("letting others prompt
  your session gives them your home"). Env-level credentials still come from the
  prompter via the env-resolver, not the owner.
- **Terminals** are sandboxed (daemon secrets masked) but do not yet get the full
  per-user-home / RBAC-mount treatment that prompts do.
- **Repo-level git ops** (clone / realign-origin) run unwrapped as the daemon
  user — Agor's own trusted code, no branch cwd.

## Failure modes / gotchas

| Symptom                                | Cause                                                    | Fix                                                                 |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| All sessions fail to start immediately | unprivileged userns blocked on host                      | `agor doctor`; enable userns, or fall back to `simple`              |
| Tools re-prompt for auth in a session  | user had no `unix_username`/home → empty canonical store | populate `filesystem_home`, or let the user re-auth once (persists) |
| Non-owner agent can't write the branch | RBAC `others_fs_access: read` → ro mount                 | grant write on the branch, or raise the default                     |
| Migration ran as the wrong user        | daemon runs as a different user than the chown target    | re-run with the correct `--daemon-user`; daemon must own the tree   |
