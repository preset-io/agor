import {
  BranchRepository,
  generateId,
  insert,
  MCPMarketplaceRepository,
  MCPServerRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  sessionMcpServers,
  setMcpMemberPolicy,
  UsersRepository,
} from '@agor/core/db';
import { Conflict, Forbidden } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  MCPMemberPolicy,
  SessionID,
  UserID,
} from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  MCPMarketplaceRemoveServerService,
  MCPMarketplaceToolPermissionService,
} from './mcp-marketplace-actions';
import { SessionMCPServersService } from './session-mcp-servers';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-000000000b0b' as UserID;

function params(userId: UserID, role: string): AuthenticatedParams {
  return { provider: 'rest', user: { user_id: userId, role } } as AuthenticatedParams;
}

async function seed(repo: MCPServerRepository, owner: UserID = ALICE) {
  return repo.create({
    name: `marketplace-action-${Math.random()}`,
    transport: 'http',
    url: 'https://example.test/mcp',
    scope: 'session',
    source: 'user',
    owner_user_id: owner,
  });
}

async function seedUser(
  db: Parameters<typeof dbTest>[0]['db'],
  userId: UserID,
  role: 'viewer' | 'member' | 'admin'
): Promise<void> {
  await new UsersRepository(db).create({
    user_id: userId,
    email: `${userId.slice(-4)}-${Math.random()}@example.test`,
    role,
  });
}

async function setPolicy(
  db: Parameters<typeof dbTest>[0]['db'],
  policy: MCPMemberPolicy
): Promise<void> {
  await setMcpMemberPolicy(db, policy, undefined);
}

dbTest('Marketplace actions reject viewers before mutation', async ({ db }) => {
  await seedUser(db, ALICE, 'viewer');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo);

  await expect(
    new MCPMarketplaceToolPermissionService(db).create(
      { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
      params(ALICE, 'viewer')
    )
  ).rejects.toBeInstanceOf(Forbidden);
  await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
    tool_permissions: undefined,
  });
});

dbTest('Marketplace actions honor use_existing_only for members', async ({ db }) => {
  await seedUser(db, ALICE, 'member');
  await setPolicy(db, 'use_existing_only');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo);

  await expect(
    new MCPMarketplaceRemoveServerService(db).create(
      { mcp_server_id: server.mcp_server_id },
      params(ALICE, 'member')
    )
  ).rejects.toBeInstanceOf(Forbidden);
  await expect(repo.findById(server.mcp_server_id)).resolves.not.toBeNull();
});

dbTest(
  'Marketplace actions allow an authorized owner and emit an empty refresh target',
  async ({ db }) => {
    await seedUser(db, ALICE, 'member');
    await setPolicy(db, 'allow_private_only');
    const repo = new MCPServerRepository(db);
    const server = await seed(repo);
    const invalidate = vi.fn();

    await expect(
      new MCPMarketplaceToolPermissionService(db, invalidate).create(
        { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
        params(ALICE, 'member')
      )
    ).resolves.toMatchObject({ permission: 'deny' });
    await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
      tool_permissions: { 'issues.create': 'deny' },
    });
    expect(invalidate).toHaveBeenCalledWith([ALICE], expect.anything(), server.mcp_server_id);
  }
);

dbTest('committed Marketplace mutations ignore availability-hint failure', async ({ db }) => {
  await seedUser(db, ALICE, 'member');
  await setPolicy(db, 'allow_private_only');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const invalidate = vi.fn().mockRejectedValue(new Error('realtime unavailable'));

  await expect(
    new MCPMarketplaceToolPermissionService(db, invalidate).create(
      { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
      params(ALICE, 'member')
    )
  ).resolves.toMatchObject({ permission: 'deny' });
  await Promise.resolve();
  await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
    tool_permissions: { 'issues.create': 'deny' },
  });
  expect(warn).toHaveBeenCalledWith(
    '[MCP Runtime] event=marketplace_hint_failed code=async_failure'
  );
});

dbTest('Marketplace actions reject a non-owner member under allow_crud', async ({ db }) => {
  await seedUser(db, ALICE, 'member');
  await seedUser(db, BOB, 'member');
  await setPolicy(db, 'allow_crud');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo, ALICE);

  await expect(
    new MCPMarketplaceToolPermissionService(db).create(
      { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
      params(BOB, 'member')
    )
  ).rejects.toBeInstanceOf(Forbidden);
});

dbTest('Marketplace actions preserve the existing admin/non-owner semantics', async ({ db }) => {
  await seedUser(db, ALICE, 'member');
  await seedUser(db, BOB, 'admin');
  await setPolicy(db, 'use_existing_only');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo, ALICE);
  const invalidate = vi.fn();

  await expect(
    new MCPMarketplaceToolPermissionService(db, invalidate).create(
      { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
      params(BOB, 'admin')
    )
  ).resolves.toMatchObject({ permission: 'deny' });
  expect(invalidate).toHaveBeenCalledWith([BOB, ALICE], expect.anything(), server.mcp_server_id);
});

dbTest('Marketplace tool action reloads a demoted role inside its transaction', async ({ db }) => {
  await seedUser(db, ALICE, 'member');
  await setPolicy(db, 'allow_private_only');
  const users = new UsersRepository(db);
  const repo = new MCPServerRepository(db);
  const server = await seed(repo);
  await users.update(ALICE, { role: 'viewer' });

  await expect(
    new MCPMarketplaceToolPermissionService(db).create(
      { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
      // Deliberately stale request authority.
      params(ALICE, 'member')
    )
  ).rejects.toBeInstanceOf(Forbidden);
  await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
    tool_permissions: undefined,
  });
});

dbTest(
  'Marketplace remove reloads a tightened member policy inside its transaction',
  async ({ db }) => {
    await seedUser(db, ALICE, 'member');
    await setPolicy(db, 'allow_private_only');
    const repo = new MCPServerRepository(db);
    const server = await seed(repo);
    await setPolicy(db, 'use_existing_only');

    await expect(
      new MCPMarketplaceRemoveServerService(db).create(
        { mcp_server_id: server.mcp_server_id },
        params(ALICE, 'member')
      )
    ).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.findById(server.mcp_server_id)).resolves.not.toBeNull();
  }
);

dbTest('Marketplace tool action reloads transport under the mutation lock', async ({ db }) => {
  await seedUser(db, ALICE, 'member');
  await setPolicy(db, 'allow_private_only');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo);
  await repo.update(server.mcp_server_id, { transport: 'stdio', command: 'node' });

  await expect(
    new MCPMarketplaceToolPermissionService(db).create(
      { mcp_server_id: server.mcp_server_id, tool_name: 'issues.create', enabled: false },
      params(ALICE, 'member')
    )
  ).rejects.toBeInstanceOf(Forbidden);
  await expect(repo.findById(server.mcp_server_id)).resolves.toMatchObject({
    transport: 'stdio',
    tool_permissions: undefined,
  });
});

async function sessionFor(db: Parameters<typeof dbTest>[0]['db'], owner = ALICE) {
  const repo = await new RepoRepository(db).create({
    slug: `delete-${generateId()}`,
    name: 'Delete fixture',
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/mcp-delete',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'fixture',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1000000),
    path: '/tmp/mcp-delete',
    created_by: owner,
  });
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id,
    created_by: owner,
    status: SessionStatus.IDLE,
    agentic_tool: 'claude-code',
  });
}

dbTest(
  'session choices intersect caller and owner eligibility, never admin inventory',
  async ({ db }) => {
    await seedUser(db, ALICE, 'admin');
    await seedUser(db, BOB, 'member');
    const repo = new MCPServerRepository(db);
    const own = await seed(repo);
    const other = await seed(repo, BOB);
    const shared = await repo.create({
      name: 'shared',
      transport: 'http',
      url: 'https://example.test',
      scope: 'session',
      source: 'user',
    });
    const session = await sessionFor(db);
    const service = new SessionMCPServersService(db);
    expect(
      (await service.listAvailableServers(session, ALICE)).map((s) => s.mcp_server_id).sort()
    ).toEqual([own.mcp_server_id, shared.mcp_server_id].sort());
    expect((await service.listAvailableServers(session, BOB)).map((s) => s.mcp_server_id)).toEqual([
      shared.mcp_server_id,
    ]);
    expect((await repo.findAll()).map((s) => s.mcp_server_id)).toContain(other.mcp_server_id);
    await expect(service.addServer(session.session_id, other.mcp_server_id)).rejects.toThrow(
      'private to another user'
    );
  }
);

dbTest(
  'delete confirms the total count without revealing hidden sessions, then cascades atomically',
  async ({ db }) => {
    await seedUser(db, ALICE, 'member');
    await seedUser(db, BOB, 'member');
    await setPolicy(db, 'allow_private_only');
    const repo = new MCPServerRepository(db);
    const server = await seed(repo);
    const retained = await seed(repo);
    const session = await sessionFor(db);
    const hidden = await sessionFor(db, BOB);
    const links = new SessionMCPServerRepository(db);
    await links.addServer(session.session_id, server.mcp_server_id);
    await links.addServer(session.session_id, retained.mcp_server_id);
    // Legacy link: count it, never disclose Bob's session metadata.
    await insert(db, sessionMcpServers)
      .values({
        session_id: hidden.session_id,
        mcp_server_id: server.mcp_server_id,
        enabled: false,
        added_at: new Date(),
      })
      .run();
    const overview = await new MCPMarketplaceRepository(db).overviewForUser(ALICE);
    expect(
      overview.servers.find((s) => s.mcp_server_id === server.mcp_server_id)?.session_count
    ).toBe(2);
    expect(JSON.stringify(overview)).not.toContain(hidden.session_id);
    const invalidate = vi.fn();
    const action = new MCPMarketplaceRemoveServerService(db, invalidate);
    const confirmed = {
      mcp_server_id: server.mcp_server_id,
      detach: true,
      expected_session_count: 2,
    };
    await expect(action.create(confirmed, params(BOB, 'member'))).rejects.toBeInstanceOf(Forbidden);
    await expect(
      action.create({ mcp_server_id: server.mcp_server_id }, params(ALICE, 'member'))
    ).rejects.toBeInstanceOf(Conflict);
    await expect(
      action.create({ ...confirmed, expected_session_count: 1 }, params(ALICE, 'member'))
    ).rejects.toBeInstanceOf(Conflict);
    expect(await links.getRelationship(hidden.session_id, server.mcp_server_id)).not.toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    // Failure after deleting must roll back the parent AND cascaded links.
    const failing = new MCPMarketplaceRemoveServerService(db, invalidate, async (tx, id) => {
      await new MCPServerRepository(tx).delete(id);
      throw new Error('injected failure');
    });
    await expect(failing.create(confirmed, params(ALICE, 'member'))).rejects.toThrow(
      'injected failure'
    );
    expect(await links.getRelationship(hidden.session_id, server.mcp_server_id)).not.toBeNull();
    expect(await repo.findById(server.mcp_server_id)).not.toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    await expect(action.create(confirmed, params(ALICE, 'member'))).resolves.toMatchObject({
      removed: true,
    });
    expect(await repo.findById(server.mcp_server_id)).toBeNull();
    expect(await links.getRelationship(hidden.session_id, server.mcp_server_id)).toBeNull();
    expect(await links.listServers(session.session_id)).toMatchObject([
      { mcp_server_id: retained.mcp_server_id },
    ]);
    expect(invalidate).toHaveBeenCalledOnce();
  }
);
