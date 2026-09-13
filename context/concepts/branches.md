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

### Permanent-deletion persistence boundary

`db/repositories/branch-deletions.ts` owns only checkpoint persistence; it does not
authorize deletion, acquire branch maintenance admission, supervise executors, or
delete the branch. Do not expose its methods as generic CRUD. The coordinator must
record acceptance in the same short transaction as authorized lifecycle admission.
An empty/sealed ledger alone never proves that the authoritative inventory is empty.

`db/branch-deletion-manifest.ts` declares ownership-review dispositions for inbound
FKs plus known plain-ID, JSON and external relations. Its dual-schema test detects
new inbound FKs; it is not an executable cascade plan or proof of exhaustive runtime
inventory. In particular, Knowledge namespaces require ownership classification,
and published artifacts belong to boards rather than their provenance branch.

Deletion operations and resource locators are deployment-bound and excluded from
tenant portability: importing them could replay deletion against restored storage.
They remain part of tenant erasure. Unsettled invocation identity must survive
restart; lease expiry alone must never make an external deletion safe to retry.

## Things that bite

- **Never use subprocess for git.** Always `simple-git` via `packages/core/src/git/index.ts`.
- **Port allocation** uses `branch.unique_id` (monotonic per repo). Templates like `{{add 9000 branch.unique_id}}` resolve in environment configs.
- **Current branch deletion is metadata-first**, not verified erasure. The durable replacement must fence admission, prove runtime containment, inventory owned resources, verify required storage removal, and drain descendants before deleting authorization and the branch row last. The checkpoint repository does not implement that lifecycle.
- **Moving a branch** requires branch Manager authority and Editor/Manager access on both boards. Inherited permissions follow the destination defaults; explicit overrides and primary ownership remain unchanged.
- **Deleting a board** first materializes every inheriting branch as an override, including the shared-session prompt switch.
- **Sessions reference branches**, not the other way around. Cascading from branch → sessions, not sessions → branch.
- **RBAC is an invariant.** Every board/branch boundary must enforce the normalized policy; there is no open-access mode.

## Where the UI lives

- Card on board: `apps/agor-ui/src/components/BranchCard/`
- Modal permissions tab: `apps/agor-ui/src/components/BranchModal/`
- Shared board/branch editor primitives: `apps/agor-ui/src/components/permissions/CapabilityPolicyEditor/`
- Permissions are always rendered and fail closed when policy loading fails.
