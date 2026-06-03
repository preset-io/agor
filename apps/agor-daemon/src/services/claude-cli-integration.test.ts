import fs from 'node:fs';
import path from 'node:path';
import { buildClaudeCliSpawn } from '@agor/core/claude-cli';
import type { Application } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSessionToken } from '../mcp/tokens.js';
import {
  buildClaudeCliAgorMcpConfig,
  buildSpawnConfigForSession,
  writeClaudeCliMcpConfigForSession,
} from './claude-cli-integration';

vi.mock('../mcp/tokens.js', () => ({
  generateSessionToken: vi.fn(async () => 'tok_test'),
}));

const generatedPaths: string[] = [];

function makeApp(config: { daemon?: { mcpEnabled?: boolean } } = {}): Application {
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
  } as unknown as Application;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: '019e8abc-0000-7000-8000-000000000001',
    branch_id: 'branch-1',
    agentic_tool: 'claude-code-cli',
    status: 'idle',
    created_by: 'user-1',
    scheduled_from_branch: false,
    tasks: [],
    contextFiles: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Session;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const filePath of generatedPaths.splice(0)) {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

describe('Claude CLI Agor MCP config', () => {
  it('renders the Claude CLI mcpServers file shape with a session bearer token', () => {
    expect(
      buildClaudeCliAgorMcpConfig({ daemonUrl: 'https://agor.example.test/', mcpToken: 'tok_123' })
    ).toEqual({
      mcpServers: {
        agor: {
          type: 'http',
          url: 'https://agor.example.test/mcp',
          headers: { Authorization: 'Bearer tok_123' },
        },
      },
    });
  });

  it('passes the generated MCP config path into Claude CLI spawn argv', () => {
    const spawnCfg = buildSpawnConfigForSession(makeSession(), '/repo/branch', {
      mcpConfigPath: '/tmp/agor-mcp-test/mcp.json',
    });
    const built = buildClaudeCliSpawn(spawnCfg);

    expect(spawnCfg.mcpConfigPath).toBe('/tmp/agor-mcp-test/mcp.json');
    expect(built.args).toContain('--mcp-config');
    expect(built.args).toContain('/tmp/agor-mcp-test/mcp.json');
    expect(built.args).toContain('--strict-mcp-config');
  });

  it('does not write a config when daemon MCP is disabled', async () => {
    const filePath = await writeClaudeCliMcpConfigForSession(
      makeApp({ daemon: { mcpEnabled: false } }),
      makeSession()
    );

    expect(filePath).toBeUndefined();
    expect(generateSessionToken).not.toHaveBeenCalled();
  });

  it('does not mint an owner-scoped token for an unauthorized external actor', async () => {
    const filePath = await writeClaudeCliMcpConfigForSession(makeApp(), makeSession(), {
      actor: { user_id: 'other-user', role: 'member' },
    });

    expect(filePath).toBeUndefined();
    expect(generateSessionToken).not.toHaveBeenCalled();
  });

  it('writes a private temp config for the session creator', async () => {
    const filePath = await writeClaudeCliMcpConfigForSession(makeApp(), makeSession(), {
      actor: { user_id: 'user-1', role: 'member' },
    });
    expect(filePath).toBeTruthy();
    generatedPaths.push(filePath as string);

    const dirMode = fs.statSync(path.dirname(filePath as string)).mode & 0o777;
    const fileMode = fs.statSync(filePath as string).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const parsed = JSON.parse(fs.readFileSync(filePath as string, 'utf8'));
    expect(parsed.mcpServers.agor.url).toBe('http://localhost:3030/mcp');
    expect(parsed.mcpServers.agor.headers.Authorization).toBe('Bearer tok_test');
    expect(generateSessionToken).toHaveBeenCalledWith(
      expect.anything(),
      makeSession().session_id,
      'user-1'
    );
  });
});
