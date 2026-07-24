import { describe, expect } from 'vitest';
import { dbTest } from '../test-helpers';
import {
  TenantCorsRevisionConflictError,
  TenantCorsSettingsRepository,
} from './tenant-cors-settings';

describe('TenantCorsSettingsRepository', () => {
  dbTest('returns an empty revision-zero policy before first save', async ({ db }) => {
    const repository = new TenantCorsSettingsRepository(db);
    await expect(repository.get()).resolves.toEqual({ revision: 0, origins: [] });
  });

  dbTest('replaces the exact origin set and records an audit diff', async ({ db }) => {
    const repository = new TenantCorsSettingsRepository(db);
    const first = await repository.replace(
      ['https://app.example.com', 'https://reports.example.com'],
      0,
      null
    );
    expect(first).toMatchObject({
      revision: 1,
      origins: ['https://app.example.com', 'https://reports.example.com'],
    });

    const second = await repository.replace(['https://reports.example.com'], 1, null);
    expect(second).toMatchObject({
      revision: 2,
      origins: ['https://reports.example.com'],
    });
    await expect(repository.listAuditEvents()).resolves.toMatchObject([
      {
        revision: 2,
        added_origins: [],
        removed_origins: ['https://app.example.com'],
      },
      {
        revision: 1,
        added_origins: ['https://app.example.com', 'https://reports.example.com'],
        removed_origins: [],
      },
    ]);
  });

  dbTest('rejects a stale full-replacement mutation', async ({ db }) => {
    const repository = new TenantCorsSettingsRepository(db);
    await repository.replace(['https://app.example.com'], 0, null);
    await expect(repository.replace(['https://other.example.com'], 0, null)).rejects.toBeInstanceOf(
      TenantCorsRevisionConflictError
    );
  });

  dbTest('does not create a new revision for an identical set', async ({ db }) => {
    const repository = new TenantCorsSettingsRepository(db);
    await repository.replace(['https://app.example.com'], 0, null);
    const result = await repository.replace(['https://app.example.com'], 1, null);
    expect(result.revision).toBe(1);
    await expect(repository.listAuditEvents()).resolves.toHaveLength(1);
  });
});
