# ID management

> Implementation: `packages/core/src/lib/ids.ts` and `packages/core/src/types/id.ts`.

## Format: UUIDv7

All newly generated Agor IDs are **UUIDv7** (RFC 9562, time-ordered; the first 48 bits are a
ms timestamp). Postgres stores them as native `uuid` and SQLite as `TEXT`.

Existing canonical identities stay as they are. Historical User rows may use a lowercase
UUIDv4, and foreign keys to them must keep that value; never replace an existing identity
with a fabricated UUIDv7. Persistence boundaries that accept an existing ID use
`isCanonicalFullUuid`. `isValidUUID` is the stricter UUIDv7-only check for newly generated IDs.

Generate IDs only through `generateId()`: `lib/ids.ts` in Node and `@agor/core/ids/browser`
in the browser, which uses `crypto.getRandomValues()` because `crypto.randomUUID()` requires a
secure context. Tests follow the same rule. Each call draws 16 fresh random bytes (RFC method 3)
instead of using the library's per-ms monotonic counter, so short-form prefixes stay
collision-safe during same-ms bursts such as spawn fan-out. As a result, order within a
millisecond isn't guaranteed. Callers that need a total order must add a stable tie-breaker.

## Short IDs

The DB stores the full UUID. User-visible IDs (URLs, notifications, logs, CLI) use the 24-char
form from `shortId(id)`; the math is in the `SHORT_ID_LENGTH` doc comment.

CLI and MCP inputs accept any prefix of 8+ hex chars, resolved by `resolveByShortIdPrefix()`
in `db/repositories/base.ts`. A full UUID is used as-is. A prefix query that matches one row
resolves; zero matches raise `EntityNotFoundError`; several raise `AmbiguousIdError`.
Repositories delegate to this helper; don't write a new resolver.

**Don't hand-roll truncation.** `scripts/check-no-ad-hoc-shortid.mjs` fails CI on
`id.substring/slice(0, N)` patterns. Use `shortId(id)`. `toShortId(id, length)` is a
lower-level primitive for documented compatibility cases. Escape hatch:
`// shortid-guard:ignore <reason>` on the line or the line above.

## Types

Entity ID types in `types/id.ts` (`SessionID`, `TaskID`, ...) are aliases of the branded `UUID`
type. They don't stop you from passing a `TaskID` where a `SessionID` is expected, but they do
reject raw strings. Use them in signatures rather than `string`.
