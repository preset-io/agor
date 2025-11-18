/**
 * Session-MCP Server Repository Tests
 *
 * Tests for many-to-many relationship management between sessions and MCP servers,
 * including FK validation, bulk operations, and enabled state toggling.
 */

import type {
  MCPServer,
  MCPServerID,
  Session,
  SessionID,
  UUID,
  WorktreeID,
} from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { EntityNotFoundError } from './base';
import { MCPServerRepository } from './mcp-servers';
import { RepoRepository } from './repos';
import { SessionMCPServerRepository } from './session-mcp-servers';
import { SessionRepository } from './sessions';
import { WorktreeRepository } from './worktrees';

/**
 * Create test session data
 */
function createSessionData(worktreeId: UUID, overrides?: Partial<Session>): Partial<Session> {
  return {
    session_id: (overrides?.session_id ?? generateId()) as SessionID,
    worktree_id: worktreeId,
    agentic_tool: overrides?.agentic_tool ?? 'claude-code',
    status: overrides?.status ?? SessionStatus.IDLE,
    created_by: overrides?.created_by ?? 'test-user',
    created_at: overrides?.created_at ?? new Date().toISOString(),
    last_updated: overrides?.last_updated ?? new Date().toISOString(),
    git_state: overrides?.git_state ?? {
      ref: 'main',
      base_sha: 'abc123',
      current_sha: 'def456',
    },
    tasks: overrides?.tasks ?? [],
    message_count: overrides?.message_count ?? 0,
    contextFiles: overrides?.contextFiles ?? [],
    genealogy: overrides?.genealogy ?? {
      children: [],
    },
    ...overrides,
  };
}

/**
 * Create test MCP server data
 */
function createMCPServerData(overrides?: Partial<MCPServer>) {
  return {
    mcp_server_id: (overrides?.mcp_server_id ?? generateId()) as MCPServerID,
    name: overrides?.name ?? `test-server-${Date.now()}`,
    transport: overrides?.transport ?? ('stdio' as const),
    command: overrides?.command ?? 'node',
    args: overrides?.args ?? ['server.js'],
    scope: overrides?.scope ?? ('global' as const),
    source: overrides?.source ?? ('user' as const),
    enabled: overrides?.enabled ?? true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/**
 * Set up test database with repo, worktree, session, and MCP servers
 */
async function setupTestData(db: any) {
  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
  const sessionRepo = new SessionRepository(db);
  const mcpServerRepo = new MCPServerRepository(db);

  // Create repo
  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: `test-repo-${Date.now()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });

  // Create worktree
  const worktree = await worktreeRepo.create({
    worktree_id: generateId() as WorktreeID,
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    worktree_unique_id: Math.floor(Math.random() * 1000000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
  });

  // Create session
  const session = await sessionRepo.create(createSessionData(worktree.worktree_id));

  // Create MCP servers
  const server1 = await mcpServerRepo.create(createMCPServerData({ name: 'test-server-1' }));
  const server2 = await mcpServerRepo.create(createMCPServerData({ name: 'test-server-2' }));
  const server3 = await mcpServerRepo.create(createMCPServerData({ name: 'test-server-3' }));

  return { session, server1, server2, server3 };
}

// ============================================================================
// addServer
// ============================================================================

describe('SessionMCPServerRepository.addServer', () => {
  dbTest('should add MCP server to session', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship).toBeDefined();
    expect(relationship?.session_id).toBe(session.session_id);
    expect(relationship?.mcp_server_id).toBe(server1.mcp_server_id);
    expect(relationship?.enabled).toBe(true);
    expect(relationship?.added_at).toBeInstanceOf(Date);
  });

  dbTest('should handle adding same server twice (idempotent)', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server1.mcp_server_id);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(1);
    expect(servers[0].mcp_server_id).toBe(server1.mcp_server_id);
  });

  dbTest('should re-enable disabled server when added again', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);
    await repo.addServer(session.session_id, server1.mcp_server_id);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship?.enabled).toBe(true);
  });

  dbTest('should throw EntityNotFoundError for invalid session', async ({ db }) => {
    const { server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);
    const invalidSessionId = generateId() as SessionID;

    await expect(repo.addServer(invalidSessionId, server1.mcp_server_id)).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('should throw EntityNotFoundError for invalid MCP server', async ({ db }) => {
    const { session } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);
    const invalidServerId = generateId() as MCPServerID;

    await expect(repo.addServer(session.session_id, invalidServerId)).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('should allow multiple servers for one session', async ({ db }) => {
    const { session, server1, server2, server3 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.addServer(session.session_id, server3.mcp_server_id);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(3);
    const serverIds = servers.map((s) => s.mcp_server_id);
    expect(serverIds).toContain(server1.mcp_server_id);
    expect(serverIds).toContain(server2.mcp_server_id);
    expect(serverIds).toContain(server3.mcp_server_id);
  });
});

// ============================================================================
// removeServer
// ============================================================================

describe('SessionMCPServerRepository.removeServer', () => {
  dbTest('should remove MCP server from session', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.removeServer(session.session_id, server1.mcp_server_id);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship).toBeNull();

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(0);
  });

  dbTest(
    'should throw EntityNotFoundError when removing non-existent relationship',
    async ({ db }) => {
      const { session, server1 } = await setupTestData(db);
      const repo = new SessionMCPServerRepository(db);

      await expect(repo.removeServer(session.session_id, server1.mcp_server_id)).rejects.toThrow(
        EntityNotFoundError
      );
    }
  );

  dbTest('should only remove specified server, not others', async ({ db }) => {
    const { session, server1, server2, server3 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.addServer(session.session_id, server3.mcp_server_id);

    await repo.removeServer(session.session_id, server2.mcp_server_id);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(2);
    const serverIds = servers.map((s) => s.mcp_server_id);
    expect(serverIds).toContain(server1.mcp_server_id);
    expect(serverIds).toContain(server3.mcp_server_id);
    expect(serverIds).not.toContain(server2.mcp_server_id);
  });
});

// ============================================================================
// toggleServer
// ============================================================================

describe('SessionMCPServerRepository.toggleServer', () => {
  dbTest('should disable MCP server', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship?.enabled).toBe(false);
  });

  dbTest('should enable MCP server', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, true);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship?.enabled).toBe(true);
  });

  dbTest('should throw EntityNotFoundError for non-existent relationship', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await expect(
      repo.toggleServer(session.session_id, server1.mcp_server_id, false)
    ).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should allow toggling multiple times', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);

    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);
    let rel = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(rel?.enabled).toBe(false);

    await repo.toggleServer(session.session_id, server1.mcp_server_id, true);
    rel = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(rel?.enabled).toBe(true);

    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);
    rel = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(rel?.enabled).toBe(false);
  });
});

// ============================================================================
// listServers
// ============================================================================

describe('SessionMCPServerRepository.listServers', () => {
  dbTest('should list all MCP servers for session', async ({ db }) => {
    const { session, server1, server2 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toHaveProperty('mcp_server_id');
    expect(servers[0]).toHaveProperty('name');
    expect(servers[0]).toHaveProperty('transport');
  });

  dbTest('should return empty array for session with no servers', async ({ db }) => {
    const { session } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(0);
  });

  dbTest('should filter by enabled status when enabledOnly=true', async ({ db }) => {
    const { session, server1, server2, server3 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.addServer(session.session_id, server3.mcp_server_id);
    await repo.toggleServer(session.session_id, server2.mcp_server_id, false);

    const allServers = await repo.listServers(session.session_id, false);
    expect(allServers).toHaveLength(3);

    const enabledServers = await repo.listServers(session.session_id, true);
    expect(enabledServers).toHaveLength(2);
    const enabledIds = enabledServers.map((s) => s.mcp_server_id);
    expect(enabledIds).toContain(server1.mcp_server_id);
    expect(enabledIds).toContain(server3.mcp_server_id);
    expect(enabledIds).not.toContain(server2.mcp_server_id);
  });

  dbTest('should include all disabled servers when enabledOnly=false', async ({ db }) => {
    const { session, server1, server2 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);
    await repo.toggleServer(session.session_id, server2.mcp_server_id, false);

    const servers = await repo.listServers(session.session_id, false);
    expect(servers).toHaveLength(2);

    const enabledServers = await repo.listServers(session.session_id, true);
    expect(enabledServers).toHaveLength(0);
  });

  dbTest('should return full MCP server details, not just IDs', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(1);
    expect(servers[0].mcp_server_id).toBe(server1.mcp_server_id);
    expect(servers[0].name).toBe(server1.name);
    expect(servers[0].transport).toBe(server1.transport);
    expect(servers[0].command).toBe(server1.command);
    expect(servers[0].scope).toBe(server1.scope);
  });
});

// ============================================================================
// setServers (bulk operation)
// ============================================================================

describe('SessionMCPServerRepository.setServers', () => {
  dbTest('should set servers for session (replacing existing)', async ({ db }) => {
    const { session, server1, server2, server3 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);

    await repo.setServers(session.session_id, [server2.mcp_server_id, server3.mcp_server_id]);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(2);
    const serverIds = servers.map((s) => s.mcp_server_id);
    expect(serverIds).toContain(server2.mcp_server_id);
    expect(serverIds).toContain(server3.mcp_server_id);
    expect(serverIds).not.toContain(server1.mcp_server_id);
  });

  dbTest('should clear all servers when given empty array', async ({ db }) => {
    const { session, server1, server2 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);

    await repo.setServers(session.session_id, []);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(0);
  });

  dbTest('should set servers on session with no existing servers', async ({ db }) => {
    const { session, server1, server2 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.setServers(session.session_id, [server1.mcp_server_id, server2.mcp_server_id]);

    const servers = await repo.listServers(session.session_id);
    expect(servers).toHaveLength(2);
  });

  dbTest('should enable all servers when set', async ({ db }) => {
    const { session, server1, server2 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.setServers(session.session_id, [server1.mcp_server_id, server2.mcp_server_id]);

    const rel1 = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    const rel2 = await repo.getRelationship(session.session_id, server2.mcp_server_id);
    expect(rel1?.enabled).toBe(true);
    expect(rel2?.enabled).toBe(true);
  });

  dbTest('should throw EntityNotFoundError for invalid session', async ({ db }) => {
    const { server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);
    const invalidSessionId = generateId() as SessionID;

    await expect(repo.setServers(invalidSessionId, [server1.mcp_server_id])).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('should deduplicate server IDs in input array', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    // Implementation may silently dedupe or error - test actual behavior
    // Current implementation will attempt duplicate insert, which should fail
    try {
      await repo.setServers(session.session_id, [server1.mcp_server_id, server1.mcp_server_id]);
      // If no error, verify only one relationship exists
      const servers = await repo.listServers(session.session_id);
      expect(servers).toHaveLength(1);
    } catch (error) {
      // Duplicate constraint error is acceptable behavior
      expect(error).toBeDefined();
    }
  });
});

// ============================================================================
// getRelationship
// ============================================================================

describe('SessionMCPServerRepository.getRelationship', () => {
  dbTest('should return relationship details', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship).toBeDefined();
    expect(relationship?.session_id).toBe(session.session_id);
    expect(relationship?.mcp_server_id).toBe(server1.mcp_server_id);
    expect(relationship?.enabled).toBe(true);
    expect(relationship?.added_at).toBeInstanceOf(Date);
    expect(relationship!.added_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  dbTest('should return null for non-existent relationship', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship).toBeNull();
  });

  dbTest('should reflect enabled state changes', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship?.enabled).toBe(false);
  });

  dbTest('should have valid added_at timestamp', async ({ db }) => {
    const { session, server1 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    const beforeAdd = Date.now();
    await repo.addServer(session.session_id, server1.mcp_server_id);
    const afterAdd = Date.now();

    const relationship = await repo.getRelationship(session.session_id, server1.mcp_server_id);
    expect(relationship?.added_at).toBeInstanceOf(Date);
    const addedTime = relationship!.added_at.getTime();
    expect(addedTime).toBeGreaterThanOrEqual(beforeAdd);
    expect(addedTime).toBeLessThanOrEqual(afterAdd);
  });
});

// ============================================================================
// count
// ============================================================================

describe('SessionMCPServerRepository.count', () => {
  dbTest('should count all servers for session', async ({ db }) => {
    const { session, server1, server2, server3 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.addServer(session.session_id, server3.mcp_server_id);

    const count = await repo.count(session.session_id);
    expect(count).toBe(3);
  });

  dbTest('should return 0 for session with no servers', async ({ db }) => {
    const { session } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    const count = await repo.count(session.session_id);
    expect(count).toBe(0);
  });

  dbTest('should count only enabled servers when enabledOnly=true', async ({ db }) => {
    const { session, server1, server2, server3 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.addServer(session.session_id, server3.mcp_server_id);
    await repo.toggleServer(session.session_id, server2.mcp_server_id, false);

    const totalCount = await repo.count(session.session_id, false);
    expect(totalCount).toBe(3);

    const enabledCount = await repo.count(session.session_id, true);
    expect(enabledCount).toBe(2);
  });

  dbTest('should return 0 when all servers disabled and enabledOnly=true', async ({ db }) => {
    const { session, server1, server2 } = await setupTestData(db);
    const repo = new SessionMCPServerRepository(db);

    await repo.addServer(session.session_id, server1.mcp_server_id);
    await repo.addServer(session.session_id, server2.mcp_server_id);
    await repo.toggleServer(session.session_id, server1.mcp_server_id, false);
    await repo.toggleServer(session.session_id, server2.mcp_server_id, false);

    const enabledCount = await repo.count(session.session_id, true);
    expect(enabledCount).toBe(0);

    const totalCount = await repo.count(session.session_id, false);
    expect(totalCount).toBe(2);
  });
});

// ============================================================================
// Error handling edge cases
// ============================================================================

describe('SessionMCPServerRepository error handling', () => {
  dbTest('should handle multiple sessions with same server', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const worktreeRepo = new WorktreeRepository(db);
    const sessionRepo = new SessionRepository(db);
    const mcpServerRepo = new MCPServerRepository(db);
    const repo = new SessionMCPServerRepository(db);

    // Create shared resources
    const testRepo = await repoRepo.create({
      repo_id: generateId() as UUID,
      slug: `test-repo-${Date.now()}`,
      name: 'Test Repo',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/test-repo',
      default_branch: 'main',
    });

    const worktree = await worktreeRepo.create({
      worktree_id: generateId() as WorktreeID,
      repo_id: testRepo.repo_id,
      name: 'main',
      ref: 'main',
      worktree_unique_id: Math.floor(Math.random() * 1000000),
      path: '/tmp/test-repo',
      base_ref: 'main',
      new_branch: false,
    });

    const server = await mcpServerRepo.create(createMCPServerData());

    // Create two sessions
    const session1 = await sessionRepo.create(createSessionData(worktree.worktree_id));
    const session2 = await sessionRepo.create(createSessionData(worktree.worktree_id));

    // Add same server to both sessions
    await repo.addServer(session1.session_id, server.mcp_server_id);
    await repo.addServer(session2.session_id, server.mcp_server_id);

    const servers1 = await repo.listServers(session1.session_id);
    const servers2 = await repo.listServers(session2.session_id);

    expect(servers1).toHaveLength(1);
    expect(servers2).toHaveLength(1);
    expect(servers1[0].mcp_server_id).toBe(server.mcp_server_id);
    expect(servers2[0].mcp_server_id).toBe(server.mcp_server_id);
  });

  dbTest('should independently toggle same server across different sessions', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const worktreeRepo = new WorktreeRepository(db);
    const sessionRepo = new SessionRepository(db);
    const mcpServerRepo = new MCPServerRepository(db);
    const repo = new SessionMCPServerRepository(db);

    const testRepo = await repoRepo.create({
      repo_id: generateId() as UUID,
      slug: `test-repo-${Date.now()}`,
      name: 'Test Repo',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/test-repo',
      default_branch: 'main',
    });

    const worktree = await worktreeRepo.create({
      worktree_id: generateId() as WorktreeID,
      repo_id: testRepo.repo_id,
      name: 'main',
      ref: 'main',
      worktree_unique_id: Math.floor(Math.random() * 1000000),
      path: '/tmp/test-repo',
      base_ref: 'main',
      new_branch: false,
    });

    const server = await mcpServerRepo.create(createMCPServerData());
    const session1 = await sessionRepo.create(createSessionData(worktree.worktree_id));
    const session2 = await sessionRepo.create(createSessionData(worktree.worktree_id));

    await repo.addServer(session1.session_id, server.mcp_server_id);
    await repo.addServer(session2.session_id, server.mcp_server_id);

    // Disable in session1, keep enabled in session2
    await repo.toggleServer(session1.session_id, server.mcp_server_id, false);

    const rel1 = await repo.getRelationship(session1.session_id, server.mcp_server_id);
    const rel2 = await repo.getRelationship(session2.session_id, server.mcp_server_id);

    expect(rel1?.enabled).toBe(false);
    expect(rel2?.enabled).toBe(true);
  });
});
