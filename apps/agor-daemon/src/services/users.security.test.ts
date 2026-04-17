/**
 * Defence-in-depth tests for UsersService env-var ingest.
 *
 * GITHUB_TOKEN / GH_TOKEN end up interpolated into a clone URL (and at one
 * point into a shell-form git credential helper). Any value that does not
 * match the `isLikelyGitToken` shape must be rejected at ingest so attacker-
 * shaped bytes cannot persist in the database.
 */

import type { UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

async function makeUser(service: UsersService): Promise<UserID> {
  const user = await service.create({
    email: `sec-${Math.random().toString(36).slice(2)}@test.local`,
    password: 'test-password-1234',
  });
  return user.user_id as UserID;
}

describe('UsersService — git token env var hardening', () => {
  dbTest('rejects GITHUB_TOKEN with shell metacharacters', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc;rm -rf /' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN with newline', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc\nmore' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN with command substitution', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'abc$(whoami)' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GITHUB_TOKEN that is too short', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: 'short' },
      })
    ).rejects.toThrow(/Invalid GITHUB_TOKEN/);
  });

  dbTest('rejects GH_TOKEN with the same shape check', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GH_TOKEN: 'abc;id' },
      })
    ).rejects.toThrow(/Invalid GH_TOKEN/);
  });

  dbTest('accepts a well-formed GitHub PAT', async ({ db }) => {
    const service = new UsersService(db);
    const id = await makeUser(service);
    await expect(
      service.patch(id, {
        env_vars: { GITHUB_TOKEN: `ghp_${'a'.repeat(36)}` },
      })
    ).resolves.toBeDefined();
  });
});
