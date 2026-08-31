import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ UsersRepository: vi.fn() }));
vi.mock('@agor/core/db', () => dbMocks);

import type { UserID } from '@agor/core/types';
import { resolveSimpleCodexHome } from '../utils/codex-credential-namespace.js';
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
const homeFor = (
  userId: UserID,
  config: unknown,
  agenticTool?: 'codex' | 'claude-code',
  tenantId = 'tenant-1'
) =>
  resolveExecutionCredentialHome({
    userId,
    tenantId,
    config: config as never,
    withTenantDatabase: withTenantDatabase as never,
    agenticTool,
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

  it('separates built-in simple Codex state by tenant and user only for Codex', async () => {
    const localSimple = { execution: { unix_user_mode: 'simple' } };
    const alice = await homeFor(ALICE, localSimple, 'codex');
    const bob = await homeFor(BOB, localSimple, 'codex');
    const otherTenantAlice = await homeFor(ALICE, localSimple, 'codex', 'tenant-2');

    expect(alice.codexHome).toBe(
      resolveSimpleCodexHome({
        tenantId: 'tenant-1',
        subjectUserId: ALICE,
        homeDir: homedir(),
      })
    );
    expect(sameExecutionCredentialHome(alice, bob)).toBe(false);
    expect(sameExecutionCredentialHome(alice, otherTenantAlice)).toBe(false);
    expect(
      sameExecutionCredentialHome(
        await homeFor(ALICE, localSimple, 'claude-code'),
        await homeFor(BOB, localSimple, 'claude-code')
      )
    ).toBe(true);
  });

  it('leaves templated simple Codex home selection to the external substrate', async () => {
    const templatedSimple = {
      execution: {
        unix_user_mode: 'simple',
        executor_command_template: 'launcher -- agor-executor --stdin',
      },
    };
    const alice = await homeFor(ALICE, templatedSimple, 'codex');
    const bob = await homeFor(BOB, templatedSimple, 'codex');
    expect(alice.codexHome).toBeUndefined();
    expect(sameExecutionCredentialHome(alice, bob)).toBe(true);
  });

  it('returns one typed failure when delegated home identity is missing', async () => {
    rows[ALICE] = { unix_username: null };
    await expect(
      homeFor(ALICE, { execution: { unix_user_mode: 'delegated' } })
    ).rejects.toMatchObject({
      reason: 'missing-username',
    });
  });
});
