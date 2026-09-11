import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types';
import { dbTest, ensureTestUser } from '../test-helpers';
import { MCPServerRepository } from './mcp-servers';
import { UserMCPOAuthTokenRepository } from './user-mcp-oauth-tokens';

dbTest(
  'SQLite full grant reads preserve plaintext, nullable fields and subject isolation',
  async ({ db }) => {
    const owner = await ensureTestUser(db, generateId() as UserID);
    const other = await ensureTestUser(db, generateId() as UserID);
    const server = await new MCPServerRepository(db).create({
      name: 'synthetic',
      transport: 'http',
      url: 'https://example.test/mcp',
      scope: 'global',
      enabled: true,
      source: 'user',
      owner_user_id: owner,
    });
    const repo = new UserMCPOAuthTokenRepository(db);
    await repo.saveToken(owner, server.mcp_server_id, {
      accessToken: 'personal',
      refreshToken: 'refresh',
      clientId: 'client',
      clientSecret: 'secret',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    await repo.saveToken(
      null,
      server.mcp_server_id,
      { accessToken: 'shared', expiresAt: null },
      owner
    );
    const [personal, shared] = await Promise.all([repo.listForUser(owner), repo.listShared()]);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({
      user_id: owner,
      oauth_access_token: 'personal',
      oauth_refresh_token: 'refresh',
      oauth_client_id: 'client',
      oauth_client_secret: 'secret',
    });
    expect(personal[0].oauth_token_expires_at?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      user_id: null,
      oauth_access_token: 'shared',
      oauth_refresh_token: undefined,
      oauth_token_expires_at: undefined,
    });
    await expect(repo.getToken(owner, server.mcp_server_id)).resolves.toEqual(personal[0]);
    await expect(repo.listForUser(other)).resolves.toEqual([]);
    await expect(repo.getToken(other, server.mcp_server_id)).resolves.toBeNull();
    await expect(repo.getCatalogGrantAuthority(owner, server.mcp_server_id)).resolves.toMatchObject(
      { oauth_client_id: 'client', oauth_client_secret: 'secret' }
    );
    const authority = await repo.listAuthorityForUserAndSharedByServerIds(owner, [
      server.mcp_server_id,
    ]);
    expect(authority).toHaveLength(2);
    expect(authority.find((record) => record.user_id === owner)).toMatchObject({
      oauth_client_id: 'client',
      oauth_client_secret: 'secret',
    });
    expect(authority.find((record) => record.user_id === null)?.oauth_client_id).toBeUndefined();
    expect(
      await repo.listAuthorityForUserAndSharedByServerIds(other, [server.mcp_server_id])
    ).toHaveLength(1);
    await expect(repo.listStatusForSubject(other)).resolves.toEqual([]);
    const status = await repo.listStatusForSubject(owner);
    expect(status).toHaveLength(1);
    expect(status[0]).not.toHaveProperty('oauth_access_token');
    expect(status[0]).not.toHaveProperty('oauth_refresh_token');
    expect(await repo.listStatusForSubject(null)).toHaveLength(1);
    await repo.deleteToken(owner, server.mcp_server_id);
    await expect(repo.listForUser(owner)).resolves.toEqual([]);
    await expect(repo.getCatalogGrantAuthority(owner, server.mcp_server_id)).resolves.toBeNull();
    await expect(repo.getToken(null, server.mcp_server_id)).resolves.toEqual(shared[0]);
  }
);
