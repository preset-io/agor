import { describe, expect, it } from 'vitest';
import { TENANT_IDENTITY_ONLY_SERVICE_PATHS, TENANT_OWNED_SERVICE_PATHS } from '../register-hooks';
import { NON_SERVICE_REGISTERED_PATHS, REALTIME_PUBLISH_POLICY } from './realtime-publish-policy';
import {
  assertTenantServiceClassification,
  classifiedTenantServicePaths,
  isBaselinedUnclassifiedService,
  TENANT_SERVICE_CLASSIFICATIONS,
  TenantServiceClassificationError,
  tenantServiceClassificationFor,
  UNCLASSIFIED_SERVICE_BASELINE,
} from './tenant-service-classification';

/** A Feathers-shaped registration table. The assertion reads nothing else. */
const appWith = (...paths: string[]) => ({
  services: Object.fromEntries(paths.map((path) => [path, {}])),
});

describe('registration-time tenant scope classification', () => {
  it('refuses a NEW service that never said where its scope is armed', () => {
    // The whole point of the mechanism. This is the shape every one of the
    // five shipped defects had at registration: a path nobody classified,
    // reaching tenant data from identity-only context.
    expect(() => assertTenantServiceClassification(appWith('mcp-slack-connect/reinvite'))).toThrow(
      TenantServiceClassificationError
    );
    try {
      assertTenantServiceClassification(appWith('mcp-slack-connect/reinvite'));
      expect.unreachable('expected the unclassified service to be refused');
    } catch (error) {
      expect((error as TenantServiceClassificationError).unclassifiedPaths).toEqual([
        'mcp-slack-connect/reinvite',
      ]);
      // The message has to say what to do, because it fires at boot.
      expect((error as Error).message).toContain('TENANT_OWNED_SERVICE_PATHS');
      expect((error as Error).message).toContain('TENANT_SERVICE_CLASSIFICATIONS');
      expect((error as Error).message).toContain('closed to new entries');
    }
  });

  it('admits a classified service, whichever of the three inventories classified it', () => {
    expect(() =>
      assertTenantServiceClassification(
        appWith(
          'messages', // scoped, via TENANT_OWNED_SERVICE_PATHS
          'mcp-servers/oauth-start', // identity-only, via TENANT_IDENTITY_ONLY_SERVICE_PATHS
          'mcp-oauth-connect', // identity-only, declared by this feature
          'mcp-slack-connect/card', // scoped, declared by this feature
          'mcp-servers/oauth-browser-reservations' // system, declared by this feature
        )
      )
    ).not.toThrow();
  });

  it('admits a baselined service and the Express mounts that are not services', () => {
    expect(() =>
      assertTenantServiceClassification(appWith('repos/clone', ...NON_SERVICE_REGISTERED_PATHS))
    ).not.toThrow();
  });

  it('resolves a classification with or without the leading slash Feathers strips', () => {
    expect(tenantServiceClassificationFor('/mcp-oauth-connect')?.scopeClass).toBe('identity-only');
    expect(tenantServiceClassificationFor('mcp-oauth-connect')?.scopeClass).toBe('identity-only');
    expect(tenantServiceClassificationFor('nothing-declared-this')).toBeUndefined();
    expect(tenantServiceClassificationFor(undefined)).toBeUndefined();
  });

  it('classifies the feature lanes as the registration actually arms them', () => {
    // Scoped: registered through createTenantScopedAuthenticatedRouteRegistrar.
    for (const path of ['mcp-slack-connect/card', 'mcp-member-policy', 'mcp-egress/status']) {
      expect(tenantServiceClassificationFor(path)?.scopeClass, path).toBe('scoped');
    }
    // Identity-only: sealed-token preflights, widget routes, Catalog connect,
    // the provider redirect. Each opens its own short unit per access.
    for (const path of [
      'mcp-oauth-connect',
      'mcp-slack-recovery',
      'widgets/:id/submit',
      'widgets/:id/oauth-resolve',
      'widgets/:id/dismiss',
      'mcp-catalog/connect',
      'mcp-catalog/start-session',
      'mcp-servers/oauth-callback',
    ]) {
      expect(tenantServiceClassificationFor(path)?.scopeClass, path).toBe('identity-only');
    }
    // System: the one that touches no database at all.
    expect(
      tenantServiceClassificationFor('mcp-servers/oauth-browser-reservations')?.scopeClass
    ).toBe('system');
  });

  it('requires every declared classification to explain itself', () => {
    for (const [path, classification] of Object.entries(TENANT_SERVICE_CLASSIFICATIONS)) {
      expect(classification.why.length, `${path} has no rationale`).toBeGreaterThan(20);
    }
  });

  it('does not restate a path the two hook inventories already classify', () => {
    // Those lists are what installs the hook. A second declaration here would
    // be a second place to be wrong about the same service.
    const hooked = new Set<string>([
      ...TENANT_OWNED_SERVICE_PATHS,
      ...TENANT_IDENTITY_ONLY_SERVICE_PATHS,
    ]);
    const restated = Object.keys(TENANT_SERVICE_CLASSIFICATIONS).filter((path) => hooked.has(path));
    expect(restated).toEqual([]);
  });
});

/**
 * The baseline's shrink-only rule, checked against the registered-path
 * inventory.
 *
 * `REALTIME_PUBLISH_POLICY` is used as that inventory on purpose rather than
 * writing a second source scanner: its own suite already proves both
 * directions — every path registered in daemon source is declared there, and
 * no declared key is stale. Leaning on it keeps one description of "the
 * services this daemon registers" instead of two that can drift.
 */
describe('unclassified service baseline', () => {
  const registered = new Set(Object.keys(REALTIME_PUBLISH_POLICY));

  it('covers every registered service between the classifications and the baseline', () => {
    const undeclared = [...registered].filter(
      (path) =>
        !classifiedTenantServicePaths().has(path) &&
        !isBaselinedUnclassifiedService(path) &&
        !NON_SERVICE_REGISTERED_PATHS.has(path)
    );
    expect(undeclared).toEqual([]);
  });

  it('holds no entry that is no longer registered', () => {
    // Ratchet one, downward: a stale entry would keep permitting a path that
    // no longer exists, and would quietly re-permit it if the name came back.
    const stale = UNCLASSIFIED_SERVICE_BASELINE.filter((path) => !registered.has(path));
    expect(stale).toEqual([]);
  });

  it('holds no entry that has since been classified', () => {
    // Ratchet two, downward: once a service answers, it must leave the
    // baseline. Otherwise the list only ever grows in practice.
    const redundant = UNCLASSIFIED_SERVICE_BASELINE.filter((path) =>
      classifiedTenantServicePaths().has(path)
    );
    expect(redundant).toEqual([]);
  });

  it('holds no duplicates', () => {
    expect(new Set(UNCLASSIFIED_SERVICE_BASELINE).size).toBe(UNCLASSIFIED_SERVICE_BASELINE.length);
  });

  it('stays within the inventory the boundary check approved', () => {
    // The upward ratchet lives in scripts/check-multitenancy-boundaries.mjs
    // and compares NAMES, not a count: classifying one service and listing a
    // different one leaves the total unchanged, which is a replenishable
    // allowance rather than a closed debt inventory. That comparison — and the
    // replacement case — is driven in
    // `scripts/check-multitenancy-boundaries.test.mjs`, against this very file;
    // it is not repeated here because the script is not part of the daemon's
    // TypeScript program. What stays here is the ceiling.
    expect(UNCLASSIFIED_SERVICE_BASELINE.length).toBeLessThanOrEqual(57);
  });
});
