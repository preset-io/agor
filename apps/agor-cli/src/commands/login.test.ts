import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../..');

describe('login command', () => {
  it('uses an explicit remote URL without loading invalid local config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-login-remote-'));
    const deploymentId = '019c1234-5678-7123-8123-123456789abc';
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health') {
        response.end(JSON.stringify({ service: 'agor-daemon', deploymentId }));
        return;
      }
      if (request.url === '/authentication' && request.method === 'POST') {
        response.end(
          JSON.stringify({
            accessToken: 'remote-token',
            user: {
              user_id: '019c9999-5678-7123-8123-123456789abc',
              email: 'remote@example.com',
              role: 'admin',
            },
          })
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
      await mkdir(join(home, '.agor'), { recursive: true });
      await writeFile(join(home, '.agor', 'config.yaml'), 'daemon: [invalid yaml');
      const env = { ...process.env };
      delete env.AGOR_API_KEY;
      delete env.AGOR_DEPLOYMENT_ID;
      delete env.DAEMON_URL;
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolveRun, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              'bin/dev.ts',
              'login',
              '--url',
              `http://127.0.0.1:${address.port}`,
              '--email',
              'remote@example.com',
              '--password',
              'password',
            ],
            {
              cwd: cliRoot,
              env: {
                ...env,
                HOME: home,
                NO_COLOR: '1',
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          let output = '';
          child.stdout.on('data', (chunk) => (output += String(chunk)));
          child.stderr.on('data', (chunk) => (output += String(chunk)));
          child.once('error', reject);
          child.once('close', (code) => resolveRun({ code, output }));
        }
      );

      expect(result.code).toBe(0);
      expect(result.output).toContain('Logged in successfully');
      expect(result.output).not.toContain('Failed to load config');
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
