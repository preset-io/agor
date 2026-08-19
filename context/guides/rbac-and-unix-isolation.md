# RBAC and execution isolation

Agor separates application authorization from the process substrate. The code
is the source of truth; the user-facing guide is
[`apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx`](../../apps/agor-docs/content/guide/multiplayer-unix-isolation.mdx).

## Current modes

```yaml
execution:
  branch_rbac: true
  unix_user_mode: sandbox # simple | sandbox | delegated
```

| Mode        | Process                                | Filesystem boundary                            | Home selection                                  |
| ----------- | -------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `simple`    | Local daemon account                   | None; trusted local execution                  | Daemon home                                     |
| `sandbox`   | Local daemon account inside bubblewrap | Fail-closed RBAC-derived mounts                | Tenant-scoped sandbox home or `filesystem_home` |
| `delegated` | Explicit external command template     | Claimed and enforced by the external substrate | Opaque `unix_username` home key                 |

`strict` and `insulated` were removed in 0.25. They are refused during config
validation rather than silently downgraded. Agor no longer creates host users or
POSIX groups, changes passwords, repairs ACLs, creates branch symlinks, or uses
sudo to launch executors.

## Authorization boundary

`execution.branch_rbac` controls application permissions independently of
execution mode. Tenant context and immutable Agor user IDs remain the trust
source for branch/session/task access. `others_can`, `others_fs_access`, branch
owners, Agor groups, board grants, and membership records are product RBAC—not
host POSIX groups.

Sandbox mode implies application RBAC and projects the effective principal's
`write | read | none` access into writable, read-only, or absent branch mounts.
It also masks daemon state and sibling tenant homes. It must fail when Linux
user namespaces or bubblewrap policy setup are unavailable; it never falls back
to `simple`.

## Delegated execution

Delegated mode requires an explicit `executor_command_template` and a
`unix_username` on every launching user/session. Despite the legacy field and
`{unix_user}` variable names, this value is only an opaque execution-home key.
It is validated and stamped immutably on sessions; it is never resolved to a
host uid or passed to sudo.

Prefer `{tenant_id}` and `{user_id}` in external launchers. The launcher owns
runtime identity, storage, credentials, containment, cancellation, and tenant
isolation. A shell command template is configuration, not proof of those
properties.

## Web terminals

`execution.allow_web_terminal` controls availability and branch RBAC controls
access. In `simple`, a terminal is a daemon-account shell and can reach daemon
state. In `sandbox`, eligible terminals receive the same fail-closed filesystem
policy as agents. A delegated deployment must provide an explicitly supported
owner-affine terminal route or leave terminals unavailable.

## Database compatibility

`branches.unix_group` and `repos.unix_group` are nullable historical columns for
rollback/audit. Runtime repositories do not expose or interpret them and new
records write `NULL`. Do not delete or rewrite historical migrations.

`users.unix_username` and `sessions.unix_username` remain temporarily for the
delegated home-key contract. Their effective namespace is tenant-local.

## Migration

There is no published 0.24 bridge release. Perform an offline 0.24.7 → 0.25.1
cutover using
[`context/guides/migrate-strict-to-sandbox.md`](migrate-strict-to-sandbox.md)
and the scripts from the 0.25.1 source tree. They are historical compatibility
tools, not active host-management APIs.

## Key implementation files

- `packages/core/src/config/types.ts` and `config-manager.ts`
- `apps/agor-daemon/src/utils/spawn-executor.ts`
- `apps/agor-daemon/src/utils/executor-delegated-identity.ts`
- `packages/core/src/unix/delegated-home-key.ts` (home-key validation only)
- `packages/core/src/db/schema.{sqlite,postgres}.ts`
