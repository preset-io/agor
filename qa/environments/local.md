# Local QA environment profile

This inventory describes repository-supported mechanisms. Every run must verify its
own prerequisites; this document does not certify an active environment as ready.

## Profile IDs and proof limits

| ID                | Use                                                                                                              | Limits                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-component` | Existing unit/component or real-browser component suites, with each scenario naming its layer and mocks.         | Does not prove deployed UI/daemon integration, real authentication, persistence, or executor behavior across mocked boundaries.                                               |
| `local-app`       | A user-managed running UI and daemon belonging to the intended checkout, with scenario-specific disposable data. | Not provisioned here. Verify actual configuration and access; local SQLite/simple mode cannot establish PostgreSQL RLS, Linux sandbox containment, or multi-replica behavior. |

## Existing checks

Run from the repository root, after confirming dependencies are installed. Commands
below execute foreground test suites; the browser component runner owns its temporary
test server. They do not start the product's development environment.

```bash
# Focused existing UI component test: replace the file with the selected test.
pnpm --filter agor-ui exec vitest run src/components/Marketplace/MCPCatalogModal.test.tsx

# Focused real-browser component example, across configured viewport instances.
pnpm --filter agor-ui exec vitest run --config vitest.browser.config.ts src/components/Marketplace/MCPCatalogModal.browser.test.tsx
```

Check the selected test path, installed dependencies, and required browser binary
before execution. If Chromium is missing, report browser setup as a prerequisite;
the documented installation command is `pnpm --filter agor-ui exec playwright install chromium`.
The [browser configuration](../../apps/agor-ui/vitest.browser.config.ts) owns viewport
definitions. [CI](../../.github/workflows/ci.yml) runs the browser suite separately from
the standard UI suite; component coverage is not a full application lane.

The [database fixture](../../packages/core/src/db/test-helpers.ts) creates a per-test
temporary SQLite file and initializes its schema. It does not reset the running daemon
database or establish authenticated tenant-boundary coverage by itself. For PostgreSQL
and RLS proof, use the disposable runner described in
[testing guidelines](../../context/guidelines/testing.md#postgresql-integration-suites),
with that environment recorded separately. Never point it at a shared application database.

## Running application preflight (`local-app`)

The operator manages daemon and UI watch processes. Follow [repository instructions](../../AGENTS.md)
and the [architecture guide](../../apps/agor-docs/content/guide/architecture.mdx).
Do not infer ports from defaults or start/restart services to make preflight pass.

Before a scenario can run, establish:

1. The actual UI and daemon URLs, successful health/authenticated application checks,
   and evidence tying the running target to the intended checkout and revision.
2. The actual database dialect, execution mode, tenant configuration, and any required
   external services. Record settings by name/value only when safe; omit credentials.
3. Disposable actors with the required roles/tenants, independently authenticated
   browser contexts for multiplayer checks, and access to authoritative observations.
4. A repeatable scenario-specific fixture setup and cleanup procedure, with run-owned
   resource IDs. Verify the starting state before every independent attempt.
5. For execution claims, a functioning executor and explicit real/mocked provider setup;
   for isolation claims, an environment that actually enforces the boundary being tested.

Resolve missing prerequisites through documented setup within the authorized scope.
If that is unavailable, record `blocked` with the missing requirement and continue
other checks whose prerequisites are satisfied. Do not invent an environment reset.

## Fixtures and missing infrastructure

[Demo fixture loading](../../scripts/load-fixtures.ts) inserts fake data without git,
network, or executor activity. It is useful for presentation scenarios but is not a
general reset mechanism, authenticated multi-user seed, or execution fixture. Inspect
its target configuration and confirm that mutations fit the existing task authorization
before use.

This scaffold supplies no full application runner, universal reset command, multi-tenant
login fixture, runtime revision probe, or executor provisioning. Define those seams from
the pilot scenarios before adding shared helpers. Reuse existing test fixtures and
documented runtime workflows where they already prove the required boundary.
