import { describe, expect, it } from 'vitest';
import {
  assertDeclaredGlobalRelation,
  assertGlobalReferencesNoTenantTable,
} from './tenant-deletion';

/**
 * The two guards that keep a global declaration honest in the live catalogue.
 *
 * GLOBAL_TABLES is empty, so `deleteTenantData` cannot reach either of them
 * against the real schema. They exist for the next table someone declares
 * global, which is exactly why they are driven directly here rather than left
 * to an integration test that can no longer construct the shape.
 *
 * The FK guard resolves parents by oid rather than by reading the rendered
 * `REFERENCES` clause.
 *
 * A rendered clause is schema-qualified whenever the target is off the
 * search_path, and a bare-name match then captures the schema instead of the
 * table — and cannot tell `other.sessions` from `public.sessions` even when it
 * does match. Both shapes are asserted here because the end-to-end path cannot
 * reach them: the audit rejects a tenant-contract relation outside `public`
 * before this function runs, and the hardened search_path keeps `public`
 * unqualified. That makes this a guard against the constraint text mattering at
 * all, which is the point of resolving by oid.
 */
function relation(overrides: Record<string, unknown> = {}) {
  return {
    relationId: '100',
    schemaName: 'public',
    tableName: 'declared_global',
    relkind: 'r',
    rlsEnabled: true,
    rlsForced: true,
    hasTenantColumn: false,
    tenantColumnTextNotNull: false,
    participatesInInheritance: false,
    foreignKeyContract: '',
    policies: [],
    ...overrides,
  } as unknown as Parameters<typeof assertGlobalReferencesNoTenantTable>[0];
}

const tenantParent = relation({ relationId: '200', tableName: 'sessions' });
const byOid = new Map([['200', tenantParent]]);

describe('assertGlobalReferencesNoTenantTable', () => {
  it('refuses an outgoing reference whose clause names another schema', () => {
    const contract = '900:100:200:FOREIGN KEY (session_id) REFERENCES app.sessions(session_id)';
    expect(() =>
      assertGlobalReferencesNoTenantTable(relation({ foreignKeyContract: contract }), byOid)
    ).toThrow(/declared global but references tenant-scoped public\.sessions/);
  });

  it('refuses it just the same when the clause is unqualified', () => {
    const contract = '900:100:200:FOREIGN KEY (session_id) REFERENCES sessions(session_id)';
    expect(() =>
      assertGlobalReferencesNoTenantTable(relation({ foreignKeyContract: contract }), byOid)
    ).toThrow(/declared global but references tenant-scoped/);
  });

  it('ignores a constraint pointing at this table rather than from it', () => {
    // The contract carries both directions; an incoming reference puts no
    // tenant rows behind the global table.
    const contract = '900:200:100:FOREIGN KEY (global_id) REFERENCES declared_global(id)';
    expect(() =>
      assertGlobalReferencesNoTenantTable(relation({ foreignKeyContract: contract }), byOid)
    ).not.toThrow();
  });

  it('ignores a self-reference', () => {
    const contract = '900:100:100:FOREIGN KEY (parent_id) REFERENCES declared_global(id)';
    expect(() =>
      assertGlobalReferencesNoTenantTable(relation({ foreignKeyContract: contract }), byOid)
    ).not.toThrow();
  });

  it('allows a reference to a relation that is not tenant-scoped', () => {
    const contract = '900:100:300:FOREIGN KEY (x) REFERENCES some_global(id)';
    expect(() =>
      assertGlobalReferencesNoTenantTable(relation({ foreignKeyContract: contract }), byOid)
    ).not.toThrow();
  });
});

describe('assertDeclaredGlobalRelation', () => {
  const named = 'public.declared_global';

  it('accepts a relation that carries no tenant column and no tenant policy', () => {
    expect(() => assertDeclaredGlobalRelation(relation(), named)).not.toThrow();
  });

  it('refuses one that carries a tenant column', () => {
    // Live discovery selects on forced row security, which a global table
    // enables for its own capability policy. Trusting the declaration would let
    // a table holding tenant rows skip the contract entirely.
    expect(() => assertDeclaredGlobalRelation(relation({ hasTenantColumn: true }), named)).toThrow(
      /declared global but has a tenant_id column/
    );
  });

  it.each([
    ['a tenant-isolation policy name', { name: 'tenant_isolation_x' }],
    ['a USING expression that reads the tenant', { name: 'p', usingExpression: 'agor.tenant_id' }],
    ['a CHECK expression that reads the tenant', { name: 'p', checkExpression: 'agor.tenant_id' }],
  ])('refuses one whose policies scope rows by tenant: %s', (_label, policy) => {
    expect(() => assertDeclaredGlobalRelation(relation({ policies: [policy] }), named)).toThrow(
      /declared global but policy/
    );
  });
});
