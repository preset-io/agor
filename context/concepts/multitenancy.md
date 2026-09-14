# Multi-tenancy agent cheat sheet

Use this during task shaping and again during review. The applicability check is
broad; the required handling depends on the resource classification.

Do not use the current SQLite/static-tenant development topology as proof that a
change is tenant-neutral. `required_from_auth` resolves tenant identity from
trusted authentication context and uses PostgreSQL row-level security (RLS).
Board and branch RBAC is always enabled: tenant isolation keeps workspaces
apart, while Board and Branch policies authorize members within one workspace.

## Trigger the check

Multi-tenancy is implicated when a change touches any of these:

- persisted data, queries, uniqueness, files, uploads, artifacts, caches, or
  shared namespaces such as keys, paths, rooms, locks, ports, and rate limits;
- tokens, signed URLs, OAuth state, credentials, secrets, or tenant-specific
  configuration;
- HTTP, Feathers, MCP, WebSocket, gateway, executor, service-to-service,
  realtime, queue, scheduler, callback, retry, or other deferred boundaries;
- shared infrastructure, capacity, quotas, metering, telemetry, or behavior
  through which one tenant can affect another;
- cleanup, deletion, offboarding, backup/restore, import/export, or orphan
  handling.

If none applies, do not add tenant abstractions or tests. Record why only when
non-applicability is non-obvious or affects implementation or review.

## Classify each resource

A tenant is the customer/account isolation boundary, not a user, branch, board,
repo, session, RBAC role, or execution-home key.

| Classification    | Required handling and proof                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant-owned**  | Preserve trusted tenant context through every affected boundary. Prove another tenant cannot reach the resource or side effect.                                |
| **Derived**       | Derive ownership through a tenant-owned parent, such as a task through its session. Preserve that tenant context and prove a mismatched parent/resource fails. |
| **System/global** | Keep the cross-tenant purpose explicit and narrow. Prove the boundary and, where required, that only the named capability grants the intended access.          |

Authentication and action authorization do not replace tenant isolation. A
caller can pass both and still target another tenant's resource if the tenant
constraint is missing.

## Decision procedure

For every triggered change:

1. **Owner:** Classify each resource and side effect. If global, state why.
2. **Source:** Find where trusted tenant identity enters; reject unvalidated or
   conflicting identity from headers, parameters, tokens, or payloads.
3. **Propagation:** Trace that identity across every synchronous and
   asynchronous boundary.
4. **Enforcement:** Reuse the shared owner that fails closed for missing or
   conflicting context. For global work, use the narrowest existing capability.
5. **Lifecycle:** Apply the same classification to cleanup, quotas, logs,
   retries, deletion, and offboarding.
6. **Proof:** Select the smallest negative check at the changed boundary that
   would fail if its isolation or capability constraint were removed.

If correct handling changes approved behavior, architecture, scope, or proof,
revise the task instead of preserving a single-tenant assumption or inventing
speculative infrastructure.

## Existing code owners

Reuse these instead of adding local tenant plumbing:

| Concern                                                                                                                    | Existing owner                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and tenant resolution                                                                                        | `packages/core/src/config/multitenancy.ts`                                                                                                                            |
| Tenant types                                                                                                               | `packages/core/src/types/tenant.ts`                                                                                                                                   |
| Ambient operation identity                                                                                                 | `packages/core/src/db/tenant-context.ts`                                                                                                                              |
| Short tenant/system database units and guarded proxies                                                                     | `packages/core/src/db/tenant-scope.ts`, `packages/core/src/db/tenant-unit-of-work.ts`                                                                                 |
| PostgreSQL tenant columns and RLS coverage                                                                                 | `packages/core/src/db/schema.postgres.ts`, `packages/core/src/db/multitenancy-schema.test.ts`, database migrations                                                    |
| Service ownership and request hooks                                                                                        | `TENANT_OWNED_SERVICE_PATHS` and `TENANT_IDENTITY_ONLY_SERVICE_PATHS` in `apps/agor-daemon/src/register-hooks.ts`                                                     |
| Request/deferred identity helpers                                                                                          | `apps/agor-daemon/src/utils/tenant-db-scope.ts`                                                                                                                       |
| Queued session work                                                                                                        | `apps/agor-daemon/src/utils/session-queue-tenant-scope.ts`                                                                                                            |
| MCP database work                                                                                                          | `apps/agor-daemon/src/mcp/tenant-scope.ts`                                                                                                                            |
| Tenant-aware realtime delivery                                                                                             | `apps/agor-daemon/src/utils/realtime-publish.ts`                                                                                                                      |
| Operator-configured analytics event identity                                                                               | `packages/core/src/analytics/logger.ts` adds trusted ambient identity as `context.tenant_id`                                                                          |
| Static guard against new raw boundary bypasses                                                                             | `scripts/check-multitenancy-boundaries.mjs`                                                                                                                           |
| Per-tenant erasure                                                                                                         | `packages/core/src/db/tenant-delete.ts` (combined proof) + `tenant-deletion.ts` (audited DB engine) + `tenant-filesystem.ts` (safe explicit-root primitives)          |
| Per-tenant inspect/export/import/verify (portability)                                                                      | `packages/core/src/db/tenant-{catalog,portability-manifest,archive,database-io,filesystem,inspect,export,import,verify}.ts`                                           |
| Per-tenant write gate (generation-bound, app-layer fail-closed gate — not a DB lock/fence; consistency relies on `verify`) | `packages/core/src/db/tenant-write-gate.ts`; enforced in `register-hooks.ts` (`writeGateBefore`) + `utils/tenant-db-scope.ts` + `utils/session-queue-tenant-scope.ts` |

RLS protects database rows, not files, object storage, caches, tokens, realtime
rooms, processes, or external side effects. Scope those at their own owner.
Long-lived work should carry tenant identity without holding an HTTP-long
transaction; open short tenant database units at the actual database call.
Globally unique UUIDs identify resources but do not authorize tenant access.

Authenticated custom Feathers routes must use
`createTenantScopedAuthenticatedRouteRegistrar`; the unscoped
`registerAuthenticatedRoute` base installs authentication and role hooks only.
Direct uses of that base should remain limited to the tenant-scoped registrar
and the explicitly reviewed long-route adapter in `register-routes.ts`, which
carries tenant identity and opens short database units instead of holding an
HTTP-long transaction. Registered services that read tenant repositories
belong in `TENANT_OWNED_SERVICE_PATHS` unless they intentionally cross a
long-running external boundary and open short scoped units at each database
call.

## Proportional validation

Add only the checks implicated by the changed boundary:

- For tenant-owned or derived paths, prove tenant A succeeds and tenant B cannot
  read, mutate, replay, or infer the resource using the same ID, token, key,
  path, room, message, or parent.
- Prove missing and conflicting identity fail closed in `required_from_auth`
  when identity resolution changes.
- Prove deferred, queued, retried, or realtime work retains the originating
  tenant when that boundary changes.
- Prove lifecycle work affects only the owning tenant when cleanup, quotas,
  logs, deletion, or offboarding changes.
- For system/global paths, prove the operation stays within its stated boundary
  and any required capability grants only the intended access.
- Preserve static-tenant behavior when supported, and run
  `pnpm check:multitenancy-boundaries` when daemon/core boundaries change.

Two positive tests with different tenant IDs are not isolation proof. Prefer one
cross-tenant or capability-negative attempt that would pass if the constraint
were removed.

## Example: uploaded image previews

Uploaded bytes and their persisted association are tenant-owned. Bind the upload
capability and storage key/path to the tenant (and any narrower task/session/user
owner), enforce the same ownership on retrieval and cleanup, and attempt to
reuse tenant A's token, task ID, or storage key from tenant B. A tenant-scoped
task lookup alone does not isolate bytes in a shared filesystem.
