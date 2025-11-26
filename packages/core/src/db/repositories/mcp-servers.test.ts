/**
 * MCPServerRepository Tests
 *
 * Tests for type-safe CRUD operations on MCP servers with the simplified
 * scope model ('global' | 'session').
 */

import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { EntityNotFoundError } from './base';
import { MCPServerRepository } from './mcp-servers';

/**
 * Create test MCP server data with required fields
 */
function createMCPServerData(overrides?: Partial<MCPServer>) {
  return {
    mcp_server_id: overrides?.mcp_server_id ?? (generateId() as MCPServerID),
    name: overrides?.name ?? 'test-server',
    transport: overrides?.transport ?? ('stdio' as const),
    scope: overrides?.scope ?? ('global' as const),
    enabled: overrides?.enabled ?? true,
    source: overrides?.source ?? ('user' as const),
    created_at: overrides?.created_at ?? new Date(),
    updated_at: overrides?.updated_at ?? new Date(),
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

  dbTest('should filter by scope and owner (global with scopeId)', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const user1 = generateId() as UserID;
    const user2 = generateId() as UserID;

    await repo.create(
      createMCPServerData({ name: 'user1-server', scope: 'global', owner_user_id: user1 })
    );
    await repo.create(
      createMCPServerData({ name: 'user2-server', scope: 'global', owner_user_id: user2 })
    );

    const user1Servers = await repo.findAll({ scope: 'global', scopeId: user1 });

    expect(user1Servers).toHaveLength(1);
    expect(user1Servers[0].name).toBe('user1-server');
    expect(user1Servers[0].owner_user_id).toBe(user1);
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
});

// ============================================================================
// Update
// ============================================================================

describe('MCPServerRepository.update', () => {
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

  dbTest('should filter global servers by owner', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const user1 = generateId() as UserID;
    const user2 = generateId() as UserID;

    // Create servers for different users
    await repo.create(
      createMCPServerData({ name: 'user1-fs', scope: 'global', owner_user_id: user1 })
    );
    await repo.create(
      createMCPServerData({ name: 'user1-git', scope: 'global', owner_user_id: user1 })
    );
    await repo.create(
      createMCPServerData({ name: 'user2-fs', scope: 'global', owner_user_id: user2 })
    );

    // Each user should only see their own servers
    const user1Servers = await repo.findAll({ scope: 'global', scopeId: user1 });
    const user2Servers = await repo.findAll({ scope: 'global', scopeId: user2 });

    expect(user1Servers).toHaveLength(2);
    expect(user2Servers).toHaveLength(1);
    expect(user1Servers.map((s) => s.name)).toContain('user1-fs');
    expect(user1Servers.map((s) => s.name)).toContain('user1-git');
    expect(user2Servers[0].name).toBe('user2-fs');
  });
});
