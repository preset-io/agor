import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../..');
const deploymentId = '019c1234-5678-7123-8123-123456789abc';

function createLoginServer() {
  return createServer((request, response) => {
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
}

async function runRemoteLogin(home: string, port: number) {
  const env = { ...process.env };
  delete env.AGOR_API_KEY;
  delete env.AGOR_DEPLOYMENT_ID;
  delete env.DAEMON_URL;

  return new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'bin/dev.ts',
        'login',
        '--url',
        `http://127.0.0.1:${port}`,
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
  });
}

async function listen(server: ReturnType<typeof createLoginServer>): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return address.port;
}

describe('login command', () => {
  it('uses an explicit remote URL without loading invalid local config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-login-remote-'));
    const server = createLoginServer();
    const port = await listen(server);

    try {
      await mkdir(join(home, '.agor'), { recursive: true });
      await chmod(join(home, '.agor'), 0o750);
      await writeFile(join(home, '.agor', 'config.yaml'), 'daemon: [invalid yaml');
      const result = await runRemoteLogin(home, port);

      expect(result.code).toBe(0);
      expect(result.output).toContain('Logged in successfully');
      expect(result.output).not.toContain('Failed to load config');
      expect((await stat(join(home, '.agor'))).mode & 0o777).toBe(0o750);
      expect((await stat(join(home, '.agor', 'cli-token'))).mode & 0o777).toBe(0o600);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('creates a private Agor home when remote login is the first local command', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-login-first-'));
    const server = createLoginServer();
    const port = await listen(server);

    try {
      const result = await runRemoteLogin(home, port);

      expect(result.code, result.output).toBe(0);
      expect((await stat(join(home, '.agor'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, '.agor', 'cli-token'))).mode & 0o777).toBe(0o600);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  describe('--api-key', () => {
    const validKey = 'agor_sk_valid-test-key';

    function createApiKeyServer(requests: string[]) {
      return createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        requests.push(`${request.method} ${request.url}`);
        if (request.url === '/health') {
          response.end(JSON.stringify({ service: 'agor-daemon', deploymentId }));
          return;
        }
        if (request.url?.startsWith('/api/v1/user/me') && request.method === 'GET') {
          if (request.headers.authorization !== `Bearer ${validKey}`) {
            response.statusCode = 401;
            response.end(
              JSON.stringify({ name: 'NotAuthenticated', code: 401, message: 'Invalid API key' })
            );
            return;
          }
          response.end(
            JSON.stringify({
              user_id: '019c9999-5678-7123-8123-123456789abc',
              email: 'key-owner@example.com',
              role: 'member',
              tenant_id: 'workspace-123',
              auth_strategy: 'api-key',
            })
          );
          return;
        }
        response.statusCode = 404;
        response.end('{}');
      });
    }

    async function runApiKeyLogin(home: string, url: string, stdin: string) {
      const env = { ...process.env };
      delete env.AGOR_API_KEY;
      delete env.AGOR_DEPLOYMENT_ID;
      delete env.DAEMON_URL;
      return new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'bin/dev.ts', 'login', '--url', url, '--api-key'],
          {
            cwd: cliRoot,
            env: {
              ...env,
              HOME: home,
              NO_COLOR: '1',
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        let output = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (output += String(chunk)));
        child.once('error', reject);
        child.once('close', (code) => resolveRun({ code, output }));
        child.stdin.end(stdin);
      });
    }

    it('verifies a key read from stdin and stores it privately without exchanging it', async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-login-key-'));
      const requests: string[] = [];
      const server = createApiKeyServer(requests);
      const port = await listen(server);
      try {
        const result = await runApiKeyLogin(home, `http://127.0.0.1:${port}`, `${validKey}\n`);

        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('Logged in with API key');
        expect(result.output).toContain('workspace-123');
        expect(result.output).not.toContain(validKey);
        expect(requests).not.toContain('POST /authentication');
        const tokenPath = join(home, '.agor', 'cli-token');
        expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(tokenPath, 'utf8'))).toMatchObject({
          version: 3,
          kind: 'api-key',
          apiKey: validKey,
          target: {
            url: `http://127.0.0.1:${port}`,
            deploymentId,
            tenantId: 'workspace-123',
          },
          user: { email: 'key-owner@example.com', role: 'member' },
        });
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(home, { recursive: true, force: true });
      }
    }, 15_000);

    it('stores nothing when the daemon rejects the key', async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-login-key-reject-'));
      const server = createApiKeyServer([]);
      const port = await listen(server);
      try {
        const result = await runApiKeyLogin(home, `http://127.0.0.1:${port}`, 'agor_sk_wrong\n');

        expect(result.code).not.toBe(0);
        expect(result.output).toContain('API key rejected');
        await expect(stat(join(home, '.agor', 'cli-token'))).rejects.toThrow();
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(home, { recursive: true, force: true });
      }
    }, 15_000);

    it('refuses to send a key to a plain-HTTP remote before any network call', async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-login-key-http-'));
      try {
        const result = await runApiKeyLogin(home, 'http://agor.example.invalid', `${validKey}\n`);

        expect(result.code).not.toBe(0);
        expect(result.output).toContain('Refusing to send an API key over plain HTTP');
        await expect(stat(join(home, '.agor', 'cli-token'))).rejects.toThrow();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 15_000);

    it('rejects values that are not personal API keys', async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-login-key-format-'));
      const server = createApiKeyServer([]);
      const port = await listen(server);
      try {
        const result = await runApiKeyLogin(home, `http://127.0.0.1:${port}`, 'eyJhbGciOi.jwt\n');

        expect(result.code).not.toBe(0);
        expect(result.output).toContain('Invalid API key format');
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await rm(home, { recursive: true, force: true });
      }
    }, 15_000);
  });
});
