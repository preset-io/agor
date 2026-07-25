import type { ResolvedCors, ResolvedMultiTenancyConfig } from '@agor/core/config';
import {
  enqueueAfterTenantDatabaseCommit,
  getCurrentTenantId,
  TenantCorsRevisionConflictError,
  TenantCorsSettingsRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict, Forbidden, NotFound } from '@agor/core/feathers';
import {
  normalizeTenantCorsOrigins,
  type Params,
  TENANT_CORS_SETTINGS_ID,
  TenantCorsOriginValidationError,
  type TenantCorsSettings,
  type TenantCorsSettingsPatch,
  type UserID,
} from '@agor/core/types';
import type { TenantCorsPolicyStore } from '../setup/tenant-cors.js';

export interface TenantCorsSettingsServiceOptions {
  resolvedCors: ResolvedCors;
  multiTenancy: ResolvedMultiTenancyConfig;
  policyStore: TenantCorsPolicyStore;
}

export class TenantCorsSettingsService {
  private readonly repository: TenantCorsSettingsRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly options: TenantCorsSettingsServiceOptions
  ) {
    this.repository = new TenantCorsSettingsRepository(db);
  }

  private routingReady(): boolean {
    return (
      this.options.multiTenancy.mode === 'static' ||
      Boolean(this.options.multiTenancy.trusted_header)
    );
  }

  private async publicSettings(): Promise<TenantCorsSettings> {
    const stored = await this.repository.get();
    return {
      id: TENANT_CORS_SETTINGS_ID,
      enabled: this.options.resolvedCors.tenantOriginsEnabled,
      routing_ready: this.routingReady(),
      revision: stored.revision,
      origins: stored.origins,
      credentials: this.options.resolvedCors.credentials,
      ...(stored.updated_by ? { updated_by: stored.updated_by } : {}),
      ...(stored.updated_at ? { updated_at: stored.updated_at } : {}),
    };
  }

  async get(id: string, _params?: Params): Promise<TenantCorsSettings> {
    if (id !== TENANT_CORS_SETTINGS_ID) throw new NotFound('Tenant CORS settings not found');
    return this.publicSettings();
  }

  async patch(
    id: string,
    data: TenantCorsSettingsPatch,
    params?: Params
  ): Promise<TenantCorsSettings> {
    if (id !== TENANT_CORS_SETTINGS_ID) throw new NotFound('Tenant CORS settings not found');
    if (!this.options.resolvedCors.tenantOriginsEnabled) {
      throw new Forbidden('Tenant-managed CORS origins are disabled by the operator');
    }
    if (!this.routingReady()) {
      throw new Conflict('Tenant routing is not available for browser preflight requests');
    }
    if (!Number.isSafeInteger(data?.expected_revision) || data.expected_revision < 0) {
      throw new BadRequest('expected_revision must be a non-negative integer');
    }

    let origins: string[];
    try {
      origins = normalizeTenantCorsOrigins(data.origins);
    } catch (error) {
      if (error instanceof TenantCorsOriginValidationError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }

    try {
      await this.repository.replace(
        origins,
        data.expected_revision,
        (params as { user?: { user_id?: UserID } } | undefined)?.user?.user_id ?? null
      );
    } catch (error) {
      if (error instanceof TenantCorsRevisionConflictError) {
        throw new Conflict(error.message, {
          expected_revision: error.expectedRevision,
          actual_revision: error.actualRevision,
        });
      }
      throw error;
    }

    const tenantId =
      (params as { tenant?: { tenant_id?: string } } | undefined)?.tenant?.tenant_id ??
      getCurrentTenantId();
    if (tenantId) {
      const invalidate = () => this.options.policyStore.invalidate(tenantId);
      if (!enqueueAfterTenantDatabaseCommit(invalidate)) invalidate();
    }
    return this.publicSettings();
  }
}

export function createTenantCorsSettingsService(
  db: TenantScopeAwareDatabase,
  options: TenantCorsSettingsServiceOptions
) {
  return new TenantCorsSettingsService(db, options);
}
