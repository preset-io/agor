import { expect } from 'vitest';
import type { Database } from '../client';
import { insert } from '../database-wrapper';
import { users } from '../schema';
import { dbTest } from '../test-helpers';
import { RefreshTokenFamiliesRepository } from './refresh-token-families';

async function seedUser(db: Database, userId: string) {
  await insert(db, users)
    .values({
      user_id: userId,
      email: `${userId}@example.test`,
      password: 'hash',
      role: 'member',
      created_at: new Date(),
      updated_at: new Date(),
      data: {},
    })
    .run();
}

dbTest('refresh rotation is one-use and concurrent reuse revokes the family', async ({ db }) => {
  await seedUser(db, 'user-a');
  const repo = new RefreshTokenFamiliesRepository(db);
  await repo.create({
    familyId: 'family-a',
    tenantId: 'default',
    userId: 'user-a',
    tokenId: 'token-1',
    expiresAt: new Date(Date.now() + 60_000),
  });

  const results = await Promise.all([
    repo.rotate({
      familyId: 'family-a',
      tenantId: 'default',
      userId: 'user-a',
      tokenId: 'token-1',
      nextTokenId: 'token-2',
    }),
    repo.rotate({
      familyId: 'family-a',
      tenantId: 'default',
      userId: 'user-a',
      tokenId: 'token-1',
      nextTokenId: 'token-3',
    }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await expect(
    repo.rotate({
      familyId: 'family-a',
      tenantId: 'default',
      userId: 'user-a',
      tokenId: 'token-2',
      nextTokenId: 'token-4',
    })
  ).resolves.toBe(false);
});

dbTest('cross-user rotation and revocation cannot affect a family', async ({ db }) => {
  await seedUser(db, 'user-a');
  const repo = new RefreshTokenFamiliesRepository(db);
  await repo.create({
    familyId: 'family-a',
    tenantId: 'tenant-a',
    userId: 'user-a',
    tokenId: 'token-1',
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expect(
    repo.rotate({
      familyId: 'family-a',
      tenantId: 'tenant-a',
      userId: 'user-b',
      tokenId: 'token-1',
      nextTokenId: 'bad',
    })
  ).resolves.toBe(false);
  await repo.revokeFamily('family-a', 'tenant-a', 'user-b');
  await expect(
    repo.rotate({
      familyId: 'family-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      tokenId: 'token-1',
      nextTokenId: 'token-2',
    })
  ).resolves.toBe(true);
});
