import {
  assertTenantWritable,
  bindRepositoryToTenantUnitOfWork,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';

/**
 * The one database handle an `identity-only` service is allowed to hold.
 *
 * ## Why this exists
 *
 * A service classified `identity-only` (see `tenant-service-classification.ts`)
 * runs with tenant CONTEXT and no request-long transaction: its callers are
 * `runWithTenantContext`, a timer, a `setImmediate`, or a sweep callback. Every
 * database access it makes must therefore open its own short tenant unit.
 *
 * Five separate defects of exactly one shape have now shipped from that
 * arrangement, three of them past a reviewer:
 *
 *  - the orchestrator holds a raw `TenantScopeAwareDatabase`;
 *  - it hands that raw handle to a free function over `app_variables`
 *    (`isMcpRuntimeRecoveryEnabled`, `getMCPEgressGatewayMode`,
 *    `isMCPSlackConnectCardEnabled`) or to a shared reader that builds its own
 *    repositories from it (`resolveMCPOAuthGrantLiveness`);
 *  - the callee has nothing to open a scope with, so against the production
 *    guard the very first read throws `MissingTenantDatabaseScopeError`;
 *  - a fail-closed `catch` upstream turns that into a generic refusal, or a
 *    sweep's `.catch(() => undefined)` swallows it whole;
 *  - and the suite stubs every repository, so there is no guard to trip.
 *
 * The fixes were per-site: one `runWithTenantDatabaseScope` here, one
 * `bindRepositoryToTenantUnitOfWork` there, one private `readInTenantScope`
 * helper somewhere else. That is several ways to remember the same thing, and
 * remembering is what kept failing.
 *
 * This facade removes the raw handle from the picture. It exposes exactly three
 * ways to reach the database — a bound repository, a read, a write — and every
 * one of them enters a tenant database scope first. There is no accessor that
 * returns the underlying handle, so "pass `db` to a free function" is not a
 * thing a holder of this object can do by accident.
 *
 * Entering a scope that is already open is a no-op, so a request-path caller
 * that already holds one is unaffected; this is equally correct on the
 * `scoped` side of the classification.
 */
export interface TenantBoundDataAccess {
  /**
   * Bind a repository so each of its methods opens its own short tenant unit.
   *
   * Identical to calling {@link bindRepositoryToTenantUnitOfWork} directly,
   * except that the tenant comes from this facade rather than from whatever
   * the call site remembered to pass.
   */
  repository<T extends object>(repository: T): T;

  /**
   * Run one read inside a short tenant database scope.
   *
   * The callback receives the SCOPED handle, which is what makes this safe to
   * hand to a free function (`read(isMCPSlackConnectCardEnabled)`) — the thing
   * that was unsafe with a raw handle.
   */
  read<T>(read: (db: TenantScopedDatabase) => Promise<T>): Promise<T>;

  /**
   * Run one write inside a short tenant unit, with the per-tenant write gate
   * checked inside that same unit.
   *
   * Deferred writers that carry only tenant identity never pass through the
   * request hook's gate check, so the gate is enforced here for the same
   * reason `bindRepositoryToTenantUnitOfWork` enforces it on bound methods.
   */
  write<T>(write: (db: TenantScopedDatabase) => Promise<T>): Promise<T>;
}

/**
 * Pin the facade to a tenant instead of reading ambient identity.
 *
 * **A pinned tenant is not authorization.** It does not decide who the caller
 * is, what they may read, or whether they may act — it only says which tenant's
 * rows the work already established it belongs to. It is appropriate when the
 * holder has evidence that is *stronger* than ambient identity (a tenant
 * verified against sealed token claims) or when the call sites are deferred
 * timers and handlers that ambient identity does not reliably reach.
 *
 * It must never become a way for a caller to name the tenant it wants. If the
 * value can be traced back to request input without passing through identity
 * resolution, this is the wrong tool and the fix is upstream.
 *
 * `because` is mandatory and non-empty so that every pinned construction says,
 * at the construction site, which of the two justifications above applies. A
 * grep for `pinnedTenantId` is then a complete review list.
 */
export interface PinnedTenantBinding {
  pinnedTenantId: string;
  because: string;
}

export interface TenantBoundDataAccessOptions {
  /** See {@link PinnedTenantBinding}. Omit to use ambient tenant identity. */
  pinned?: PinnedTenantBinding;
}

/**
 * Build the tenant-bound data access facade for an orchestration service.
 *
 * Hold this instead of the `TenantScopeAwareDatabase`. Where a service still
 * needs the raw handle — an explicit system scope for cross-tenant discovery,
 * or dialect inspection that must work outside any scope — keep that as a
 * separate, named, commented field so it reads as the exception it is.
 */
export function createTenantBoundDataAccess(
  db: TenantScopeAwareDatabase,
  options: TenantBoundDataAccessOptions = {}
): TenantBoundDataAccess {
  const pinned = options.pinned;
  if (pinned !== undefined) {
    if (!pinned.pinnedTenantId) {
      throw new Error('A pinned tenant-bound data access requires a tenant id');
    }
    if (!pinned.because?.trim()) {
      throw new Error(
        'A pinned tenant-bound data access requires `because`: say why this tenant is stronger evidence than ambient identity. Pinning is not authorization.'
      );
    }
  }

  const tenantId = () => pinned?.pinnedTenantId ?? getCurrentTenantId();

  return {
    repository: (repository) =>
      bindRepositoryToTenantUnitOfWork(db, repository, pinned?.pinnedTenantId),
    read: (read) => runWithTenantDatabaseScope(db, tenantId(), (scoped) => read(scoped)),
    write: (write) =>
      runWithTenantDatabaseScope(db, tenantId(), async (scoped) => {
        const activeTenantId = tenantId();
        if (activeTenantId) await assertTenantWritable(scoped, activeTenantId);
        return write(scoped);
      }),
  };
}
