/**
 * MCPServerRepository Tests
 *
 * Tests for type-safe CRUD operations on MCP servers with short ID support,
 * scope filtering, and comprehensive JSON field handling.
 */

import type { MCPServer, MCPServerID, TeamID, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError } from './base';
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
  dbTest('should create MCP server with all required fields', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'filesystem',
      transport: 'stdio',
      scope: 'global',
    });

    const created = await repo.create(data);

    expect(created.mcp_server_id).toBe(data.mcp_server_id);
    expect(created.name).toBe('filesystem');
    expect(created.transport).toBe('stdio');
    expect(created.scope).toBe('global');
    expect(created.enabled).toBe(true);
    expect(created.source).toBe('user');
    expect(created.created_at).toBeDefined();
    expect(created.updated_at).toBeDefined();
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

  dbTest('should default to enabled=true if not provided', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    delete (data as any).enabled;

    const created = await repo.create(data);

    expect(created.enabled).toBe(true);
  });

  dbTest('should default to source=user if not provided', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    delete (data as any).source;

    const created = await repo.create(data);

    expect(created.source).toBe('user');
  });

  dbTest('should store all optional fields correctly for stdio transport', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const userId = generateId() as UserID;
    const data = createMCPServerData({
      name: 'filesystem',
      display_name: 'Filesystem Access',
      description: 'Access local filesystem via MCP',
      transport: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/Users/test/projects'],
      env: {
        ALLOWED_PATHS: '/Users/test/projects',
        LOG_LEVEL: 'debug',
      },
      scope: 'global',
      owner_user_id: userId,
      source: 'imported',
      import_path: '/Users/test/.mcp.json',
      enabled: false,
      tools: [
        {
          name: 'mcp__filesystem__list_files',
          description: 'List files in a directory',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
        {
          name: 'mcp__filesystem__read_file',
          description: 'Read file contents',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      resources: [
        {
          uri: 'file:///Users/test/projects',
          name: 'Projects Directory',
          mimeType: 'application/x-directory',
        },
      ],
      prompts: [
        {
          name: 'list-project-files',
          description: 'List all files in project directory',
          arguments: [{ name: 'project', description: 'Project name', required: true }],
        },
      ],
    });

    const created = await repo.create(data);

    // Verify all fields are preserved
    expect(created.name).toBe('filesystem');
    expect(created.display_name).toBe('Filesystem Access');
    expect(created.description).toBe('Access local filesystem via MCP');
    expect(created.transport).toBe('stdio');
    expect(created.command).toBe('npx');
    expect(created.args).toEqual([
      '@modelcontextprotocol/server-filesystem',
      '/Users/test/projects',
    ]);
    expect(created.env).toEqual({
      ALLOWED_PATHS: '/Users/test/projects',
      LOG_LEVEL: 'debug',
    });
    expect(created.scope).toBe('global');
    expect(created.owner_user_id).toBe(userId);
    expect(created.source).toBe('imported');
    expect(created.import_path).toBe('/Users/test/.mcp.json');
    expect(created.enabled).toBe(false);
    expect(created.tools).toHaveLength(2);
    expect(created.tools![0].name).toBe('mcp__filesystem__list_files');
    expect(created.tools![1].name).toBe('mcp__filesystem__read_file');
    expect(created.resources).toHaveLength(1);
    expect(created.resources![0].uri).toBe('file:///Users/test/projects');
    expect(created.prompts).toHaveLength(1);
    expect(created.prompts![0].name).toBe('list-project-files');
  });

  dbTest('should store all optional fields correctly for http transport', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const teamId = generateId() as TeamID;
    const data = createMCPServerData({
      name: 'sentry',
      display_name: 'Sentry Error Tracking',
      description: 'Query Sentry for errors and issues',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      env: {
        SENTRY_API_KEY: 'test-key-123',
        SENTRY_ORG: 'my-org',
      },
      scope: 'team',
      team_id: teamId,
      source: 'agor',
      enabled: true,
      tools: [
        {
          name: 'mcp__sentry__list_issues',
          description: 'List recent issues',
          input_schema: { type: 'object', properties: { project: { type: 'string' } } },
        },
      ],
      resources: [
        {
          uri: 'https://sentry.io/organizations/my-org/issues/',
          name: 'Sentry Issues',
          mimeType: 'application/json',
        },
      ],
    });

    const created = await repo.create(data);

    expect(created.name).toBe('sentry');
    expect(created.display_name).toBe('Sentry Error Tracking');
    expect(created.description).toBe('Query Sentry for errors and issues');
    expect(created.transport).toBe('http');
    expect(created.url).toBe('https://mcp.sentry.dev/mcp');
    expect(created.env).toEqual({
      SENTRY_API_KEY: 'test-key-123',
      SENTRY_ORG: 'my-org',
    });
    expect(created.scope).toBe('team');
    expect(created.team_id).toBe(teamId);
    expect(created.source).toBe('agor');
    expect(created.tools).toHaveLength(1);
    expect(created.resources).toHaveLength(1);
    expect(created.command).toBeUndefined();
    expect(created.args).toBeUndefined();
  });

  dbTest('should handle repo scope with repo_id', async ({ db }) => {
    const mcpRepo = new MCPServerRepository(db);
    const { RepoRepository } = await import('./repos');
    const repoRepo = new RepoRepository(db);

    // Create actual repo first (FK constraint)
    const testRepo = await repoRepo.create({
      slug: 'test-repo',
      name: 'Test Repo',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/test',
      default_branch: 'main',
    });

    const data = createMCPServerData({
      name: 'repo-server',
      transport: 'stdio',
      scope: 'repo',
      repo_id: testRepo.repo_id,
    });

    const created = await mcpRepo.create(data);

    expect(created.scope).toBe('repo');
    expect(created.repo_id).toBe(testRepo.repo_id);
    expect(created.owner_user_id).toBeUndefined();
    expect(created.team_id).toBeUndefined();
    expect(created.session_id).toBeUndefined();
  });

  dbTest('should handle session scope with session_id', async ({ db }) => {
    const mcpRepo = new MCPServerRepository(db);

    // Create repo and worktree first (FK constraints for session)
    const { RepoRepository } = await import('./repos');
    const { WorktreeRepository } = await import('./worktrees');
    const { SessionRepository } = await import('./sessions');

    const repoRepo = new RepoRepository(db);
    const testRepo = await repoRepo.create({
      slug: 'test-session-repo',
      name: 'Test Session Repo',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/test',
      default_branch: 'main',
    });

    const worktreeRepo = new WorktreeRepository(db);
    const testWorktree = await worktreeRepo.create({
      repo_id: testRepo.repo_id,
      name: 'main',
      ref: 'main',
      worktree_unique_id: 1,
      path: '/tmp/test',
      base_ref: 'main',
      new_branch: false,
    });

    const sessionRepo = new SessionRepository(db);
    const testSession = await sessionRepo.create({
      worktree_id: testWorktree.worktree_id,
      agentic_tool: 'claude-code',
      status: 'idle',
      created_by: 'test',
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    });

    const data = createMCPServerData({
      name: 'session-server',
      transport: 'stdio',
      scope: 'session',
      session_id: testSession.session_id,
    });

    const created = await mcpRepo.create(data);

    expect(created.scope).toBe('session');
    expect(created.session_id).toBe(testSession.session_id);
    expect(created.owner_user_id).toBeUndefined();
    expect(created.team_id).toBeUndefined();
    expect(created.repo_id).toBeUndefined();
  });

  dbTest('should preserve timestamps if provided', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const createdAt = new Date('2024-01-01T00:00:00Z');
    const updatedAt = new Date('2024-01-02T00:00:00Z');
    const data = createMCPServerData({
      created_at: createdAt,
      updated_at: updatedAt,
    });

    const created = await repo.create(data);

    expect(created.created_at).toEqual(createdAt);
    expect(created.updated_at).toEqual(updatedAt);
  });
});

// ============================================================================
// FindById (with short ID support)
// ============================================================================

describe('MCPServerRepository.findById', () => {
  dbTest('should find server by full UUID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({ name: 'test-server' });
    await repo.create(data);

    const found = await repo.findById(data.mcp_server_id);

    expect(found).not.toBeNull();
    expect(found?.mcp_server_id).toBe(data.mcp_server_id);
    expect(found?.name).toBe('test-server');
  });

  dbTest('should find server by 8-char short ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({ name: 'short-id-test' });
    await repo.create(data);

    const shortId = (data.mcp_server_id as string).replace(/-/g, '').slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.mcp_server_id).toBe(data.mcp_server_id);
  });

  dbTest('should handle short ID with hyphens', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    await repo.create(data);

    const shortId = (data.mcp_server_id as string).slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.mcp_server_id).toBe(data.mcp_server_id);
  });

  dbTest('should be case-insensitive', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    await repo.create(data);

    const shortId = (data.mcp_server_id as string).replace(/-/g, '').slice(0, 8).toUpperCase();
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.mcp_server_id).toBe(data.mcp_server_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const found = await repo.findById('99999999');

    expect(found).toBeNull();
  });

  dbTest('should throw AmbiguousIdError for ambiguous short ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const id1 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as MCPServerID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-000000000000' as MCPServerID;

    await repo.create(createMCPServerData({ mcp_server_id: id1, name: 'server-1' }));
    await repo.create(createMCPServerData({ mcp_server_id: id2, name: 'server-2' }));

    const ambiguousPrefix = '01933e4a';

    await expect(repo.findById(ambiguousPrefix)).rejects.toThrow(AmbiguousIdError);
  });

  dbTest('should provide helpful suggestions for ambiguous ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as MCPServerID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as MCPServerID;

    await repo.create(createMCPServerData({ mcp_server_id: id1, name: 'server-1' }));
    await repo.create(createMCPServerData({ mcp_server_id: id2, name: 'server-2' }));

    const shortPrefix = '01933e4a';

    try {
      await repo.findById(shortPrefix);
      throw new Error('Expected AmbiguousIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousIdError);
      const ambiguousError = error as AmbiguousIdError;
      expect(ambiguousError.matches).toHaveLength(2);
    }
  });

  dbTest('should preserve all JSON fields when retrieving', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'comprehensive-server',
      display_name: 'Comprehensive MCP Server',
      description: 'Testing all fields',
      command: 'node',
      args: ['server.js', '--verbose'],
      env: { KEY: 'value', DEBUG: 'true' },
      tools: [{ name: 'test-tool', description: 'Test', input_schema: {} }],
      resources: [{ uri: 'test://resource', name: 'Test Resource' }],
      prompts: [{ name: 'test-prompt', description: 'Test prompt' }],
    });
    await repo.create(data);

    const found = await repo.findById(data.mcp_server_id);

    expect(found?.display_name).toBe('Comprehensive MCP Server');
    expect(found?.description).toBe('Testing all fields');
    expect(found?.command).toBe('node');
    expect(found?.args).toEqual(['server.js', '--verbose']);
    expect(found?.env).toEqual({ KEY: 'value', DEBUG: 'true' });
    expect(found?.tools).toHaveLength(1);
    expect(found?.resources).toHaveLength(1);
    expect(found?.prompts).toHaveLength(1);
  });
});

// ============================================================================
// FindAll (with filters)
// ============================================================================

describe('MCPServerRepository.findAll', () => {
  dbTest('should return empty array when no servers', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const servers = await repo.findAll();

    expect(servers).toEqual([]);
  });

  dbTest('should return all servers without filters', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'server-1' }));
    await repo.create(createMCPServerData({ name: 'server-2' }));
    await repo.create(createMCPServerData({ name: 'server-3' }));

    const servers = await repo.findAll();

    expect(servers).toHaveLength(3);
    expect(servers.map((s) => s.name).sort()).toEqual(['server-1', 'server-2', 'server-3']);
  });

  dbTest('should filter by scope', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'global-1', scope: 'global' }));
    await repo.create(createMCPServerData({ name: 'team-1', scope: 'team' }));
    await repo.create(createMCPServerData({ name: 'global-2', scope: 'global' }));

    const globalServers = await repo.findAll({ scope: 'global' });

    expect(globalServers).toHaveLength(2);
    expect(globalServers.map((s) => s.name).sort()).toEqual(['global-1', 'global-2']);
  });

  dbTest('should filter by scope and scopeId for global scope', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const userId1 = generateId() as UserID;
    const userId2 = generateId() as UserID;

    await repo.create(
      createMCPServerData({ name: 'user1-server', scope: 'global', owner_user_id: userId1 })
    );
    await repo.create(
      createMCPServerData({ name: 'user2-server', scope: 'global', owner_user_id: userId2 })
    );

    const user1Servers = await repo.findAll({ scope: 'global', scopeId: userId1 });

    expect(user1Servers).toHaveLength(1);
    expect(user1Servers[0].name).toBe('user1-server');
  });

  dbTest('should filter by scope and scopeId for team scope', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const teamId1 = generateId() as TeamID;
    const teamId2 = generateId() as TeamID;

    await repo.create(
      createMCPServerData({ name: 'team1-server', scope: 'team', team_id: teamId1 })
    );
    await repo.create(
      createMCPServerData({ name: 'team2-server', scope: 'team', team_id: teamId2 })
    );

    const team1Servers = await repo.findAll({ scope: 'team', scopeId: teamId1 });

    expect(team1Servers).toHaveLength(1);
    expect(team1Servers[0].name).toBe('team1-server');
  });

  dbTest('should filter by scope and scopeId for repo scope', async ({ db }) => {
    const mcpRepo = new MCPServerRepository(db);
    const { RepoRepository } = await import('./repos');
    const repoRepo = new RepoRepository(db);

    // Create actual repos first (FK constraint)
    const testRepo1 = await repoRepo.create({
      slug: 'test-repo-1',
      name: 'Test Repo 1',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo1.git',
      local_path: '/tmp/test1',
      default_branch: 'main',
    });
    const testRepo2 = await repoRepo.create({
      slug: 'test-repo-2',
      name: 'Test Repo 2',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo2.git',
      local_path: '/tmp/test2',
      default_branch: 'main',
    });

    await mcpRepo.create(
      createMCPServerData({ name: 'repo1-server', scope: 'repo', repo_id: testRepo1.repo_id })
    );
    await mcpRepo.create(
      createMCPServerData({ name: 'repo2-server', scope: 'repo', repo_id: testRepo2.repo_id })
    );

    const repo1Servers = await mcpRepo.findAll({ scope: 'repo', scopeId: testRepo1.repo_id });

    expect(repo1Servers).toHaveLength(1);
    expect(repo1Servers[0].name).toBe('repo1-server');
  });

  dbTest('should filter by scope and scopeId for session scope', async ({ db }) => {
    const mcpRepo = new MCPServerRepository(db);

    // Create repos, worktrees, and sessions (FK constraints)
    const { RepoRepository } = await import('./repos');
    const { WorktreeRepository } = await import('./worktrees');
    const { SessionRepository } = await import('./sessions');

    const repoRepo = new RepoRepository(db);
    const testRepo = await repoRepo.create({
      slug: 'test-session-scope-repo',
      name: 'Test Session Scope Repo',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/test',
      default_branch: 'main',
    });

    const worktreeRepo = new WorktreeRepository(db);
    const testWorktree1 = await worktreeRepo.create({
      repo_id: testRepo.repo_id,
      name: 'main1',
      ref: 'main',
      worktree_unique_id: 1,
      path: '/tmp/test1',
      base_ref: 'main',
      new_branch: false,
    });
    const testWorktree2 = await worktreeRepo.create({
      repo_id: testRepo.repo_id,
      name: 'main2',
      ref: 'main',
      worktree_unique_id: 2,
      path: '/tmp/test2',
      base_ref: 'main',
      new_branch: false,
    });

    const sessionRepo = new SessionRepository(db);
    const testSession1 = await sessionRepo.create({
      worktree_id: testWorktree1.worktree_id,
      agentic_tool: 'claude-code',
      status: 'idle',
      created_by: 'test',
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    });
    const testSession2 = await sessionRepo.create({
      worktree_id: testWorktree2.worktree_id,
      agentic_tool: 'claude-code',
      status: 'idle',
      created_by: 'test',
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    });

    await mcpRepo.create(
      createMCPServerData({
        name: 'session1-server',
        scope: 'session',
        session_id: testSession1.session_id,
      })
    );
    await mcpRepo.create(
      createMCPServerData({
        name: 'session2-server',
        scope: 'session',
        session_id: testSession2.session_id,
      })
    );

    const session1Servers = await mcpRepo.findAll({
      scope: 'session',
      scopeId: testSession1.session_id,
    });

    expect(session1Servers).toHaveLength(1);
    expect(session1Servers[0].name).toBe('session1-server');
  });

  dbTest('should filter by transport', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'stdio-1', transport: 'stdio' }));
    await repo.create(createMCPServerData({ name: 'http-1', transport: 'http' }));
    await repo.create(createMCPServerData({ name: 'stdio-2', transport: 'stdio' }));

    const stdioServers = await repo.findAll({ transport: 'stdio' });

    expect(stdioServers).toHaveLength(2);
    expect(stdioServers.map((s) => s.name).sort()).toEqual(['stdio-1', 'stdio-2']);
  });

  dbTest('should filter by enabled status', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'enabled-1', enabled: true }));
    await repo.create(createMCPServerData({ name: 'disabled-1', enabled: false }));
    await repo.create(createMCPServerData({ name: 'enabled-2', enabled: true }));

    const enabledServers = await repo.findAll({ enabled: true });

    expect(enabledServers).toHaveLength(2);
    expect(enabledServers.map((s) => s.name).sort()).toEqual(['enabled-1', 'enabled-2']);
  });

  dbTest('should filter by source', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'user-1', source: 'user' }));
    await repo.create(createMCPServerData({ name: 'imported-1', source: 'imported' }));
    await repo.create(createMCPServerData({ name: 'user-2', source: 'user' }));

    const userServers = await repo.findAll({ source: 'user' });

    expect(userServers).toHaveLength(2);
    expect(userServers.map((s) => s.name).sort()).toEqual(['user-1', 'user-2']);
  });

  dbTest('should support multiple filters simultaneously', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const userId = generateId() as UserID;

    await repo.create(
      createMCPServerData({
        name: 'match',
        scope: 'global',
        owner_user_id: userId,
        transport: 'stdio',
        enabled: true,
        source: 'user',
      })
    );
    await repo.create(
      createMCPServerData({
        name: 'no-match-disabled',
        scope: 'global',
        owner_user_id: userId,
        transport: 'stdio',
        enabled: false,
        source: 'user',
      })
    );
    await repo.create(
      createMCPServerData({
        name: 'no-match-http',
        scope: 'global',
        owner_user_id: userId,
        transport: 'http',
        enabled: true,
        source: 'user',
      })
    );

    const filtered = await repo.findAll({
      scope: 'global',
      scopeId: userId,
      transport: 'stdio',
      enabled: true,
      source: 'user',
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('match');
  });
});

// ============================================================================
// FindByScope
// ============================================================================

describe('MCPServerRepository.findByScope', () => {
  dbTest('should find servers by scope without scopeId', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'global-1', scope: 'global' }));
    await repo.create(createMCPServerData({ name: 'team-1', scope: 'team' }));

    const globalServers = await repo.findByScope('global');

    expect(globalServers).toHaveLength(1);
    expect(globalServers[0].name).toBe('global-1');
  });

  dbTest('should find servers by scope with scopeId', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const teamId = generateId() as TeamID;

    await repo.create(
      createMCPServerData({ name: 'team1-server', scope: 'team', team_id: teamId })
    );

    const teamServers = await repo.findByScope('team', teamId);

    expect(teamServers).toHaveLength(1);
    expect(teamServers[0].name).toBe('team1-server');
  });
});

// ============================================================================
// Update
// ============================================================================

describe('MCPServerRepository.update', () => {
  dbTest('should update server by full UUID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({ name: 'original' });
    await repo.create(data);

    const updated = await repo.update(data.mcp_server_id, {
      display_name: 'Updated Display Name',
    });

    expect(updated.display_name).toBe('Updated Display Name');
    expect(updated.mcp_server_id).toBe(data.mcp_server_id);
    expect(updated.name).toBe('original');
  });

  dbTest('should update server by short ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({ enabled: true });
    await repo.create(data);

    const shortId = (data.mcp_server_id as string).replace(/-/g, '').slice(0, 8);
    const updated = await repo.update(shortId, { enabled: false });

    expect(updated.enabled).toBe(false);
    expect(updated.mcp_server_id).toBe(data.mcp_server_id);
  });

  dbTest('should update multiple fields', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      display_name: 'Original',
      description: 'Original description',
      enabled: true,
    });
    await repo.create(data);

    const updated = await repo.update(data.mcp_server_id, {
      display_name: 'Updated',
      description: 'Updated description',
      enabled: false,
    });

    expect(updated.display_name).toBe('Updated');
    expect(updated.description).toBe('Updated description');
    expect(updated.enabled).toBe(false);
  });

  dbTest('should update transport-specific config fields', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      transport: 'stdio',
      command: 'node',
      args: ['old.js'],
    });
    await repo.create(data);

    const updated = await repo.update(data.mcp_server_id, {
      command: 'npx',
      args: ['new-package', '--flag'],
    });

    expect(updated.command).toBe('npx');
    expect(updated.args).toEqual(['new-package', '--flag']);
  });

  dbTest('should update environment variables', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      env: { OLD_KEY: 'old-value' },
    });
    await repo.create(data);

    const updated = await repo.update(data.mcp_server_id, {
      env: { NEW_KEY: 'new-value', ANOTHER_KEY: 'another' },
    });

    expect(updated.env).toEqual({ NEW_KEY: 'new-value', ANOTHER_KEY: 'another' });
  });

  dbTest('should update updated_at timestamp', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    const created = await repo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(data.mcp_server_id, { enabled: false });

    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
      new Date(created.updated_at).getTime()
    );
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await expect(repo.update('99999999', { enabled: false })).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should preserve unchanged fields', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'preserve-test',
      display_name: 'Original Display Name',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    const created = await repo.create(data);

    const updated = await repo.update(data.mcp_server_id, { enabled: false });

    expect(updated.name).toBe(created.name);
    expect(updated.display_name).toBe(created.display_name);
    expect(updated.transport).toBe(created.transport);
    expect(updated.command).toBe(created.command);
    expect(updated.args).toEqual(created.args);
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('MCPServerRepository.delete', () => {
  dbTest('should delete server by full UUID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    await repo.create(data);

    await repo.delete(data.mcp_server_id);

    const found = await repo.findById(data.mcp_server_id);
    expect(found).toBeNull();
  });

  dbTest('should delete server by short ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData();
    await repo.create(data);

    const shortId = (data.mcp_server_id as string).replace(/-/g, '').slice(0, 8);
    await repo.delete(shortId);

    const found = await repo.findById(data.mcp_server_id);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await expect(repo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should not affect other servers', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data1 = createMCPServerData({ name: 'server-1' });
    const data2 = createMCPServerData({ name: 'server-2' });
    await repo.create(data1);
    await repo.create(data2);

    await repo.delete(data1.mcp_server_id);

    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('server-2');
  });
});

// ============================================================================
// Count
// ============================================================================

describe('MCPServerRepository.count', () => {
  dbTest('should return 0 for empty database', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const count = await repo.count();

    expect(count).toBe(0);
  });

  dbTest('should return correct count', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'server-1' }));
    await repo.create(createMCPServerData({ name: 'server-2' }));
    await repo.create(createMCPServerData({ name: 'server-3' }));

    const count = await repo.count();

    expect(count).toBe(3);
  });

  dbTest('should update count after delete', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data1 = createMCPServerData({ name: 'server-1' });
    const data2 = createMCPServerData({ name: 'server-2' });

    await repo.create(data1);
    await repo.create(data2);
    expect(await repo.count()).toBe(2);

    await repo.delete(data1.mcp_server_id);
    expect(await repo.count()).toBe(1);
  });

  dbTest('should count with filters', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    await repo.create(createMCPServerData({ name: 'enabled-1', enabled: true }));
    await repo.create(createMCPServerData({ name: 'disabled-1', enabled: false }));
    await repo.create(createMCPServerData({ name: 'enabled-2', enabled: true }));

    const enabledCount = await repo.count({ enabled: true });

    expect(enabledCount).toBe(2);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('MCPServerRepository edge cases', () => {
  dbTest('should handle different transport types', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const stdio = await repo.create(createMCPServerData({ name: 'stdio', transport: 'stdio' }));
    const http = await repo.create(createMCPServerData({ name: 'http', transport: 'http' }));
    const sse = await repo.create(createMCPServerData({ name: 'sse', transport: 'sse' }));

    expect(stdio.transport).toBe('stdio');
    expect(http.transport).toBe('http');
    expect(sse.transport).toBe('sse');
  });

  dbTest('should handle different source types', async ({ db }) => {
    const repo = new MCPServerRepository(db);

    const user = await repo.create(createMCPServerData({ name: 'user', source: 'user' }));
    const imported = await repo.create(
      createMCPServerData({ name: 'imported', source: 'imported' })
    );
    const agor = await repo.create(createMCPServerData({ name: 'agor', source: 'agor' }));

    expect(user.source).toBe('user');
    expect(imported.source).toBe('imported');
    expect(agor.source).toBe('agor');
  });

  dbTest('should handle servers with no optional fields', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'minimal',
      transport: 'stdio',
      scope: 'global',
    });

    const created = await repo.create(data);

    expect(created.display_name).toBeUndefined();
    expect(created.description).toBeUndefined();
    expect(created.command).toBeUndefined();
    expect(created.args).toBeUndefined();
    expect(created.url).toBeUndefined();
    expect(created.env).toBeUndefined();
    expect(created.tools).toBeUndefined();
    expect(created.resources).toBeUndefined();
    expect(created.prompts).toBeUndefined();
  });

  dbTest('should handle complex nested capabilities', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'complex',
      tools: [
        {
          name: 'complex-tool',
          description: 'Complex tool with nested schema',
          input_schema: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                properties: {
                  nested: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
            required: ['config'],
          },
        },
      ],
    });

    const created = await repo.create(data);

    expect(created.tools![0].input_schema).toHaveProperty('properties');
    expect((created.tools![0].input_schema as any).properties.config.properties.nested.type).toBe(
      'array'
    );
  });

  dbTest('should handle empty arrays for capabilities', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'empty-capabilities',
      tools: [],
      resources: [],
      prompts: [],
    });

    const created = await repo.create(data);

    expect(created.tools).toEqual([]);
    expect(created.resources).toEqual([]);
    expect(created.prompts).toEqual([]);
  });

  dbTest('should handle servers with many environment variables', async ({ db }) => {
    const repo = new MCPServerRepository(db);
    const data = createMCPServerData({
      name: 'many-env-vars',
      env: {
        VAR1: 'value1',
        VAR2: 'value2',
        VAR3: 'value3',
        VAR4: 'value4',
        VAR5: 'value5',
        LONG_VALUE: 'a'.repeat(1000),
      },
    });

    const created = await repo.create(data);

    expect(Object.keys(created.env!)).toHaveLength(6);
    expect(created.env!.LONG_VALUE).toHaveLength(1000);
  });
});
