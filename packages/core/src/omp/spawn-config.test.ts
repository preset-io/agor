import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OmpRpcClient } from './rpc-client.js';
import {
  AGOR_MCP_TOKEN_ENV,
  AGOR_MCP_URL_ENV,
  AGOR_OMP_MCP_SERVER_NAME,
  buildOmpEnv,
  ensureAgorMcpConfig,
  getOmpAgentDir,
  getOmpMcpConfigPath,
} from './spawn-config.js';

describe('OmpRpcClient.buildArgs', () => {
  it('always runs in RPC mode', () => {
    expect(OmpRpcClient.buildArgs({})).toEqual(['--mode', 'rpc']);
  });

  it('omits --profile so OMP uses the host user login by default', () => {
    // A named profile starts with an empty auth store, so defaulting to one
    // would leave the agent unable to reach any model.
    expect(OmpRpcClient.buildArgs({})).not.toContain('--profile');
  });

  it('passes profile, model and resume through when supplied', () => {
    expect(
      OmpRpcClient.buildArgs({ profile: 'agor', model: 'opus', resume: '/s/abc.jsonl' })
    ).toEqual([
      '--mode',
      'rpc',
      '--profile',
      'agor',
      '--model',
      'opus',
      '--resume',
      '/s/abc.jsonl',
    ]);
  });

  it('emits --resume only when a prior session exists', () => {
    // Multi-turn continuity depends on this: each Agor task spawns a fresh
    // process, and --resume is what carries the conversation forward.
    expect(OmpRpcClient.buildArgs({ resume: 'sess-1' })).toContain('--resume');
    expect(OmpRpcClient.buildArgs({})).not.toContain('--resume');
  });
});

describe('getOmpAgentDir', () => {
  it('resolves the default profile outside the profiles tree', () => {
    expect(getOmpAgentDir(undefined, '/home/u')).toBe('/home/u/.omp/agent');
  });

  it('roots a named profile under profiles/<name>', () => {
    expect(getOmpAgentDir('agor', '/home/u')).toBe('/home/u/.omp/profiles/agor/agent');
    expect(getOmpMcpConfigPath('agor', '/home/u')).toBe(
      '/home/u/.omp/profiles/agor/agent/mcp.json'
    );
  });
});

describe('buildOmpEnv', () => {
  it('exports the Agor MCP endpoint when a session token was issued', () => {
    const env = buildOmpEnv({
      base: {},
      daemonUrl: 'http://127.0.0.1:5150',
      mcpToken: 'tok-1',
    });
    expect(env[AGOR_MCP_URL_ENV]).toBe('http://127.0.0.1:5150/mcp');
    expect(env[AGOR_MCP_TOKEN_ENV]).toBe('tok-1');
  });

  it('strips a trailing slash from the daemon URL', () => {
    const env = buildOmpEnv({ base: {}, daemonUrl: 'http://d/', mcpToken: 't' });
    expect(env[AGOR_MCP_URL_ENV]).toBe('http://d/mcp');
  });

  it('clears stale endpoint vars when no token is available', () => {
    // Degrades to "no Agor self-drive tools" rather than leaking another
    // session's credentials into this process.
    const env = buildOmpEnv({
      base: { [AGOR_MCP_URL_ENV]: 'http://old/mcp', [AGOR_MCP_TOKEN_ENV]: 'old' },
      daemonUrl: 'http://d',
    });
    expect(env[AGOR_MCP_URL_ENV]).toBeUndefined();
    expect(env[AGOR_MCP_TOKEN_ENV]).toBeUndefined();
  });

  it('pins OMP_PROFILE only when isolation was requested', () => {
    expect(buildOmpEnv({ base: {}, profile: 'agor' }).OMP_PROFILE).toBe('agor');
    expect(buildOmpEnv({ base: { OMP_PROFILE: 'stale' } }).OMP_PROFILE).toBeUndefined();
  });
});

describe('ensureAgorMcpConfig', () => {
  it('creates a templated Agor entry that OMP expands per process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omp-mcp-'));
    const path = await ensureAgorMcpConfig({ home });
    const config = JSON.parse(await readFile(path, 'utf8'));
    const server = config.mcpServers[AGOR_OMP_MCP_SERVER_NAME];

    expect(server.type).toBe('http');
    // Placeholders, not baked values: one shared file must stay correct for
    // concurrent sessions, and stay inert outside Agor.
    expect(server.url).toBe(`\${${AGOR_MCP_URL_ENV}}`);
    expect(server.headers.Authorization).toBe(`Bearer \${${AGOR_MCP_TOKEN_ENV}}`);
  });

  it('preserves MCP servers the user already configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omp-mcp-'));
    const agentDir = getOmpAgentDir(undefined, home);
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'my-server' } } }),
      'utf8'
    );

    const path = await ensureAgorMcpConfig({ home });
    const config = JSON.parse(await readFile(path, 'utf8'));
    expect(config.mcpServers.mine).toEqual({ command: 'my-server' });
    expect(config.mcpServers[AGOR_OMP_MCP_SERVER_NAME]).toBeDefined();
  });

  it('is idempotent across repeated session starts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omp-mcp-'));
    const path = await ensureAgorMcpConfig({ home });
    const first = await readFile(path, 'utf8');
    await ensureAgorMcpConfig({ home });
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('recovers from an unparseable config instead of throwing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omp-mcp-'));
    const agentDir = getOmpAgentDir(undefined, home);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'mcp.json'), '{ not json', 'utf8');

    const path = await ensureAgorMcpConfig({ home });
    const config = JSON.parse(await readFile(path, 'utf8'));
    expect(config.mcpServers[AGOR_OMP_MCP_SERVER_NAME]).toBeDefined();
  });
});
