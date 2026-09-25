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

- Materialized columns for query/index include `name`, `ref`, `path`, `branch`, `issue_url`, `pull_request_url`, `board_id`, `unique_id` (port assignment), explicitly transferable `primary_owner_user_id`, and `permission_binding` (`inherit | override`).
- Other state (notes, env config overrides, etc.) lives in JSON.
- `branch_permission_configs` and `branch_permission_entries` are always authoritative. The complete config also stores the shared-session prompt switch. A branch either inherits its board's entire template or uses one complete override. Historical owner/grant fields are inert compatibility shells.

Schemas: `packages/core/src/db/schema.{sqlite,postgres}.ts`.
Repository: `packages/core/src/db/repositories/branches.ts`.
Service: `apps/agor-daemon/src/services/branches.ts`.
Type: `packages/core/src/types/branch.ts`.

### Permanent-deletion persistence boundary

Permanent deletion stores `deletion_status`, a bounded safe `deletion_error`, and
`deletion_updated_at` on the branch. Both `deleting` and `deletion_failed` are
sticky admission fences; failure never authorizes resuming ordinary work.

`db/repositories/branch-maintenance.ts` holds the shared private operation and
invocation identity on that same row. It does not authorize callers or supervise
executors. Its short claimed transactions must not contain filesystem/network
work. Invocation uncertainty retains ownership; elapsed time is not settlement.
`db/branch-admission.ts` supplies the Branch-first lock for producer admission.
Do not expose maintenance methods or internal claim JSON as generic CRUD.

`db/branch-deletion-manifest.ts` declares ownership-review dispositions for inbound
FKs plus known plain-ID, JSON and external relations. Its dual-schema test detects
new inbound FKs; it is not an executable cascade plan or proof of exhaustive runtime
inventory. In particular, Knowledge namespaces require ownership classification,
and published artifacts belong to boards rather than their provenance branch.

Keep original storage locator rows until required removal has been verified.
Do not replace those rows with an unbounded manifest on the branch or treat an
empty descendant query as proof of filesystem/process containment.

## Things that bite

- **Never use subprocess for git.** Always `simple-git` via `packages/core/src/git/index.ts`.
- **Port allocation** uses `branch.unique_id` (monotonic per repo). Templates like `{{add 9000 branch.unique_id}}` resolve in environment configs.
- **Permanent deletion is executor-owned**: `commands/branch-deletion.ts` drives authenticated `branch-deletion-steps` requests; `BranchDeletionRepository` drains owned data before branch-row-last finalization. The shared maintenance claim fences managed producers. Known activity and best-effort terminal closure are not proof that detached processes stopped. Unknown invocations remain fenced; never retry on heartbeat age alone.
- Delegated permanent deletion is opt-in through `execution.delegated_branch_deletion`; its executor verifies that tenant worktrees, repos, and branch homes share an external storage device before removal. A missing or inconsistent mount must leave the branch fenced.
- **Moving a branch** requires branch Manager authority and Editor/Manager access on both boards. Inherited permissions follow the destination defaults; explicit overrides and primary ownership remain unchanged.
- **Deleting a board** first materializes every inheriting branch as an override, including the shared-session prompt switch.
- **Sessions reference branches**, not the other way around. Cascading from branch → sessions, not sessions → branch.
- **RBAC is an invariant.** Every board/branch boundary must enforce the normalized policy; there is no open-access mode.

## Where the UI lives

- Card on board: `apps/agor-ui/src/components/BranchCard/`
- Modal permissions tab: `apps/agor-ui/src/components/BranchModal/`
- Shared board/branch editor primitives: `apps/agor-ui/src/components/permissions/CapabilityPolicyEditor/`
- Permissions are always rendered and fail closed when policy loading fails.
