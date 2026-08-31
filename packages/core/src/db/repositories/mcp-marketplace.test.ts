import type { BranchID, MCPServerID, SessionID, UserID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert } from '../database-wrapper';
import { sessionMcpServers } from '../schema';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { MCPMarketplaceRepository } from './mcp-marketplace';
import { MCPServerRepository } from './mcp-servers';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-00000000b0b0' as UserID;

async function sessionFor(db: Database, createdBy: UserID) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `marketplace-${createdBy.slice(-4)}-${Math.random()}`,
    name: 'Marketplace Test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/repo.git',
    local_path: `/tmp/marketplace-${createdBy.slice(-4)}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/marketplace-${createdBy.slice(-4)}`,
    base_ref: 'main',
    new_branch: false,
    created_by: createdBy as unknown as UUID,
  });
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branch.branch_id,
    title: `${createdBy === ALICE ? 'Alice' : 'Bob'} session`,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: createdBy,
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
  });
}

describe('MCPMarketplaceRepository', () => {
  dbTest(
    'projects only the current owner, visible sessions, and explicit secret-free fields',
    async ({ db }) => {
      const users = new UsersRepository(db);
      await users.create({
        user_id: ALICE,
        email: 'alice-marketplace@example.invalid',
        role: 'member',
      });
      await users.create({
        user_id: BOB,
        email: 'bob-marketplace@example.invalid',
        role: 'member',
      });
      const servers = new MCPServerRepository(db);
      const aliceServerBase = await servers.create({
        name: 'alice-private',
        display_name: 'Alice private',
        transport: 'http',
        url: 'https://alice-secret-endpoint.invalid/mcp',
        headers: { Authorization: 'alice-header-secret' },
        auth: { type: 'bearer', token: 'alice-token-secret' },
        env: { SECRET_ENV: 'alice-env-secret' },
        scope: 'session',
        source: 'user',
        owner_user_id: ALICE,
      });
      const aliceServer = await servers.update(aliceServerBase.mcp_server_id, {
        tools: [{ name: 'write_task', description: 'Writes a task', input_schema: {} }],
        tool_permissions: { write_task: 'ask' },
      });
      const bobServer = await servers.create({
        name: 'bob-private',
        transport: 'http',
        url: 'https://bob.invalid/mcp',
        auth: { type: 'bearer', token: 'bob-token-secret' },
        scope: 'session',
        source: 'user',
        owner_user_id: BOB,
      });
      await servers.create({
        name: 'shared',
        transport: 'http',
        url: 'https://shared.invalid/mcp',
        auth: { type: 'bearer', token: 'shared-token-secret' },
        scope: 'session',
        source: 'user',
      });

      const aliceSession = await sessionFor(db, ALICE);
      const bobSession = await sessionFor(db, BOB);
      await insert(db, sessionMcpServers)
        .values([
          {
            session_id: aliceSession.session_id,
            mcp_server_id: aliceServer.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          },
          // Deliberately stale/invalid cross-owner link: the overview must not
          // disclose Bob's session metadata even to an admin-shaped Alice caller.
          {
            session_id: bobSession.session_id,
            mcp_server_id: aliceServer.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          },
          {
            session_id: bobSession.session_id,
            mcp_server_id: bobServer.mcp_server_id,
            enabled: true,
            added_at: new Date(),
          },
        ])
        .run();

      const result = await new MCPMarketplaceRepository(db).overviewForUser(ALICE);
      expect(result.servers.map((server) => server.name)).toEqual(['alice-private']);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].session_id).toBe(aliceSession.session_id);
      expect(result.servers[0].session_count).toBe(1);
      expect(result.servers[0].transport).toBe('http');
      expect(result.credentials).toMatchObject([
        {
          mcp_server_id: aliceServer.mcp_server_id as MCPServerID,
          method: 'bearer',
          status: 'configured',
        },
      ]);
      expect(result.servers[0].tools).toMatchObject([{ name: 'write_task', permission: 'ask' }]);

      const forbiddenKeys =
        /^(auth|token|secret|headers?|env|url|endpoint|client_id|resource|issuer)$/i;
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          expect(key).not.toMatch(forbiddenKeys);
          visit(child);
        }
      };
      visit(result);
      expect(JSON.stringify(result)).not.toMatch(
        /alice-token-secret|alice-header-secret|alice-env-secret|secret-endpoint|bob-token-secret|shared-token-secret/
      );
    }
  );
});
