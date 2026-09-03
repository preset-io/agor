# Making tenant DB scope structurally unforgettable — implementation plan

**Date:** 2026-08-30
**Branch:** `harden-tenant-db-scope-invariant`
**Root-cause follow-up to:** PR #2612 (design note
`mcp-tenant-db-scope-createbranch-2026-08-29.md`, "Durable follow-up").

## Goal (restated)

Make "touch tenant data without declaring tenancy intent" a structural
impossibility, caught in the cheapest environment (SQLite/dev/tests), so the
per-call-site MCP wraps and the static audit test are no longer needed.

Two independent boundaries, kept strictly separate throughout:

- **(i) scope presence** — is _any_ tenant/system DB scope active. Arming
  `requireScope` everywhere makes a MISSING scope fail in every mode. Subsumes
  the original bug and the scope-presence half of the audit. **Deliverable A.**
- **(ii) write-freeze gate** — a write during a freeze must be rejected
  (`assertTenantWritable` → `Unavailable`). Orthogonal to (i): a write can be
  perfectly scoped and still skip the gate. Only folding the gate into a
  service-side write primitive retires the read/write helper split and the
  `MUTATION_TOKENS` check. **Deliverables B + C.**

## Current-state facts established by exploration

- Guard is armed only in HA: `setup/database.ts:158`
  `requireScope: options.requireTenantScope === true`, driven by
  `index.ts:754` `requireTenantScope: multiTenancy.mode === 'required_from_auth'`.
- Mode selection (`register-hooks.ts:3877`): Postgres → `registerTenantHooks()`
  (`tenantDatabaseScopeAround`, enters `runWithTenantDatabaseScope`). SQLite →
  `registerTenantIdentityForOwnedServices()` (`tenantIdentityAround`,
  `transaction:false` — enters tenant **context** only, NO DB scope).
  → **Arming `requireScope` in SQLite breaks every standard Feathers DB op**
  unless static mode also enters the (cheap, no-op) DB scope. On non-Postgres,
  `runWithTenantDatabaseScope` opens no transaction — a scope is just an
  AsyncLocalStorage store, so this is cheap.
- Test harness gap (the real silence): `dbTest`
  (`packages/core/src/db/test-helpers.ts`) creates real temp-file SQLite via
  `createDatabase` — **not** wrapped in `createTenantScopedDatabaseProxy`, and
  repository tests call repos with no scope. Service tests use a mock
  `createTenantScopeTestDb()` (`run`/`transaction` stubs). MCP tool tests use
  `db: {}`. None exercises the guard.
- Non-request DB entry points: daemon runtime is already fully scoped (all
  background reconcilers/queues/schedulers/health/token/OAuth workers wrap in
  `runWithSystemDatabaseScope` + per-tenant `runWithTenantDatabaseScope`/
  `withFreshTenantWrite`; `setup/database.ts` seeds under system/tenant scope).
  **Unscoped and would throw once armed:** CLI `init`, `db migrate`,
  `db status`, `tenant delete|export|import|verify`; dev `scripts/setup-db.ts`.
- Services: Repos/Boards/Cards/Sessions/Branches extend `DrizzleService`
  (`adapters/drizzle.ts:87`); BoardObjects and Gateway do not. BranchesService
  already has private `withTenantDatabase(params, work)` (short scope).
  Gateway/artifacts bind every repo via `bindRepositoryToTenantUnitOfWork`.
  ReposService.remove / SessionsService.remove use
  `runWithTenantDatabaseTransaction` for atomic cascades; sessions
  `setArchiveStateForTree` does a multi-target write that must stay in ONE scope.
- MCP scaffolding to retire: **59** `runWithMcpTenantDatabase{Scope,Write}`
  wraps across 11 tool files; `tenant-scope-audit.test.ts`;
  `branches.tenant-scope.test.ts`. Un-gated MCP mutations found:
  `SessionRelationshipRepository.setCallbackEnabled` and `.create` (wrapped in
  the READ helper — mutations with no gate!), `appendSystemMessage` in
  `widgets.ts`, and env mutators (`startEnvironment` et al. — need the
  ADMISSION pattern, not a held transaction).

## Progress (2026-08-30)

**Stage A core landed and verified green (core 4053 / daemon 3939 tests, boundary
check ok):**

- Guard armed by default (opt-out) — `createTenantScopedDatabaseProxy`
  (`packages/core/src/db/tenant-scope.ts`).
- Production daemon path armed unconditionally — `setup/database.ts` (+ removed
  the now-dead `requireTenantScope` option there and in `index.ts`).
- **A1 done:** static/SQLite tenant-owned services now enter the (no-op) DB
  scope via `tenantDatabaseScopeAround` (`register-hooks.ts`
  `registerTenantDatabaseScopeForOwnedServices`), + regression test
  `register-hooks.static-scope.test.ts`.
- Fallout fixed: `tenant-scope.test.ts` (2 routing tests → explicit
  `requireScope:false`), `repos-removal-transaction.sqlite.test.ts` (wrap direct
  `remove` in the ambient scope production supplies).
- **A4 (guarded-proxy entry points):** `create-admin.ts` migrations wrapped in
  `runWithSystemDatabaseScope`; `dev-fixtures.ts` already scoped. Raw-handle CLI
  commands (`init`, `db migrate|status`, `tenant delete|export|import|verify`)
  are unaffected (they never wrap in the guarded proxy) — converting them to
  guarded proxies is optional defense-in-depth, deferred.

**A3 done:** `mcp/tools/guard-regression.test.ts` proves — over a REAL guarded
SQLite proxy, at the exact MCP boundary (tenant context, no DB scope) — that the
pre-#2612 unscoped `agor_cards_get` (`cardsService.getWithType`) and
`agor_sessions_archive` (`setArchiveStateForTree`) throw the guard error, while
wrapping the same call in a tenant DB scope satisfies it. No seeding needed (a
missing-id lookup still issues a guarded SELECT).

**A2 finding — arming the repository-layer `dbTest` fixture is NOT viable, by
design:** Two independent blockers, both confirmed empirically:

1. Vitest runs the test body on the fixture's async resource, but
   AsyncLocalStorage `.run(cb)` does NOT propagate across the `use()` boundary
   (only `.enterWith()` does).
2. More fundamentally, yielding a _guarded proxy_ as the fixture value fails:
   Vitest/Node probe the value (thenable `.then` check, etc.) OUTSIDE our scope,
   tripping the guard during fixture plumbing before the test body runs.
   Conclusion: the guard is a CALLER concern (services / MCP tools / request
   hooks); repositories are the callee, legitimately unit-tested in isolation on a
   raw handle. `dbTest` stays raw. Scope-presence is enforced (a) in production
   (armed by default), and (b) at the service/tool test layer by wrapping the raw
   handle in `createTenantScopedDatabaseProxy` and entering a scope INSIDE the test
   body — the pattern `guard-regression.test.ts` uses and that Stage B's service
   self-scoping will make the default.

**Remaining (Stage A wind-down / defer to B):** the ~10 MCP-tool tests using
`db: {}` + mocked services still don't exercise the guard; converting them to
real guarded services is large and lower-value (they test tool arg/realtime
logic, not scoping) — best folded into Stage B, where services self-scope and a
handful of service-level scope tests replace per-tool proof.

## Staging

Each stage lands as its own PR. A is independently valuable and mergeable alone.

### Stage A — Arm the guard universally (dev + tests first)

**A1. Static mode enters the (no-op) DB scope.** Make tenant-owned services in
SQLite/static enter `runWithTenantDatabaseScope` (via `tenantDatabaseScopeAround`
or an armed variant) instead of identity-only, so scope presence holds in every
mode. `TENANT_IDENTITY_ONLY_SERVICE_PATHS` keep identity-only (they self-scope
at the call site) — verify each such path's DB touches are wrapped.

**A2. Guarded test harness — armed EVERYWHERE (decided 2026-08-30).**
`requireScope` is always on: SQLite, tests, dev, prod. No mode conditional, no
escape hatch. Fail fast, fail early — the more protection the better.

- Flip `createTenantScopedDatabaseProxy` to default `requireScope: true`
  (opt-out only), and drop the `requireTenantScope` conditional in
  `setup/database.ts` / `index.ts`.
- Arm the shared `dbTest` fixture: wrap the yielded db in
  `createTenantScopedDatabaseProxy({requireScope:true})` and run the test body
  inside a scope (a default tenant scope) so the ~410 repository tests pass via
  ONE fixture change, not per-test edits. The small subset that deliberately
  switch tenants (isolation tests) get targeted fixes — discovered empirically
  ("turn it on, fix what throws"), not guessed.
- Replace `db: {}` (MCP tool tests) and the `createTenantScopeTestDb()` mock
  (service tests) with a real guarded proxy via a `makeGuardedMcpContext(...)` /
  service-test factory whose tool boundary enters tenant **context only**
  (mirroring production), so an unwrapped service.method call throws.

**A3. Proof.** Add tests showing the PRE-FIX `agor_cards_get`
(`cardsService.getWithType`) and `agor_sessions_archive`
(`setArchiveStateForTree`) would FAIL their own unit tests under the guarded
harness (missing scope throws in SQLite too).

**A4. Production single-tenant — flip ON, no escape hatch (decided
2026-08-30).** Wrap the unscoped CLI/dev entry points (`init`, `db migrate`,
`db status`, `tenant *`, `scripts/setup-db.ts`) in `runWithSystemDatabaseScope`
/ tenant scope, then leave `requireScope` on for static production too (the
daemon runtime is already clean). Requires A1 (static services enter the DB
scope) to land together so static request handling works.

### Stage B — Collapse scoping into one service-side primitive

Add a `TenantScopedService` base/mixin (extending or composed with
`DrizzleService`) exposing:

- `this.tenantRead(params, work)` — enter scope (join ambient if present).
- `this.tenantWrite(params, work)` — enter scope AND `assertTenantWritable`,
  mapping `TenantWriteGateActiveError` → `Unavailable` (mirrors
  `tenantWriteGateAround` / `runWithMcpTenantDatabaseWrite`).
- `this.tenantTransaction(params, work)` — atomic multi-write
  (`runWithTenantDatabaseTransaction`) for cascades.

Route the custom methods on Repos/Boards/BoardObjects/Cards/Sessions through
these so they self-defend regardless of caller (HTTP/MCP/gateway/scheduler).
Generalize BranchesService's `withTenantDatabase` into the base.

**Atomicity discipline (non-negotiable):** DEFAULT one scope per method
(multi-write atomicity, e.g. sessions `setArchiveStateForTree`, cards
`createWithPlacement`). Opt into per-call `bindRepositoryToTenantUnitOfWork`
(gateway/artifacts) ONLY for genuinely single ops. Do NOT bind every repo.
NEVER hold a Postgres transaction across executor/network I/O — long env/provider
methods keep the short-unit / admission pattern.

### Stage C — Retire the scaffolding

- Remove the 59 per-call-site `runWithMcpTenantDatabase{Scope,Write}` wraps in
  `mcp/tools/*.ts` (redundant once services self-scope). Retire the helpers
  (and `tenantScopedToolProxy` keeps only the context entry).
- Delete/trivialize `tenant-scope-audit.test.ts` (invariant no longer exists);
  keep at most a check that services use the base primitive.
- Fold `branches.tenant-scope.test.ts` into the Stage-A guarded-harness proofs.
- Extend the write gate to EVERY MCP tenant mutation (criterion = "is it a
  tenant write", not HTTP-route parity): direct-repo writes
  (`SessionRelationshipRepository.setCallbackEnabled`/`.create`), utility writes
  (`appendSystemMessage`), and env mutators via the ADMISSION pattern.

## Constraints / proof obligations (every stage)

- Preserve tenant/RBAC/RLS boundaries; never suppress scope or gate errors; no
  global runner reuse; never hold a Postgres tx across executor/network I/O.
- Prove: unscoped DB op fails in SQLite too; tenant-B cannot reach tenant-A
  rows; a frozen tenant's write is rejected with `Unavailable` WITHOUT running;
  static single-tenant behavior still works.
- Run `pnpm check` and `pnpm check:multitenancy-boundaries`.
- Verify against the branch's HA env (variant `ha`) via
  `scripts/test-ha-mcp-branch-create.mjs` and the minted-MCP-token technique.
- Guard local `pnpm install` (shared host disk ~97% full) — prefer Docker/HA.

```

```
