# Branches (cheat sheet for agents)

> User-facing reference: [`apps/agor-docs/pages/guide/branches.mdx`](../../apps/agor-docs/pages/guide/branches.mdx).

## The shape

```
Boards ←one-to-many→ Branches ←one-to-many→ Sessions
```

- A **Branch** is a first-class git working directory at `~/.agor/worktrees/<repo>/<name>`, on its own branch, with its own dev environment.
- **Boards display Branches as the primary card.** Sessions live _inside_ a branch's card as a genealogy tree. Do not treat Sessions as the unit on a board.
- A **Session** has a _required_ `branch_id` FK. Multiple sessions (across users) share one branch's filesystem and git branch.

Conventional unit: **1 branch = 1 feature / 1 PR / 1 dev environment**.

## Persistence

The `branches` table is normalized (was nested in `repos` JSON historically):

- Materialized columns for query/index include `name`, `ref`, `path`, `branch`, `issue_url`, `pull_request_url`, `board_id`, `unique_id` (port assignment), immutable `primary_owner_user_id`, and `permission_binding` (`inherit | override`).
- Other state (notes, env config overrides, etc.) lives in JSON.
- `branch_permission_configs` and `branch_permission_entries` are always authoritative. The complete config also stores the shared-session prompt switch. A branch either inherits its board's entire template or uses one complete override. Historical owner/grant fields are inert compatibility shells.

Schemas: `packages/core/src/db/schema.{sqlite,postgres}.ts`.
Repository: `packages/core/src/db/repositories/branches.ts`.
Service: `apps/agor-daemon/src/services/branches.ts`.
Type: `packages/core/src/types/branch.ts`.

## Things that bite

- **Never use subprocess for git.** Always `simple-git` via `packages/core/src/git/index.ts`.
- **Port allocation** uses `branch.unique_id` (monotonic per repo). Templates like `{{add 9000 branch.unique_id}}` resolve in environment configs.
- **Deleting a branch** must cascade through: stop environment, kill terminals, delete normalized policy rows and sessions (including tasks/messages), then remove the git workspace. The service owns the canonical sequence.
- **Moving a branch** while its permissions are inherited is rejected. Switch it to an override first so changing boards cannot silently change access.
- **Deleting a board** first materializes every inheriting branch as an override, including the shared-session prompt switch.
- **Sessions reference branches**, not the other way around. Cascading from branch → sessions, not sessions → branch.
- **RBAC is an invariant.** Every board/branch boundary must enforce the normalized policy; there is no open-access mode.

## Where the UI lives

- Card on board: `apps/agor-ui/src/components/BranchCard/`
- Modal permissions tab: `apps/agor-ui/src/components/BranchModal/`
- Shared board/branch editor primitives: `apps/agor-ui/src/components/permissions/CapabilityPolicyEditor/`
- Permissions are always rendered and fail closed when policy loading fails.
