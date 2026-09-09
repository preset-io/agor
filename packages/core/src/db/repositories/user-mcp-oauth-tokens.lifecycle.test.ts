import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types';
import { deleteFrom, insert } from '../database-wrapper';
import { userMcpOauthTokens, users } from '../schema';
import { dbTest, ensureTestUser } from '../test-helpers';
import { MCPServerRepository } from './mcp-servers';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';
import { UsersRepository } from './users';

async function seed(db: Parameters<typeof ensureTestUser>[0]) {
  const owner = await ensureTestUser(db, generateId() as UserID);
  const a = await ensureTestUser(db, generateId() as UserID);
  const b = await ensureTestUser(db, generateId() as UserID);
  const server = await new MCPServerRepository(db).create({
    name: 'shared-grant-lifecycle',
    transport: 'http',
    url: 'https://provider.example.test/mcp',
    scope: 'global',
    enabled: true,
    source: 'user',
    owner_user_id: owner,
    auth: { type: 'oauth', oauth_mode: 'shared' },
  });
  return {
    a,
    b,
    owner,
    serverId: server.mcp_server_id,
    grants: new UserMCPOAuthTokenRepository(db),
  };
}

dbTest(
  'hard deletion retires the consenter, not server-owner or other-user grants',
  async ({ db }) => {
    const { a, b, owner, serverId, grants } = await seed(db);
    await grants.saveToken(a, serverId, { accessToken: 'personal-a' });
    await grants.saveToken(b, serverId, { accessToken: 'personal-b' });
    await grants.saveToken(null, serverId, { accessToken: 'shared-a' }, a);
    await new UsersRepository(db).delete(owner);
    await expect(grants.getToken(null, serverId)).resolves.toMatchObject({ granted_by_user_id: a });
    await new UsersRepository(db).delete(a);
    await expect(grants.getToken(a, serverId)).resolves.toBeNull();
    await expect(grants.getToken(null, serverId)).resolves.toBeNull();
    await expect(grants.hasValidToken(null, serverId)).resolves.toBe(false);
    await expect(
      grants.listAuthorityForUserAndSharedByServerIds(b, [serverId])
    ).resolves.toHaveLength(1);
    await expect(grants.getToken(b, serverId)).resolves.toMatchObject({
      oauth_access_token: 'personal-b',
    });
  }
);

dbTest(
  'refresh preserves attribution and cannot recreate a directly cascaded grant',
  async ({ db }) => {
    const { a, serverId, grants } = await seed(db);
    await grants.saveToken(
      null,
      serverId,
      { accessToken: 'shared-a', refreshToken: 'refresh-a' },
      a
    );
    const version = { grantGeneration: 0 };
    await expect(
      grants.completeStandaloneRefresh(null, serverId, version, {
        accessToken: 'rotated',
        expiresAt: null,
      })
    ).resolves.toBe(true);
    await expect(grants.getToken(null, serverId)).resolves.toMatchObject({
      granted_by_user_id: a,
      oauth_access_token: 'rotated',
      oauth_refresh_token: 'refresh-a',
    });
    await deleteFrom(db, users).where(eq(users.user_id, a)).run();
    await expect(
      grants.completeStandaloneRefresh(null, serverId, version, {
        accessToken: 'late-refresh',
        expiresAt: null,
      })
    ).resolves.toBe(false);
    await expect(
      grants.saveToken(null, serverId, { accessToken: 'late-callback' }, a)
    ).rejects.toThrow();
    await expect(grants.getToken(null, serverId)).resolves.toBeNull();
  }
);

dbTest(
  'new consent replaces attribution with the token and survives deletion of A',
  async ({ db }) => {
    const { a, b, serverId, grants } = await seed(db);
    const binding = {
      generation: 1,
      version: 4 as const,
      fingerprint: 'a'.repeat(64),
      metadataUri: 'https://provider.example.test/metadata',
      resourceUri: 'https://provider.example.test/mcp',
      issuer: 'https://provider.example.test',
      authorizationEndpoint: 'https://provider.example.test/authorize',
      tokenEndpoint: 'https://provider.example.test/token',
      redirectUri: 'https://agor.example.test/callback',
    };
    await grants.saveToken(
      null,
      serverId,
      { accessToken: 'a', clientId: 'client-a', grantBinding: binding },
      a
    );
    await grants.saveToken(
      null,
      serverId,
      {
        accessToken: 'b',
        clientId: 'client-b',
        grantBinding: { ...binding, generation: 2 },
      },
      b
    );
    await expect(
      grants.saveToken(
        null,
        serverId,
        {
          accessToken: 'stale-a',
          clientId: 'client-a',
          grantBinding: binding,
        },
        a
      )
    ).rejects.toThrow(/superseded/);
    await deleteFrom(db, users).where(eq(users.user_id, a)).run();
    await expect(
      grants.completeStandaloneRefresh(
        null,
        serverId,
        {
          grantGeneration: 1,
          grantBindingFingerprint: binding.fingerprint,
        },
        { accessToken: 'late-a', expiresAt: null }
      )
    ).resolves.toBe(false);
    await expect(grants.getToken(null, serverId)).resolves.toMatchObject({
      granted_by_user_id: b,
      oauth_access_token: 'b',
      oauth_client_id: 'client-b',
      grant_generation: 2,
    });
  }
);

dbTest(
  'repository and direct SQLite writes reject missing/foreign/mismatched consenters',
  async ({ db }) => {
    const { a, b, serverId, grants } = await seed(db);
    const foreignUser = generateId() as UserID; // Not a principal in this single-tenant database.
    await expect(grants.saveToken(null, serverId, { accessToken: 'missing' })).rejects.toThrow(
      /consenting user/
    );
    await expect(
      grants.saveToken(null, serverId, { accessToken: 'foreign' }, foreignUser)
    ).rejects.toThrow();
    await expect(grants.saveToken(a, serverId, { accessToken: 'mismatch' }, b)).rejects.toThrow(
      /consenting user/
    );
    for (const consenter of [null, foreignUser, b]) {
      await expect(
        insert(db, userMcpOauthTokens)
          .values({
            user_id: consenter === b ? a : null,
            granted_by_user_id: consenter as unknown as UserID,
            mcp_server_id: serverId,
            oauth_access_token: 'forged',
            created_at: new Date(),
          })
          .run()
      ).rejects.toThrow();
    }
    await expect(grants.listShared()).resolves.toEqual([]);
  }
);
