import {
  MCPMarketplaceRepository,
  MCPServerRepository,
  setMcpMemberPolicy,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticatedParams, MCPMemberPolicy, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { mayCallerManageSharedMcpServers } from '../utils/mcp-server-authorization';
import { MCPMarketplaceService } from './mcp-marketplace';
import { resolveMCPMarketplaceOAuthGrantAuthority } from './mcp-oauth-grant-authority';

const ADMIN = '00000000-0000-7000-8000-00000000ad31' as UserID;
const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-000000000b0b' as UserID;
const VIEWER = '00000000-0000-7000-8000-00000000f1e3' as UserID;

type Db = Parameters<Parameters<typeof dbTest>[1]>[0]['db'];

function params(userId: UserID, role: string): AuthenticatedParams {
  return { provider: 'rest', user: { user_id: userId, role } } as AuthenticatedParams;
}

/** The service as `register-services.ts` wires it. */
function service(db: Db): MCPMarketplaceService {
  return new MCPMarketplaceService(
    new MCPMarketplaceRepository(db, (userId, serverIds, options) =>
      resolveMCPMarketplaceOAuthGrantAuthority({
        db,
        userId,
        serverIds,
        serverRepository: new MCPServerRepository(db),
        tokenRepository: new UserMCPOAuthTokenRepository(db),
        includeShared: options?.includeShared,
      })
    ),
    (callerParams) => mayCallerManageSharedMcpServers(db, callerParams)
  );
}

async function seed(db: Db) {
  const users = new UsersRepository(db);
  for (const [user_id, role] of [
    [ADMIN, 'admin'],
    [ALICE, 'member'],
    [BOB, 'member'],
    [VIEWER, 'viewer'],
  ] as const) {
    await users.create({ user_id, email: `${user_id.slice(-4)}@example.test`, role });
  }
  const servers = new MCPServerRepository(db);
  const bobPrivate = await servers.create({
    name: 'bob-private',
    transport: 'http',
    url: 'https://bob.example.test/mcp',
    auth: { type: 'bearer', token: 'bob-token-secret' },
    scope: 'session',
    source: 'user',
    owner_user_id: BOB,
  });
  const sharedBearer = await servers.create({
    name: 'shared-bearer',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    auth: { type: 'bearer', token: 'shared-token-secret' },
    scope: 'session',
    source: 'user',
  });
  const sharedOAuth = await servers.create({
    name: 'shared-oauth',
    transport: 'http',
    url: 'https://oauth.example.com/mcp',
    auth: { type: 'oauth', oauth_mode: 'shared' },
    scope: 'session',
    source: 'user',
  });
  await new UserMCPOAuthTokenRepository(db).saveToken(
    null,
    sharedOAuth.mcp_server_id,
    { accessToken: 'shared-access-secret', refreshToken: 'shared-refresh-secret' },
    ADMIN
  );
  return { bobPrivate, sharedBearer, sharedOAuth };
}

const names = (overview: { servers: { name: string }[] }) =>
  overview.servers.map((server) => server.name).sort();

describe('MCPMarketplaceService Shared servers', () => {
  dbTest('admins see Shared servers, tagged, with shared OAuth authority', async ({ db }) => {
    const { sharedOAuth } = await seed(db);

    const overview = await service(db).find(params(ADMIN, 'admin'));

    // Another user's private row stays out, admins included.
    expect(names(overview)).toEqual(['shared-bearer', 'shared-oauth']);
    expect(overview.servers.every((server) => server.shared === true)).toBe(true);
    expect(
      overview.credentials.find((item) => item.mcp_server_id === sharedOAuth.mcp_server_id)
    ).toMatchObject({ method: 'oauth', detail_status: 'active' });
    expect(JSON.stringify(overview)).not.toMatch(
      /shared-token-secret|shared-access-secret|shared-refresh-secret|bob-token-secret|example\.com/
    );
  });

  for (const [policy, visible] of [
    ['use_existing_only', false],
    ['allow_private_only', false],
    ['allow_crud', true],
  ] as const satisfies readonly (readonly [MCPMemberPolicy, boolean])[]) {
    dbTest(
      `members see Shared servers only when ${policy} lets them manage one`,
      async ({ db }) => {
        await seed(db);
        await setMcpMemberPolicy(db, policy, undefined);

        const overview = await service(db).find(params(ALICE, 'member'));

        expect(names(overview)).toEqual(visible ? ['shared-bearer', 'shared-oauth'] : []);
        expect(overview.credentials.length).toBe(visible ? 2 : 0);
        expect(JSON.stringify(overview)).not.toMatch(/bob-private|secret/);
      }
    );
  }

  dbTest('viewers never see Shared servers, even under allow_crud', async ({ db }) => {
    await seed(db);
    await setMcpMemberPolicy(db, 'allow_crud', undefined);

    await expect(service(db).find(params(VIEWER, 'viewer'))).resolves.toMatchObject({
      servers: [],
      credentials: [],
      attachments: [],
    });
    await expect(
      mayCallerManageSharedMcpServers(db, {
        provider: 'rest',
        user: { user_id: ALICE, role: 'member', _isServiceAccount: true },
      } as unknown as AuthenticatedParams)
    ).resolves.toBe(false);
  });
});
