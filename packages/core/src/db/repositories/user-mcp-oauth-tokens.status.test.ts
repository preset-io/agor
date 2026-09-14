/** Characterize the envelope-integrity boundary before optimizing status reads. */

import { setImmediate as nextTurn } from 'node:timers/promises';
import type { MCPServerID, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../client';
import * as envelope from '../oauth-secret-envelope';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';

const query = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  projections: [] as Array<Record<string, unknown> | undefined>,
  tenantId: 'tenant-a',
}));

// Exercise the real repository mapping and authenticated encryption, without
// a PG connection. This is not SQL/RLS coverage; the adapter supplies selected
// rows just as the database wrapper does.
vi.mock('../database-wrapper', () => ({
  select: (_db: unknown, projection?: Record<string, unknown>) => {
    query.projections.push(projection);
    const selected = () =>
      query.rows.map((row) =>
        projection
          ? Object.fromEntries(
              Object.keys(projection).map((key) => [
                key,
                key === 'has_access_token'
                  ? row.oauth_access_token != null && row.oauth_access_token !== ''
                  : row[key],
              ])
            )
          : row
      );
    return {
      from: () => ({
        where: () => ({
          all: async () => selected(),
          one: async () => selected()[0],
        }),
      }),
    };
  },
}));
vi.mock('../tenant-scope', () => ({ isPostgresDatabaseHandle: () => true }));
vi.mock('../tenant-context', () => ({ getCurrentTenantId: () => query.tenantId }));

const userId = '00000000-0000-7000-8000-00000000a11c' as UserID;
const serverId = '00000000-0000-7000-8000-00000000b0b0' as MCPServerID;
const master = 'status-characterization-test-master';

function grant(subject: UserID | null = userId): Record<string, unknown> {
  const seal = (value: string, purpose: envelope.BoundSecretPurpose, field: string) =>
    envelope.sealBoundSecret(
      value,
      master,
      purpose,
      ['tenant-a', subject ?? '<shared>', serverId, '1', field].join('\0')
    );
  return {
    user_id: subject,
    mcp_server_id: serverId,
    grant_generation: 1,
    oauth_access_token: seal('access', 'access-token', 'access'),
    oauth_refresh_token: seal('refresh', 'refresh-token', 'refresh'),
    oauth_client_id: seal('client', 'client-id', 'client-id'),
    oauth_client_secret: seal('secret', 'client-secret', 'client-secret'),
    oauth_token_expires_at: new Date('2030-01-01T00:00:00Z'),
    refresh_status: 'idle',
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  query.rows = [];
  query.projections = [];
  query.tenantId = 'tenant-a';
});

describe('OAuth status grant read integrity and cost', () => {
  it('status opens only client binding material, never access or refresh tokens', async () => {
    query.rows = [
      {
        ...grant(),
        oauth_access_token: 'corrupt-unread-access',
        oauth_refresh_token: 'corrupt-unread-refresh',
      },
    ];
    const open = vi.spyOn(envelope, 'openBoundSecretAsync');
    const repo = new UserMCPOAuthTokenRepository({} as Database, master);
    const records = await repo.listStatusForSubject(userId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ oauth_client_id: 'client', oauth_client_secret: 'secret' });
    expect(records[0]).not.toHaveProperty('oauth_access_token');
    expect(records[0]).not.toHaveProperty('oauth_refresh_token');
    expect(Object.keys(query.projections[0]!)).not.toContain('oauth_access_token');
    expect(Object.keys(query.projections[0]!)).not.toContain('oauth_refresh_token');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('status filters expired and ambiguous grants before opening client material', async () => {
    query.rows = [
      { ...grant(), oauth_token_expires_at: new Date('2000-01-01'), oauth_client_secret: 'unread' },
      { ...grant(), refresh_status: 'ambiguous', oauth_client_secret: 'unread' },
    ];
    const open = vi.spyOn(envelope, 'openBoundSecretAsync');
    await expect(
      new UserMCPOAuthTokenRepository({} as Database, master).listStatusForSubject(userId)
    ).resolves.toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([null, ''])(
    'status excludes access token %s before opening client material',
    async (accessToken) => {
      query.rows = [{ ...grant(), oauth_access_token: accessToken, oauth_client_secret: 'unread' }];
      const open = vi.spyOn(envelope, 'openBoundSecretAsync');
      await expect(
        new UserMCPOAuthTokenRepository({} as Database, master).listStatusForSubject(userId)
      ).resolves.toEqual([]);
      expect(open).not.toHaveBeenCalled();
    }
  );

  it('status still rejects client material transplanted across tenants', async () => {
    query.rows = [grant()];
    query.tenantId = 'tenant-b';
    await expect(
      new UserMCPOAuthTokenRepository({} as Database, master).listStatusForSubject(userId)
    ).rejects.toThrow();
  });

  it('awaits fields and rows serially, preserves order, and never caches a read', async () => {
    query.rows = [grant(), { ...grant(), created_at: new Date('2026-02-01T00:00:00Z') }];
    let active = 0;
    let peak = 0;
    const open = vi.spyOn(envelope, 'openBoundSecretAsync').mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      await nextTurn();
      try {
        return envelope.openBoundSecret(...args);
      } finally {
        active--;
      }
    });
    const repo = new UserMCPOAuthTokenRepository({} as Database, master);
    const tokens = await repo.listForUser(userId);
    expect(peak).toBe(1);
    expect(open).toHaveBeenCalledTimes(8);
    expect(query.projections).toEqual([undefined]);
    expect(tokens.map((token) => token.created_at.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ]);
    query.rows = [];
    await expect(repo.listForUser(userId)).resolves.toEqual([]);
    expect(query.projections).toEqual([undefined, undefined]);
  });

  it.each(['user_id', 'mcp_server_id', 'grant_generation'])(
    'rejects a grant transplanted to a different %s and wraps async errors on point reads',
    async (field) => {
      query.rows = [{ ...grant(), [field]: field === 'grant_generation' ? 2 : 'other' }];
      const repo = new UserMCPOAuthTokenRepository({} as Database, master);
      await expect(repo.getToken(userId, serverId)).rejects.toThrow('Failed to get OAuth token');
      await expect(repo.listForUser(userId)).rejects.toThrow(
        'Failed to list OAuth tokens for user'
      );
    }
  );

  it.skipIf(process.env.AGOR_BENCH_OAUTH_READ !== '1')(
    'benchmarks grant hydration and unrelated event-loop progress (synthetic, no DB timing)',
    async () => {
      query.rows = Array.from({ length: 6 }, () => grant());
      const repo = new UserMCPOAuthTokenRepository({} as Database, master);
      const nativeOpen = envelope.openBoundSecretAsync;
      const samples: Record<string, Array<{ elapsedMs: number; maxTickGapMs: number }>> = {
        sync: [],
        async: [],
      };
      for (let round = 0; round < 4; round++) {
        for (const mode of round % 2 ? ['async', 'sync'] : ['sync', 'async']) {
          const spy = vi
            .spyOn(envelope, 'openBoundSecretAsync')
            .mockImplementation(
              mode === 'sync' ? async (...args) => envelope.openBoundSecret(...args) : nativeOpen
            );
          let last = performance.now();
          let maxTickGapMs = 0;
          const tick = () => {
            const now = performance.now();
            maxTickGapMs = Math.max(maxTickGapMs, now - last);
            last = now;
          };
          const timer = setInterval(tick, 5);
          const start = performance.now();
          try {
            const tokens = await repo.listForUser(userId);
            const elapsedMs = performance.now() - start;
            await nextTurn();
            tick();
            expect(tokens).toHaveLength(6);
            expect(tokens.every((token) => token.oauth_refresh_token === 'refresh')).toBe(true);
            if (round) samples[mode].push({ elapsedMs, maxTickGapMs });
          } finally {
            clearInterval(timer);
            spy.mockRestore();
          }
        }
      }
      process.stdout.write(
        `OAuth read benchmark: 6 grants x 4 envelopes, 1 warmup, 3 samples\n${JSON.stringify(samples)}\n`
      );
    },
    30000
  );

  it('opens four envelopes on a full read versus two on catalog authority', async () => {
    query.rows = [grant()];
    const open = vi.spyOn(envelope, 'openBoundSecretAsync');
    const syncOpen = vi.spyOn(envelope, 'openBoundSecret');
    const repo = new UserMCPOAuthTokenRepository({} as Database, master);
    await expect(repo.listForUser(userId)).resolves.toMatchObject([
      { oauth_access_token: 'access', oauth_refresh_token: 'refresh' },
    ]);
    expect(query.projections).toEqual([undefined]);
    expect(open.mock.calls.map((call) => call[2])).toEqual([
      'access-token',
      'refresh-token',
      'client-id',
      'client-secret',
    ]);

    expect(syncOpen).not.toHaveBeenCalled();
    query.projections = [];
    open.mockClear();
    const authority = await repo.getCatalogGrantAuthority(userId, serverId);
    expect(query.projections).toHaveLength(1);
    expect(query.projections[0]).not.toHaveProperty('oauth_access_token');
    expect(query.projections[0]).not.toHaveProperty('oauth_refresh_token');
    expect(open.mock.calls.map((call) => call[2])).toEqual(['client-id', 'client-secret']);
    expect(syncOpen).not.toHaveBeenCalled();
    expect(authority).toMatchObject({
      oauth_access_token: '<present>',
      oauth_client_id: 'client',
      oauth_client_secret: 'secret',
    });
    expect(authority).not.toHaveProperty('oauth_refresh_token');
  });

  it.each(['oauth_access_token', 'oauth_refresh_token'] as const)(
    'full status lists reject corrupt %s even on expired/ambiguous grants',
    async (field) => {
      const repo = new UserMCPOAuthTokenRepository({} as Database, master);
      for (const subject of [userId, null]) {
        query.rows = [
          {
            ...grant(subject),
            [field]: 'corrupt-envelope',
            oauth_token_expires_at: new Date('2000-01-01T00:00:00Z'),
            refresh_status: 'ambiguous',
          },
        ];
        await expect(
          subject === null ? repo.listShared() : repo.listForUser(subject)
        ).rejects.toThrow('Unsupported bound secret envelope');
      }
      // The existing catalog projection deliberately has a different contract.
      // Reusing that contract for status would remove its fail-closed behavior.
      query.rows = [{ ...grant(), [field]: 'corrupt-envelope' }];
      await expect(repo.getCatalogGrantAuthority(userId, serverId)).resolves.toMatchObject({
        has_access_token: true,
      });
    }
  );

  it.each([
    ['oauth_access_token', 'access-token', 'access'],
    ['oauth_refresh_token', 'refresh-token', 'refresh'],
  ] as const)(
    'full lists detect a valid but foreign-tenant %s envelope',
    async (column, purpose, field) => {
      query.rows = [
        {
          ...grant(),
          [column]: envelope.sealBoundSecret(
            'foreign-token',
            master,
            purpose,
            ['tenant-b', userId, serverId, '1', field].join('\0')
          ),
        },
      ];
      const repo = new UserMCPOAuthTokenRepository({} as Database, master);
      await expect(repo.listForUser(userId)).rejects.toThrow(
        'Failed to list OAuth tokens for user'
      );
      // Format/presence checks are insufficient: only opening the envelope
      // authenticates the token's tenant/subject/server/generation binding.
      await expect(repo.getCatalogGrantAuthority(userId, serverId)).resolves.toMatchObject({
        has_access_token: true,
      });
    }
  );

  it('rejects same-purpose ciphertext transplanted from another tenant', async () => {
    query.rows = [grant()];
    query.tenantId = 'tenant-b';
    const repo = new UserMCPOAuthTokenRepository({} as Database, master);
    await expect(repo.listForUser(userId)).rejects.toThrow('Failed to list OAuth tokens for user');
    await expect(repo.getCatalogGrantAuthority(userId, serverId)).rejects.toThrow(
      'Failed to read OAuth grant authority'
    );
  });
  it('authority inventories open client fields serially and never hydrate access/refresh tokens', async () => {
    query.rows = [grant(), grant(null)];
    const native = envelope.openBoundSecretAsync;
    let active = 0;
    let peak = 0;
    const open = vi.spyOn(envelope, 'openBoundSecretAsync').mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      try {
        return await native(...args);
      } finally {
        active--;
      }
    });
    const repo = new UserMCPOAuthTokenRepository({} as Database, master);
    const records = await repo.listAuthorityForUserAndSharedByServerIds(userId, [serverId]);
    expect(records.map((record) => record.user_id)).toEqual([userId, null]);
    expect(records.every((record) => record.oauth_client_secret === 'secret')).toBe(true);
    expect(open.mock.calls.map((call) => call[2])).toEqual([
      'client-id',
      'client-secret',
      'client-id',
      'client-secret',
    ]);
    expect(peak).toBe(1);
    expect(query.projections).toHaveLength(1);
    expect(query.projections[0]).not.toHaveProperty('oauth_access_token');
    expect(query.projections[0]).not.toHaveProperty('oauth_refresh_token');
  });

  it.each([
    'oauth_client_id',
    'oauth_client_secret',
    'grant_generation',
    'user_id',
    'mcp_server_id',
  ])('authority reads retain asynchronous corruption/binding failure for %s', async (field) => {
    const repo = new UserMCPOAuthTokenRepository({} as Database, master);
    query.rows = [{ ...grant(), [field]: field === 'grant_generation' ? 2 : 'foreign-or-corrupt' }];
    await expect(repo.listAuthorityForUserAndSharedByServerIds(userId, [serverId])).rejects.toThrow(
      'Failed to list OAuth grants for authority projection'
    );
    // Point reads bind to the requested subject/server, not caller-supplied row IDs.
    if (field !== 'user_id' && field !== 'mcp_server_id') {
      await expect(repo.getCatalogGrantAuthority(userId, serverId)).rejects.toThrow(
        'Failed to read OAuth grant authority'
      );
    }
  });
});
