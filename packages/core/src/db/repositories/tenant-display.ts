import { and, eq } from 'drizzle-orm';
import type { StoredTenantDisplay, TenantDisplay } from '../../types/tenant';
import type { TenantScopedDatabase } from '../client';
import { lockRowForUpdate } from '../database-wrapper';
import { appVariables } from '../schema';
import { getCurrentTenantDatabaseScope, getCurrentTenantId } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';

// Reserved server-owned metadata. Never expose this through preference APIs.
export const TENANT_DISPLAY_NAMESPACE = 'tenant.display';
export const TENANT_DISPLAY_LABEL_KEY = 'label';
export const TENANT_DISPLAY_LABEL_MAX_LENGTH = 80;

/** Trimmed display label, or a throw that never reflects the rejected value. */
export function validateTenantDisplayLabel(label: unknown): string {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (
    !trimmed ||
    trimmed.length > TENANT_DISPLAY_LABEL_MAX_LENGTH ||
    [...trimmed].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f)
  ) {
    throw new Error('Invalid tenant display label');
  }
  return trimmed;
}

export function validateTenantDisplay(label: unknown, issuedAt: unknown): TenantDisplay {
  const valid = validateTenantDisplayLabel(label);
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error('Invalid tenant display metadata');
  }
  return { label: valid, assertion_issued_at: issuedAt };
}

/**
 * Per-tenant display label observed from verified launches.
 *
 * Follows `TenantPublicRoutingRepository` except for malformed stored data:
 * the label is cosmetic, so a corrupt row reads as absent (callers fall back
 * to deployment config) and the next verified observation replaces it instead
 * of blocking login.
 */
export class TenantDisplayRepository {
  constructor(private db: TenantScopedDatabase) {}

  async find(): Promise<TenantDisplay | null> {
    const variable = await new AppVariableRepository(this.db).find(
      TENANT_DISPLAY_NAMESPACE,
      TENANT_DISPLAY_LABEL_KEY
    );
    if (!variable || variable.is_encrypted || typeof variable.value_text !== 'string') return null;
    try {
      const parsed = JSON.parse(variable.value_text) as StoredTenantDisplay;
      // Archive imports can rewrite the row's tenant_id, not the original
      // assertion binding. Another tenant must reinitialize through launch.
      if (parsed?.tenant_id !== getCurrentTenantId()) return null;
      return validateTenantDisplay(parsed.label, parsed.assertion_issued_at);
    } catch {
      return null;
    }
  }

  /**
   * Called only after verified launch, inside the same tenant transaction and
   * authorization fence as user projection. Older assertions cannot undo a
   * newer observation; equal-iat conflicts retain the first observation.
   */
  async observeVerifiedLaunch(display: TenantDisplay): Promise<void> {
    const next = validateTenantDisplay(display.label, display.assertion_issued_at);
    const scope = getCurrentTenantDatabaseScope();
    if (
      scope?.kind !== 'tenant' ||
      !scope.transactionActive ||
      !scope.tenantId ||
      scope.tenantId !== getCurrentTenantId() ||
      scope.db !== this.db
    ) {
      throw new Error('Tenant display updates require the active tenant transaction');
    }
    const variables = new AppVariableRepository(this.db);
    const data = {
      namespace: TENANT_DISPLAY_NAMESPACE,
      key: TENANT_DISPLAY_LABEL_KEY,
      value: JSON.stringify({
        ...next,
        tenant_id: scope.tenantId,
      } satisfies StoredTenantDisplay),
      content_type: 'application/json',
    };
    await variables.setIfAbsent(data);
    await lockRowForUpdate(
      this.db,
      this.db,
      appVariables,
      and(
        eq(appVariables.namespace, TENANT_DISPLAY_NAMESPACE),
        eq(appVariables.key, TENANT_DISPLAY_LABEL_KEY)
      )!
    );
    const current = await this.find();
    if (current && current.assertion_issued_at >= next.assertion_issued_at) return;
    await variables.set(data);
  }
}
