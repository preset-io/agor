/**
 * Regression: tenant-owned services must carry ambient tenant identity even
 * without tenant columns (SQLite / single-tenant default).
 *
 * Tenant-aware service code should observe the configured static tenant even
 * when tenant columns are absent. MCP token issuance can independently resolve
 * the configured tenant in static mode, but other service code still relies on
 * this ambient identity and required_from_auth must never receive a static
 * fallback.
 *
 * The fix registers the identity-only around hook (no data stamping, no RLS
 * transaction) for tenant-owned services in SQLite mode. This test drives that
 * exact hook through its Feathers `(context, next)` contract and proves the
 * wrapped service body runs with the static tenant active.
 */

import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import { getCurrentTenantId } from '@agor/core/db';
import type { HookContext } from '@feathersjs/feathers';
import { describe, expect, it } from 'vitest';
import { createTenantDatabaseScopeAroundHook } from './utils/tenant-db-scope';

const JWT_SECRET = 'test-jwt-secret-do-not-use-in-production';

// A SQLite deployment: no `database.url`, so the dialect resolves to sqlite and
// `tenantColumnsEnabled` is false. Multi-tenancy defaults to static mode.
const sqliteConfig = {} as unknown as Parameters<
  typeof createTenantDatabaseScopeAroundHook
>[0]['config'];

// Identity-only mode never opens a DB unit, so the db handle is unused here.
const fakeDb = {} as never;

const identityAround = createTenantDatabaseScopeAroundHook({
  db: fakeDb,
  config: sqliteConfig,
  jwtSecret: JWT_SECRET,
  transaction: false,
});

// A bare REST-style hook context for a `sessions.create`, matching what Feathers
// passes into an around hook.
const makeContext = (): HookContext =>
  ({ path: 'sessions', method: 'create', params: { provider: 'rest' } }) as unknown as HookContext;

describe('tenant identity for owned services (SQLite / static mode)', () => {
  it('activates the static tenant while the wrapped service body runs', async () => {
    let observed: string | undefined = 'sentinel';
    await identityAround(makeContext(), async () => {
      // Stand-in for tenant-aware service code reading the active tenant.
      observed = getCurrentTenantId();
    });

    expect(observed).toBe(DEFAULT_STATIC_TENANT_ID);
  });

  it('leaves no ambient tenant identity when the hook is absent (documents the regression)', () => {
    // Exactly the pre-fix SQLite path: the service body runs with no around hook.
    expect(getCurrentTenantId()).toBeUndefined();
  });
});
