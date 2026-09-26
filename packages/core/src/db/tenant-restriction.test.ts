import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  applyTenantRestrictionIntent,
  readTenantRestrictionIntents,
  TenantRestrictionUnsupportedError,
} from './tenant-restriction';
import { createTenantScopedDatabaseProxy } from './tenant-scope';

describe('tenant restriction dialect contract', () => {
  it('refuses SQLite instead of claiming an unenforced tenant restriction', async () => {
    const db = createDatabase({ url: ':memory:' });
    await expect(
      readTenantRestrictionIntents(createTenantScopedDatabaseProxy(db), 'one')
    ).rejects.toBeInstanceOf(TenantRestrictionUnsupportedError);
    await expect(readTenantRestrictionIntents(db, 'one')).rejects.toBeInstanceOf(
      TenantRestrictionUnsupportedError
    );
    await expect(
      applyTenantRestrictionIntent(db, 'one', {
        version: 1,
        controllerId: 'control',
        placementId: 'placement',
        operationId: 'op',
        revision: 1,
        action: 'restrict',
      })
    ).rejects.toBeInstanceOf(TenantRestrictionUnsupportedError);
  });
});
