# Git remote credential spillover

Status: implemented first-pass mitigations after Preset incident report.

## Problem

Agor's legacy branch storage mode uses `git worktree add`. A worktree's `.git`
file points back into the base repo under `~/.agor/repos/<slug>/.git`, so
remote configuration is shared. If any actor runs a command like:

```bash
git remote add extra https://user:REDACTED@example.com/org/repo.git
```

then the credential-bearing URL is persisted in the shared `.git/config` and is
visible to every Agor branch/worktree for that repo.

## Existing protection and gap

Agor already sets process-wide `GIT_CONFIG_PARAMETERS` with
`transfer.credentialsInUrl=die`. That is useful for transfer operations
(`clone`, `fetch`, `push`) on supported Git versions, but it does **not** block
plain config writes such as `git remote add` because no network transfer occurs.

Agor-managed clone flows also pass user tokens via scoped
`http.<host>.extraheader` environment config instead of embedding tokens in
argv/URLs. The missing layer was persisted remote-config hygiene after arbitrary
agent/user git commands.

## Mitigations added

- Core URL helpers detect, redact, and strip URL userinfo.
- Core `.git/config` scanner/repair reads config files directly (no git
  subprocess), including worktree pointer files and shared `commondir` configs.
- Repo clone/metadata paths strip credentials before persisting `remote_url` or
  invoking `git clone`.
- Branch creation/restore scrubs the base repo config before `fetch` /
  `worktree add`.
- Clone-mode branch creation scrubs the new clone's `.git/config` after clone.
- Daemon startup warns if managed repos/branches contain unsafe remote URLs.
- CLI repair: `agor admin scrub-git-remotes` scans; add `--write` to remove
  userinfo from remote `url` / `pushurl` entries.

## Operational guidance

1. Remove embedded credentials from all shared repo configs:
   `agor admin scrub-git-remotes --write`.
2. Rotate any token that was ever embedded in a git remote URL.
3. Prefer credential helpers or Agor's per-user git token flow; never persist
   PATs in remotes.
4. For multi-user or security-sensitive repos, set new branches to clone mode:

```yaml
execution:
  branch_storage:
    default_mode: clone
    allowed_modes:
      - clone
      - worktree
```

Changing the default affects future branch creation only. Existing branch rows
keep their stored `storage_mode`, and existing worktree directories remain
usable. Removing `worktree` from `allowed_modes` only blocks new worktree-mode
creates; it does not migrate or delete existing worktrees.
