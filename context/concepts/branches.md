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

The `branches` table is normalized (was nested in `repos` JSON blob historically):

- Materialized columns for query/index: `name`, `ref`, `path`, `branch`, `issue_url`, `pull_request_url`, `board_id`, `unique_id` (port assignment), `others_can`, `dangerously_allow_session_sharing`.
- Other state (notes, env config overrides, etc.) lives in JSON.
- `branch_owners` (when `branch_rbac` enabled) is a side table — see `context/guides/rbac-and-unix-isolation.md`.

Schemas: `packages/core/src/db/schema.{sqlite,postgres}.ts`.
Repository: `packages/core/src/db/repositories/branches.ts`.
Service: `apps/agor-daemon/src/services/branches.ts`.
Type: `packages/core/src/types/branch.ts`.

## Things that bite

- **Never use subprocess for git.** Always `simple-git` via `packages/core/src/git/index.ts`.
- **Port allocation** uses `branch.unique_id` (monotonic per repo). Templates like `{{add 9000 branch.unique_id}}` resolve in environment configs.
- **Deleting a branch** must cascade through: stop environment, kill terminals, delete `branch_owners` rows, delete sessions (and their tasks/messages), then `git worktree remove`. The CLI has the canonical sequence; mirror it from there if you're rewriting it.
- **Sessions reference branches**, not the other way around. Cascading from branch → sessions, not sessions → branch.
- **RBAC is feature-flagged.** Code paths must work whether `execution.branch_rbac` is on or off. See AGENTS.md "Feature Flags" section.

## Where the UI lives

- Card on board: `apps/agor-ui/src/components/BranchCard/`
- Modal (5 tabs: Overview, Sessions, Environment, Schedule, Owners): `apps/agor-ui/src/components/BranchModal/`
- Owners section is conditionally rendered when `branch_rbac` is on.
