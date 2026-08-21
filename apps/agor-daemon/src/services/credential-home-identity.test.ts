import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ UsersRepository: vi.fn() }));
vi.mock('@agor/core/db', () => dbMocks);

import type { UserID } from '@agor/core/types';
import {
  resolveExecutionCredentialHome,
  sameExecutionCredentialHome,
} from './credential-home-identity.js';

const ALICE = 'user-alice' as UserID;
const BOB = 'user-bob' as UserID;
let rows: Record<string, { unix_username?: string | null; filesystem_home?: string | null }>;

beforeEach(() => {
  rows = {
    [ALICE]: { unix_username: 'alice', filesystem_home: null },
    [BOB]: { unix_username: 'bob', filesystem_home: null },
  };
  dbMocks.UsersRepository.mockImplementation(function UsersRepositoryStub() {
    return { findById: async (id: string) => rows[id] ?? null };
  });
});

const withTenantDatabase = <T>(work: (db: unknown) => Promise<T>) => work({});
const homeFor = (userId: UserID, config: unknown) =>
  resolveExecutionCredentialHome({
    userId,
    tenantId: 'tenant-1',
    config: config as never,
    withTenantDatabase: withTenantDatabase as never,
  });

describe('native credential home identity', () => {
  it('separates sandbox homes by exact user and keeps one user stable', async () => {
    const config = {
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user' },
      },
    };
    const alice = await homeFor(ALICE, config);
    const bob = await homeFor(BOB, config);
    expect(alice.homeStore).toContain(ALICE);
    expect(bob.homeStore).toContain(BOB);
    expect(sameExecutionCredentialHome(alice, bob)).toBe(false);
    expect(sameExecutionCredentialHome(alice, await homeFor(ALICE, config))).toBe(true);
  });

  it('honors a validated filesystem-home override', async () => {
    rows[ALICE] = { filesystem_home: '/srv/homes/shared' };
    rows[BOB] = { filesystem_home: '/srv/homes/shared' };
    const config = {
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user' },
      },
    };
    expect(
      sameExecutionCredentialHome(await homeFor(ALICE, config), await homeFor(BOB, config))
    ).toBe(true);
  });

  it('models simple shared and delegated keyed homes', async () => {
    expect(
      sameExecutionCredentialHome(
        await homeFor(ALICE, { execution: { unix_user_mode: 'simple' } }),
        await homeFor(BOB, { execution: { unix_user_mode: 'simple' } })
      )
    ).toBe(true);
    expect(
      sameExecutionCredentialHome(
        await homeFor(ALICE, { execution: { unix_user_mode: 'delegated' } }),
        await homeFor(BOB, { execution: { unix_user_mode: 'delegated' } })
      )
    ).toBe(false);
  });
});
