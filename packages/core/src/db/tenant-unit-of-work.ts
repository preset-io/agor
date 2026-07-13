import type { TenantScopeAwareDatabase } from './client';
import { getCurrentTenantId, runWithTenantDatabaseScope } from './tenant-scope';

/**
 * Bind an async repository to short tenant database units of work.
 *
 * Each repository method gets its own transaction unless the caller already
 * opened an explicit tenant DB scope, in which case it joins that scope. This
 * is intended for long-lived orchestration services whose network/process work
 * must remain outside transactions.
 */
export function bindRepositoryToTenantUnitOfWork<T extends object>(
  db: TenantScopeAwareDatabase,
  repository: T
): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        runWithTenantDatabaseScope(db, getCurrentTenantId(), () =>
          Promise.resolve(Reflect.apply(value, target, args))
        );
    },
  });
}
