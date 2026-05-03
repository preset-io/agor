# ID management

> Implementation: `packages/core/src/lib/ids.ts` and `packages/core/src/types/id.ts`.

## Format: UUIDv7

All entity IDs (Session, Task, Worktree, Board, Repo, etc.) are **UUIDv7** — RFC 9562, time-ordered. The first 48 bits encode the creation timestamp (ms precision).

Why: globally unique, sortable by creation time (no separate index on `created_at` needed for ordering), B-tree friendly, IETF-standard, native UUID types in Postgres.

```
01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f
└──────┘
  timestamp prefix
```

Generated via the `uuidv7` npm package in `lib/ids.ts`.

## Short IDs

The DB stores the full UUID. The UI / CLI / MCP tools accept and display the **first 8 characters** (e.g. `01933e4a`) as a short ID — git-style.

Resolution rule (in service hooks):

1. If the input is 36 chars → treat as full UUID, look up directly.
2. If the input is shorter → prefix-match. Exactly one row → resolve. Zero → 404. Multiple → 409 with disambiguation hint.

The hook lives in `apps/agor-daemon/src/hooks/short-id-resolver.ts` (or similar — search for `resolveShortId`). All find-by-id paths flow through it; never write a service that takes a raw `id` parameter and queries directly without resolution.

Collisions are extremely rare with 8-char prefix on UUIDv7 (32 bits of randomness in the suffix), but the 409 path is real and tested.

## Branded types

`packages/core/src/types/id.ts` defines branded TypeScript types per entity:

```ts
type SessionId = string & { __brand: 'SessionId' };
type WorktreeId = string & { __brand: 'WorktreeId' };
// etc.
```

This catches "passed a TaskId where a SessionId was expected" at compile time. When you accept an ID at a public boundary (route, MCP handler, CLI flag), cast through a `parseXxxId(s: string): XxxId` helper that validates shape.

## Things to know

- **Don't generate IDs anywhere except `lib/ids.ts`** (`newSessionId()`, `newTaskId()`, etc.). Tests included.
- **Don't accept raw `string` for IDs in service signatures** — use the branded type so the resolver hook is wired correctly.
- **Display short IDs** in user-facing strings (logs, CLI output, error messages). Full UUIDs are noisy and unhelpful when the user just wants to grep their terminal.
- **Postgres** uses native `uuid` columns; SQLite stores them as `TEXT`. Drizzle handles the dialect difference; you don't.
