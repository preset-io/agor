/** Characterize the envelope-integrity boundary before optimizing status reads. */
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
                key === 'has_access_token' ? row.oauth_access_token != null : row[key],
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
  it('opens four envelopes on a full read versus two on catalog authority', async () => {
    query.rows = [grant()];
    const open = vi.spyOn(envelope, 'openBoundSecret');
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

    open.mockClear();
    query.projections = [];
    const authority = await repo.getCatalogGrantAuthority(userId, serverId);
    expect(query.projections).toHaveLength(1);
    expect(query.projections[0]).not.toHaveProperty('oauth_access_token');
    expect(query.projections[0]).not.toHaveProperty('oauth_refresh_token');
    expect(open.mock.calls.map((call) => call[2])).toEqual(['client-id', 'client-secret']);
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
});
