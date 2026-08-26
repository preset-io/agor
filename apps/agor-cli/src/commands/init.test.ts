import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAgenticToolSelectionManifestPath,
  inspectManagedAgenticToolAlignment,
} from '@agor/core/agentic-integrations';
import { dump as dumpYaml, load as loadYaml } from '@agor/core/yaml';
import { spawn as spawnPty } from '@lydell/node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInitSupportsConfiguredDatabase,
  createInstallTelemetryConfig,
  isFreshInitState,
  moveInstallToPrivateBackup,
  parseInitialAgenticTools,
  shouldDeferAdminSetup,
  validateInitAdminPassword,
} from './init.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

function stripTerminalControl(value: string): string {
  const controlSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return value.replaceAll(controlSequence, '');
}

async function writeFixtureNpm(binDirectory: string, fail = false): Promise<void> {
  await mkdir(binDirectory, { recursive: true });
  const fixture = fail
    ? '#!/usr/bin/env node\nprocess.exit(42);\n'
    : `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args.at(-1);
const match = /^(@agor-live\\/[^@]+)@(.+)$/.exec(spec);
if (!prefix || !match) process.exit(64);
const packageName = match[1];
const version = match[2];
const slug = packageName.slice('@agor-live/'.length);
const vendors = {
  claude: '@anthropic-ai/claude-agent-sdk',
  codex: '@openai/codex-sdk',
  copilot: '@github/copilot-sdk',
  gemini: '@google/gemini-cli-core',
  opencode: '@opencode-ai/sdk',
  cursor: '@cursor/sdk',
};
const writePackage = (name, source) => {
  const directory = path.join(prefix, 'node_modules', ...name.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(directory, 'index.js'), source);
};
writePackage(packageName, \`export const AGOR_INTEGRATION_VERSION = \${JSON.stringify(version)}; export const sdk = { fixture: true };\`);
writePackage(vendors[slug], 'export const fixture = true;');
console.log('fixture npm installed ' + packageName + '@' + version);
`;
  const npmPath = join(binDirectory, 'npm');
  await writeFile(npmPath, fixture, 'utf8');
  await chmod(npmPath, 0o755);
}

function createInitEnvironment(
  home: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    AGOR_AGENTIC_TOOLS_DIR: join(home, '.agor', 'agentic-tools'),
    AGOR_MANAGED_AGENTIC_TOOLS: '1',
    AGOR_TELEMETRY: '0',
    AGOR_VERSION: '9.8.7-test',
    ...overrides,
  };
  // The parent Agor session points at its own daemon. A clean-install fixture
  // must resolve daemon status only from the fixture's HOME/config, exactly as
  // a fresh shell would.
  delete env.DAEMON_URL;
  delete env.AGOR_API_KEY;
  delete env.AGOR_DEPLOYMENT_ID;
  delete env.PORT;
  delete env.AGOR_CONFIG_PATH;
  return env as Record<string, string>;
}

async function runInteractiveInit(
  home: string,
  fixtureBin: string,
  managedTools = true
): Promise<{
  exitCode: number;
  output: string;
}> {
  const cliRoot = join(import.meta.dirname, '..', '..');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const env = createInitEnvironment(home, {
    PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ''}`,
  });
  if (!managedTools) delete env.AGOR_MANAGED_AGENTIC_TOOLS;
  const terminal = spawnPty(process.execPath, [tsxCli, join(cliRoot, 'bin', 'dev.ts'), 'init'], {
    cwd: cliRoot,
    cols: 100,
    rows: 40,
    env,
  });

  let output = '';
  let skippedAdmin = false;
  let rejectedEmptySelection = false;
  let selectedTools = false;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`Timed out waiting for interactive init:\n${stripTerminalControl(output)}`));
    }, 30_000);
    terminal.onData((data) => {
      output += data;
      const plain = stripTerminalControl(output);
      if (!skippedAdmin && plain.includes('Set up your admin account now?')) {
        skippedAdmin = true;
        terminal.write('n\r');
      }
      if (
        !rejectedEmptySelection &&
        plain.includes('Which agentic tools should this deployment support?') &&
        plain.includes('@agor-live/codex@9.8.7-test')
      ) {
        rejectedEmptySelection = true;
        terminal.write('\r');
      }
      if (
        !selectedTools &&
        plain.includes('Select at least one agentic tool, or press Ctrl+C to exit.')
      ) {
        selectedTools = true;
        // Move from Claude Code to Codex, select it, then submit.
        terminal.write('\u001B[B \r');
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      resolve({ exitCode, output: stripTerminalControl(output) });
    });
  });
}

async function runInitWithoutPty(
  home: string,
  args: string[]
): Promise<{
  exitCode: number | null;
  output: string;
}> {
  const cliRoot = join(import.meta.dirname, '..', '..');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const child = spawn(process.execPath, [tsxCli, join(cliRoot, 'bin', 'dev.ts'), 'init', ...args], {
    cwd: cliRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: createInitEnvironment(home),
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKill.unref();
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (timedOut) {
        reject(
          new Error(`Timed out waiting for noninteractive init:\n${stripTerminalControl(output)}`)
        );
      } else {
        resolve({ exitCode, output: stripTerminalControl(output) });
      }
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

async function runInteractiveReinit(
  home: string,
  fixtureBin?: string
): Promise<{
  exitCode: number;
  output: string;
}> {
  const cliRoot = join(import.meta.dirname, '..', '..');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const terminal = spawnPty(process.execPath, [tsxCli, join(cliRoot, 'bin', 'dev.ts'), 'init'], {
    cwd: cliRoot,
    cols: 100,
    rows: 40,
    env: createInitEnvironment(home, {
      ...(fixtureBin ? { PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ''}` } : {}),
    }),
  });

  let output = '';
  let selectedReinitAction = false;
  let skippedAdmin = false;
  let selectedTools = false;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(
        new Error(`Timed out waiting for interactive re-init:\n${stripTerminalControl(output)}`)
      );
    }, 30_000);
    terminal.onData((data) => {
      output += data;
      const plain = stripTerminalControl(output);
      if (!selectedReinitAction && plain.includes('How would you like to re-initialize?')) {
        selectedReinitAction = true;
        // Accept the recommended backup-and-reinitialize action.
        terminal.write('\r');
      }
      if (!skippedAdmin && plain.includes('Set up your admin account now?')) {
        skippedAdmin = true;
        terminal.write('n\r');
      }
      if (!selectedTools && plain.includes('Which agentic tools should this deployment support?')) {
        selectedTools = true;
        // Move from Claude Code to Codex, select it, then submit.
        terminal.write('\u001B[B \r');
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      resolve({ exitCode, output: stripTerminalControl(output) });
    });
  });
}

describe('database support', () => {
  it('accepts SQLite initialization', () => {
    expect(() => assertInitSupportsConfiguredDatabase('sqlite')).not.toThrow();
  });

  it('fails clearly instead of mixing a SQLite client with the PostgreSQL schema', () => {
    expect(() => assertInitSupportsConfiguredDatabase('postgresql')).toThrow(
      /supports SQLite installations only/
    );
  });
});

describe('safe init state detection', () => {
  it('forces a re-init backup root to owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-backup-'));
    temporaryDirectories.push(root);
    const baseDir = join(root, '.agor');
    await mkdir(baseDir, { mode: 0o755 });

    const backupDir = await moveInstallToPrivateBackup(baseDir, {
      date: new Date('2026-08-26T12:34:56.000Z'),
    });

    expect(backupDir).toBe(`${baseDir}.bkp.20260826-123456`);
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700);
    await expect(access(baseDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a pre-created empty .agor mount as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        configExists: false,
        databaseExists: false,
        reposExist: false,
        branchesExist: false,
      })
    ).toBe(true);
  });

  it('does not treat existing data as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        configExists: true,
        databaseExists: true,
        reposExist: true,
        branchesExist: true,
      })
    ).toBe(false);
  });

  it('treats a config-only directory as an existing deployment boundary', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        configExists: true,
        databaseExists: false,
        reposExist: false,
        branchesExist: false,
      })
    ).toBe(false);
  });
});

describe('install telemetry config', () => {
  it('does not mutate an opted-out config for the one-time install ping', () => {
    const config = { telemetry: { enabled: false, instance_id: 'stable-id' } };

    const deliveryConfig = createInstallTelemetryConfig(config, 'stable-id');

    expect(deliveryConfig.telemetry?.enabled).toBe(true);
    expect(config.telemetry.enabled).toBe(false);
  });
});

describe('headless admin bootstrap', () => {
  it('always defers admin creation during noninteractive init', () => {
    expect(
      shouldDeferAdminSetup(true, {
        NODE_ENV: 'development',
        AGOR_ADMIN_PASSWORD: 'admin',
        AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
      })
    ).toBe(true);
  });

  it('retains force-init convenience only behind the complete development gate', () => {
    const completeGate = {
      NODE_ENV: 'development',
      AGOR_ADMIN_PASSWORD: 'admin',
      AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
    };
    expect(shouldDeferAdminSetup(false, completeGate)).toBe(false);
    for (const incompleteGate of [
      { ...completeGate, NODE_ENV: 'production' },
      { ...completeGate, AGOR_ADMIN_PASSWORD: 'not-admin' },
      { ...completeGate, AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'false' },
    ]) {
      expect(shouldDeferAdminSetup(false, incompleteGate)).toBe(true);
    }
  });

  it('uses the secure policy for interactive password assignment', () => {
    expect(validateInitAdminPassword('short', 'operator@example.com')).toMatch(/at least 15/);
    expect(validateInitAdminPassword('operatoroperatoroperator', 'operator@example.com')).toMatch(
      /account or Agor name/
    );
    expect(validateInitAdminPassword('a unique bootstrap passphrase', 'operator@example.com')).toBe(
      true
    );
  });
});

describe('initial agentic tool selection', () => {
  it('supports allowlisted lists and explicit all/none shorthands', () => {
    expect(parseInitialAgenticTools('claude,codex,codex')).toEqual(['claude-code', 'codex']);
    expect(parseInitialAgenticTools('none')).toEqual([]);
    expect(parseInitialAgenticTools('all')).toHaveLength(6);
    expect(() => parseInitialAgenticTools('codex,arbitrary-package')).toThrow(
      /Unknown agentic tool/
    );
    expect(() => parseInitialAgenticTools('all,codex')).toThrow(/Use `all` or `none` by itself/);
  });

  it.each(['', '   ', ',,,', ' , , '])(
    'rejects blank policy %j instead of treating it as none',
    (policy) => {
      expect(() => parseInitialAgenticTools(policy)).toThrow(
        'Use `none` for an intentionally empty deployment'
      );
    }
  );

  it('rejects --local instead of mixing per-directory data with global config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-local-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    await mkdir(home);

    const result = await runInitWithoutPty(home, ['--local']);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('agor init --local` is no longer supported');
    await expect(access(join(home, '.agor'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('rejects a non-TTY interactive invocation before creating partial state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-nontty-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    await mkdir(home);

    const result = await runInitWithoutPty(home, []);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Interactive `agor init` requires a TTY');
    await expect(access(join(home, '.agor'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('requires an explicit fresh headless policy before creating partial state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-headless-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    await mkdir(home);

    const result = await runInitWithoutPty(home, ['--non-interactive']);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('requires an explicit agentic-tool policy');
    await expect(access(join(home, '.agor'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('refuses to unlink a live daemon database, then safely re-initializes after it stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-reinit-pty-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const fixtureBin = join(root, 'bin');
    await mkdir(home, { recursive: true });
    await writeFixtureNpm(fixtureBin);

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"service":"agor-daemon","status":"ok"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server has no TCP port');

    try {
      const firstInit = await runInitWithoutPty(home, [
        '--non-interactive',
        '--agentic-tools',
        'none',
        '--daemon-host',
        '127.0.0.1',
        '--daemon-port',
        String(address.port),
      ]);
      expect(firstInit.exitCode, firstInit.output).toBe(0);
      expect((await stat(join(home, '.agor'))).mode & 0o777).toBe(0o700);
      const originalConfig = loadYaml(
        await readFile(join(home, '.agor', 'config.yaml'), 'utf8')
      ) as { daemon?: { deployment_id?: string; jwtSecret?: string } };

      const refused = await runInteractiveReinit(home, fixtureBin);
      expect(refused.exitCode, refused.output).toBe(2);
      expect(refused.output).toContain('The Agor daemon is running');
      expect(refused.output).toContain('agor daemon stop');
      await expect(access(join(home, '.agor', 'agor.db'))).resolves.toBeUndefined();

      await closeServer(server);
      await writeFile(join(home, '.agor', 'agor.db-wal'), 'stale WAL fixture');
      await writeFile(join(home, '.agor', 'agor.db-shm'), 'stale SHM fixture');

      const reinitialized = await runInteractiveReinit(home, fixtureBin);
      expect(reinitialized.exitCode, reinitialized.output).toBe(0);
      expect(reinitialized.output).toContain('Migrations complete');
      expect(reinitialized.output).toContain('Agor initialized successfully');
      expect(reinitialized.output).toContain('Backing up existing installation');
      expect(reinitialized.output).toContain(`Moved ${join(home, '.agor')} to`);
      const backupDir = (await readdir(home)).find((entry) => entry.startsWith('.agor.bkp.'));
      expect(backupDir).toBeDefined();
      expect((await stat(join(home, backupDir!))).mode & 0o777).toBe(0o700);
      await expect(access(join(home, backupDir!, 'agor.db-wal'))).resolves.toBeUndefined();
      await expect(access(join(home, backupDir!, 'agor.db-shm'))).resolves.toBeUndefined();
      const config = loadYaml(await readFile(join(home, '.agor', 'config.yaml'), 'utf8')) as {
        agentic_tools?: { installed?: string[] };
        daemon?: { deployment_id?: string; jwtSecret?: string };
      };
      expect(config.agentic_tools?.installed).toEqual(['codex']);
      expect(config.daemon?.deployment_id).toBeTruthy();
      expect(config.daemon?.deployment_id).not.toBe(originalConfig.daemon?.deployment_id);
      expect(config.daemon?.jwtSecret).not.toBe(originalConfig.daemon?.jwtSecret);
    } finally {
      await closeServer(server);
    }
  }, 60_000);

  it('drives the real CLI through a pseudo-TTY, persists declarative policy, and proves managed readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-pty-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const fixtureBin = join(root, 'bin');
    await mkdir(home, { recursive: true });
    await writeFixtureNpm(fixtureBin);

    const result = await runInteractiveInit(home, fixtureBin);

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('Agentic tool packages');
    expect(result.output).toContain('Provider credentials are configured after the daemon starts.');
    expect(result.output).toContain('Use ↑/↓ to move, Space to select, and Enter to continue.');
    expect(result.output).not.toContain("Sandbox agents' filesystem access");
    expect(result.output).toContain('Select at least one agentic tool, or press Ctrl+C to exit.');
    expect(result.output).toContain('Configured: codex');
    expect(result.output).toContain('Codex installed');
    const config = loadYaml(await readFile(join(home, '.agor', 'config.yaml'), 'utf8')) as {
      agentic_tools?: { installed?: string[] };
    };
    expect(config.agentic_tools?.installed).toEqual(['codex']);

    const previousToolsDirectory = process.env.AGOR_AGENTIC_TOOLS_DIR;
    process.env.AGOR_AGENTIC_TOOLS_DIR = join(home, '.agor', 'agentic-tools');
    try {
      await expect(readFile(getAgenticToolSelectionManifestPath(), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(inspectManagedAgenticToolAlignment(['codex'], '9.8.7-test')).resolves.toEqual([
        expect.objectContaining({ tool: 'codex', status: 'ready' }),
      ]);
    } finally {
      if (previousToolsDirectory === undefined) delete process.env.AGOR_AGENTIC_TOOLS_DIR;
      else process.env.AGOR_AGENTIC_TOOLS_DIR = previousToolsDirectory;
    }
  }, 35_000);

  it('always shows the tool selector for an interactive source/development init', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-source-tools-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const fixtureBin = join(root, 'bin');
    await mkdir(home, { recursive: true });
    await writeFixtureNpm(fixtureBin);

    const result = await runInteractiveInit(home, fixtureBin, false);

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('Which agentic tools should this deployment support?');
    const config = loadYaml(await readFile(join(home, '.agor', 'config.yaml'), 'utf8')) as {
      agentic_tools?: { installed?: string[] };
    };
    expect(config.agentic_tools?.installed).toEqual(['codex']);
  }, 35_000);

  it('backs up a config-only install so interactive tool changes persist in a fresh config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-config-only-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const fixtureBin = join(root, 'bin');
    await mkdir(home, { recursive: true });
    await writeFixtureNpm(fixtureBin);

    const firstInit = await runInitWithoutPty(home, [
      '--non-interactive',
      '--agentic-tools',
      'none',
    ]);
    expect(firstInit.exitCode, firstInit.output).toBe(0);
    await rm(join(home, '.agor', 'agor.db'), { force: true });
    await rm(join(home, '.agor', 'repos'), { recursive: true, force: true });
    await rm(join(home, '.agor', 'worktrees'), { recursive: true, force: true });

    const result = await runInteractiveReinit(home, fixtureBin);

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('Backing up existing installation');
    expect(result.output).toContain('Re-initialization affects the entire installation');
    expect(result.output).toContain('including config.yaml');
    const config = loadYaml(await readFile(join(home, '.agor', 'config.yaml'), 'utf8')) as {
      agentic_tools?: { installed?: string[] };
    };
    expect(config.agentic_tools?.installed).toEqual(['codex']);
  }, 60_000);

  it('prompts an upgraded local install for tools before destructive re-initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-reinit-tools-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const fixtureBin = join(root, 'bin');
    await mkdir(home, { recursive: true });
    await writeFixtureNpm(fixtureBin);

    const firstInit = await runInitWithoutPty(home, [
      '--non-interactive',
      '--agentic-tools',
      'none',
    ]);
    expect(firstInit.exitCode, firstInit.output).toBe(0);

    const configPath = join(home, '.agor', 'config.yaml');
    const legacyConfig = loadYaml(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    delete legacyConfig.agentic_tools;
    await writeFile(configPath, dumpYaml(legacyConfig), 'utf8');

    const result = await runInteractiveReinit(home, fixtureBin);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('Which agentic tools should this deployment support?');
    expect(result.output).toContain('Configured: codex');

    const freshConfig = loadYaml(await readFile(configPath, 'utf8')) as {
      agentic_tools?: { installed?: string[] };
    };
    expect(freshConfig.agentic_tools?.installed).toEqual(['codex']);
  }, 60_000);

  it('preserves the declarative choice and prints one recovery command when install fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-init-pty-failure-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const fixtureBin = join(root, 'bin');
    await mkdir(home, { recursive: true });
    await writeFixtureNpm(fixtureBin, true);

    const result = await runInteractiveInit(home, fixtureBin);

    expect(result.exitCode, result.output).toBe(2);
    const config = loadYaml(await readFile(join(home, '.agor', 'config.yaml'), 'utf8')) as {
      agentic_tools?: { installed?: string[] };
    };
    expect(config.agentic_tools?.installed).toEqual(['codex']);
    expect(result.output.match(/agor install --sync/g)).toHaveLength(1);
    expect(result.output).toContain('The new config was preserved.');
  }, 35_000);
});
