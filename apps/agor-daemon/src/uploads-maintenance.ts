import { type AgorConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  assertValidTenantId,
  isPostgresDatabase,
  type RawDatabase,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  UploadMaintenanceDiscoveryRepository,
  UploadRepository,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import {
  configureUploadStagingStoreFromConfig,
  getUploadStagingStore,
} from './utils/upload-staging.js';

export interface UploadCleanupOptions {
  db: RawDatabase;
  config: AgorConfig;
  tenantId?: string;
  allTenants?: boolean;
  limit?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface UploadCleanupResult {
  dryRun: boolean;
  tenantsExamined: number;
  expired: number;
  deleted: number;
  failed: number;
  hasMore: boolean;
}

async function resolveMaintenanceTenants(options: UploadCleanupOptions): Promise<TenantID[]> {
  if (options.tenantId && options.allTenants) {
    throw new Error('Choose either tenantId or allTenants, not both');
  }
  const multitenancy = resolveMultiTenancyConfig(options.config);
  if (options.tenantId) {
    assertValidTenantId(options.tenantId);
    if (multitenancy.mode === 'static' && options.tenantId !== multitenancy.static_tenant_id) {
      throw new Error(
        `Static deployment tenant is ${multitenancy.static_tenant_id}; refusing ${options.tenantId}`
      );
    }
    return [options.tenantId as TenantID];
  }

  if (multitenancy.mode === 'static') return [multitenancy.static_tenant_id];
  if (!options.allTenants) {
    throw new Error('Multi-tenant upload cleanup requires --tenant-id or --all-tenants');
  }
  if (!isPostgresDatabase(options.db)) {
    throw new Error('Cross-tenant upload cleanup requires PostgreSQL');
  }

  return runWithSystemDatabaseScope(
    options.db,
    'upload maintenance tenant discovery',
    (systemDb) =>
      new UploadMaintenanceDiscoveryRepository(systemDb).findExpiredTenantIds(
        options.now ?? new Date(),
        options.limit ?? 500
      ),
    { capability: 'upload_maintenance' }
  );
}

/**
 * Delete a bounded set of expired uploads using exact metadata-derived keys.
 * This never lists object storage and is intended for deployment-local jobs.
 */
export async function cleanupExpiredUploads(
  options: UploadCleanupOptions
): Promise<UploadCleanupResult> {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error('Upload cleanup limit must be an integer between 1 and 10000');
  }
  const now = options.now ?? new Date();
  const tenants = await resolveMaintenanceTenants({ ...options, limit, now });
  const repository = new UploadRepository(options.db);
  const dryRun = options.dryRun === true;
  if (!dryRun) configureUploadStagingStoreFromConfig(options.config, undefined, options.db);
  const store = dryRun ? undefined : getUploadStagingStore();

  let expired = 0;
  let deleted = 0;
  let failed = 0;
  let remaining = limit;
  let tenantsExamined = 0;
  for (const tenantId of tenants) {
    if (remaining === 0) break;
    tenantsExamined++;
    const rows = await runWithTenantDatabaseScope(options.db, tenantId, () =>
      repository.findExpired(tenantId, now, remaining)
    );
    expired += rows.length;
    remaining -= rows.length;
    if (dryRun) continue;

    for (const upload of rows) {
      try {
        await store?.delete({
          tenantId,
          sessionId: upload.sessionId,
          branchId: upload.branchId,
          ref: upload.ref,
        });
        deleted++;
      } catch {
        failed++;
      }
    }
  }

  return {
    dryRun,
    tenantsExamined,
    expired,
    deleted,
    failed,
    hasMore: expired === limit,
  };
}
