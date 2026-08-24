import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cliRoot = resolve(import.meta.dirname, '../..');
const localDeploymentId = '019c1234-5678-7123-8123-123456789abc';
const remoteDeploymentId = '019c9876-5432-7123-8123-123456789abc';
const homes: string[] = [];
const servers: Server[] = [];

interface CliResult {
  code: number | null;
  output: string;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())))
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('version command deployment selection', () => {
  it('uses local by default and with --local, and uses the login target with --remote', async () => {
    const local = await startDaemon(localDeploymentId, 'local-version');
    const remote = await startDaemon(remoteDeploymentId, 'remote-version');
    const home = await createHome();
    await writeLocalConfig(home, local.port, localDeploymentId);
    await writeLogin(home, remote.url, remoteDeploymentId);

    for (const args of [['version'], ['version', '--local']]) {
      const result = await runCli(home, args);
      expect(result.code).toBe(0);
      expect(result.output).toContain('Daemon: local-version');
      expect(result.output).toContain(`deployment: ${localDeploymentId}`);
      expect(result.output).not.toContain('remote-version');
    }

    const remoteResult = await runCli(home, ['version', '--remote']);
    expect(remoteResult.code).toBe(0);
    expect(remoteResult.output).toContain('Daemon: remote-version');
    expect(remoteResult.output).toContain(`deployment: ${remoteDeploymentId}`);
  }, 30_000);

  it('requires a connected target only when --remote is explicit', async () => {
    const local = await startDaemon(localDeploymentId, 'local-version');
    const home = await createHome();
    await writeLocalConfig(home, local.port, localDeploymentId);

    const localResult = await runCli(home, ['version']);
    expect(localResult.code).toBe(0);

    const remoteResult = await runCli(home, ['version', '--remote']);
    expect(remoteResult.code).not.toBe(0);
    expect(remoteResult.output).toContain('Not connected. Run agor login --url <daemon-url>.');
  }, 20_000);

  it('does not fall back to a stored login when local config is missing or invalid', async () => {
    const remote = await startDaemon(remoteDeploymentId, 'remote-version');
    const missingHome = await createHome();
    await writeLogin(missingHome, remote.url, remoteDeploymentId);

    const missingResult = await runCli(missingHome, ['version']);
    expect(missingResult.code).not.toBe(0);
    expect(missingResult.output).toContain('No local config found');
    expect(missingResult.output).toContain('Run agor init.');
    expect(missingResult.output).not.toContain('remote-version');

    const invalidHome = await createHome();
    await writeLogin(invalidHome, remote.url, remoteDeploymentId);
    await mkdir(join(invalidHome, '.agor'), { recursive: true });
    await writeFile(join(invalidHome, '.agor', 'config.yaml'), 'daemon: [invalid yaml');

    const invalidResult = await runCli(invalidHome, ['version']);
    expect(invalidResult.code).not.toBe(0);
    expect(invalidResult.output).toContain('Failed to load config');
    expect(invalidResult.output).not.toContain('remote-version');
  }, 20_000);

  it('rejects conflicting local and remote flags', async () => {
    const home = await createHome();

    const result = await runCli(home, ['version', '--local', '--remote']);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/--local.*--remote|--remote.*--local/);
  }, 10_000);
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agor-version-'));
  homes.push(home);
  return home;
}

async function runCli(home: string, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
  };
  delete env.AGOR_API_KEY;
  delete env.AGOR_DEPLOYMENT_ID;
  delete env.AGOR_OUTER_SANDBOX;
  delete env.DAEMON_URL;
  delete env.PORT;

  return new Promise<CliResult>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/dev.ts', ...args], {
      cwd: cliRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, output }));
  });
}

async function startDaemon(
  deploymentId: string,
  version: string
): Promise<{ port: number; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: 'agor-daemon', deploymentId, version }));
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return { port: address.port, url: `http://127.0.0.1:${address.port}` };
}

async function writeLocalConfig(home: string, port: number, deploymentId: string): Promise<void> {
  await mkdir(join(home, '.agor'), { recursive: true });
  await writeFile(
    join(home, '.agor', 'config.yaml'),
    `daemon:\n  host: 127.0.0.1\n  port: ${port}\n  deployment_id: ${deploymentId}\n`
  );
}

async function writeLogin(home: string, url: string, deploymentId: string): Promise<void> {
  await mkdir(join(home, '.agor'), { recursive: true });
  await writeFile(
    join(home, '.agor', 'cli-token'),
    JSON.stringify({
      version: 2,
      target: { url, origin: new URL(url).origin, deploymentId },
      accessToken: 'test-token',
      user: { user_id: 'user-1', email: 'test@example.com', role: 'admin' },
      expiresAt: Date.now() + 60_000,
    })
  );
}
