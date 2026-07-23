import fs from 'node:fs';
import path from 'node:path';
import { buildClaudeCliSpawn } from '@agor/core/claude-cli';
import {
  getCurrentTenantDatabaseScope,
  runWithTenantContext,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { type Session, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSessionToken } from '../mcp/tokens.js';
import {
  buildClaudeCliAgorMcpConfig,
  buildCliEventSink,
  buildSpawnConfigForSession,
  resolveClaudeCliMcpConfigTargetUnixUser,
  setPendingCliTask,
  stopClaudeCliTask,
  writeClaudeCliMcpConfigFile,
  writeClaudeCliMcpConfigForSession,
} from './claude-cli-integration';

vi.mock('../mcp/tokens.js', () => ({
  generateSessionToken: vi.fn(async () => 'tok_test'),
}));

const generatedPaths: string[] = [];
const testDb = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;

function makeApp(
  config: {
    daemon?: { mcpEnabled?: boolean };
    execution?: { unix_user_mode?: string; executor_unix_user?: string | null };
  } = {}
): Application {
  return {
    get: (key: string) => {
      if (key === 'config') return config;
      if (key === 'database') return testDb;
      return undefined;
    },
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const filePath of generatedPaths.splice(0)) {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

describe('Claude CLI integration', () => {
  it('sends Ctrl-C through the existing terminal channel and stays unverified without watcher confirmation', async () => {
    const task = {
      task_id: '019e8abc-0000-7000-8000-000000000002',
      session_id: makeSession().session_id,
      status: 'running',
      created_at: new Date().toISOString(),
    };
    const emit = vi.fn();
    const settleTermination = vi.fn(async () => ({
      outcome: 'unverified',
      task: { ...task, status: 'stopping', sdk_failure: { termination: 'unverified' } },
    }));
    const app = {
      io: { to: vi.fn(() => ({ emit })) },
      service: () => ({
        claimTermination: vi.fn(async () => ({
          outcome: 'claimed',
          task: { ...task, status: 'stopping' },
        })),
        settleTermination,
      }),
    } as unknown as Application;

    const result = await stopClaudeCliTask({
      app,
      session: makeSession({ status: 'running', tasks: [task.task_id] as never }),
      task: task as never,
      timeoutMs: 1,
    });

    expect(emit).toHaveBeenCalledWith('terminal:input', {
      userId: 'user-1',
      input: '\x03',
    });
    expect(settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unverified' }),
      expect.objectContaining({ provider: undefined })
    );
    expect(result.status).toBe('unverified');
  });

  it('settles a Stop that wins the turn_end race without releasing the session itself', async () => {
    const sessionId = makeSession().session_id;
    const taskId = '019e8abc-0000-7000-8000-000000000002';
    const runningTask = {
      task_id: taskId,
      session_id: sessionId,
      status: TaskStatus.RUNNING,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: '2026-07-20T10:00:00.000Z',
      },
    };
    const stoppingTask = {
      ...runningTask,
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-20T10:00:01.000Z',
      },
    };
    const patchTask = vi.fn(async (_id: string, data: Record<string, unknown>) => {
      if (data.status === TaskStatus.COMPLETED) {
        throw new Error('termination-owned tasks must be settled');
      }
      return { ...stoppingTask, ...data };
    });
    const settleTermination = vi.fn(async () => ({
      outcome: 'transitioned',
      task: { ...stoppingTask, status: TaskStatus.STOPPED },
    }));
    const claimTermination = vi.fn(async () => ({ outcome: 'claimed', task: stoppingTask }));
    const patchSession = vi.fn();
    const app = {
      get: () => undefined,
      service: (name: string) => {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => runningTask),
            patch: patchTask,
            claimTermination,
            settleTermination,
          };
        }
        if (name === 'sessions') return { patch: patchSession };
        throw new Error(`unexpected service ${name}`);
      },
    } as unknown as Application;
    const sink = buildCliEventSink(app);
    setPendingCliTask(sessionId, taskId as never, 0);

    await sink(sessionId, {
      type: 'user_message',
      content: 'ping',
      timestamp: '2026-07-20T10:00:00.000Z',
      isSidechain: false,
    });
    await sink(sessionId, {
      type: 'turn_end',
      messageId: 'turn-end',
      timestamp: '2026-07-20T10:00:02.000Z',
      interrupted: true,
    });

    expect(claimTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, cause: 'user_stop' }),
      { provider: undefined }
    );
    expect(patchTask).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: TaskStatus.COMPLETED }),
      { provider: undefined }
    );
    expect(settleTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, outcome: 'verified_absent' }),
      expect.objectContaining({ provider: undefined })
    );
    expect(patchSession).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ status: 'idle', ready_for_prompt: true })
    );
  });

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
    vi.mocked(generateSessionToken).mockImplementationOnce(async () => {
      expect(getCurrentTenantDatabaseScope()).toMatchObject({
        kind: 'tenant',
        tenantId: 'tenant-x',
      });
      return 'tok_test';
    });
    const filePath = await runWithTenantContext('tenant-x', () =>
      writeClaudeCliMcpConfigForSession(makeApp(), makeSession(), {
        actor: { user_id: 'user-1', role: 'member' },
      })
    );
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

  it('keeps token issuance best-effort after tenant scope entry succeeds', async () => {
    vi.mocked(generateSessionToken).mockRejectedValueOnce(new Error('temporary token store error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      runWithTenantContext('tenant-x', () =>
        writeClaudeCliMcpConfigForSession(makeApp(), makeSession(), {
          actor: { user_id: 'user-1', role: 'member' },
        })
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to issue MCP token'),
      'temporary token store error'
    );
  });

  it('fails fast before token issuance without tenant identity', async () => {
    await expect(
      writeClaudeCliMcpConfigForSession(makeApp(), makeSession(), {
        actor: { user_id: 'user-1', role: 'member' },
      })
    ).rejects.toThrow('Missing active tenant context for Claude CLI MCP config generation');
    expect(generateSessionToken).not.toHaveBeenCalled();
  });

  it('resolves the MCP config file owner from Unix isolation mode', () => {
    expect(resolveClaudeCliMcpConfigTargetUnixUser(undefined, makeSession())).toBeUndefined();

    expect(
      resolveClaudeCliMcpConfigTargetUnixUser(
        { execution: { unix_user_mode: 'insulated', executor_unix_user: 'agor_executor' } },
        makeSession({ unix_username: 'alice' })
      )
    ).toBe('agor_executor');

    expect(
      resolveClaudeCliMcpConfigTargetUnixUser(
        { execution: { unix_user_mode: 'strict' } },
        makeSession({ unix_username: 'alice' })
      )
    ).toBe('alice');
  });

  it('validates target-user config paths before attempting privileged writes', () => {
    expect(() =>
      writeClaudeCliMcpConfigFile({
        mcpConfig: buildClaudeCliAgorMcpConfig({
          daemonUrl: 'https://agor.example.test',
          mcpToken: 'tok_123',
        }),
        sessionShortId: '019e8abc',
        targetUnixUser: 'bad user',
      })
    ).toThrow('invalid target Unix username');
  });
});
