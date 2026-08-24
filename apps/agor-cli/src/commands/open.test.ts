import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

describe('open command deployment selection', () => {
  it('uses local by default and with --local, and uses the login target with --remote', async () => {
    const local = await startDaemon(localDeploymentId);
    const remote = await startDaemon(remoteDeploymentId);
    const home = await createHome();
    await writeLocalConfig(home, local.port, localDeploymentId);
    await writeLogin(home, remote.url, remoteDeploymentId);
    const openedUrlFile = await installFakeBrowserOpener(home);

    for (const args of [['open'], ['open', '--local']]) {
      await rm(openedUrlFile, { force: true });
      const result = await runCli(home, args, openedUrlFile);
      expect(result.code).toBe(0);
      expect(result.output).toContain('URL: http://localhost:5173');
      await expect(readFile(openedUrlFile, 'utf8')).resolves.toBe('http://localhost:5173');
    }

    await rm(openedUrlFile, { force: true });
    const remoteResult = await runCli(home, ['open', '--remote'], openedUrlFile);
    expect(remoteResult.code).toBe(0);
    expect(remoteResult.output).toContain(`URL: ${remote.url}/ui`);
    await expect(readFile(openedUrlFile, 'utf8')).resolves.toBe(`${remote.url}/ui`);
  }, 30_000);

  it('requires a connected target only when --remote is explicit', async () => {
    const local = await startDaemon(localDeploymentId);
    const home = await createHome();
    await writeLocalConfig(home, local.port, localDeploymentId);
    const openedUrlFile = await installFakeBrowserOpener(home);

    const localResult = await runCli(home, ['open'], openedUrlFile);
    expect(localResult.code).toBe(0);

    const remoteResult = await runCli(home, ['open', '--remote'], openedUrlFile);
    expect(remoteResult.code).not.toBe(0);
    expect(remoteResult.output).toContain('Not connected. Run agor login --url <daemon-url>.');
  }, 20_000);

  it('identifies an unreachable default target as local', async () => {
    const local = await startDaemon(localDeploymentId);
    const home = await createHome();
    await writeLocalConfig(home, local.port, localDeploymentId);
    const openedUrlFile = await installFakeBrowserOpener(home);
    await local.close();

    const result = await runCli(home, ['open'], openedUrlFile);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Local daemon is not reachable');
    expect(result.output).not.toContain('Connected daemon is not reachable');
  }, 10_000);

  it('does not fall back to a stored login when local config is missing or invalid', async () => {
    const remote = await startDaemon(remoteDeploymentId);
    const missingHome = await createHome();
    await writeLogin(missingHome, remote.url, remoteDeploymentId);
    const missingOpenedUrlFile = await installFakeBrowserOpener(missingHome);

    const missingResult = await runCli(missingHome, ['open'], missingOpenedUrlFile);
    expect(missingResult.code).not.toBe(0);
    expect(missingResult.output).toContain('No local config found');
    expect(missingResult.output).toContain('Run agor init.');

    const invalidHome = await createHome();
    await writeLogin(invalidHome, remote.url, remoteDeploymentId);
    await mkdir(join(invalidHome, '.agor'), { recursive: true });
    await writeFile(join(invalidHome, '.agor', 'config.yaml'), 'daemon: [invalid yaml');
    const invalidOpenedUrlFile = await installFakeBrowserOpener(invalidHome);

    const invalidResult = await runCli(invalidHome, ['open'], invalidOpenedUrlFile);
    expect(invalidResult.code).not.toBe(0);
    expect(invalidResult.output).toContain('Failed to load config');
  }, 20_000);

  it('rejects conflicting local and remote flags', async () => {
    const home = await createHome();
    const openedUrlFile = await installFakeBrowserOpener(home);

    const result = await runCli(home, ['open', '--local', '--remote'], openedUrlFile);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/--local.*--remote|--remote.*--local/);
  }, 10_000);
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agor-open-'));
  homes.push(home);
  return home;
}

async function installFakeBrowserOpener(home: string): Promise<string> {
  const bin = join(home, 'bin');
  const openedUrlFile = join(home, 'opened-url');
  await mkdir(bin, { recursive: true });
  const script = '#!/bin/sh\nprintf %s "$1" > "$AGOR_TEST_OPEN_FILE"\n';
  for (const command of ['open', 'xdg-open']) {
    const path = join(bin, command);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  return openedUrlFile;
}

async function runCli(home: string, args: string[], openedUrlFile: string): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGOR_TEST_OPEN_FILE: openedUrlFile,
    HOME: home,
    NO_COLOR: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim(),
    PATH: `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
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
  deploymentId: string
): Promise<{ close: () => Promise<void>; port: number; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: 'agor-daemon', deploymentId }));
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return {
    close: async () => {
      const index = servers.indexOf(server);
      if (index >= 0) servers.splice(index, 1);
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      );
    },
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
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
