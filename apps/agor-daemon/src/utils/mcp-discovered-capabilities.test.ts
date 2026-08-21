import {
  createDatabaseAsync,
  eq,
  MCPServerRepository,
  mcpServers,
  runMigrations,
  setMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  UsersRepository,
  update,
} from '@agor/core/db';
import { Conflict, Forbidden } from '@agor/core/feathers';
import type { MCPServer, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureMCPDiscoveryAuthority,
  fingerprintMCPDiscoveryConfiguration,
  persistDiscoveredMCPCapabilities,
} from './mcp-discovered-capabilities.js';

let db: TenantScopeAwareDatabase;
let ownerId: UserID;
let server: MCPServer;

async function seed(): Promise<void> {
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

const capabilities = {
  tools: [{ name: 'search', description: 'Search' }],
  resources: [{ uri: 'file:///a', name: 'a' }],
  prompts: [{ name: 'greet', description: 'Greet' }],
};

describe('discovery authority/configuration CAS (SQLite)', () => {
  beforeEach(seed);

  it('persists only capability paths after an unchanged held network phase', async () => {
    const snapshot = await captureMCPDiscoveryAuthority(db, undefined, ownerId, server);
    await persistDiscoveredMCPCapabilities(db, undefined, snapshot, capabilities);

    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        url: 'https://a.example.test/mcp',
        auth: { type: 'bearer', token: 'server-secret' },
        headers: { 'X-Tenant': 'one' },
        tools: capabilities.tools,
        resources: capabilities.resources,
        prompts: capabilities.prompts,
        tool_permissions: { remembered: 'ask' },
      }
    );
  });

  it('rejects endpoint A to B while provider I/O is held and writes no stale capabilities', async () => {
    const snapshot = await captureMCPDiscoveryAuthority(db, undefined, ownerId, server);
    let releaseNetwork!: () => void;
    const network = new Promise<void>((resolve) => (releaseNetwork = resolve));
    const heldDiscovery = (async () => {
      await network;
      await persistDiscoveredMCPCapabilities(db, undefined, snapshot, capabilities);
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
    const snapshot = await captureMCPDiscoveryAuthority(db, undefined, ownerId, server);
    await new MCPServerRepository(db).update(server.mcp_server_id, {
      transport: 'stdio',
      command: 'unsafe-new-command',
    });

    await expect(
      persistDiscoveredMCPCapabilities(db, undefined, snapshot, capabilities)
    ).rejects.toBeInstanceOf(Forbidden);
    await expect(new MCPServerRepository(db).findById(server.mcp_server_id)).resolves.toMatchObject(
      {
        transport: 'stdio',
        tools: undefined,
      }
    );
  });

  it('rejects role demotion and policy changes made during discovery', async () => {
    await setMcpMemberPolicy(db, 'allow_private_only', undefined);
    const roleSnapshot = await captureMCPDiscoveryAuthority(db, undefined, ownerId, server);
    await new UsersRepository(db).update(ownerId, { role: 'viewer' });
    await expect(
      persistDiscoveredMCPCapabilities(db, undefined, roleSnapshot, capabilities)
    ).rejects.toBeInstanceOf(Forbidden);

    await new UsersRepository(db).update(ownerId, { role: 'member' });
    const policySnapshot = await captureMCPDiscoveryAuthority(db, undefined, ownerId, server);
    await setMcpMemberPolicy(db, 'use_existing_only', undefined);
    await expect(
      persistDiscoveredMCPCapabilities(db, undefined, policySnapshot, capabilities)
    ).rejects.toBeInstanceOf(Conflict);
  });

  it('rejects an ownership change made while discovery is in flight', async () => {
    const snapshot = await captureMCPDiscoveryAuthority(db, undefined, ownerId, server);
    const replacement = await new UsersRepository(db).create({
      email: 'replacement-owner@example.test',
      name: 'Replacement owner',
      role: 'member',
    });
    await update(db, mcpServers)
      .set({ owner_user_id: replacement.user_id })
      .where(eq(mcpServers.mcp_server_id, server.mcp_server_id))
      .run();

    await expect(
      persistDiscoveredMCPCapabilities(db, undefined, snapshot, capabilities)
    ).rejects.toBeInstanceOf(Forbidden);
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
});
