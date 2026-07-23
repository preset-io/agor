/**
 * Regression: tenant-owned services must carry ambient tenant identity even
 * without tenant columns (SQLite / single-tenant default).
 *
 * PR #1942 made MCP session-token minting (mcp/tokens.ts) call
 * `requireCurrentTenantId()`, which throws when no tenant context is active.
 * register-hooks.ts only registered the tenant around-hook when tenant columns
 * were enabled (PostgreSQL), so on the default SQLite deployment `sessions`
 * had no around-hook, no ambient tenant, and every `sessions.create` /
 * `sessions.get` 500'd with "missing active tenant context" — surfaced in the
 * UI as "Failed to create session".
 *
 * The fix registers the identity-only around hook (no data stamping, no RLS
 * transaction) for tenant-owned services in SQLite mode. This test drives that
 * exact hook through its Feathers `(context, next)` contract and proves the
 * wrapped service body runs with the static tenant active — which is what lets
 * `generateSessionToken` succeed downstream instead of throwing.
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
      // Stand-in for the after-hook (mcp/tokens.ts) reading the active tenant.
      observed = getCurrentTenantId();
    });

    expect(observed).toBe(DEFAULT_STATIC_TENANT_ID);
  });

  it('leaves no ambient tenant identity when the hook is absent (documents the regression)', () => {
    // Exactly the pre-fix SQLite path: the service body runs with no around hook.
    expect(getCurrentTenantId()).toBeUndefined();
  });
});
