/**
 * MCP Tools Integration Tests
 *
 * These tests verify all 9 MCP tools work end-to-end.
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
  it('tools/list returns all 15 tools', async () => {
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
    expect(data.result.tools).toHaveLength(15);

    const toolNames = data.result.tools.map(t => t.name);
    expect(toolNames).toContain('agor_sessions_list');
    expect(toolNames).toContain('agor_sessions_get');
    expect(toolNames).toContain('agor_sessions_get_current');
    expect(toolNames).toContain('agor_sessions_spawn');
    expect(toolNames).toContain('agor_worktrees_get');
    expect(toolNames).toContain('agor_worktrees_list');
    expect(toolNames).toContain('agor_boards_get');
    expect(toolNames).toContain('agor_boards_list');
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

    expect(result).toHaveProperty('session_id');
    expect(result).toHaveProperty('parent_session_id');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('worktree_id');
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
