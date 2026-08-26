import { resolveUserEnvironment } from '@agor/core/config';
import {
  createDatabaseAsync,
  encryptApiKey,
  eq,
  MCPServerRepository,
  mcpServers,
  runMigrations,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  setMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
  update,
  users,
} from '@agor/core/db';
import { Conflict, Forbidden } from '@agor/core/feathers';
import type { MCPServer, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindMCPDiscoveryOAuthGrant,
  bindMCPDiscoveryResolvedConfiguration,
  captureMCPDiscoveryAuthority,
  fingerprintMCPDiscoveryConfiguration,
  persistDiscoveredMCPCapabilities,
} from './mcp-discovered-capabilities.js';
import { resolveProbeServerTemplates } from './mcp-probe-templates.js';

let db: TenantScopeAwareDatabase;
let ownerId: UserID;
let server: MCPServer;
const masterSecret = 'mcp-discovery-test-master-secret';

async function seed(): Promise<void> {
  process.env.AGOR_MASTER_SECRET = masterSecret;
  db = (await createDatabaseAsync({
    dialect: 'sqlite',
    url: ':memory:',
  })) as TenantScopeAwareDatabase;
  await runMigrations(db);
  const owner = await new UsersRepository(db).create({
    email: 'discovery-owner@example.test',
    name: 'Discovery owner',
    role: 'member',
  });
  ownerId = owner.user_id as UserID;
  server = await new MCPServerRepository(db).create({
    name: 'held-provider',
    transport: 'http',
    url: 'https://a.example.test/mcp',
    headers: { 'X-Tenant': 'one' },
    auth: { type: 'bearer', token: 'server-secret' },
    scope: 'session',
    source: 'user',
    owner_user_id: ownerId,
    tool_permissions: { remembered: 'ask' },
  });
}

async function captureSnapshot(currentServer: MCPServer = server) {
  return runWithTenantDatabaseScope(db, undefined, async (scopedDb) => {
    const snapshot = await captureMCPDiscoveryAuthority(
      scopedDb,
      undefined,
      ownerId,
      currentServer
    );
    const environment = await resolveUserEnvironment(ownerId, scopedDb);
    const resolution = resolveProbeServerTemplates(
      {
        url: currentServer.url ?? '',
        transport: currentServer.transport,
        auth: currentServer.auth,
        headers: currentServer.headers,
        name: currentServer.name,
        mcpServerId: currentServer.mcp_server_id,
      },
      environment
    );
    if (!resolution.ok) throw new Error(resolution.error);
    return bindMCPDiscoveryResolvedConfiguration(snapshot, resolution.resolved, masterSecret);
  });
}

async function persistSnapshot(snapshot: Awaited<ReturnType<typeof captureSnapshot>>) {
  return runWithTenantDatabaseTransaction(db, undefined, (scopedDb) =>
    persistDiscoveredMCPCapabilities(scopedDb, undefined, snapshot, capabilities, masterSecret)
  );
}

const capabilities = {
  tools: [{ name: 'search', description: 'Search' }],
  resources: [{ uri: 'file:///a', name: 'a' }],
  prompts: [{ name: 'greet', description: 'Greet' }],
};

describe('discovery authority/configuration CAS (SQLite)', () => {
  beforeEach(seed);

  it('persists only capability paths after an unchanged held network phase', async () => {
    const snapshot = await captureSnapshot();
    await persistSnapshot(snapshot);

    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        url: 'https://a.example.test/mcp',
        auth: { type: 'bearer', token: 'server-secret' },
        headers: { 'X-Tenant': 'one' },
        tools: capabilities.tools,
        resources: capabilities.resources,
        prompts: capabilities.prompts,
        capabilities_discovered_at: expect.any(Date),
        tool_permissions: { remembered: 'ask' },
      }
    );
  });

  it('accepts protocol-legal capabilities with optional descriptions and schemas', async () => {
    const snapshot = await captureSnapshot();
    const legal = {
      tools: [{ name: 'no-description' }],
      resources: [
        { uri: 'file:///a', name: 'a' },
        { uri: 'file:///b', name: 'b', description: 'optional' },
      ],
      prompts: [{ name: 'prompt', arguments: [{ name: 'subject' }] }],
    };
    await runWithTenantDatabaseTransaction(db, undefined, (scopedDb) =>
      persistDiscoveredMCPCapabilities(scopedDb, undefined, snapshot, legal, masterSecret)
    );

    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      legal
    );
    await expect(
      new MCPServerRepository(db).update(server.mcp_server_id, { display_name: 'Still editable' })
    ).resolves.toMatchObject({
      display_name: 'Still editable',
      ...legal,
      capabilities_discovered_at: expect.any(Date),
    });
  });

  it('persists and returns one deterministic tool per provider-reported name', async () => {
    const snapshot = await captureSnapshot();
    const duplicateTools = {
      tools: [
        { name: 'search', description: 'First provider description' },
        { name: 'lookup', description: 'Lookup' },
        { name: 'search', description: 'Conflicting later description' },
      ],
      resources: [],
      prompts: [],
    };
    const canonical = await runWithTenantDatabaseTransaction(db, undefined, (scopedDb) =>
      persistDiscoveredMCPCapabilities(scopedDb, undefined, snapshot, duplicateTools, masterSecret)
    );

    expect(canonical.tools).toEqual([
      { name: 'search', description: 'First provider description' },
      { name: 'lookup', description: 'Lookup' },
    ]);
    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      { tools: canonical.tools }
    );
  });

  it('fails closed on oversized or malicious provider discovery before persistence', async () => {
    for (const malicious of [
      {
        tools: Array.from({ length: 257 }, (_, index) => ({ name: `tool-${index}` })),
        resources: [],
        prompts: [],
      },
      {
        tools: [{ name: 'escape', provider_secret: 'must-not-persist' }],
        resources: [],
        prompts: [],
      },
      {
        tools: [{ name: 'shape', input_schema: { value: () => 'not-json' } }],
        resources: [],
        prompts: [],
      },
    ]) {
      const snapshot = await captureSnapshot();
      await expect(
        runWithTenantDatabaseTransaction(db, undefined, (scopedDb) =>
          persistDiscoveredMCPCapabilities(
            scopedDb,
            undefined,
            snapshot,
            malicious as never,
            masterSecret
          )
        )
      ).rejects.toThrow(/at most 256|Unknown tools\[0\] field|must be an object/);
      expect(
        (await new MCPServerRepository(db).findById(server.mcp_server_id))?.tools
      ).toBeUndefined();
    }
  });

  it('rejects endpoint A to B while provider I/O is held and writes no stale capabilities', async () => {
    const snapshot = await captureSnapshot();
    let releaseNetwork!: () => void;
    const network = new Promise<void>((resolve) => (releaseNetwork = resolve));
    const heldDiscovery = (async () => {
      await network;
      await persistSnapshot(snapshot);
    })();

    await new MCPServerRepository(db).update(server.mcp_server_id, {
      url: 'https://b.example.test/mcp',
    });
    releaseNetwork();

    await expect(heldDiscovery).rejects.toBeInstanceOf(Conflict);
    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        url: 'https://b.example.test/mcp',
        tools: undefined,
      }
    );
  });

  it('rejects HTTP to stdio before persistence', async () => {
    const snapshot = await captureSnapshot();
    await new MCPServerRepository(db).update(server.mcp_server_id, {
      transport: 'stdio',
      command: 'unsafe-new-command',
    });

    await expect(persistSnapshot(snapshot)).rejects.toBeInstanceOf(Forbidden);
    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        transport: 'stdio',
        tools: undefined,
      }
    );
  });

  it('rejects role demotion and policy changes made during discovery', async () => {
    await setMcpMemberPolicy(db, 'allow_private_only', undefined);
    const roleSnapshot = await captureSnapshot();
    await new UsersRepository(db).update(ownerId, { role: 'viewer' });
    await expect(persistSnapshot(roleSnapshot)).rejects.toBeInstanceOf(Forbidden);

    await new UsersRepository(db).update(ownerId, { role: 'member' });
    const policySnapshot = await captureSnapshot();
    await setMcpMemberPolicy(db, 'use_existing_only', undefined);
    await expect(persistSnapshot(policySnapshot)).rejects.toBeInstanceOf(Conflict);
  });

  it('rejects an ownership change made while discovery is in flight', async () => {
    const snapshot = await captureSnapshot();
    const replacement = await new UsersRepository(db).create({
      email: 'replacement-owner@example.test',
      name: 'Replacement owner',
      role: 'member',
    });
    await update(db, mcpServers)
      .set({ owner_user_id: replacement.user_id })
      .where(eq(mcpServers.mcp_server_id, server.mcp_server_id))
      .run();

    await expect(persistSnapshot(snapshot)).rejects.toBeInstanceOf(Forbidden);
  });

  it('binds ownership and every secret-bearing configuration field into an internal-only stamp', () => {
    expect(
      fingerprintMCPDiscoveryConfiguration({
        ...server,
        owner_user_id: 'another-owner' as UserID,
      })
    ).not.toBe(fingerprintMCPDiscoveryConfiguration(server));
    expect(
      fingerprintMCPDiscoveryConfiguration({
        ...server,
        auth: { type: 'bearer', token: 'rotated-secret' },
      })
    ).not.toBe(fingerprintMCPDiscoveryConfiguration(server));
  });

  it('rejects unscoped and non-transactional use even if a caller casts around the type', async () => {
    await expect(
      captureMCPDiscoveryAuthority(
        db as unknown as TenantScopedDatabase,
        undefined,
        ownerId,
        server
      )
    ).rejects.toThrow('explicit tenant database scope');

    const snapshot = await captureSnapshot();
    await expect(
      runWithTenantDatabaseScope(db, undefined, (scopedDb) =>
        persistDiscoveredMCPCapabilities(scopedDb, undefined, snapshot, capabilities, masterSecret)
      )
    ).rejects.toThrow('tenant-scoped transaction');
  });

  it('rejects same-millisecond user environment rotation with an HMAC fence', async () => {
    server = (await new MCPServerRepository(db).update(server.mcp_server_id, {
      url: '{{ user.env.MCP_DISCOVERY_URL }}',
    })) as MCPServer;
    const stableUpdatedAt = new Date('2026-08-21T00:00:00.000Z');
    const storedEnv = (value: string) => ({
      MCP_DISCOVERY_URL: { value_encrypted: encryptApiKey(value), scope: 'global' },
    });
    await update(db, users)
      .set({
        data: { env_vars: storedEnv('https://a.example.test/mcp') },
        updated_at: stableUpdatedAt,
      })
      .where(eq(users.user_id, ownerId))
      .run();

    const snapshot = await captureSnapshot(server);
    expect(JSON.stringify(snapshot)).not.toContain('https://a.example.test/mcp');
    await update(db, users)
      .set({
        data: { env_vars: storedEnv('https://b.example.test/mcp') },
        updated_at: stableUpdatedAt,
      })
      .where(eq(users.user_id, ownerId))
      .run();

    await expect(persistSnapshot(snapshot)).rejects.toBeInstanceOf(Conflict);
    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        tools: undefined,
      }
    );
  });

  it('rejects OAuth account replacement, generation, binding, and refresh rotation', async () => {
    server = (await new MCPServerRepository(db).update(server.mcp_server_id, {
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    })) as MCPServer;
    const saveGrant = (generation: number, suffix: string) =>
      runWithTenantDatabaseScope(db, undefined, (scopedDb) =>
        new UserMCPOAuthTokenRepository(scopedDb, masterSecret).saveToken(
          ownerId,
          server.mcp_server_id,
          {
            accessToken: `access-${suffix}`,
            refreshToken: `refresh-${suffix}`,
            clientId: `client-${suffix}`,
            clientSecret: `client-secret-${suffix}`,
            grantBinding: {
              generation,
              version: 4,
              fingerprint: `binding-${suffix}`,
              metadataUri: `https://${suffix}.example.test/oauth/resource`,
              resourceUri: `https://${suffix}.example.test/mcp`,
              issuer: `https://${suffix}.example.test`,
              authorizationEndpoint: `https://${suffix}.example.test/oauth/authorize`,
              tokenEndpoint: `https://${suffix}.example.test/oauth/token`,
              redirectUri: 'https://agor.example.test/oauth/callback',
            },
          }
        )
      );
    await saveGrant(1, 'account-a');
    let snapshot = await captureSnapshot(server);
    snapshot = await runWithTenantDatabaseScope(db, undefined, async (scopedDb) => {
      const grant = await new UserMCPOAuthTokenRepository(scopedDb, masterSecret).getToken(
        ownerId,
        server.mcp_server_id
      );
      if (!grant) throw new Error('expected OAuth grant');
      return bindMCPDiscoveryOAuthGrant(snapshot, ownerId, grant, masterSecret);
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /access-account-a|refresh-account-a|client-secret/
    );

    await saveGrant(2, 'account-b');
    await expect(persistSnapshot(snapshot)).rejects.toBeInstanceOf(Conflict);
    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        tools: undefined,
      }
    );
  });

  it('rejects deletion of the exact OAuth grant used for the provider probe', async () => {
    server = (await new MCPServerRepository(db).update(server.mcp_server_id, {
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    })) as MCPServer;
    await runWithTenantDatabaseScope(db, undefined, (scopedDb) =>
      new UserMCPOAuthTokenRepository(scopedDb, masterSecret).saveToken(
        ownerId,
        server.mcp_server_id,
        { accessToken: 'access-before-delete', refreshToken: 'refresh-before-delete' }
      )
    );
    let snapshot = await captureSnapshot(server);
    snapshot = await runWithTenantDatabaseScope(db, undefined, async (scopedDb) => {
      const grant = await new UserMCPOAuthTokenRepository(scopedDb, masterSecret).getToken(
        ownerId,
        server.mcp_server_id
      );
      if (!grant) throw new Error('expected OAuth grant');
      return bindMCPDiscoveryOAuthGrant(snapshot, ownerId, grant, masterSecret);
    });
    await runWithTenantDatabaseScope(db, undefined, (scopedDb) =>
      new UserMCPOAuthTokenRepository(scopedDb, masterSecret).deleteToken(
        ownerId,
        server.mcp_server_id
      )
    );

    await expect(persistSnapshot(snapshot)).rejects.toBeInstanceOf(Conflict);
  });
});
