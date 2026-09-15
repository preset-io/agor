import { OpenCodeTool } from '@agor/agentic-tool-opencode/runtime';
import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  type Database,
  MCPServerRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import { getMcpServersForSession, resolveEffectiveSessionMcpServers } from '@agor/core/mcp';
import { resolveSessionMcpServerIds } from '@agor/core/sessions';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { SessionsService } from './sessions';

// Regression coverage for #2629: the create-time MCP selection was persisted by
// a best-effort follow-up loop that could silently drop servers. It now attaches
// inside the same create call.

interface EmittedEvent {
  path: string;
  event: string;
  data: unknown;
}

function appStub(events: EmittedEvent[] = []): Application {
  const config = { execution: { unix_user_mode: 'simple' } } as AgorConfig;
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
    service: (path: string) => ({
      emit: (event: string, data: unknown) => events.push({ path, event, data }),
    }),
  } as unknown as Application;
}

async function fixture(db: Database) {
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

// dbTest supplies an isolated raw SQLite fixture; guarded tenant boundaries have
// dedicated service tests. The service constructor uses the production handle type.
describe('SessionsService create-time MCP attachment', () => {
  dbTest(
    'explicit [] survives persistence and the production runtime set without global/user/branch fallback',
    async ({ db }) => {
      const { user, branch, servers, sharedServer } = await fixture(db);
      const gmail = await servers.create({
        name: 'fictional-gmail',
        scope: 'global',
        source: 'user',
        transport: 'http',
        url: 'https://gmail.example.test/mcp',
        enabled: true,
        owner_user_id: user.user_id,
        auth: { type: 'oauth', oauth_mode: 'per_user' },
      });
      const service = new SessionsService(db as unknown as TenantScopeAwareDatabase, appStub());
      const base = {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code' as const,
        status: SessionStatus.IDLE,
      };
      const explicit = resolveSessionMcpServerIds({
        explicit: [],
        branch: { mcp_server_ids: [gmail.mcp_server_id] },
        user: { default_mcp_server_ids: [gmail.mcp_server_id] },
      });
      const created = await service.create({ ...base, mcpServerIds: explicit }, {
        _agenticConfigResolved: true,
      } as never);
      const stored = await new SessionRepository(db).findById(created.session_id);
      expect(stored?.mcp_selection_explicit).toBe(true);
      const links = new SessionMCPServerRepository(db);
      const global = vi.fn(async () => [gmail, sharedServer]);
      const auth = vi.fn();
      const resolved = await getMcpServersForSession(
        created.session_id,
        {
          sessionMCPRepo: {
            listServers: (id, enabled) => links.listServers(id, enabled),
            listEffectiveServers: async (id, enabled, caller) =>
              resolveEffectiveSessionMcpServers(
                (await new SessionRepository(db).findById(id))!,
                await links.listServers(id, enabled),
                global,
                caller
              ),
          },
          mcpServerRepo: servers,
          mcpOAuthAuthHeadersRepo: { getAuthHeaders: auth },
          forUserId: user.user_id,
        },
        { toolFiltering: 'intercept' }
      );
      expect(resolved).toEqual([]);
      const tool = new OpenCodeTool({
        resolveMcpServers: async () => resolved,
        getDaemonUrl: async () => 'https://daemon.example.test',
      });
      const config = await (
        tool as unknown as {
          buildInvocationConfig(
            id: string,
            token: string
          ): Promise<{ mcp: Record<string, unknown> }>;
        }
      ).buildInvocationConfig(created.session_id, 'fictional-agor-token');
      expect(Object.keys(config.mcp)).toHaveLength(1);
      expect(Object.keys(config.mcp)[0]).toMatch(/^agor_/);
      expect(global).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
      expect(
        await resolveEffectiveSessionMcpServers(stored!, [gmail], global, user.user_id)
      ).toEqual([gmail]);
      expect(global).not.toHaveBeenCalled();
      await expect(
        service.patch(created.session_id, { mcp_selection_explicit: false })
      ).rejects.toThrow('mcp_selection_explicit is server-managed');
      const omitted = await service.create(base, { _agenticConfigResolved: true } as never);
      expect(omitted.mcp_selection_explicit).toBeUndefined();
      expect(await resolveEffectiveSessionMcpServers(omitted, [], global, user.user_id)).toEqual([
        gmail,
        sharedServer,
      ]);
      expect(
        await resolveEffectiveSessionMcpServers(omitted, [], global, 'different-caller')
      ).toEqual([sharedServer]);
    }
  );

  dbTest('deduplicates explicit mcpServerIds for persistence and events', async ({ db }) => {
    const { user, branch, sharedServer } = await fixture(db);
    const events: EmittedEvent[] = [];
    const service = new SessionsService(db as unknown as TenantScopeAwareDatabase, appStub(events));

    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
        mcpServerIds: [sharedServer.mcp_server_id, sharedServer.mcp_server_id],
      },
      { _agenticConfigResolved: true } as never
    );

    const attached = await new SessionMCPServerRepository(db).listServers(session.session_id);
    expect(attached.map((server) => server.mcp_server_id)).toEqual([sharedServer.mcp_server_id]);
    expect(events).toEqual([
      {
        path: 'session-mcp-servers',
        event: 'created',
        data: expect.objectContaining({
          session_id: session.session_id,
          mcp_server_id: sharedServer.mcp_server_id,
          enabled: true,
        }),
      },
    ]);
  });

  dbTest('rejects malformed mcpServerIds as typed bad requests', async ({ db }) => {
    const service = new SessionsService(db as unknown as TenantScopeAwareDatabase, appStub());
    const base = {
      branch_id: generateId(),
      created_by: generateId(),
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
    } as const;

    for (const mcpServerIds of [null, 'not-an-array', [generateId(), 42], [' ']]) {
      await expect(
        service.create(
          { ...base, mcpServerIds } as never,
          { _agenticConfigResolved: true } as never
        )
      ).rejects.toMatchObject({
        name: BadRequest.name,
        code: 400,
      });
    }

    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
  });

  dbTest('maps an inaccessible server to Forbidden and rolls the session back', async ({ db }) => {
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
    const events: EmittedEvent[] = [];
    const service = new SessionsService(db as unknown as TenantScopeAwareDatabase, appStub(events));

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
    ).rejects.toMatchObject({
      name: Forbidden.name,
      code: 403,
      message: 'That MCP server is private to another user',
    });

    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
    expect(events).toEqual([]);
  });

  dbTest('maps a missing server to NotFound and rolls the session back', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const events: EmittedEvent[] = [];
    const service = new SessionsService(db as unknown as TenantScopeAwareDatabase, appStub(events));

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          mcpServerIds: [generateId()],
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toMatchObject({
      name: NotFound.name,
      code: 404,
      message: 'That MCP server was not found',
    });

    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
    expect(events).toEqual([]);
  });
});
