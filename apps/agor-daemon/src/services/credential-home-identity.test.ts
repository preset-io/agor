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

describe('resolveExecutionCredentialHome', () => {
  it('gives every user the daemon home in simple mode, so no two users diverge', async () => {
    const config = { execution: { unix_user_mode: 'simple' } };

    const alice = await homeFor(ALICE, config);
    const bob = await homeFor(BOB, config);

    expect(alice).toEqual({ delegatedHomeKey: null, homeStore: null });
    expect(sameExecutionCredentialHome(alice, bob)).toBe(true);
    // A shared home needs no user row at all.
    expect(dbMocks.UsersRepository).not.toHaveBeenCalled();
  });

  it('separates per-owner sandbox stores by user', async () => {
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
    // Same user resolves to the same store on every call.
    expect(sameExecutionCredentialHome(alice, await homeFor(ALICE, config))).toBe(true);
  });

  it('keeps the shared daemon home when the sandbox uses a shared home', async () => {
    const config = {
      execution: {
        unix_user_mode: 'simple',
        sandbox: { enabled: true, home_mode: 'shared' },
      },
    };

    expect(
      sameExecutionCredentialHome(await homeFor(ALICE, config), await homeFor(BOB, config))
    ).toBe(true);
  });

  it('separates delegated home keys by the user execution-home key', async () => {
    const config = { execution: { unix_user_mode: 'delegated' } };

    const alice = await homeFor(ALICE, config);
    const bob = await homeFor(BOB, config);

    expect(alice).toEqual({ delegatedHomeKey: 'alice', homeStore: null });
    expect(sameExecutionCredentialHome(alice, bob)).toBe(false);
  });

  it('treats two users sharing one delegated home key as the same home', async () => {
    rows[BOB] = { unix_username: 'alice', filesystem_home: null };
    const config = { execution: { unix_user_mode: 'delegated' } };

    expect(
      sameExecutionCredentialHome(await homeFor(ALICE, config), await homeFor(BOB, config))
    ).toBe(true);
  });

  it('honors an admin filesystem_home override when comparing sandbox stores', async () => {
    rows[BOB] = { unix_username: 'bob', filesystem_home: '/srv/homes/alice-and-bob' };
    rows[ALICE] = { unix_username: 'alice', filesystem_home: '/srv/homes/alice-and-bob' };
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
});
