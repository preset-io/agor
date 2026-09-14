/**
 * Private MCP servers: a server owned by one user must not become reachable
 * from another user's session by any route through the data layer.
 *
 * The scenario each test builds is the one that matters — two members of the
 * same tenant, one of whom configured a server carrying their own credential.
 */

import type { BranchID, SessionID, UserID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { MCPServerNotUsableError } from '../../mcp/ownership';
import type { Database } from '../client';
import { insert } from '../database-wrapper';
import { sessionMcpServers } from '../schema';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { MCPServerRepository } from './mcp-servers';
import { RepoRepository } from './repos';
import { SessionMCPServerRepository } from './session-mcp-servers';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-00000000b0b0' as UserID;

async function setupTenant(db: Database) {
  const users = new UsersRepository(db);
  await users.create({ user_id: ALICE, email: 'alice-mcp-owner@example.invalid', role: 'member' });
  await users.create({ user_id: BOB, email: 'bob-mcp-owner@example.invalid', role: 'member' });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `ownership-repo-${Math.floor(Math.random() * 1_000_000)}`,
    name: 'Ownership Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/ownership-repo',
    default_branch: 'main',
  });

  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/ownership-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: ALICE as unknown as UUID,
  });

  const sessionRepo = new SessionRepository(db);
  const sessionFor = (createdBy: UserID) =>
    sessionRepo.create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: createdBy,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
    });

  const mcpServerRepo = new MCPServerRepository(db);
  const alicesPrivateServer = await mcpServerRepo.create({
    name: 'alices-tracker',
    transport: 'http',
    url: 'https://tracker.example.com/mcp',
    scope: 'session',
    source: 'user',
    owner_user_id: ALICE,
  });
  const sharedServer = await mcpServerRepo.create({
    name: 'shared-docs',
    transport: 'http',
    url: 'https://docs.example.com/mcp',
    scope: 'session',
    source: 'user',
  });

  return {
    mcpServerRepo,
    sessionMcpRepo: new SessionMCPServerRepository(db),
    alicesSession: await sessionFor(ALICE),
    bobsSession: await sessionFor(BOB),
    alicesPrivateServer,
    sharedServer,
  };
}

describe('private MCP server ownership', () => {
  dbTest('owner_user_id survives a round trip through create', async ({ db }) => {
    const { alicesPrivateServer, sharedServer, mcpServerRepo } = await setupTenant(db);

    await expect(mcpServerRepo.findById(alicesPrivateServer.mcp_server_id)).resolves.toMatchObject({
      owner_user_id: ALICE,
    });
    expect(sharedServer.owner_user_id).toBeUndefined();
  });

  dbTest('a member cannot attach another member’s private server', async ({ db }) => {
    const { sessionMcpRepo, bobsSession, alicesPrivateServer } = await setupTenant(db);

    // Bob controls this session outright — the refusal comes from the server's
    // owner, not from anything about Bob's access to the session.
    await expect(
      sessionMcpRepo.addServer(bobsSession.session_id, alicesPrivateServer.mcp_server_id)
    ).rejects.toBeInstanceOf(MCPServerNotUsableError);

    await expect(
      sessionMcpRepo.getRelationship(bobsSession.session_id, alicesPrivateServer.mcp_server_id)
    ).resolves.toBeNull();
  });

  dbTest('the owner can attach their own private server', async ({ db }) => {
    const { sessionMcpRepo, alicesSession, alicesPrivateServer } = await setupTenant(db);

    await sessionMcpRepo.addServer(alicesSession.session_id, alicesPrivateServer.mcp_server_id);

    await expect(sessionMcpRepo.listServers(alicesSession.session_id)).resolves.toMatchObject([
      { mcp_server_id: alicesPrivateServer.mcp_server_id },
    ]);
  });

  dbTest(
    'creator failure cannot delete a catalog row after a conflict loser adopts it',
    async ({ db }) => {
      const { sessionMcpRepo, alicesSession, mcpServerRepo } = await setupTenant(db);
      const winnerCreated = await mcpServerRepo.create({
        name: 'catalog-race',
        transport: 'http',
        url: 'https://catalog.example/mcp',
        scope: 'session',
        source: 'catalog',
        catalog_entry_name: 'com.example/race',
        owner_user_id: ALICE,
      });

      // The concurrent insert lost the unique race, recovered winnerCreated,
      // and completed its attachment before the creator's later step failed.
      await sessionMcpRepo.addServer(alicesSession.session_id, winnerCreated.mcp_server_id);

      await expect(mcpServerRepo.deleteIfUnattached(winnerCreated.mcp_server_id)).resolves.toBe(
        false
      );
      await expect(mcpServerRepo.findById(winnerCreated.mcp_server_id)).resolves.toMatchObject({
        mcp_server_id: winnerCreated.mcp_server_id,
      });
      await expect(
        sessionMcpRepo.getRelationship(alicesSession.session_id, winnerCreated.mcp_server_id)
      ).resolves.not.toBeNull();
    }
  );

  dbTest('a shared server stays attachable by anyone', async ({ db }) => {
    const { sessionMcpRepo, bobsSession, sharedServer } = await setupTenant(db);

    await sessionMcpRepo.addServer(bobsSession.session_id, sharedServer.mcp_server_id);

    await expect(sessionMcpRepo.listServers(bobsSession.session_id)).resolves.toHaveLength(1);
  });

  dbTest('a bulk set is refused whole rather than partially applied', async ({ db }) => {
    const { sessionMcpRepo, bobsSession, sharedServer, alicesPrivateServer } =
      await setupTenant(db);

    await expect(
      sessionMcpRepo.setServers(bobsSession.session_id, [
        sharedServer.mcp_server_id,
        alicesPrivateServer.mcp_server_id,
      ])
    ).rejects.toBeInstanceOf(MCPServerNotUsableError);

    await expect(sessionMcpRepo.listServers(bobsSession.session_id)).resolves.toHaveLength(0);
  });

  dbTest('resolution drops a private server a junction row still points at', async ({ db }) => {
    const { sessionMcpRepo, bobsSession, alicesPrivateServer } = await setupTenant(db);

    // Write the link straight to the junction table, past the attach gate, so
    // the read path is what is under test — the state a row created before
    // enforcement, or by a future write that forgets it, would leave behind.
    await insert(db, sessionMcpServers)
      .values({
        session_id: bobsSession.session_id,
        mcp_server_id: alicesPrivateServer.mcp_server_id,
        enabled: true,
        added_at: new Date(),
      })
      .run();

    await expect(sessionMcpRepo.listServers(bobsSession.session_id)).resolves.toEqual([]);
    await expect(sessionMcpRepo.listServersWithMetadata(bobsSession.session_id)).resolves.toEqual(
      []
    );
  });

  dbTest('usableByUserId keeps shared servers and drops foreign private ones', async ({ db }) => {
    const { mcpServerRepo, alicesPrivateServer, sharedServer } = await setupTenant(db);

    const forBob = await mcpServerRepo.findAll({ usableByUserId: BOB });
    expect(forBob.map((server) => server.mcp_server_id)).toEqual([sharedServer.mcp_server_id]);

    const forAlice = await mcpServerRepo.findAll({ usableByUserId: ALICE });
    expect(forAlice.map((server) => server.mcp_server_id).sort()).toEqual(
      [alicesPrivateServer.mcp_server_id, sharedServer.mcp_server_id].sort()
    );

    // Unfiltered stays tenant-wide, which is what an admin listing needs.
    await expect(mcpServerRepo.findAll()).resolves.toHaveLength(2);
  });

  dbTest('a catalog install records the entry it came from', async ({ db }) => {
    const { mcpServerRepo } = await setupTenant(db);

    const installed = await mcpServerRepo.create({
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      scope: 'session',
      source: 'catalog',
      owner_user_id: BOB,
      catalog_entry_name: 'com.linear/linear',
    });

    await expect(mcpServerRepo.findById(installed.mcp_server_id)).resolves.toMatchObject({
      catalog_entry_name: 'com.linear/linear',
    });

    // An update rewrites the JSON blob wholesale from the current row, so the
    // stamp is only durable if it survives that round trip — and provenance
    // that a routine edit could drop would be worse than none.
    await mcpServerRepo.update(installed.mcp_server_id, { display_name: 'Linear (renamed)' });
    await expect(mcpServerRepo.findById(installed.mcp_server_id)).resolves.toMatchObject({
      catalog_entry_name: 'com.linear/linear',
    });
  });

  dbTest('ownership cannot be moved by an update', async ({ db }) => {
    const { mcpServerRepo, alicesPrivateServer } = await setupTenant(db);

    await mcpServerRepo.update(alicesPrivateServer.mcp_server_id, {
      owner_user_id: BOB,
    } as never);

    await expect(mcpServerRepo.findById(alicesPrivateServer.mcp_server_id)).resolves.toMatchObject({
      owner_user_id: ALICE,
    });
  });
});
