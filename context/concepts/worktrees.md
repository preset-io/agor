# Worktrees (cheat sheet for agents)

> User-facing reference: [`apps/agor-docs/pages/guide/worktrees.mdx`](../../apps/agor-docs/pages/guide/worktrees.mdx).

## The shape

```
Boards ←one-to-many→ Worktrees ←one-to-many→ Sessions
```

- A **Worktree** is a first-class git working directory at `~/.agor/worktrees/<repo>/<name>`, on its own branch, with its own dev environment.
- **Boards display Worktrees as the primary card.** Sessions live *inside* a worktree's card as a genealogy tree. Do not treat Sessions as the unit on a board.
- A **Session** has a *required* `worktree_id` FK. Multiple sessions (across users) share one worktree's filesystem and git branch.

Conventional unit: **1 worktree = 1 feature / 1 PR / 1 dev environment**.

## Persistence

The `worktrees` table is normalized (was nested in `repos` JSON blob historically):

- Materialized columns for query/index: `name`, `ref`, `path`, `branch`, `issue_url`, `pull_request_url`, `board_id`, `unique_id` (port assignment), `others_can`, `dangerously_allow_session_sharing`.
- Other state (notes, env config overrides, etc.) lives in JSON.
- `worktree_owners` (when `worktree_rbac` enabled) is a side table — see `context/guides/rbac-and-unix-isolation.md`.

Schemas: `packages/core/src/db/schema.{sqlite,postgres}.ts`.
Repository: `packages/core/src/db/repositories/worktrees.ts`.
Service: `apps/agor-daemon/src/services/worktrees.ts`.
Type: `packages/core/src/types/worktree.ts`.

## Things that bite

- **Never use subprocess for git.** Always `simple-git` via `packages/core/src/git/index.ts`.
- **Port allocation** uses `worktree.unique_id` (monotonic per repo). Templates like `{{add 9000 worktree.unique_id}}` resolve in environment configs.
- **Deleting a worktree** must cascade through: stop environment, kill terminals, delete `worktree_owners` rows, delete sessions (and their tasks/messages), then `git worktree remove`. The CLI has the canonical sequence; mirror it from there if you're rewriting it.
- **Sessions reference worktrees**, not the other way around. Cascading from worktree → sessions, not sessions → worktree.
- **RBAC is feature-flagged.** Code paths must work whether `execution.worktree_rbac` is on or off. See AGENTS.md "Feature Flags" section.

## Where the UI lives

- Card on board: `apps/agor-ui/src/components/WorktreeCard/`
- Modal (5 tabs: Overview, Sessions, Environment, Schedule, Owners): `apps/agor-ui/src/components/WorktreeModal/`
- Owners section is conditionally rendered when `worktree_rbac` is on.
