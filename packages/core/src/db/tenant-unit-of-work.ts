import type { TenantScopeAwareDatabase } from './client';
import { getCurrentTenantId, runWithTenantDatabaseScope } from './tenant-scope';
import { assertTenantWritable, isTenantWriteMethodName } from './tenant-write-gate';

/**
 * Bind an async repository to short tenant database units of work.
 *
 * Each repository method gets its own transaction unless the caller already
 * opened an explicit tenant DB scope, in which case it joins that scope. This
 * is intended for long-lived orchestration services whose network/process work
 * must remain outside transactions.
 *
 * This is also the reusable enforcement point for the per-tenant write gate.
 * Deferred writers that carry only tenant identity (the gateway, MCP tools,
 * custom routes) never pass through the request-hook gate check, so gating each
 * write here — inside the same short transaction the method runs in — closes
 * that bypass once, at the boundary, rather than at every call site. The gate is
 * a WRITE gate: reads pass through untouched (see {@link isTenantWriteMethodName}),
 * matching the request path's "reads are never gated" invariant. On the
 * single-tenant SQLite schema (no tenant id) enforcement is a no-op.
 */
export function bindRepositoryToTenantUnitOfWork<T extends object>(
  db: TenantScopeAwareDatabase,
  repository: T
): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const gated = typeof property === 'string' && isTenantWriteMethodName(property);
      return (...args: unknown[]) => {
        const tenantId = getCurrentTenantId();
        return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          if (gated && tenantId) await assertTenantWritable(scoped, tenantId);
          return Promise.resolve(Reflect.apply(value, target, args));
        });
      };
    },
  });
}
