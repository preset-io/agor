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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      update: [createMcpServerWriteAuthorizationHook(db) as never],
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
    setPolicy: (next: MCPMemberPolicy) => setMcpMemberPolicy(db, next, undefined, null),
    create: (data: Record<string, unknown>) =>
      app
        .service('mcp-servers')
        .create({ ...REMOTE_SERVER, ...data }, params) as Promise<MCPServer>,
    patch: (id: string, data: Record<string, unknown>) =>
      app.service('mcp-servers').patch(id, data, params) as Promise<MCPServer>,
    update: (id: string, data: Record<string, unknown>) =>
      app.service('mcp-servers').update(id, data, params) as Promise<MCPServer>,
    storedServers: () => new MCPServerRepository(rawDb).findAll({}),
  };
}

describe('member policy, as it lands in mcp_servers', () => {
  it('holds a member’s server to the session it is attached to under allow_private_only', async () => {
    const { user, create, storedServers } = await buildDaemon('allow_private_only');

    await create({ scope: 'session' });

    const [server] = await storedServers();
    expect(server).toMatchObject({ scope: 'session', owner_user_id: user.user_id });
  });

  it('takes the scope rather than the payload’s, the way it takes the owner', async () => {
    // The CLI flag and the MCP tool both put `global` in the payload by
    // default, so a member never chose it and must not be refused for it.
    const { create, storedServers } = await buildDaemon('allow_private_only');

    const created = await create({ scope: 'global' });

    expect(created.scope).toBe('session');
    const [server] = await storedServers();
    expect(server?.scope).toBe('session');
  });

  it('supplies the scope a member stated nowhere', async () => {
    const { create, storedServers } = await buildDaemon('allow_private_only');

    await create({});

    const [server] = await storedServers();
    expect(server?.scope).toBe('session');
  });

  it('refuses a member widening their own server to workspace-wide', async () => {
    const { create, patch, storedServers } = await buildDaemon('allow_private_only');

    const created = await create({ scope: 'session' });

    await expect(patch(created.mcp_server_id, { scope: 'global' })).rejects.toThrow(
      /reach cannot be widened/
    );
    const [server] = await storedServers();
    expect(server?.scope).toBe('session');
  });

  it('leaves the owner of a row that predates the policy able to edit it', async () => {
    // Created while `allow_crud` allowed it, then the policy tightened. The
    // edit form resends the stored scope, which has widened nothing.
    const { user, create, patch, setPolicy } = await buildDaemon('allow_crud');
    const created = await create({ scope: 'global', owner_user_id: user.user_id });
    expect(created.scope).toBe('global');
    await setPolicy('allow_private_only');

    const patched = await patch(created.mcp_server_id, {
      scope: 'global',
      display_name: 'DeepWiki',
    });

    expect(patched).toMatchObject({ scope: 'global', display_name: 'DeepWiki' });
  });

  it('refuses a widening update, and leaves one that names no scope alone', async () => {
    // PUT reaches the same hook as PATCH. An update that states nothing must
    // not become a widening by way of a replace.
    const { create, update, storedServers } = await buildDaemon('allow_private_only');
    const created = await create({ scope: 'session' });

    await expect(update(created.mcp_server_id, { scope: 'global' })).rejects.toThrow(
      /reach cannot be widened/
    );
    await update(created.mcp_server_id, {
      display_name: 'DeepWiki',
      url: 'https://example.com/mcp',
    });

    const [server] = await storedServers();
    expect(server).toMatchObject({ scope: 'session', display_name: 'DeepWiki' });
  });

  it('leaves a member free to narrow their own server', async () => {
    const { user, create, patch, setPolicy } = await buildDaemon('allow_crud');
    const created = await create({ scope: 'global', owner_user_id: user.user_id });
    await setPolicy('allow_private_only');

    const patched = await patch(created.mcp_server_id, { scope: 'session' });

    expect(patched.scope).toBe('session');
  });

  it('leaves workspace-wide reach to allow_crud, which is the value that grants it', async () => {
    const { user, create, storedServers } = await buildDaemon('allow_crud');

    // Owned, because saying nothing about ownership is not a decision to
    // publish; the reach asked for is honoured either way.
    await create({ scope: 'global' });

    const [server] = await storedServers();
    expect(server).toMatchObject({ scope: 'global', owner_user_id: user.user_id });
  });

  it('lets an allow_crud member publish a server the workspace can use', async () => {
    const { create, storedServers } = await buildDaemon('allow_crud');

    await create({ scope: 'global', owner_user_id: null });

    const [server] = await storedServers();
    // No owner at all, which is what `isMCPServerUsableBy` treats as everyone's.
    expect(server?.scope).toBe('global');
    expect(server?.owner_user_id ?? null).toBeNull();
  });

  it('leaves an admin every scope under every policy value', async () => {
    const { create, patch, storedServers } = await buildDaemon('allow_private_only', 'admin');

    const created = await create({ scope: 'global' });
    await patch(created.mcp_server_id, { scope: 'session' });
    await patch(created.mcp_server_id, { scope: 'global' });

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

/**
 * The gate on the endpoint that answers the policy, asserted against the
 * registration itself.
 *
 * The handler is defined inside `registerRoutes` and cannot be stood up
 * without the rest of the daemon, so this reads the registration the way
 * `register-routes.prompt-scope.test.ts` does. What it pins is the reason the
 * gate is where it is: half of what this endpoint answers is about the caller,
 * so the caller a policy refuses has to be able to read it. Raising it back to
 * member would make that answer unreachable by the only people it says no to.
 */
describe('the MCP member policy endpoint, as it is registered', () => {
  const source = readFileSync(join(__dirname, '..', 'register-routes.ts'), 'utf8');
  const servicesSource = readFileSync(join(__dirname, '..', 'register-services.ts'), 'utf8');
  const registration = source.slice(
    source.indexOf("'/mcp-member-policy'"),
    source.indexOf('MCP marketplace connect')
  );

  it('lets any authenticated caller read it', () => {
    expect(registration).toContain(
      "find: { role: ROLES.VIEWER, action: 'read the MCP member policy' }"
    );
  });

  it('keeps the write to admins', () => {
    expect(registration).toContain(
      "patch: { role: ROLES.ADMIN, action: 'change the MCP member policy' }"
    );
  });

  it('answers the caller their own capability, not only the tenant value', () => {
    expect(registration).toContain('can_configure: canConfigureMcpServers(params.user?.role');
  });

  it('emits an empty tenant-scoped invalidation after a policy write', () => {
    expect(registration).toContain("path: 'mcp-servers'");
    expect(registration).toContain('event: MCP_MEMBER_POLICY_CHANGED_EVENT');
    expect(registration).toContain('data: {}');
    // Request params carry the trusted tenant context into emitServiceEvent;
    // without them a post-commit publish could cross or miss tenant channels.
    expect(registration).toContain('params,');
  });

  it('registers the invalidation at the mcp-servers transport boundary', () => {
    const serviceRegistration = servicesSource.slice(
      servicesSource.indexOf("app.use('/mcp-servers', createMCPServersService(db)"),
      servicesSource.indexOf('const coordinateMCPServerMutation')
    );
    expect(serviceRegistration).toContain('events: [MCP_MEMBER_POLICY_CHANGED_EVENT]');
  });
});
