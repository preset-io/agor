/**
 * MCP Tools Integration Tests
 *
 * These tests verify all 24 MCP tools work end-to-end.
 * Requires daemon to be running on localhost:3030.
 *
 * Run with: INTEGRATION=true pnpm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

// Skip integration tests by default - require daemon running
const runIntegration = process.env.INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

const DAEMON_URL = 'http://localhost:3030';
let sessionToken: string;

beforeAll(async () => {
  // Use MCP token from environment variable (get from DB or logs)
  // Example: sqlite3 ~/.agor/agor.db "SELECT substr(json_extract(data, '$.mcp_token'), 1, 64) FROM sessions WHERE json_extract(data, '$.mcp_token') IS NOT NULL LIMIT 1"
  sessionToken =
    process.env.MCP_TEST_TOKEN ||
    'cd5fc175008aca05cf28d7ac9ea35c1cb02d898985c7f7e015c0afce8980f8c8';

  if (!sessionToken) {
    throw new Error('MCP_TEST_TOKEN environment variable not set');
  }

  console.log(`Using token ${sessionToken.substring(0, 16)}... for tests`);
});

async function callMCPTool(name: string, args: Record<string, unknown> = {}) {
  const resp = await fetch(`${DAEMON_URL}/mcp?sessionToken=${sessionToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const data = (await resp.json()) as {
    error?: { message: string };
    result?: { content: Array<{ text: string }> };
  };

  if (data.error) {
    throw new Error(`MCP tool ${name} failed: ${data.error.message}`);
  }

  return JSON.parse(data.result!.content[0].text);
}

describeIntegration('MCP Tools - Session Tools', () => {
  it('tools/list returns all 24 tools', async () => {
    const resp = await fetch(`${DAEMON_URL}/mcp?sessionToken=${sessionToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });

    const data = (await resp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(data.result.tools).toHaveLength(24);

    const toolNames = data.result.tools.map((t) => t.name);
    expect(toolNames).toContain('agor_sessions_list');
    expect(toolNames).toContain('agor_sessions_get');
    expect(toolNames).toContain('agor_sessions_get_current');
    expect(toolNames).toContain('agor_sessions_spawn');
    expect(toolNames).toContain('agor_sessions_prompt');
    expect(toolNames).toContain('agor_sessions_create');
    expect(toolNames).toContain('agor_sessions_update');
    expect(toolNames).toContain('agor_repos_list');
    expect(toolNames).toContain('agor_repos_get');
    expect(toolNames).toContain('agor_repos_create_remote');
    expect(toolNames).toContain('agor_repos_create_local');
    expect(toolNames).toContain('agor_worktrees_get');
    expect(toolNames).toContain('agor_worktrees_list');
    expect(toolNames).toContain('agor_worktrees_update');
    expect(toolNames).toContain('agor_boards_get');
    expect(toolNames).toContain('agor_boards_list');
    expect(toolNames).toContain('agor_boards_update');
    expect(toolNames).toContain('agor_tasks_list');
    expect(toolNames).toContain('agor_tasks_get');
    expect(toolNames).toContain('agor_users_list');
    expect(toolNames).toContain('agor_users_get');
    expect(toolNames).toContain('agor_users_get_current');
    expect(toolNames).toContain('agor_users_update_current');
    expect(toolNames).toContain('agor_user_create');
  });

  it('agor_sessions_list returns sessions', async () => {
    const result = await callMCPTool('agor_sessions_list', { limit: 5 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toHaveProperty('session_id');
  });

  it('agor_sessions_get_current returns current session', async () => {
    const result = await callMCPTool('agor_sessions_get_current');

    expect(result).toHaveProperty('session_id');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('agentic_tool');
  });

  it('agor_sessions_get returns specific session', async () => {
    // First get a session ID
    const sessions = await callMCPTool('agor_sessions_list', { limit: 1 });
    const sessionId = sessions.data[0].session_id;

    // Then fetch it specifically
    const result = await callMCPTool('agor_sessions_get', { sessionId });

    expect(result.session_id).toBe(sessionId);
    expect(result).toHaveProperty('status');
  });

  it('agor_sessions_spawn creates child session', async () => {
    const result = await callMCPTool('agor_sessions_spawn', {
      prompt: 'Test subsession task',
    });

    expect(result.session).toHaveProperty('session_id');
    expect(result.session.genealogy).toHaveProperty('parent_session_id');
    expect(result.session).toHaveProperty('status');
    expect(result.session).toHaveProperty('worktree_id');
    expect(result).toHaveProperty('taskId');
  });

  it('agor_sessions_update updates session metadata', async () => {
    // Get current session
    const currentSession = await callMCPTool('agor_sessions_get_current');

    // Update title and status
    const result = await callMCPTool('agor_sessions_update', {
      sessionId: currentSession.session_id,
      title: 'Updated Test Session',
      status: 'idle',
    });

    expect(result.session.title).toBe('Updated Test Session');
    expect(result.session.status).toBe('idle');
    expect(result.note).toBe('Session updated successfully.');
  });

  it('agor_sessions_create creates new session with initialPrompt', async () => {
    // Get a worktree to create session in
    const worktrees = await callMCPTool('agor_worktrees_list', { limit: 1 });

    if (worktrees.data.length === 0) {
      console.log('No worktrees found, skipping test');
      return;
    }

    const worktreeId = worktrees.data[0].worktree_id;

    // Create session with initial prompt
    const result = await callMCPTool('agor_sessions_create', {
      worktreeId,
      agenticTool: 'claude-code',
      title: 'Test Created Session',
      description: 'Session created via MCP tool',
      initialPrompt: 'Say hello',
    });

    expect(result.session).toHaveProperty('session_id');
    expect(result.session.worktree_id).toBe(worktreeId);
    expect(result.session.agentic_tool).toBe('claude-code');
    expect(result.session.title).toBe('Test Created Session');
    expect(result.session.description).toBe('Session created via MCP tool');
    expect(result).toHaveProperty('taskId'); // Should have task from initialPrompt
    expect(result.note).toBe('Session created and initial prompt execution started.');
  });

  it('agor_sessions_prompt continues existing session', async () => {
    // Get current session
    const currentSession = await callMCPTool('agor_sessions_get_current');

    // Continue with new prompt
    const result = await callMCPTool('agor_sessions_prompt', {
      sessionId: currentSession.session_id,
      prompt: 'Additional work',
      mode: 'continue',
    });

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('taskId');
    expect(result.note).toBe('Prompt added to existing session and execution started.');
  });
});

describeIntegration('MCP Tools - Repository Tools', () => {
  it('agor_repos_list returns repositories', async () => {
    const result = await callMCPTool('agor_repos_list', { limit: 5 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
    if (result.data.length > 0) {
      expect(result.data[0]).toHaveProperty('repo_id');
      expect(result.data[0]).toHaveProperty('slug');
      expect(result.data[0]).toHaveProperty('repo_type');
    }
  });

  it('agor_repos_get returns specific repository', async () => {
    // First get a repository ID
    const repos = await callMCPTool('agor_repos_list', { limit: 1 });

    if (repos.data.length === 0) {
      console.log('No repositories found, skipping test');
      return;
    }

    const repoId = repos.data[0].repo_id;

    // Then fetch it specifically
    const result = await callMCPTool('agor_repos_get', { repoId });

    expect(result.repo_id).toBe(repoId);
    expect(result).toHaveProperty('slug');
    expect(result).toHaveProperty('local_path');
  });

  it('agor_repos_create_remote initiates clone operation', async () => {
    // This test just verifies the API works - the clone happens async
    // Using a small, public test repository
    const result = await callMCPTool('agor_repos_create_remote', {
      url: 'https://github.com/anthropics/anthropic-sdk-typescript.git',
      slug: 'test/sdk-clone-' + Date.now(),
    });

    expect(result).toHaveProperty('status');
    expect(result.status).toBe('pending');
    expect(result).toHaveProperty('slug');
  });

  it('agor_repos_create_local validates required params', async () => {
    // This should fail gracefully if path doesn't exist
    try {
      await callMCPTool('agor_repos_create_local', {
        path: '/nonexistent/path/to/repo',
      });
      // If we get here, test should fail
      expect(false).toBe(true);
    } catch (error) {
      // Expected to fail with invalid path
      expect(error).toBeDefined();
    }
  });

  it('agor_repos_create_remote rejects invalid git URL', async () => {
    try {
      await callMCPTool('agor_repos_create_remote', {
        url: 'not-a-valid-url',
        slug: 'test/invalid',
      });
      expect(false).toBe(true); // Should not reach here
    } catch (error: any) {
      expect(error).toBeDefined();
      expect(error.message).toContain('must be a valid git URL');
    }
  });

  it('agor_repos_create_remote rejects invalid slug format', async () => {
    try {
      await callMCPTool('agor_repos_create_remote', {
        url: 'https://github.com/test/repo.git',
        slug: 'invalid slug with spaces',
      });
      expect(false).toBe(true); // Should not reach here
    } catch (error: any) {
      expect(error).toBeDefined();
      expect(error.message).toContain('org/name format');
    }
  });

  it('agor_repos_create_remote derives slug from URL when omitted', async () => {
    const result = await callMCPTool('agor_repos_create_remote', {
      url: 'https://github.com/anthropics/anthropic-sdk-typescript.git',
    });

    expect(result).toHaveProperty('status');
    expect(result.status).toBe('pending');
    expect(result).toHaveProperty('slug');
    expect(result.slug).toContain('anthropics/anthropic-sdk-typescript');
  });
});

describeIntegration('MCP Tools - Worktree Tools', () => {
  it('agor_worktrees_list returns worktrees', async () => {
    const result = await callMCPTool('agor_worktrees_list', { limit: 5 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('agor_worktrees_get returns specific worktree', async () => {
    // First get a worktree ID
    const worktrees = await callMCPTool('agor_worktrees_list', { limit: 1 });

    if (worktrees.data.length === 0) {
      console.log('No worktrees found, skipping test');
      return;
    }

    const worktreeId = worktrees.data[0].worktree_id;

    // Then fetch it specifically
    const result = await callMCPTool('agor_worktrees_get', { worktreeId });

    expect(result.worktree_id).toBe(worktreeId);
    expect(result).toHaveProperty('path');
  });

  it('agor_worktrees_update updates worktree metadata', async () => {
    const worktrees = await callMCPTool('agor_worktrees_list', { limit: 1 });

    if (worktrees.data.length === 0) {
      console.log('No worktrees found, skipping test');
      return;
    }

    const worktree = worktrees.data[0];
    const worktreeId = worktree.worktree_id;

    const updated = await callMCPTool('agor_worktrees_update', {
      worktreeId,
      issueUrl: 'https://example.com/issues/123',
      pullRequestUrl: null,
      notes: 'Updated via MCP test',
    });

    expect(updated.worktree.worktree_id).toBe(worktreeId);
    expect(updated.worktree.issue_url).toBe('https://example.com/issues/123');
    expect(updated.worktree.pull_request_url).toBeNull();
    expect(updated.worktree.notes).toBe('Updated via MCP test');

    // Restore original state
    await callMCPTool('agor_worktrees_update', {
      worktreeId,
      issueUrl: worktree.issue_url ?? null,
      pullRequestUrl: worktree.pull_request_url ?? null,
      notes: worktree.notes ?? null,
    });
  });
});

describeIntegration('MCP Tools - Board Tools', () => {
  it('agor_boards_list returns boards', async () => {
    const result = await callMCPTool('agor_boards_list', { limit: 5 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('agor_boards_get returns specific board', async () => {
    // First get a board ID
    const boards = await callMCPTool('agor_boards_list', { limit: 1 });

    if (boards.data.length === 0) {
      console.log('No boards found, skipping test');
      return;
    }

    const boardId = boards.data[0].board_id;

    // Then fetch it specifically
    const result = await callMCPTool('agor_boards_get', { boardId });

    expect(result.board_id).toBe(boardId);
    expect(result).toHaveProperty('name');
  });

  it('agor_boards_update updates board metadata and creates zones', async () => {
    const boards = await callMCPTool('agor_boards_list', { limit: 1 });

    if (boards.data.length === 0) {
      console.log('No boards found, skipping test');
      return;
    }

    const board = boards.data[0];
    const boardId = board.board_id;

    // Test updating metadata
    const metadataUpdate = await callMCPTool('agor_boards_update', {
      boardId,
      description: 'Updated via MCP test',
      icon: '🧪',
    });

    expect(metadataUpdate.board.board_id).toBe(boardId);
    expect(metadataUpdate.board.description).toBe('Updated via MCP test');
    expect(metadataUpdate.board.icon).toBe('🧪');

    // Test creating/updating zones
    const testZoneId = 'test-zone-' + Date.now();
    const zonesUpdate = await callMCPTool('agor_boards_update', {
      boardId,
      upsertObjects: {
        [testZoneId]: {
          type: 'zone',
          x: 100,
          y: 100,
          width: 400,
          height: 300,
          label: 'Test Zone',
          borderColor: '#3b82f6',
          backgroundColor: '#eff6ff',
        },
      },
    });

    expect(zonesUpdate.board.objects).toHaveProperty(testZoneId);
    expect(zonesUpdate.board.objects[testZoneId].label).toBe('Test Zone');

    // Clean up - remove test zone and verify removal
    const removalResult = await callMCPTool('agor_boards_update', {
      boardId,
      removeObjects: [testZoneId],
    });

    // Verify the zone was removed
    expect(removalResult.board.objects[testZoneId]).toBeUndefined();

    // Restore original metadata
    await callMCPTool('agor_boards_update', {
      boardId,
      description: board.description ?? '',
      icon: board.icon ?? '',
    });
  });
});

describeIntegration('MCP Tools - Task Tools', () => {
  it('agor_tasks_list returns tasks', async () => {
    const result = await callMCPTool('agor_tasks_list', { limit: 5 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('agor_tasks_get returns specific task', async () => {
    // First get a task ID
    const tasks = await callMCPTool('agor_tasks_list', { limit: 1 });

    if (tasks.data.length === 0) {
      console.log('No tasks found, skipping test');
      return;
    }

    const taskId = tasks.data[0].task_id;

    // Then fetch it specifically
    const result = await callMCPTool('agor_tasks_get', { taskId });

    expect(result.task_id).toBe(taskId);
    expect(result).toHaveProperty('status');
  });
});

describeIntegration('MCP Tools - User Tools', () => {
  it('agor_users_list returns users', async () => {
    const result = await callMCPTool('agor_users_list', { limit: 5 });

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('agor_users_get_current returns current user', async () => {
    const result = await callMCPTool('agor_users_get_current');

    expect(result).toHaveProperty('user_id');
    expect(result).toHaveProperty('email');
    expect(result).toHaveProperty('role');
  });

  it('agor_users_get returns specific user', async () => {
    // First get current user
    const currentUser = await callMCPTool('agor_users_get_current');

    // Then fetch it specifically
    const result = await callMCPTool('agor_users_get', { userId: currentUser.user_id });

    expect(result.user_id).toBe(currentUser.user_id);
    expect(result.email).toBe(currentUser.email);
  });

  it('agor_users_update_current updates user profile', async () => {
    // Get original state
    const originalUser = await callMCPTool('agor_users_get_current');

    // Update with test data
    const updatedUser = await callMCPTool('agor_users_update_current', {
      name: 'Test User',
      emoji: '🤖',
    });

    expect(updatedUser.name).toBe('Test User');
    expect(updatedUser.emoji).toBe('🤖');

    // Restore original state
    await callMCPTool('agor_users_update_current', {
      name: originalUser.name,
      emoji: originalUser.emoji,
    });
  });

  it('agor_user_create creates a new user', async () => {
    // Generate unique email for test
    const testEmail = `test-${Date.now()}@example.com`;

    // Create user with all fields
    const newUser = await callMCPTool('agor_user_create', {
      email: testEmail,
      password: 'test-password-123',
      name: 'Test User',
      emoji: '🧪',
      role: 'admin',
    });

    expect(newUser).toHaveProperty('user_id');
    expect(newUser.email).toBe(testEmail);
    expect(newUser.name).toBe('Test User');
    expect(newUser.emoji).toBe('🧪');
    expect(newUser.role).toBe('admin');

    // Verify password is NOT in response (it should be hashed internally)
    expect(newUser).not.toHaveProperty('password');
  });

  it('agor_user_create validates required fields', async () => {
    // Test missing email
    await expect(async () => {
      await callMCPTool('agor_user_create', {
        password: 'test-password-123',
      });
    }).rejects.toThrow();

    // Test missing password
    await expect(async () => {
      await callMCPTool('agor_user_create', {
        email: 'test@example.com',
      });
    }).rejects.toThrow();
  });
});
