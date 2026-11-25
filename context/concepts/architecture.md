# Architecture (cheat sheet for agents)

> User-facing reference: [`apps/agor-docs/content/guide/architecture.mdx`](../../apps/agor-docs/content/guide/architecture.mdx).
> Source of truth = the code. This file is a fast orientation map.

## Mental model

```
Clients (agor-cli | agor-ui | external SDK clients)
      │                          via Feathers client
      ▼
agor-daemon (FeathersJS server, REST + WS + JSON-RPC /mcp)
      │
      ├── Services (apps/agor-daemon/src/services/*)
      │     hooks: auth, validation, short-id resolution, RBAC
      │
      ├── Repositories (packages/core/src/db/repositories/*)
      │     thin Drizzle wrappers, return canonical types
      │
      ├── Drizzle ORM (packages/core/src/db/schema.{sqlite,postgres}.ts)
      │
      ├── Executor (packages/executor — subprocess-isolated agent runtime)
      │     spawns claude-code / codex / gemini SDK handlers
      │
      └── Storage:
            SQLite (LibSQL) at ~/.agor/agor.db          (default)
            PostgreSQL                                   (multi-tenant)
            Filesystem at ~/.agor/worktrees/<repo>/<wt> (git branches)
```

## Key decisions you'll bump into

- **API-first from day one.** CLI and UI both go through the daemon's Feathers API; nothing speaks to the DB directly. New features → service + repository + (maybe) CLI command.
- **Hybrid materialization.** Columns for fields you query/index by, JSON for everything else. Cross-dialect (SQLite + Postgres) — never write dialect-specific SQL outside `db/schema.*.ts`.
- **simple-git only.** No `execSync`/`spawn` for git. `@agor/git` (`packages/git/`) is the single git wrapper.
- **WebSocket events** (`<service>:<created|patched|removed>`) are emitted by Feathers automatically; UI subscribes via `@agor/client` reactive helpers.
- **Executor isolation.** Agents run in `packages/executor` as a separate process tree; `unix_user_mode` selects simple, sandboxed, or delegated execution. See [`rbac-and-unix-isolation.md`](../guides/rbac-and-unix-isolation.md).
- **MCP self-access.** Daemon exposes `POST /mcp` so agents introspect Agor (sessions, branches, boards). Token-authenticated. Server in `apps/agor-daemon/src/mcp/server.ts`; tools in `apps/agor-daemon/src/mcp/tools/`.

## Where to look first

| If you're touching...  | Open this                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Data model             | `packages/core/src/types/` + `packages/core/src/db/schema.{sqlite,postgres}.ts`                    |
| New service / endpoint | `apps/agor-daemon/src/services/` + `context/guides/extending-feathers-services.md`                 |
| Migrations             | `packages/core/drizzle/{sqlite,postgres}/` + `context/guides/creating-database-migrations.md`      |
| Git operations         | `packages/git/src/index.ts`                                                                        |
| Auth / RBAC            | `apps/agor-daemon/src/utils/branch-authorization.ts` + `context/guides/rbac-and-unix-isolation.md` |
| Agent runtime          | `packages/executor/`                                                                               |
| Task runtime state     | `context/concepts/task-runtime-state.md`                                                           |
| Real-time UI           | `packages/client/` reactive helpers + `apps/agor-ui/src/hooks/`                                    |
| UI state / memory      | `apps/agor-ui/src/store/` + `context/concepts/frontend-state.md`                                   |
| MCP tools              | `apps/agor-daemon/src/mcp/tools/`                                                                  |

## Tech stack (one-liner)

FeathersJS · Drizzle · LibSQL/SQLite · PostgreSQL · simple-git · React 19 + Vite · zustand · Ant Design · React Flow · oclif · pnpm/turborepo.
