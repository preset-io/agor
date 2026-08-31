/**
 * MCPServerRepository Tests
 *
 * Tests for type-safe CRUD operations on MCP servers with the simplified
 * scope model ('global' | 'session').
 */

import type { MCPServer, MCPServerID, UpdateMCPServerInput, UserID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { MCP_HEADER_REDACTED_SENTINEL } from '../../tools/mcp/http-headers';
import { select, update } from '../database-wrapper';
import { mcpServers } from '../schema';
import { dbTest } from '../test-helpers';
import { EntityNotFoundError } from './base';
import { MCPServerRepository } from './mcp-servers';

/**
 * Create test MCP server data with required fields
 */
function createMCPServerData(overrides?: Partial<MCPServer>) {
  const transport = overrides?.transport ?? (overrides?.auth || overrides?.url ? 'http' : 'stdio');
  return {
    mcp_server_id: overrides?.mcp_server_id ?? (generateId() as MCPServerID),
    name: overrides?.name ?? 'test-server',
    transport,
    scope: overrides?.scope ?? ('global' as const),
    enabled: overrides?.enabled ?? true,
    source: overrides?.source ?? ('user' as const),
    created_at: overrides?.created_at ?? new Date(),
    updated_at: overrides?.updated_at ?? new Date(),
    ...(transport === 'stdio'
      ? { command: overrides?.command ?? 'npx' }
      : { url: overrides?.url ?? 'https://mcp.example.test/mcp' }),
    ...overrides,
  };
}

// ============================================================================
// Create
// ============================================================================

describe('MCPServerRepository.create', () => {
  dbTest('should create MCP server with global scope', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const userId = generateId() as UserID;
    const data = createMCPServerData({
      name: 'filesystem',
      transport: 'stdio',
      scope: 'global',
      owner_user_id: userId,
    });

    const created = await repo.create(data);

    expect(created.mcp_server_id).toBe(data.mcp_server_id);
    expect(created.name).toBe('filesystem');
    expect(created.transport).toBe('stdio');
    expect(created.scope).toBe('global');
    expect(created.owner_user_id).toBe(userId);
    expect(created.enabled).toBe(true);
    expect(created.source).toBe('user');
  });

  dbTest('should create MCP server with session scope', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'session-tool',
      scope: 'session',
    });

    const created = await repo.create(data);

    expect(created.scope).toBe('session');
    expect(created.owner_user_id).toBeUndefined();
  });

  dbTest('should generate mcp_server_id if not provided', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    delete (data as any).mcp_server_id;

    const created = await repo.create(data);

    expect(created.mcp_server_id).toBeDefined();
    expect(created.mcp_server_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  dbTest('should default to enabled=true', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    delete (data as any).enabled;

    const created = await repo.create(data);

    expect(created.enabled).toBe(true);
  });

  dbTest('rejects internal and unknown OAuth compatibility modes on create', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    for (const mode of ['marketplace', 'future-mode']) {
      await expect(
        repo.create(
          createMCPServerData({
            auth: { type: 'oauth', oauth_compatibility_mode: mode } as never,
          })
        )
      ).rejects.toThrow(/must be either strict or legacy/);
    }
  });
});

describe('MCPServerRepository pagination', () => {
  dbTest(
    'pushes sorting, limit, and offset into the list query while count ignores paging',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      for (const name of ['charlie', 'alpha', 'bravo']) {
        await repo.create(createMCPServerData({ name, enabled: true }));
      }
      await repo.create(createMCPServerData({ name: 'disabled', enabled: false }));

      const page = await repo.findAll({
        enabled: true,
        sort: { name: 1 },
        limit: 1,
        offset: 1,
      });

      expect(page.map((server) => server.name)).toEqual(['bravo']);
      expect(await repo.count({ enabled: true, limit: 1, offset: 1 })).toBe(3);
    }
  );
});

// ============================================================================
// Read
// ============================================================================

describe('MCPServerRepository.findById', () => {
  dbTest('should find MCP server by full ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(createMCPServerData({ name: 'test' }));

    const found = await repo.findById(created.mcp_server_id);

    expect(found).toBeDefined();
    expect(found?.mcp_server_id).toBe(created.mcp_server_id);
    expect(found?.name).toBe('test');
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const nonExistentId = generateId() as MCPServerID;

    const found = await repo.findById(nonExistentId);

    expect(found).toBeNull();
  });
});

describe('MCPServerRepository.findAll', () => {
  dbTest('should return all MCP servers when no filters', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    await repo.create(createMCPServerData({ name: 'server-1' }));
    await repo.create(createMCPServerData({ name: 'server-2' }));

    const all = await repo.findAll();

    expect(all).toHaveLength(2);
  });

  dbTest('should filter by scope (global)', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    await repo.create(createMCPServerData({ name: 'global-1', scope: 'global' }));
    await repo.create(createMCPServerData({ name: 'session-1', scope: 'session' }));

    const globalServers = await repo.findAll({ scope: 'global' });

    expect(globalServers).toHaveLength(1);
    expect(globalServers[0].name).toBe('global-1');
  });

  dbTest('should keep shared and caller-owned servers for usableByUserId', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const user1 = generateId() as UserID;
    const user2 = generateId() as UserID;

    await repo.create(createMCPServerData({ name: 'shared' }));
    await repo.create(createMCPServerData({ name: 'user1', owner_user_id: user1 }));
    await repo.create(createMCPServerData({ name: 'user2', owner_user_id: user2 }));

    const visible = await repo.findAll({ usableByUserId: user1 });

    expect(visible.map((server) => server.name)).toEqual(['shared', 'user1']);
  });

  dbTest('should restrict ownerless queries to shared rows', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    await repo.create(createMCPServerData({ name: 'shared' }));
    await repo.create(
      createMCPServerData({ name: 'private', owner_user_id: generateId() as UserID })
    );

    const visible = await repo.findAll({ ownerless: true });

    expect(visible.map((server) => server.name)).toEqual(['shared']);
  });

  dbTest('should filter by enabled status', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    await repo.create(createMCPServerData({ name: 'enabled-1', enabled: true }));
    await repo.create(createMCPServerData({ name: 'disabled-1', enabled: false }));

    const enabledServers = await repo.findAll({ enabled: true });

    expect(enabledServers).toHaveLength(1);
    expect(enabledServers[0].name).toBe('enabled-1');
  });

  dbTest('should filter by transport', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    await repo.create(createMCPServerData({ name: 'stdio-1', transport: 'stdio' }));
    await repo.create(createMCPServerData({ name: 'http-1', transport: 'http' }));

    const stdioServers = await repo.findAll({ transport: 'stdio' });

    expect(stdioServers).toHaveLength(1);
    expect(stdioServers[0].name).toBe('stdio-1');
  });

  dbTest('bounds and paginates status-style server scans', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    for (const name of ['page-1', 'page-2', 'page-3']) {
      await repo.create(createMCPServerData({ name }));
    }

    const first = await repo.findAll({ limit: 1, offset: 0 });
    const second = await repo.findAll({ limit: 1, offset: 1 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.mcp_server_id).not.toBe(second[0]!.mcp_server_id);
  });
});

// ============================================================================
// Update
// ============================================================================

describe('MCPServerRepository.update', () => {
  dbTest('keeps daemon-owned config revisions monotonic', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create({
      ...createMCPServerData({
        display_name: 'Before',
        transport: 'http',
        url: 'https://before.example.test/mcp',
      }),
      config_version: Number.MAX_SAFE_INTEGER,
    } as never);
    expect(created).toMatchObject({ config_version: 1 });

    const metadataOnly = await repo.update(created.mcp_server_id, {
      display_name: 'After',
      expected_config_version: 1,
    });
    expect(metadataOnly).toMatchObject({ config_version: 2 });

    const endpointEdit = await repo.update(created.mcp_server_id, {
      url: 'https://changed.example.test/mcp',
      expected_config_version: 2,
    });
    expect(endpointEdit).toMatchObject({ config_version: 3 });
  });

  dbTest(
    'fails closed at revision exhaustion without making revision 1 valid again',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      const created = await repo.create(createMCPServerData({ display_name: 'Before' }));
      const row = await select(db)
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
        .one();
      for (const exhausted of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
        await update(db, mcpServers)
          .set({ data: { ...row!.data, config_version: exhausted } })
          .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
          .run();

        await expect(repo.findById(created.mcp_server_id)).resolves.toMatchObject({
          display_name: 'Before',
          config_version: exhausted,
        });
        await expect(
          repo.update(created.mcp_server_id, {
            display_name: 'Must not advance into an exhausted revision',
            expected_config_version: exhausted,
          })
        ).rejects.toThrow('configuration revision is invalid or exhausted');

        // A client which retained the initial revision must never regain CAS
        // authority after exhaustion (ABA).
        await expect(
          repo.update(created.mcp_server_id, {
            display_name: 'Ancient stale edit',
            expected_config_version: 1,
          })
        ).rejects.toThrow('configuration revision is invalid or exhausted');
      }

      const stored = await select(db)
        .from(mcpServers)
        .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
        .one();
      expect(stored?.data.config_version).toBe(Number.MAX_SAFE_INTEGER);
      expect(stored?.data.display_name).toBe('Before');
    }
  );

  dbTest('projects a pre-existing invalid revision as baseline 1', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(createMCPServerData({ display_name: 'Invalid revision' }));
    const row = await select(db)
      .from(mcpServers)
      .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
      .one();
    await update(db, mcpServers)
      .set({ data: { ...row!.data, config_version: 0 } })
      .where(eq(mcpServers.mcp_server_id, created.mcp_server_id))
      .run();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(repo.findById(created.mcp_server_id)).resolves.toMatchObject({
        config_version: 1,
      });
      await expect(
        repo.update(created.mcp_server_id, {
          display_name: 'Recovered invalid revision',
          expected_config_version: 1,
        })
      ).resolves.toMatchObject({ config_version: 2 });
      expect(JSON.stringify(warning.mock.calls)).not.toContain('Invalid revision');
    } finally {
      warning.mockRestore();
    }
  });

  dbTest('should update MCP server', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(createMCPServerData({ name: 'original', enabled: true }));

    const updated = await repo.update(created.mcp_server_id, {
      display_name: 'Updated Display Name',
      enabled: false,
    });

    expect(updated.display_name).toBe('Updated Display Name');
    expect(updated.enabled).toBe(false);
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const nonExistentId = generateId() as MCPServerID;

    await expect(repo.update(nonExistentId, { enabled: false })).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('rejects internal OAuth compatibility mode on patch/update', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(
      createMCPServerData({ auth: { type: 'oauth', oauth_compatibility_mode: 'strict' } })
    );

    await expect(
      repo.update(created.mcp_server_id, {
        auth: { type: 'oauth', oauth_compatibility_mode: 'marketplace' } as never,
      })
    ).rejects.toThrow(/must be either strict or legacy/);
  });

  dbTest(
    'merges a narrow auth patch without clobbering credentials or compatibility',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      const created = await repo.create(
        createMCPServerData({
          transport: 'http',
          url: 'https://calendar.example.test/mcp',
          auth: {
            type: 'oauth',
            oauth_scope: 'calendar.readonly',
            oauth_client_id: 'registered-client',
            oauth_client_secret: 'registered-secret',
            oauth_compatibility_mode: 'legacy',
          },
        })
      );

      const updated = await repo.update(created.mcp_server_id, {
        auth: { oauth_scope: 'calendar.events' },
        expected_config_version: created.config_version,
      });

      expect(updated.config_version).toBe((created.config_version ?? 1) + 1);
      expect(updated.auth).toEqual({
        type: 'oauth',
        oauth_scope: 'calendar.events',
        oauth_client_id: 'registered-client',
        oauth_client_secret: 'registered-secret',
        oauth_compatibility_mode: 'legacy',
      });
    }
  );

  dbTest('clears one auth field with null and rejects a stale config version', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(
      createMCPServerData({
        auth: { type: 'oauth', oauth_scope: 'one', oauth_client_id: 'client' },
      })
    );
    const updated = await repo.update(created.mcp_server_id, {
      auth: { oauth_scope: null },
      expected_config_version: created.config_version,
    });
    expect(updated.auth).toEqual({ type: 'oauth', oauth_client_id: 'client' });
    await expect(
      repo.update(created.mcp_server_id, {
        auth: { oauth_scope: 'stale' },
        expected_config_version: created.config_version,
      })
    ).rejects.toMatchObject({ name: 'MCPServerConfigConflictError' });
  });

  dbTest('supports an explicit same-mode whole-auth replacement', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(
      createMCPServerData({
        auth: {
          type: 'oauth',
          oauth_scope: 'old',
          oauth_client_id: 'old-client',
          oauth_client_secret: 'old-secret',
        },
      })
    );
    const updated = await repo.update(created.mcp_server_id, {
      auth: { type: 'oauth', oauth_scope: 'new' },
      replace_auth: true,
      expected_config_version: created.config_version,
    });
    expect(updated.auth).toEqual({ type: 'oauth', oauth_scope: 'new' });
  });

  dbTest(
    'keeps materialized provenance aligned with an internal whole-row update',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      const created = await repo.create(
        createMCPServerData({ source: 'catalog', catalog_entry_name: 'catalog/original' })
      );

      await repo.update(created.mcp_server_id, {
        catalog_entry_name: 'catalog/drifted',
      } as unknown as UpdateMCPServerInput);

      await expect(repo.findById(created.mcp_server_id)).resolves.toMatchObject({
        catalog_entry_name: 'catalog/drifted',
      });
      await expect(repo.findAll({ catalogEntryName: 'catalog/drifted' })).resolves.toHaveLength(1);
    }
  );
});

// ============================================================================
// Delete
// ============================================================================

describe('MCPServerRepository.delete', () => {
  dbTest('should delete MCP server', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(createMCPServerData({ name: 'to-delete' }));

    await repo.delete(created.mcp_server_id);

    const found = await repo.findById(created.mcp_server_id);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const nonExistentId = generateId() as MCPServerID;

    await expect(repo.delete(nonExistentId)).rejects.toThrow(EntityNotFoundError);
  });
});

// ============================================================================
// JSON Field Handling
// ============================================================================

describe('MCPServerRepository JSON fields', () => {
  dbTest('should store and retrieve stdio transport config', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { NODE_ENV: 'production' },
    });

    const created = await repo.create(data);
    const found = await repo.findById(created.mcp_server_id);

    expect(found?.command).toBe('npx');
    expect(found?.args).toEqual(['@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(found?.env).toEqual({ NODE_ENV: 'production' });
  });

  dbTest('should store and retrieve http transport config', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'remote-api',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      auth: {
        type: 'bearer',
        token: 'test-token',
      },
    });

    const created = await repo.create(data);
    const found = await repo.findById(created.mcp_server_id);

    expect(found?.url).toBe('https://api.example.com/mcp');
    expect(found?.auth).toEqual({
      type: 'bearer',
      token: 'test-token',
    });
  });
});

// ============================================================================
// Scope Model Tests (Global vs Session)
// ============================================================================

describe('MCPServerRepository scope model', () => {
  dbTest('should only support global and session scopes', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    // Global scope should work
    const globalServer = await repo.create(
      createMCPServerData({ name: 'global-server', scope: 'global' })
    );
    expect(globalServer.scope).toBe('global');

    // Session scope should work
    const sessionServer = await repo.create(
      createMCPServerData({ name: 'session-server', scope: 'session' })
    );
    expect(sessionServer.scope).toBe('session');
  });
});

describe('MCPServerRepository custom headers', () => {
  dbTest('should store and retrieve custom HTTP headers', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(
      createMCPServerData({
        name: 'datadog',
        transport: 'http',
        url: 'https://mcp.datadog.example/mcp',
        headers: {
          'DD-API-KEY': '{{ user.env.DD_API_KEY }}',
          'X-Datadog-Parent-Org-Id': '1234',
          Authorization: 'Bearer should-not-persist',
          Cookie: 'session=should-not-persist',
        },
      })
    );

    const found = await repo.findById(created.mcp_server_id);

    expect(found?.headers).toEqual({
      'DD-API-KEY': '{{ user.env.DD_API_KEY }}',
      'X-Datadog-Parent-Org-Id': '1234',
    });
  });

  dbTest('should drop custom headers for stdio servers', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(
      createMCPServerData({
        name: 'filesystem',
        transport: 'stdio',
        headers: {
          'X-Should-Not-Persist': 'value',
        },
      })
    );

    const found = await repo.findById(created.mcp_server_id);

    expect(found?.headers).toBeUndefined();
  });

  dbTest('should reject case-insensitive duplicate custom headers', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    await expect(
      repo.create(
        createMCPServerData({
          name: 'ambiguous-headers',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { 'X-Route': 'a', 'x-route': 'b' },
        })
      )
    ).rejects.toThrow(/Duplicate custom HTTP header names/);
  });

  dbTest(
    'should preserve existing header values when update sends redacted sentinel',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      const created = await repo.create(
        createMCPServerData({
          name: 'datadog',
          transport: 'http',
          url: 'https://mcp.datadog.example/mcp',
          headers: {
            'DD-API-KEY': 'secret-value',
            'X-Datadog-Parent-Org-Id': '1234',
          },
        })
      );

      const updated = await repo.update(created.mcp_server_id, {
        headers: {
          'DD-API-KEY': MCP_HEADER_REDACTED_SENTINEL,
          'X-Datadog-Parent-Org-Id': '5678',
        },
      });

      expect(updated.headers).toEqual({
        'DD-API-KEY': 'secret-value',
        'X-Datadog-Parent-Org-Id': '5678',
      });
    }
  );

  dbTest(
    'should preserve existing OAuth secrets when update sends redacted sentinel',
    async ({ db }) => {
      const repo = new MCPServerRepository(db);
      const created = await repo.create(
        createMCPServerData({
          name: 'oauth-server',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          auth: {
            type: 'oauth',
            oauth_client_id: 'old-client-id',
            oauth_client_secret: 'stored-client-secret',
          },
        })
      );

      const updated = await repo.update(created.mcp_server_id, {
        auth: {
          type: 'oauth',
          oauth_client_id: 'new-client-id',
          oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
        },
      });

      expect(updated.auth).toMatchObject({
        type: 'oauth',
        oauth_client_id: 'new-client-id',
        oauth_client_secret: 'stored-client-secret',
      });
    }
  );

  dbTest('should clear custom headers when updating to stdio transport', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const created = await repo.create(
      createMCPServerData({
        name: 'datadog',
        transport: 'http',
        url: 'https://mcp.datadog.example/mcp',
        headers: {
          'DD-API-KEY': 'secret-value',
        },
      })
    );

    const updated = await repo.update(created.mcp_server_id, {
      transport: 'stdio',
      command: 'npx',
    });

    expect(updated.headers).toBeUndefined();
  });
});
