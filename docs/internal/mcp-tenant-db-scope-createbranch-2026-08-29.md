# MCP `agor_branches_create` — "Missing tenant database scope" in HA

**Date:** 2026-08-29
**Area:** multi-tenancy · MCP tool boundary · daemon services
**Mode affected:** `execution.multi_tenancy = required_from_auth` (HA / hosted Postgres). Static SQLite/single-tenant is unaffected.

## Symptom

Calling the MCP tool `agor_branches_create` against an HA daemon returned:

```
Missing tenant database scope for daemon database access
```

Reproduced live against the branch's HA Compose stack (variant `ha`, ingress `:7833`,
tenants `acme`/`globex`, two daemon replicas behind nginx) on **both** replicas and for
**both** `waitForReady=false` and `waitForReady=true`. The equivalent REST call
(`POST /repos/:id/branches`) **succeeded** in the same environment — proving the gap is
specific to the MCP path, not to branch creation itself.

## Root cause

`MissingTenantDatabaseScopeError` is thrown by the guarded daemon-database proxy
(`packages/core/src/db/tenant-scope.ts`, `assertDatabaseScopeAllowed`). In
`required_from_auth` the proxy is created with `requireScope: true`
(`apps/agor-daemon/src/setup/database.ts`), so **every** DB touch must run inside an
active tenant **database** scope (`tenantDatabaseScope`, an `AsyncLocalStorage` set by
`runWithTenantDatabaseScope`). Tenant **context** identity alone (`tenantContextScope`,
set by `runWithTenantContext`) does **not** satisfy the guard.

Two facts combine:

1. **The MCP tool boundary enters only tenant _context_.**
   `tenantScopedToolProxy` (`apps/agor-daemon/src/mcp/tenant-scope.ts`) wraps every tool
   handler in `runWithTenantContext(tenantId, …)` — identity only, deliberately no
   HTTP-long DB transaction, because many tools then do long polling / executor / provider
   work. Each handler is expected to open a **short** tenant DB unit at the actual DB call
   via `runWithMcpTenantDatabaseScope(ctx, …)`.

2. **`ReposService.createBranch` is deliberately NOT a Feathers transport method.**
   It takes `(id, data)` and is exposed to HTTP/CLI only through the authenticated custom
   route `/repos/:id/branches` (`register-routes.ts`). That route is registered with the
   standard `registerAuthenticatedRoute`, whose around chain is
   `[tenantDatabaseScopeAround, tenantWriteGateAround]` — i.e. the whole method runs inside
   one tenant DB transaction. `createBranch` therefore assumes an **ambient** scope: it
   reads/writes `this.db` directly (`new BranchRepository(this.db).findActiveByRepoAndName`,
   `resolveDelegatedExecutionHomeKey(this.db, …)`, `this.get`, `branchesService.create`,
   `board-objects.create`) with no scope of its own.

The MCP tool called `reposService.createBranch(repoId, …, ctx.baseServiceParams)`
**directly** — a programmatic call that bypasses the Feathers around hooks — while the
tool boundary had provided only tenant _context_. The very first `this.db` touch
(`findActiveByRepoAndName`) tripped the guard. Nearby MCP DB touches were already correct
(e.g. the auto-suffix pre-read at `branches.ts` uses `runWithMcpTenantDatabaseScope`); the
`createBranch` call was the one unguarded site.

`waitForReady` is irrelevant to the failure — the error is thrown during the initial
metadata write, before the fire-and-forget executor spawn and before the readiness poll.

### Why some sibling MCP calls were already fine

Services differ in how they defend themselves:

- **`BranchesService`** has a private `withTenantDatabase(params, work)` helper (short
  tenant unit) that its own custom methods (`unarchive`, `startEnvironment`,
  `nukeEnvironment`, …) use internally — so those are safe even when called directly from
  MCP, and correctly do **not** hold a transaction across executor/network work.
- **`SessionsService`** and **`GatewayService`** similarly scope internally
  (`runWithTenantDatabaseScope` / `deferWithTenantContext`).
- **`cards.ts`** already wrapped `cardsService.createWithPlacement` in
  `runWithMcpTenantDatabaseScope`.

The outliers are services whose custom methods touch `this.db` **without** an internal
helper and rely purely on the caller's ambient scope: **`ReposService`**,
**`BoardsService.archive/unarchive`**, **`BoardObjectsService.findByBranchId`**,
**`CardsService.getWithType`**, and **`SessionsService.archive/unarchive`** (via
`setArchiveStateForTree`). The last two were pre-existing misses surfaced by the static
audit test described below, not by the original report.

By contrast, `SessionsService`'s _other_ DB work and `GatewayService` (identity-only, with
`bindRepositoryToTenantUnitOfWork`-bound repos) do self-scope — only the archive tree walk
had been left relying on an ambient scope.

## Fix

Wrap each affected direct custom-method call at the MCP call site in
`runWithMcpTenantDatabaseScope(ctx, …)`. On Postgres this opens one short tenant
transaction (with `agor.tenant_id` set for RLS) and joins any already-active same-tenant
scope; on SQLite/static it is a no-op identity scope. Long readiness waits stay **outside**
the scope, so no transaction is held across polls.

Sites fixed:

| File                                         | Tool                                   | Custom method                             |
| -------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| `apps/agor-daemon/src/mcp/tools/branches.ts` | `agor_branches_create`                 | `reposService.createBranch`               |
| `apps/agor-daemon/src/mcp/tools/branches.ts` | `agor_branches_set_zone`               | `boardObjectsService.findByBranchId` (×2) |
| `apps/agor-daemon/src/mcp/tools/repos.ts`    | `agor_repos_clone`                     | `reposService.cloneRepository`            |
| `apps/agor-daemon/src/mcp/tools/repos.ts`    | `agor_repos_update`                    | `reposService.updateMetadata`             |
| `apps/agor-daemon/src/mcp/tools/boards.ts`   | `agor_boards_archive` / `_unarchive`   | `boardsService.archive` / `unarchive`     |
| `apps/agor-daemon/src/mcp/tools/cards.ts`    | `agor_cards_get`                       | `cardsService.getWithType`                |
| `apps/agor-daemon/src/mcp/tools/sessions.ts` | `agor_sessions_archive` / `_unarchive` | `sessionsService.archive` / `unarchive`   |

**Deliberately NOT wrapped: `agor_repos_create_local` (`addLocalRepository`).** That
service method rejects with `BadRequest` in `required_from_auth` mode _before_ any DB
touch, so the scope guard can never fire there in a scope-requiring deployment. It also
`await`s a `git.repo.inspect` executor round-trip before its DB writes — so wrapping the
whole call would risk holding a Postgres transaction across that network I/O if the HA
guard were ever lifted. Local-repo registration stays a static/single-tenant path.

This matches the established codebase pattern (identity at the tool boundary, short DB
units at the call site) and the multitenancy cheat sheet's rule: _"Long-lived work should
carry tenant identity without holding an HTTP-long transaction; open short tenant database
units at the actual database call."_ No scope error is caught/suppressed, and no global
runner is reused.

## Tenant / RBAC / RLS boundary preservation

The fix only re-enters the caller's already-authenticated tenant. `resolveTenantBoundary`
still rejects any cross-tenant switch, and the Postgres transaction sets `agor.tenant_id`
transaction-locally so RLS policies enforce isolation. A tenant-B caller still cannot reach
tenant-A repos/branches (verified: a foreign `repoId` reads as 404, indistinguishable from
missing). Nothing weakens the existing negative boundaries.

### Write-freeze gate parity (mutations)

Entering the tenant DB scope is not sufficient for **mutations**. HTTP custom routes wrap
`[tenantDatabaseScopeAround, tenantWriteGateAround]`, so a write during a tenant freeze
(deletion/export/import/verify window) is rejected with `Unavailable`. Standard Feathers
methods get the same via the `writeGateBefore` hook. But a custom (non-transport) service
method that writes `this.db` directly (`ReposService.updateMetadata` → `this.patch`,
`SessionsService.setArchiveStateForTree` → `sessionRepo` writes, etc.) has neither on the
MCP path. So `runWithMcpTenantDatabaseScope` alone would let an MCP mutation slip past a
freeze that HTTP enforces.

`runWithMcpTenantDatabaseWrite` closes that: it enters the scope **and** calls
`assertTenantWritable` inside it, translating `TenantWriteGateActiveError` → `Unavailable`
exactly like the route hook. It is used for the mutating call sites (createBranch,
cloneRepository, updateMetadata, boards/sessions archive+unarchive); reads keep the
read-only helper. On SQLite/static the gate read short-circuits (`readTenantWriteGate`
returns inactive for non-Postgres), so single-tenant behavior is unchanged.

## Tests

- `apps/agor-daemon/src/mcp/tools/branches.tenant-scope.test.ts` — exercises the **real**
  guard machinery (`createTenantScopedDatabaseProxy({requireScope:true})` +
  `tenantDatabaseScope`): locks the exact error string; proves `createBranch` now runs
  under an active tenant DB scope bound to the authenticated tenant (`waitForReady`
  false/true); proves scope cleanup after return; proves tenant A/B don't share a scope;
  proves a conflicting foreign ambient tenant fails closed; and preserves static
  single-tenant behavior (no scope, no error).
- `scripts/test-ha-mcp-branch-create.mjs` — gated HA integration reproduction against the
  live Compose stack (real `/mcp`, minted session token): REST control succeeds; MCP
  create succeeds on both replicas for both wait modes; concurrent creates all succeed
  (no scope bleed); tenant-B token cannot create against a tenant-A repo.

## Durable follow-up (recommended, not done here)

`ReposService`, `BoardsService`, `BoardObjectsService`, and `CardsService` should grow the
same private `withTenantDatabase(params, work)` helper that `BranchesService` already has,
and wrap their custom methods internally. That makes the services defend themselves
regardless of caller (HTTP route, MCP, gateway, scheduler) rather than relying on every
call site to remember the wrapper — the same defense-in-depth the branches/sessions/gateway
services already apply, and it removes the drift risk that let `agor_cards_get` and `agor_sessions_archive` slip
through the first pass.

**The static audit is now implemented** as
`apps/agor-daemon/src/mcp/tools/tenant-scope-audit.test.ts`: it scans every `mcp/tools/*.ts`
for `<x>Service.<method>()` calls to non-transport methods and fails unless the call is
wrapped in either `runWithMcpTenantDatabaseScope` or `runWithMcpTenantDatabaseWrite`
(balanced-span aware, so multi-statement `async (db) => { … }` wrappers count) or is on an
explicit, per-token allow-list with a documented reason (branches env methods + `unarchive`
via `withTenantDatabase`; `gatewayService.emitMessage` via unit-of-work-bound repos;
`reposService.addLocalRepository` as intentionally unwrapped). It additionally enforces a
`MUTATION_TOKENS` list (mutations must use the WRITE helper, not the read-only one) and the
`<name>Service` alias convention the scan relies on. Running it during this change is what
surfaced the `sessions` miss.

Two threads remain for the service-side follow-up. (1) The **write-freeze gate** should
cover _every_ MCP-initiated tenant mutation, not only those the scanner sees as
`Service.method` calls — direct repository writes
(`SessionRelationshipRepository.setCallbackEnabled`), utility writes (`appendSystemMessage`
in `widgets.ts`), and the internally-scoped env mutators (`startEnvironment` et al., which
need the _admission_ pattern rather than a held transaction) are not yet gated on the MCP
path. HTTP-route parity is a convenient signal, not the criterion — the criterion is "is it
a tenant write." (2) Growing the `withTenantDatabase`/write-unit helper on
`ReposService`/`BoardsService`/`BoardObjectsService`/`CardsService` (as `BranchesService`
already has) would make the services defend themselves — scope _and_ gate — regardless of
caller, retiring the per-call-site read/write helper juggling entirely.
