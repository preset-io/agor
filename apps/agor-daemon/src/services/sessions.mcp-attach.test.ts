import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  MCPServerRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { MCPServerNotUsableError } from '@agor/core/mcp';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { SessionsService } from './sessions';

// Regression coverage for #2629: the create-time MCP selection was persisted by
// a best-effort follow-up loop that could silently drop servers. It now attaches
// inside the same create call.

function appStub(): Application {
  const config = { execution: { unix_user_mode: 'simple' } } as AgorConfig;
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
    service: () => ({ emit: () => {} }),
  } as unknown as Application;
}

async function fixture(db: TenantScopeAwareDatabase) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}-mcp-attach@example.com`,
    name: 'MCP attach owner',
  });
  const repo = await new RepoRepository(db).create({
    slug: `mcp-attach-${generateId()}`,
    name: 'MCP attach repo',
    repo_type: 'remote',
    remote_url: 'https://example.com/mcp-attach.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `mcp-attach-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: user.user_id,
  });
  const servers = new MCPServerRepository(db);
  const sharedServer = await servers.create({
    name: `shared-${generateId()}`,
    transport: 'stdio',
    command: 'node',
    args: ['shared.js'],
    scope: 'global',
    source: 'user',
    enabled: true,
  });
  return { user, branch, servers, sharedServer };
}

describe('SessionsService create-time MCP attachment', () => {
  dbTest('attaches explicit mcpServerIds in the same create call', async ({ db }) => {
    const { user, branch, sharedServer } = await fixture(db);
    const service = new SessionsService(db, appStub());

    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
        mcpServerIds: [sharedServer.mcp_server_id],
      },
      { _agenticConfigResolved: true } as never
    );

    const attached = await new SessionMCPServerRepository(db).listServers(session.session_id);
    expect(attached.map((server) => server.mcp_server_id)).toEqual([sharedServer.mcp_server_id]);
  });

  dbTest('rejects a server private to another user and creates no session', async ({ db }) => {
    const { user, branch, servers } = await fixture(db);
    const otherUser = await new UsersRepository(db).create({
      email: `${generateId()}-other-owner@example.com`,
      name: 'Other owner',
    });
    const privateServer = await servers.create({
      name: `private-${generateId()}`,
      transport: 'stdio',
      command: 'node',
      args: ['private.js'],
      scope: 'global',
      source: 'user',
      enabled: true,
      owner_user_id: otherUser.user_id,
    });
    const service = new SessionsService(db, appStub());

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          mcpServerIds: [privateServer.mcp_server_id],
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toBeInstanceOf(MCPServerNotUsableError);

    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
  });
});
