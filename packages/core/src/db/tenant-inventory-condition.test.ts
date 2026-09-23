import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { runWithTenantContext, tenantDatabaseScope } from './tenant-context';
import { tenantInventoryCondition } from './tenant-inventory-condition';

vi.mock('./database-wrapper', () => ({ isPostgresDatabase: vi.fn(() => true) }));
const db = {} as Database;
const table = sql.identifier('sessions');

describe('tenant inventory planner predicate', () => {
  it('binds trusted tenant identity separately on every call', () => {
    for (const id of ['tenant-a', 'tenant-b']) {
      runWithTenantContext(id, () => {
        const condition = tenantInventoryCondition(db, table)!;
        expect(new PgDialect().sqlToQuery(condition)).toMatchObject({
          sql: '"sessions"."tenant_id" = $1',
          params: [id],
        });
      });
    }
  });
  it('does not interpret absent identity as system authority', () => {
    expect(() => tenantInventoryCondition(db, table)).toThrow('Missing active tenant context');
  });
  it('leaves explicit system discovery governed by existing RLS', () => {
    tenantDatabaseScope.run(
      { db, kind: 'system', systemReason: 'test', systemCapability: 'scheduler_discovery' },
      () => {
        expect(tenantInventoryCondition(db, table)).toBeUndefined();
      }
    );
  });
  it('does not reference nonexistent tenant columns on SQLite', () => {
    vi.mocked(isPostgresDatabase).mockReturnValueOnce(false);
    expect(tenantInventoryCondition(db, table)).toBeUndefined();
  });
});
