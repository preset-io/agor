import { resolveMultiTenancyConfig, resolveSecurity } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { Params } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import type { TenantCorsPolicyStore } from '../setup/tenant-cors';
import { createTenantCorsSettingsService } from './tenant-cors-settings';

function serviceFor(
  db: TenantScopeAwareDatabase,
  enabled: boolean
): {
  service: ReturnType<typeof createTenantCorsSettingsService>;
  invalidate: ReturnType<typeof vi.fn>;
} {
  const invalidate = vi.fn();
  return {
    service: createTenantCorsSettingsService(db, {
      resolvedCors: resolveSecurity({
        security: { cors: { tenant_origins: { enabled } } },
      }).cors,
      operatorOrigins: ['https://operator.example.com'],
      multiTenancy: resolveMultiTenancyConfig({}),
      policyStore: { invalidate } as unknown as TenantCorsPolicyStore,
    }),
    invalidate,
  };
}

describe('TenantCorsSettingsService', () => {
  dbTest('normalizes a full replacement and invalidates the live policy', async ({ db }) => {
    const { service, invalidate } = serviceFor(db, true);
    const params = {
      tenant: { tenant_id: 'default', source: 'static' },
    } as Params;

    const updated = await service.patch(
      'current',
      {
        expected_revision: 0,
        origins: ['https://BÜCHER.example:443/', 'https://app.example.com'],
      },
      params
    );

    expect(updated).toMatchObject({
      id: 'current',
      enabled: true,
      routing_ready: true,
      revision: 1,
      origins: ['https://app.example.com', 'https://xn--bcher-kva.example'],
      operator_origins: ['https://operator.example.com'],
    });
    expect(invalidate).toHaveBeenCalledWith('default');
  });

  dbTest('rejects mutations while the operator feature flag is disabled', async ({ db }) => {
    const { service, invalidate } = serviceFor(db, false);
    await expect(
      service.patch('current', { expected_revision: 0, origins: ['https://app.example.com'] })
    ).rejects.toThrow(/disabled by the operator/);
    expect(invalidate).not.toHaveBeenCalled();
  });

  dbTest('returns a conflict for a stale replacement', async ({ db }) => {
    const { service } = serviceFor(db, true);
    await service.patch('current', {
      expected_revision: 0,
      origins: ['https://app.example.com'],
    });
    await expect(
      service.patch('current', {
        expected_revision: 0,
        origins: ['https://other.example.com'],
      })
    ).rejects.toMatchObject({ code: 409 });
  });
});
