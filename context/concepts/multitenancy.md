# Multi-tenancy: applicability and code map

Use this during task shaping and again when reviewing a change that might affect
a tenant-owned resource or carry tenant context across a boundary.

The check is mandatory; tenant-specific code is not. A presentation-only change
over already-authorized data can be unaffected. A small file, token, cache, or
background-work change can be highly relevant.

Do not use the current SQLite/static-tenant development topology as proof that a
change is tenant-neutral. `required_from_auth` mode resolves tenant identity
from trusted authentication context and uses PostgreSQL row-level security
(RLS).

## Keep the boundaries distinct

A tenant is the customer/account isolation boundary. It is not interchangeable
with a user, branch, board, repo, session, RBAC role, or Unix user.

Authentication answers who the caller is. Authorization answers which action
the caller may perform. Tenant isolation additionally constrains the resources
on which that action can operate. A caller can be authenticated and authorized
for an action while a missing tenant constraint still targets another tenant's
resource.

Classify affected resources explicitly as:

- **tenant-owned** — data, configuration, credentials, files, processes, or
  side effects belonging to one tenant;
- **system/global** — intentionally cross-tenant infrastructure with a narrow,
  explicit reason and capability;
- **derived ownership** — a resource owned through another tenant-owned object,
  such as a task through its session.

## Fast applicability check

Multi-tenancy is implicated when a change does any of the following:

- Creates, reads, updates, deletes, caches, exports, or logs tenant-owned state.
- Adds a database table, query, uniqueness rule, repository, or service.
- Stores or retrieves files, uploads, artifacts, generated output, or object
  storage keys.
- Creates a token, signed URL, OAuth state, API key, credential, secret, or
  tenant-specific configuration.
- Crosses HTTP, Feathers, MCP, WebSocket, gateway, executor, or
  service-to-service boundaries.
- Defers work into a queue, scheduler, callback, retry, event handler, health
  monitor, or other background process.
- Uses a shared namespace or process-local primitive: IDs, filenames, cache
  keys, maps, locks, rooms, ports, deduplication keys, or rate limits.
- Changes shared capacity, quotas, metering, telemetry, or behavior through
  which one tenant can affect another.
- Changes onboarding, offboarding, cleanup, deletion, backup, restore,
  import/export, or orphan handling.

If none applies, continue without tenant-specific abstractions or tests. Record
a non-applicability rationale only when the answer is non-obvious or affects the
implementation or review.

## Decision procedure

For an implicated change, answer these before choosing an implementation:

1. **Owner:** Which tenant owns each affected resource or side effect?
2. **Source:** Where does trusted tenant identity enter the flow? Never accept an
   unvalidated tenant ID merely because it came from a header, parameter, token,
   or payload.
3. **Propagation:** Does the same tenant context survive every synchronous and
   asynchronous boundary?
4. **Enforcement:** Which shared mechanism constrains access, and does it fail
   closed when tenant context is missing or conflicting?
5. **Lifecycle:** Are cleanup, quotas, logs, retries, deletion, and offboarding
   scoped to the same owner?
6. **Proof:** Which negative test demonstrates that another tenant cannot use
   the same ID, key, token, path, or message to reach the resource?

If correct handling changes the approved behavior, architecture, scope, or proof
boundary, stop and revise the task rather than silently preserving a
single-tenant assumption or inventing speculative infrastructure.

## Established Agor seams

Reuse these owners instead of introducing local tenant plumbing:

| Concern                                                | Existing owner                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Configuration and tenant resolution                    | `packages/core/src/config/multitenancy.ts`                                                                         |
| Tenant types                                           | `packages/core/src/types/tenant.ts`                                                                                |
| Ambient operation identity                             | `packages/core/src/db/tenant-context.ts`                                                                           |
| Short tenant/system database units and guarded proxies | `packages/core/src/db/tenant-scope.ts`, `packages/core/src/db/tenant-unit-of-work.ts`                              |
| PostgreSQL tenant columns and RLS coverage             | `packages/core/src/db/schema.postgres.ts`, `packages/core/src/db/multitenancy-schema.test.ts`, database migrations |
| Service ownership and request hooks                    | `TENANT_OWNED_SERVICE_PATHS` and `TENANT_IDENTITY_ONLY_SERVICE_PATHS` in `apps/agor-daemon/src/register-hooks.ts`  |
| Request/deferred identity helpers                      | `apps/agor-daemon/src/utils/tenant-db-scope.ts`                                                                    |
| Queued session work                                    | `apps/agor-daemon/src/utils/session-queue-tenant-scope.ts`                                                         |
| MCP database work                                      | `apps/agor-daemon/src/mcp/tenant-scope.ts`                                                                         |
| Tenant-aware realtime delivery                         | `apps/agor-daemon/src/utils/realtime-publish.ts`                                                                   |
| Static guard against new raw boundary bypasses         | `scripts/check-multitenancy-boundaries.mjs`                                                                        |

Database RLS protects database rows. It does not protect filesystem paths,
object storage, cache entries, tokens, realtime rooms, processes, or external
side effects. Those resources need their own tenant-aware owner or capability.

Long-lived network or process work should carry tenant identity without holding
an HTTP-long database transaction. Open short tenant database units at the
actual database call, following the existing identity-only and deferred-work
patterns.

## Implementation defaults

- Derive tenant context from authenticated/trusted context and reject conflicts.
- Reuse tenant-aware hooks, repositories, storage namespaces, realtime helpers,
  and deferral helpers rather than adding call-site filters.
- Scope names, keys, capabilities, and persisted associations to the tenant when
  they can be replayed or resolved outside RLS.
- Treat globally unique UUIDs as identifiers, not as tenant authorization.
- Make system/global work explicit and narrow; never obtain it by dropping
  tenant context accidentally.
- Consider noisy-neighbor behavior for shared compute, queues, storage, search,
  rate limits, and expensive background work.
- Preserve static-tenant/SQLite behavior without using it as the isolation
  proof for hosted PostgreSQL mode.

## Validation

Choose the smallest set that covers the changed boundary:

- Tenant A can perform the intended operation.
- Tenant B cannot read, mutate, replay, or infer tenant A's resource using the
  same ID, token, key, path, room, or message.
- Missing and conflicting tenant identity fail closed in
  `required_from_auth` mode.
- Deferred, queued, retried, and realtime work retains the originating tenant.
- Cleanup, quotas, logs, and lifecycle actions affect only the owning tenant.
- Static-tenant mode still works when that path is supported.
- `pnpm check:multitenancy-boundaries` passes when daemon/core boundaries
  change.

Do not rely only on two positive tests with different tenant IDs. Include a
mismatched or cross-tenant attempt that would fail if the isolation constraint
were removed.

## Example: uploaded image previews

An image-preview feature is tenant-relevant even if the visible UI change is
small:

- uploaded bytes are tenant-owned;
- the upload capability should be bound to the tenant and the narrowest
  applicable user/session/task owner;
- the storage key or path needs a tenant-aware namespace or equivalent
  ownership check;
- retrieval must prove that the active tenant owns the persisted association;
- cleanup, quotas, orphan handling, and offboarding must use the same boundary;
- tests should attempt to reuse tenant A's token, task ID, and storage key from
  tenant B.

A tenant-scoped task lookup alone does not isolate bytes stored in a shared
filesystem.

## Non-goals

- Do not add `tenant_id` to every transient object.
- Do not deploy dedicated infrastructure per tenant by default.
- Do not create a second authorization system beside existing Agor seams.
- Do not add tenant abstractions to changes that cross no tenant boundary.

Isolation can be pooled, siloed, or mixed per resource. Choose the smallest
established mechanism that satisfies the actual boundary.

## External references

- [AWS SaaS Lens: isolation mindset](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/isolation-mindset.html)
- [Azure multitenancy checklist](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/checklist)
- [OWASP Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
