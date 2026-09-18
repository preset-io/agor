import { expect, it, vi } from 'vitest';
import { assertTenantLaunchRevision } from './tenant-launch-revision.js';

const { read, postgres } = vi.hoisted(() => ({ read: vi.fn(), postgres: vi.fn(() => true) }));
vi.mock('@agor/core/db', () => ({
  readTenantRestrictionIntents: read,
  isPostgresDatabaseHandle: postgres,
}));
const db = {} as never;
it('allows only legacy zero baseline without a retained watermark', async () => {
  read.mockResolvedValue([]);
  await expect(assertTenantLaunchRevision(db, 't', undefined)).resolves.toBeUndefined();
  await expect(
    assertTenantLaunchRevision(db, 't', { controllerId: 'cloud', revision: 0 }, 'cloud')
  ).resolves.toBeUndefined();
  for (const claim of [
    { controllerId: 'cloud', revision: 2 },
    { controllerId: 'other', revision: 0 },
    { controllerId: 'cloud', revision: -1 },
    { controllerId: 'cloud', revision: 0, extra: true },
  ]) {
    await expect(assertTenantLaunchRevision(db, 't', claim, 'cloud')).rejects.toMatchObject({
      code: 401,
    });
  }
});
it('requires exact configured owner and every owner active, with no positive missing-row fallback', async () => {
  read.mockResolvedValue([{ controllerId: 'cloud', revision: 2, phase: 'active' }]);
  await expect(
    assertTenantLaunchRevision(db, 't', { controllerId: 'cloud', revision: 2 }, 'cloud')
  ).resolves.toBeUndefined();
  for (const claim of [
    undefined,
    { controllerId: 'cloud', revision: 0 },
    { controllerId: 'cloud', revision: 1 },
    { controllerId: 'other', revision: 2 },
  ]) {
    await expect(assertTenantLaunchRevision(db, 't', claim, 'cloud')).rejects.toMatchObject({
      code: 401,
    });
  }
  await expect(
    assertTenantLaunchRevision(db, 't', { controllerId: 'cloud', revision: 2 })
  ).rejects.toMatchObject({ code: 401 });
  read.mockResolvedValue([{ controllerId: 'other', revision: 2, phase: 'active' }]);
  await expect(
    assertTenantLaunchRevision(db, 't', { controllerId: 'cloud', revision: 2 }, 'cloud')
  ).rejects.toMatchObject({ code: 401 });
  read.mockResolvedValue([
    { controllerId: 'cloud', revision: 2, phase: 'active' },
    { controllerId: 'other', revision: 1, phase: 'restricted' },
  ]);
  await expect(
    assertTenantLaunchRevision(db, 't', { controllerId: 'cloud', revision: 2 }, 'cloud')
  ).rejects.toMatchObject({ code: 401 });
});
