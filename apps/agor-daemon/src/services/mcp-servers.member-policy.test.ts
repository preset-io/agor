/**
 * What `mcp_member_policy` lets a member land in `mcp_servers`, driven through
 * the endpoint.
 *
 * The rest of this seam is tested by calling `authorizeMcpServerWrite` directly,
 * which proves the decision and nothing about the row. A policy is only worth
 * what the database ends up holding, so this drives the real `mcp-servers`
 * service carrying the real write hook against a real database, as an
 * authenticated member reaches it, and reads back what landed.
 *
 * Ownership is covered where an install lands it (`mcp-catalog-connect.install`);
 * this file is the matrix for the other two fields a policy decides — the
 * transport a member may configure, and the reach their server is held to.
 */

import {
  createDatabaseAsync,
  MCPServerRepository,
  runMigrations,
  setMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  MCPMemberPolicy,
  MCPServer,
  User,
  UserRole,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { createMcpServerWriteAuthorizationHook } from '../utils/mcp-server-authorization.js';
import { createMCPServersService } from './mcp-servers.js';

const REMOTE_SERVER = {
  name: 'deepwiki',
  transport: 'http' as const,
  url: 'https://mcp.example.com/mcp',
  source: 'user' as const,
  enabled: true,
};

async function buildDaemon(policy: MCPMemberPolicy, role: UserRole = 'member') {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  await runMigrations(rawDb);
  await setMcpMemberPolicy(db, policy, undefined, null);

  const user = (await new UsersRepository(rawDb).create({
    email: 'bob@agor.live',
    name: 'Bob',
    role,
  })) as User;

  const app = feathers();
  app.use('mcp-servers', createMCPServersService(db));
  app.service('mcp-servers').hooks({
    before: {
      create: [createMcpServerWriteAuthorizationHook(db) as never],
      patch: [createMcpServerWriteAuthorizationHook(db) as never],
    },
  } as never);

  // The shape a REST request arrives with: an external provider and the
  // authenticated caller.
  const params = {
    provider: 'rest',
    authenticated: true,
    user: { user_id: user.user_id, role },
  } as unknown as AuthenticatedParams;

  return {
    user,
    create: (data: Record<string, unknown>) =>
      app
        .service('mcp-servers')
        .create({ ...REMOTE_SERVER, ...data }, params) as Promise<MCPServer>,
    patch: (id: string, data: Record<string, unknown>) =>
      app.service('mcp-servers').patch(id, data, params) as Promise<MCPServer>,
    storedServers: () => new MCPServerRepository(rawDb).findAll({}),
  };
}

describe('member policy, as it lands in mcp_servers', () => {
  it('refuses a member a workspace-wide server under allow_private_only, storing nothing', async () => {
    const { create, storedServers } = await buildDaemon('allow_private_only');

    await expect(create({ scope: 'global' })).rejects.toThrow(
      /only allows members to add private MCP servers/
    );
    await expect(storedServers()).resolves.toHaveLength(0);
  });

  it('stores a session-scoped server owned by the member who added it', async () => {
    const { user, create, storedServers } = await buildDaemon('allow_private_only');

    await create({ scope: 'session' });

    const [server] = await storedServers();
    expect(server).toMatchObject({ scope: 'session', owner_user_id: user.user_id });
  });

  it('derives the scope a member did not state rather than letting storage default it', async () => {
    const { create, storedServers } = await buildDaemon('allow_private_only');

    await create({});

    const [server] = await storedServers();
    expect(server?.scope).toBe('session');
  });

  it('refuses a member widening their own server to workspace-wide', async () => {
    const { create, patch, storedServers } = await buildDaemon('allow_private_only');

    const created = await create({ scope: 'session' });

    await expect(patch(created.mcp_server_id, { scope: 'global' })).rejects.toThrow(
      /only allows members to add private MCP servers/
    );
    const [server] = await storedServers();
    expect(server?.scope).toBe('session');
  });

  it('leaves an unrelated edit of a member’s own server alone', async () => {
    const { create, patch } = await buildDaemon('allow_private_only');

    const created = await create({ scope: 'session' });
    const patched = await patch(created.mcp_server_id, { display_name: 'DeepWiki' });

    expect(patched).toMatchObject({ scope: 'session', display_name: 'DeepWiki' });
  });

  it('leaves workspace-wide scope to allow_crud, which is the value that grants it', async () => {
    const { user, create, storedServers } = await buildDaemon('allow_crud');

    await create({ scope: 'global' });

    const [server] = await storedServers();
    // Unowned, because `allow_crud` reads "no owner requested" as opting into a
    // server the whole workspace may use. A shared server reads back with no
    // owner at all, which is what `isMCPServerUsableBy` treats as everyone's.
    expect(server?.scope).toBe('global');
    expect(server?.owner_user_id ?? null).toBeNull();
    expect(server?.owner_user_id).not.toBe(user.user_id);
  });

  it('leaves an admin every scope under every policy value', async () => {
    const { create, storedServers } = await buildDaemon('allow_private_only', 'admin');

    await create({ scope: 'global' });

    const [server] = await storedServers();
    expect(server?.scope).toBe('global');
  });

  it('refuses a member a stdio server, whatever the scope', async () => {
    const { create, storedServers } = await buildDaemon('allow_crud');

    await expect(
      create({ scope: 'session', transport: 'stdio', command: '/bin/sh', url: undefined })
    ).rejects.toThrow(/Only admins can configure stdio MCP servers/);
    await expect(storedServers()).resolves.toHaveLength(0);
  });

  it('refuses a member every write under the default use_existing_only', async () => {
    const { create, storedServers } = await buildDaemon('use_existing_only');

    await expect(create({ scope: 'session' })).rejects.toThrow(
      /does not allow members to configure MCP servers/
    );
    await expect(storedServers()).resolves.toHaveLength(0);
  });
});
