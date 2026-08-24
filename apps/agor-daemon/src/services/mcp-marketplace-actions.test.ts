import { MCPServerRepository, setMcpMemberPolicy, UsersRepository } from '@agor/core/db';
import { Conflict, Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPMemberPolicy, UserID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  MCPMarketplaceRemoveServerService,
  MCPMarketplaceToolPermissionService,
} from './mcp-marketplace-actions';

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
    expect(invalidate).toHaveBeenCalledWith([ALICE], expect.anything());
  }
);

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
  expect(invalidate).toHaveBeenCalledWith([BOB, ALICE], expect.anything());
});

dbTest('remove reports when an attachment wins without ordinary remove', async ({ db }) => {
  await seedUser(db, ALICE, 'admin');
  const repo = new MCPServerRepository(db);
  const server = await seed(repo);
  const deleteIfUnattached = vi
    .spyOn(MCPServerRepository.prototype, 'deleteIfUnattachedInCurrentTransaction')
    .mockResolvedValue(false);
  const ordinaryRemove = vi.spyOn(MCPServerRepository.prototype, 'delete');

  await expect(
    new MCPMarketplaceRemoveServerService(db).create(
      { mcp_server_id: server.mcp_server_id },
      params(ALICE, 'admin')
    )
  ).rejects.toBeInstanceOf(Conflict);
  expect(deleteIfUnattached).toHaveBeenCalled();
  expect(ordinaryRemove).not.toHaveBeenCalled();
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
