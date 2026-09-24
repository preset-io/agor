/**
 * What the registration-time classification gate does NOT catch.
 *
 * Every case here PASSES the gate, on purpose. `assertTenantServiceClassification`
 * is a Feathers registration coverage gate: it compares the keys of
 * `app.services` against three declaration tables and refuses to boot on a path
 * nobody answered for. It reads no handler, inspects no registrar, and
 * instruments no query, so a declaration is a claim rather than a proof.
 *
 * That limit is worth a suite of its own because the mechanism is easy to
 * over-read — it was described during review as making the tenant-scope defect
 * class structurally impossible, and it does not do that. Making it true means
 * connecting classification to the actual registrar or to injected
 * dependencies, which is a platform change. Until then, these five escapes are
 * the shape of what still gets through, and the runtime guard
 * (`createTenantScopedDatabaseProxy(..., { requireScope: true })`) is what
 * actually stops the defect — which is why two of them end by showing the guard
 * throwing where the gate said nothing.
 *
 * See `context/concepts/multitenancy.md` ("What the gate is, and what it does
 * not catch") and §7.1.12 of
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
 */
import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  isMCPSlackConnectCardEnabled,
  MissingTenantDatabaseScopeError,
  runMigrations,
  runWithTenantContext,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_OWNED_SERVICE_PATHS } from '../register-hooks';
import {
  assertTenantServiceClassification,
  TenantServiceClassificationError,
  tenantServiceClassificationFor,
} from './tenant-service-classification';

const TENANT = 'tenant-a';

let raw: Awaited<ReturnType<typeof createDatabaseAsync>>;
let guarded: TenantScopeAwareDatabase;

beforeEach(async () => {
  raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(raw);
  guarded = createTenantScopedDatabaseProxy(raw, {
    requireScope: true,
    label: 'classification limits test',
  });
});

afterEach(() => {
  (raw as unknown as { $client?: { close(): void } }).$client?.close();
});

/** A Feathers-shaped registration table. The assertion reads nothing else. */
const appWith = (services: Record<string, unknown>) => ({ services });

describe('a declaration is a claim, not a proof', () => {
  it('admits an identity-only service that holds a raw handle and reads unscoped', async () => {
    // `mcp-oauth-connect` is declared `identity-only` — "every database access
    // opens its own short unit". This service does the opposite: it keeps the
    // raw handle and makes exactly the unscoped kill-switch read the connect
    // lane's own sweep made (§7.1.3).
    const service = {
      db: guarded,
      async find() {
        return isMCPSlackConnectCardEnabled(this.db);
      },
    };

    // The gate: silent. It never looked inside.
    expect(() =>
      assertTenantServiceClassification(appWith({ 'mcp-oauth-connect': service }))
    ).not.toThrow();

    // The runtime guard: the only thing that objects, and only once the code
    // actually runs, from a caller with tenant identity and no scope.
    await expect(runWithTenantContext(TENANT, () => service.find())).rejects.toBeInstanceOf(
      MissingTenantDatabaseScopeError
    );
  });

  it('admits a `scoped` declaration on an app with no hooks or registrar at all', () => {
    // A `scoped` answer means "the registration arms a scope for the whole
    // request". Two things actually do that: membership in
    // TENANT_OWNED_SERVICE_PATHS, which installs the around-hook, and
    // createTenantScopedAuthenticatedRouteRegistrar. A hand-written `scoped`
    // entry in the supplemental table asserts one of them happened; nothing
    // checks that it did.
    expect(tenantServiceClassificationFor('mcp-slack-connect/card')?.scopeClass).toBe('scoped');
    expect(TENANT_OWNED_SERVICE_PATHS).not.toContain('mcp-slack-connect/card');

    // This app has no hooks, no registrar and no database. It passes.
    expect(() =>
      assertTenantServiceClassification(appWith({ 'mcp-slack-connect/card': {} }))
    ).not.toThrow();
  });
});

describe('the unit of declaration is a registered path, not a line of code', () => {
  it('says nothing about new code added inside an already-classified service', async () => {
    // One path, one answer, given once. A method added later — or a timer or
    // sweep callback the service starts — inherits the classification without
    // re-deciding anything. The declaration is made at registration, and the
    // code that reaches the database is written afterwards and separately.
    const service = {
      db: guarded,
      async find() {
        return true;
      },
      /** Added in a later pull request. Nothing re-classifies the path. */
      async sweep() {
        return isMCPSlackConnectCardEnabled(this.db);
      },
    };

    expect(() =>
      assertTenantServiceClassification(appWith({ 'mcp-oauth-connect': service }))
    ).not.toThrow();
    await expect(runWithTenantContext(TENANT, () => service.sweep())).rejects.toBeInstanceOf(
      MissingTenantDatabaseScopeError
    );
  });

  it('never sees an Express handler, because it is not a service', () => {
    // `app.post('/mcp-egress/:serverId', …)` in register-routes.ts is a live
    // example: a real request handler that reaches tenant data and never
    // appears in `app.services`, so the gate has nothing to be missing.
    expect(tenantServiceClassificationFor('mcp-egress/:serverId')).toBeUndefined();
    // Its sibling `mcp-egress/status` IS a service, and therefore answered —
    // which is the whole difference between the two.
    expect(tenantServiceClassificationFor('mcp-egress/status')?.scopeClass).toBe('scoped');

    const app = appWith({}) as { services: Record<string, unknown>; routes?: string[] };
    app.routes = ['/mcp-egress/:serverId'];
    expect(() => assertTenantServiceClassification(app)).not.toThrow();
  });
});

describe('the gate fires once', () => {
  it('does not notice a service registered after the boot assertion ran', () => {
    // Phase 3.6 of `index.ts` calls this once, after all three registration
    // phases. A service added to the same app afterwards — lazily, by a
    // plugin, by a test — is never looked at again.
    const app = appWith({ 'mcp-oauth-connect': {} });
    expect(() => assertTenantServiceClassification(app)).not.toThrow();

    app.services['mcp-slack-connect/reinvite'] = {};
    // Nothing re-runs, so nothing refuses. Only asking again would.
    expect(() => assertTenantServiceClassification(app)).toThrow(TenantServiceClassificationError);
  });
});
