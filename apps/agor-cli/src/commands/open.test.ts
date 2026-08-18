import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../..');
const deploymentId = '019c1234-5678-7123-8123-123456789abc';

/** Minimal daemon whose /health advertises the given deployment id. */
async function startHealthServer(id: string): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ service: 'agor-daemon', deploymentId: id }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return { server, port: address.port };
}

function runOpen(home: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const env = { ...process.env };
  delete env.AGOR_API_KEY;
  delete env.AGOR_DEPLOYMENT_ID;
  delete env.DAEMON_URL;
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/dev.ts', 'open', ...args], {
      cwd: cliRoot,
      env: {
        ...env,
        HOME: home,
        NO_COLOR: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, output }));
  });
}

describe('open command', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agor-open-'));
    await mkdir(join(home, '.agor'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('defaults to the local deployment without a prior login', async () => {
    const { server, port } = await startHealthServer(deploymentId);
    try {
      await writeFile(
        join(home, '.agor', 'config.yaml'),
        `daemon:\n  host: 127.0.0.1\n  port: ${port}\n  deployment_id: ${deploymentId}\n`
      );

      const result = await runOpen(home, []);

      expect(result.code).toBe(0);
      expect(result.output).toContain('Opening Agor UI in browser...');
      expect(result.output).not.toContain('Not connected');
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 15_000);

  it('falls back to the stored login target when there is no local config', async () => {
    const { server, port } = await startHealthServer(deploymentId);
    try {
      const url = `http://127.0.0.1:${port}`;
      // No config.yaml — only a stored login token (remote-only user).
      await writeFile(
        join(home, '.agor', 'cli-token'),
        JSON.stringify({
          version: 2,
          target: { url, origin: url, deploymentId },
          accessToken: 'remote-token',
          user: { user_id: 'u1', email: 'remote@example.com', role: 'admin' },
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      );

      const result = await runOpen(home, []);

      expect(result.code).toBe(0);
      expect(result.output).toContain('Opening Agor UI in browser...');
      expect(result.output).toContain(`${url}/ui`);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 15_000);

  it('errors when neither a local config nor a stored login exists', async () => {
    const result = await runOpen(home, []);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Not connected');
  }, 15_000);
});
