import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function serve(status = 200): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ''}`);
    response.setHeader('content-type', 'application/json');
    response.statusCode = status;
    // Feathers error bodies carry the HTTP status as `code`.
    response.end(
      JSON.stringify(status === 200 ? { id: 'key-123' } : { message: 'boom', code: status })
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function homeWithLogin(url: string, source: 'cli_login' | 'manual'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agor-logout-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.agor'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, '.agor', 'cli-token'),
    JSON.stringify({
      version: 3,
      kind: 'api-key',
      target: { url, origin: url, deploymentId: 'd-1', tenantId: 'ws-1' },
      apiKey: 'agor_sk_machine-key',
      apiKeyId: 'key-123',
      apiKeySource: source,
      user: { user_id: 'u-1', email: 'u@example.test', role: 'member' },
    }),
    { mode: 0o600 }
  );
  return home;
}

function runLogout(home: string, args: string[] = []) {
  const env = { ...process.env };
  delete env.AGOR_API_KEY;
  return new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/dev.ts', 'logout', ...args], {
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

const tokenGone = (home: string) =>
  expect(stat(join(home, '.agor', 'cli-token'))).rejects.toThrow();

describe('logout command', () => {
  it("deletes this machine's CLI key on the server with the key itself", async () => {
    const server = await serve();
    const home = await homeWithLogin(server.url, 'cli_login');

    const result = await runLogout(home);

    expect(result.code, result.output).toBe(0);
    expect(server.requests).toEqual([
      'DELETE /api/v1/user/api-keys/key-123 Bearer agor_sk_machine-key',
    ]);
    expect(result.output).toContain('CLI key was deleted on the server');
    await tokenGone(home);
  }, 20_000);

  it('keeps the server key with --keep-key', async () => {
    const server = await serve();
    const home = await homeWithLogin(server.url, 'cli_login');

    const result = await runLogout(home, ['--keep-key']);

    expect(result.code, result.output).toBe(0);
    expect(server.requests).toEqual([]);
    await tokenGone(home);
  }, 20_000);

  it('never deletes a manually created key', async () => {
    const server = await serve();
    const home = await homeWithLogin(server.url, 'manual');

    const result = await runLogout(home);

    expect(result.code, result.output).toBe(0);
    expect(server.requests).toEqual([]);
    expect(result.output).toContain('was not deleted');
    await tokenGone(home);
  }, 20_000);

  it('keeps the local login and fails when the server delete fails', async () => {
    const server = await serve(500);
    const home = await homeWithLogin(server.url, 'cli_login');

    const result = await runLogout(home);

    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('You are still logged in');
    await expect(stat(join(home, '.agor', 'cli-token'))).resolves.toBeTruthy();
  }, 20_000);

  it('removes the local login anyway with --force', async () => {
    const server = await serve(500);
    const home = await homeWithLogin(server.url, 'cli_login');

    const result = await runLogout(home, ['--force']);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('It is still valid');
    await tokenGone(home);
  }, 20_000);

  it('treats an already revoked key as logged out', async () => {
    const server = await serve(401);
    const home = await homeWithLogin(server.url, 'cli_login');

    const result = await runLogout(home);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('already revoked');
    await tokenGone(home);
  }, 20_000);
});
