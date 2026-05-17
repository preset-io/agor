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

Generated via `generateId()` in `lib/ids.ts`, which wraps the `uuid` npm package's `v7()` and passes fresh `randomBytes(16)` per call. This bypasses the library's per-ms monotonic counter (RFC method 1) so we get full per-call entropy (RFC method 3) — necessary because a 24-char short-form prefix needs real random bits, not a counter, to stay collision-safe under same-ms bursts (parent fan-out spawning, etc.).

Trade-off: we give up strict sub-millisecond ordering. Ms-resolution ordering on the timestamp prefix is preserved; nothing in Agor depends on tighter ordering (the one caller that did, `TaskRepository.createMany`, now imposes insertion order explicitly).

## Short IDs

The DB stores the full UUID. Everywhere a user sees an ID — URLs, notifications, pills, logs, CLI — uses the canonical 24-char short form via `shortId(id)`. Why 24: it's the shortest length that carries enough per-call entropy (~42 random bits) to stay collision-safe under same-ms generation bursts. See the doc comment on `SHORT_ID_LENGTH` in `types/id.ts` for the math.

```
shortId('01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f')
// => '01933e4a7b897c35a8f39d2e'
```

**Inputs can be shorter.** The CLI and MCP tools accept any 8+ hex chars and resolve via the centralized `resolveByShortIdPrefix()` helper in `db/repositories/base.ts`:

1. If the input is a full 36-char UUID → use directly.
2. Otherwise → `SELECT … WHERE id LIKE prefix% LIMIT 11`. Exactly one row → resolve. Zero → `EntityNotFoundError`. Multiple → `AmbiguousIdError` with disambiguation hint.

Repositories (`cards`, `users`, `mcp-servers`, `board-comments`, `card-types`, `worktrees`, `tasks`, `sessions`, `boards`, `repos`) all delegate to it — never write a new resolver inline.

**Don't roll your own truncation.** `scripts/check-no-ad-hoc-shortid.mjs` greps for `xxxId.substring(0, N)` / `.slice(0, N)` / `.replace(/-/g, '').slice(0, N)` patterns and fails CI. Use `shortId(id)` for display, `toShortId(id, length)` for the rare documented non-canonical case (e.g. Unix-name 8-char carve-out in `unix/short-id-naming.ts`). Pragma escape hatch: `// shortid-guard:ignore <reason>` on the offending line or the line above.

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
