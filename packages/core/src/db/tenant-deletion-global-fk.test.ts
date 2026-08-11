import { describe, expect, it } from 'vitest';
import { assertGlobalReferencesNoTenantTable } from './tenant-deletion';

/**
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
    tableName: 'mcp_catalog_entries',
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
    const contract =
      '900:200:100:FOREIGN KEY (catalog_entry_id) REFERENCES mcp_catalog_entries(id)';
    expect(() =>
      assertGlobalReferencesNoTenantTable(relation({ foreignKeyContract: contract }), byOid)
    ).not.toThrow();
  });

  it('ignores a self-reference', () => {
    const contract = '900:100:100:FOREIGN KEY (parent_id) REFERENCES mcp_catalog_entries(id)';
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
