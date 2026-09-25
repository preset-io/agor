import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  EntityNotFoundError,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type { CreateSessionInput } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { type SessionParams, SessionsService } from './sessions';

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

function createService(db: Database, events: EmittedEvent[] = []) {
  const scopedDb = createTenantScopedDatabaseProxy(db, { requireScope: true });
  const service = new SessionsService(scopedDb, appStub(events));
  return {
    create: (input: CreateSessionInput, params?: SessionParams) =>
      runWithTenantDatabaseScope(scopedDb, 'static', () => service.create(input, params)),
  };
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

afterEach(() => vi.restoreAllMocks());

describe('SessionsService create-time MCP attachment', () => {
  dbTest(
    'default → delete → create keeps valid defaults and warns without rolling back',
    async ({ db }) => {
      const { user, branch, servers, sharedServer } = await fixture(db);
      const removed = await servers.create({
        name: 'removed-default',
        transport: 'stdio',
        command: 'node',
        scope: 'session',
        source: 'user',
        enabled: true,
      });
      await new BranchRepository(db).update(branch.branch_id, {
        mcp_server_ids: [sharedServer.mcp_server_id, removed.mcp_server_id],
      });
      await servers.delete(removed.mcp_server_id);
      const events: EmittedEvent[] = [];
      const session = await createService(db, events).create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
        },
        { _agenticConfigResolved: true } as never
      );
      expect(
        (await new SessionMCPServerRepository(db).listServers(session.session_id)).map(
          (server) => server.mcp_server_id
        )
      ).toEqual([sharedServer.mcp_server_id]);
      expect(session).toMatchObject({ mcp_defaults_skipped: 1 });
      expect(events).toHaveLength(1);
      expect(await new SessionRepository(db).findById(session.session_id)).not.toHaveProperty(
        'mcp_defaults_skipped'
      );
    }
  );

  dbTest(
    'user defaults inherit; an all-missing branch does not fall through to user defaults',
    async ({ db }) => {
      const scopedDb = createTenantScopedDatabaseProxy(db, { requireScope: true });
      await runWithTenantDatabaseScope(scopedDb, 'static', async (scoped) => {
        const { user, branch, sharedServer } = await fixture(scoped);
        const missing = generateId();
        await new UsersRepository(scoped).update(user.user_id, {
          default_mcp_server_ids: [sharedServer.mcp_server_id, missing],
        });
        const service = new SessionsService(scopedDb, appStub());
        const input = {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
        } as const;
        const inherited = await service.create(input, { _agenticConfigResolved: true } as never);
        expect(inherited.mcp_defaults_skipped).toBe(1);
        expect(
          await new SessionMCPServerRepository(scoped).listServers(inherited.session_id)
        ).toHaveLength(1);
        await new BranchRepository(scoped).update(branch.branch_id, { mcp_server_ids: [missing] });
        const allMissing = await service.create(input, { _agenticConfigResolved: true } as never);
        expect(allMissing.mcp_defaults_skipped).toBe(1);
        expect(
          await new SessionMCPServerRepository(scoped).listServers(allMissing.session_id)
        ).toEqual([]);
        for (const explicit of [[], [sharedServer.mcp_server_id]]) {
          const overridden = await service.create({ ...input, mcpServerIds: explicit }, {
            _agenticConfigResolved: true,
          } as never);
          expect(overridden.mcp_defaults_skipped).toBeUndefined();
          expect(
            (await new SessionMCPServerRepository(scoped).listServers(overridden.session_id)).map(
              (server) => server.mcp_server_id
            )
          ).toEqual(explicit);
        }
      });
    }
  );

  dbTest(
    'does not suppress missing sessions, permission, malformed defaults, or infrastructure failures',
    async ({ db }) => {
      const { user, branch, sharedServer } = await fixture(db);
      await new BranchRepository(db).update(branch.branch_id, {
        mcp_server_ids: [sharedServer.mcp_server_id],
      });
      const events: EmittedEvent[] = [];
      const service = createService(db, events);
      const input = {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      } as const;
      for (const failure of [
        new EntityNotFoundError('Session', generateId()),
        new Forbidden('Denied'),
        new Error('database unavailable'),
      ]) {
        const add = vi
          .spyOn(SessionMCPServerRepository.prototype, 'addServer')
          .mockRejectedValueOnce(failure);
        await expect(service.create(input, { _agenticConfigResolved: true } as never)).rejects.toBe(
          failure
        );
        add.mockRestore();
        expect(await new SessionRepository(db).findAll()).toEqual([]);
        expect(events).toEqual([]);
      }
      await new BranchRepository(db).update(branch.branch_id, { mcp_server_ids: [' '] });
      await expect(
        service.create(input, { _agenticConfigResolved: true } as never)
      ).rejects.toBeInstanceOf(BadRequest);
    }
  );

  dbTest('deduplicates explicit mcpServerIds for persistence and events', async ({ db }) => {
    const { user, branch, sharedServer } = await fixture(db);
    const events: EmittedEvent[] = [];
    const service = createService(db, events);

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
    const service = createService(db);
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
    const service = createService(db, events);

    await new BranchRepository(db).update(branch.branch_id, {
      mcp_server_ids: [privateServer.mcp_server_id],
    });
    for (const mcpServerIds of [[privateServer.mcp_server_id], undefined]) {
      await expect(
        service.create(
          {
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'claude-code',
            status: SessionStatus.IDLE,
            mcpServerIds,
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
    }
  });

  dbTest('maps a missing server to NotFound and rolls the session back', async ({ db }) => {
    const { user, branch, sharedServer } = await fixture(db);
    const events: EmittedEvent[] = [];
    const service = createService(db, events);

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
          status: SessionStatus.IDLE,
          mcpServerIds: [sharedServer.mcp_server_id, generateId()],
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toMatchObject({
      name: NotFound.name,
      code: 404,
      message: expect.stringContaining('Remove the unavailable selection'),
    });

    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
    expect(events).toEqual([]);
  });
});
