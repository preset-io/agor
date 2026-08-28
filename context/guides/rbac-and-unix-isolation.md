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

| Mode        | Process                                | Filesystem boundary                | Home selection                                  |
| ----------- | -------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| `simple`    | Local daemon account                   | None; trusted local execution      | Daemon home                                     |
| `sandbox`   | Local daemon account inside bubblewrap | Fail-closed RBAC-derived mounts    | Tenant-scoped sandbox home or `filesystem_home` |
| `delegated` | Explicit external command template     | Enforced by the external substrate | Opaque `unix_username` home key                 |

`strict` and `insulated` were removed in 0.25. Agor no longer creates host
users/groups, changes passwords, repairs ACLs, creates branch symlinks, or uses
sudo to launch executors.

## Capability policy model

When `execution.branch_rbac` is enabled, normalized capability-policy tables
are the only authorization source. The historical owner/grant rows and
`others_can` fields remain empty, fail-closed compatibility shells; runtime
code does not read or write them.

Normalized policy rows persist a fixed role (`Viewer`, `Editor`/
`Collaborator`, or `Manager`) and, for branch access, `none | read | write`
filesystem access. They do not persist capability arrays or query JSON blobs.
API read models derive the corresponding low-level capabilities from the
canonical role map, and writes are rejected unless their derived capability
view matches the submitted role and filesystem access. Set-based list queries
compare indexed role/principal columns; point checks use the same role map.

Every board and branch has one immutable `primary_owner_user_id`. Ownership is
not part of a policy entry and cannot be reassigned. Administrators retain the
existing tenant-management bypass, but that does not change primary ownership.

### Boards

A board stores two distinct policies:

1. `board_access`: who can see or manage the canvas.
2. `branch_template`: the complete branch permission package inherited by
   branches on that board, including personal session-sharing rules.

Board roles are cumulative:

| Role    | Capabilities                                 |
| ------- | -------------------------------------------- |
| Viewer  | `board.view`                                 |
| Editor  | Viewer + `board.edit`, `board.attach_branch` |
| Manager | Editor + `board.policy.manage`               |

Board listing and canvas delivery consult `board_access` only. Seeing any
branch on a board no longer makes the board visible. Within a visible board,
branch objects are returned only when the caller can also view that branch.

### Branches

A branch has one monolithic binding:

- `inherit`: use its current board's entire `branch_template`.
- `override`: use a branch-owned copy of the complete configuration.

Switching to override starts from the current board template. A branch must be
overridden before it can be moved to another board, which prevents a board move
from silently changing access. Deleting a board materializes every inheriting
branch as an override before the board reference is cleared.

Branch roles are cumulative:

| Role         | Capabilities                                                                                |
| ------------ | ------------------------------------------------------------------------------------------- |
| Viewer       | `branch.view`                                                                               |
| Collaborator | Viewer + `sessions.create`, `sessions.prompt_own`                                           |
| Manager      | Collaborator + session lifecycle, branch/environment management, and `branch.policy.manage` |

Manager does not imply permission to prompt another person's session or use
their home. Filesystem access is a separate `none | read | write` dimension.
Terminal access is derived: Collaborator or Manager plus non-`none` filesystem
access. Sandbox mounts and `{branch_fs_access}` for delegated executors use the
actual prompt actor's effective filesystem access, never the session owner's.

### Principal resolution

Each access row points to exactly one user or one group. Groups are tenant
objects managed by administrators; membership changes take effect everywhere
without rewriting policies.

Effective access uses these deterministic rules:

1. The immutable primary owner receives the owner capabilities.
2. A direct user entry shadows every group entry for that user.
3. Otherwise all active group entries are additive; filesystem access takes
   the highest of `none < read < write`.
4. `Others` applies only to an active, authenticated same-tenant member who has
   no active direct or group match.

Private policies carry no named entries or `Others` grant. Inactive/deleted
principals remain visible for repair but do not become fallback matches. User
deactivation is being delivered separately; until that branch adds a persisted
active-state column, database authorization can distinguish only an existing
same-tenant user from a deleted one. Its cutover must add the active-user
predicate to both the point resolver and the set-based SQL below.

## Personal session sharing

Personal session sharing is disabled by default at workspace level. When an
administrator enables it, each session owner may grant named users/groups
permission to prompt sessions that owner owns. Nobody, including a branch
Manager, may edit or discard another owner's rule; those rules are read-only in
the form.

An allowed shared prompt preserves:

- the original `session.created_by`, native conversation genealogy, and owner
  home (`~/`);
- the actual caller on `task.created_by`, prompt attribution, Agor-managed
  environment variables, connector credentials, and private MCP visibility;
- the caller's branch filesystem projection.

The shared home remains a high-trust boundary. Home-resident tool credentials
such as `~/.codex/auth.json`, native histories, dotfiles, and any files left by
users or agents can still be read or changed by an agent operating there. See
[`context/explorations/session-sharing.md`](../explorations/session-sharing.md).

## Listing and point checks

Set-based inventory predicates live in
`packages/core/src/db/repositories/branch-access.ts`. Point checks resolve the
same normalized policies through `CapabilityPolicyRepository`:

- `resolveBoardAccess(boardId, userId)`
- `resolveBranchAccess(branchId, userId)`
- `resolveSessionPromptAuthority({ branch_id, caller_user_id, session_owner_user_id })`

`BranchRepository.resolveUserAccess` is the compatibility projection used by
existing hooks; it is backed exclusively by the normalized resolver. SQL list
queries mirror direct-user shadowing, additive active groups, and unmatched
`Others`. PostgreSQL RLS and tenant-qualified foreign keys remain an additional
boundary, not a substitute for application authorization.

Realtime delivery materializes the exact current set of viewers with that same
SQL predicate. A permissive `Others` role is never represented as a tenant-wide
broadcast because a direct `No access` entry or a matched non-view group can
suppress it for one user. ACL and group mutations invalidate daemon-local
caches and evict affected sockets across HA; hard-delete paths snapshot the
audience before policy rows cascade.

Internal runtime callers do not rely on provider-only Feathers hooks. Gateway
inbound traffic checks Collaborator access before Session creation, binds a
durable platform thread to the configured branch, and resolves personal
session-sharing authority immediately before Prompt admission. The scheduler
checks its creator at Session admission and again before its initial Prompt so
revocation races and crash recovery fail closed.

## Execution modes

Sandbox mode implies application RBAC and projects effective `write | read |
none` access into writable, read-only, or absent branch mounts. It masks daemon
state and sibling tenant homes and fails closed when bubblewrap policy setup is
unavailable.

Delegated mode requires an explicit `executor_command_template`. Prefer
`{tenant_id}`, `{user_id}`, and `{branch_fs_access}`. `{unix_user}` remains an
opaque compatibility home key. The launcher owns runtime identity, storage,
credentials, containment, cancellation, and tenant isolation.

In `simple` mode, agents and terminals run as the daemon account and application
RBAC cannot provide filesystem isolation. Use it only on trusted installations.

## Migration and rollback

The capability remodel is an offline, big-bang migration for both SQLite and
PostgreSQL. Existing databases require the explicit offline-cutover
acknowledgement. Both dialects attribute every Board/Branch owner they can,
create normalized policies, then empty the legacy authority tables/fields.
Backfill is deliberately equal-or-less:

- an existing current owner, then the creator as a fallback, is used for
  primary-owner attribution;
- a valid Board creator who is not selected as primary owner remains a Board
  Manager, matching legacy Board visibility without restoring removed Branch
  creators;
- additional owners become Managers;
- legacy prompt-like grants become Collaborators, not personal home-sharing;
- named user/group grants map to the closest equal-or-less fixed role;
- board-aligned branches with branch-specific authority are materialized as
  complete overrides copied from the board template;
- personal sharing starts empty and the workspace gate starts off.

If no existing User or legacy owner row can truthfully own a resource, the
migration does not abort the rest of the database and does not invent an owner.
It retains the row with a NULL legacy-quarantine owner and creates a private,
empty normalized policy. Authorization requires a non-NULL owner independently
of policy contents. Migration diagnostics report only aggregate Board/Branch
counts, never resource or tenant identifiers. See
[`context/explorations/rbac-migration-owner-quarantine.md`](../explorations/rbac-migration-owner-quarantine.md).

`branch_rbac=false` remains the intentional trusted-installation bypass for
normalized application authorization; it does not change migration
attribution or revive legacy authority. Enable RBAC (or sandbox mode) before
restart when the runtime quarantine boundary is required.

Legacy authority fields are tombstoned to private/none so a stray old daemon
fails closed, and daemon startup rejects a database newer than its migration
journal. Old daemon versions must still never run after this migration. Rollback means stopping
all new daemons and restoring the complete pre-migration database backup; the
historical columns are not a dual-read rollback path.

## Key implementation files

- `packages/core/src/types/capability-policy.ts`
- `packages/core/src/db/repositories/capability-policies.ts`
- `packages/core/src/db/repositories/branch-access.ts`
- `packages/core/src/db/schema.{sqlite,postgres}.ts`
- `apps/agor-daemon/src/services/capability-policies.ts`
- `apps/agor-daemon/src/utils/branch-authorization.ts`
- `apps/agor-daemon/src/utils/spawn-executor.ts`
- `apps/agor-ui/src/components/permissions/CapabilityPolicyEditor/`
