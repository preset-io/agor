import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../../..');

function runUserList(
  home: string,
  overrides: NodeJS.ProcessEnv = {}
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env };
    delete env.AGOR_API_KEY;
    delete env.AGOR_DEPLOYMENT_ID;
    delete env.DAEMON_URL;

    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/dev.ts', 'user', 'list'], {
      cwd: cliRoot,
      env: {
        ...env,
        HOME: home,
        NO_COLOR: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
        ...overrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('user list command', () => {
  it('requires a connection instead of opening the local database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-user-list-'));
    try {
      const result = await runUserList(home);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('Not authenticated');
      await expect(access(join(home, '.agor', 'agor.db'))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('lists users from the selected daemon without opening the local database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-user-list-remote-'));
    const deploymentId = '019c1234-5678-7123-8123-123456789abc';
    const userId = '019c9999-5678-7123-8123-123456789abc';
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health') {
        response.end(JSON.stringify({ service: 'agor-daemon', deploymentId }));
        return;
      }
      if (request.url?.startsWith('/users')) {
        response.end(
          JSON.stringify([
            {
              user_id: userId,
              email: 'remote@example.com',
              name: 'Remote User',
              role: 'admin',
              created_at: 1_700_000_000_000,
            },
          ])
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');

    try {
      const result = await runUserList(home, {
        AGOR_API_KEY: 'agor_sk_test',
        AGOR_DEPLOYMENT_ID: deploymentId,
        DAEMON_URL: `http://127.0.0.1:${address.port}`,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('remote@example.com');
      expect(result.stdout).toContain('Remote User');
      await expect(access(join(home, '.agor', 'agor.db'))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('sends a stored API-key login as the bearer and tolerates a moved deployment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-user-list-key-'));
    const apiKey = 'agor_sk_stored-login-key';
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health') {
        // A hosted workspace moved to another Cell: new deployment ID.
        response.end(JSON.stringify({ service: 'agor-daemon', deploymentId: 'cell-after-move' }));
        return;
      }
      if (request.url?.startsWith('/users')) {
        authorizations.push(request.headers.authorization);
        response.end(
          JSON.stringify([
            { user_id: 'u-1', email: 'key-owner@example.com', role: 'member', created_at: 1 },
          ])
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const url = `http://127.0.0.1:${address.port}`;

    try {
      await mkdir(join(home, '.agor'), { recursive: true, mode: 0o700 });
      await writeFile(
        join(home, '.agor', 'cli-token'),
        JSON.stringify({
          version: 3,
          kind: 'api-key',
          target: { url, origin: url, deploymentId: 'cell-before-move', tenantId: 'ws-1' },
          apiKey,
          user: { user_id: 'u-1', email: 'key-owner@example.com', role: 'member' },
        }),
        { mode: 0o600 }
      );

      const result = await runUserList(home);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('key-owner@example.com');
      expect(authorizations).toEqual([`Bearer ${apiKey}`]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
