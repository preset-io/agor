import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAgenticToolSelectionManifestPath,
  inspectManagedAgenticToolAlignment,
} from '@agor/core/agentic-integrations';
import { load as loadYaml } from '@agor/core/yaml';
import { spawn as spawnPty } from '@lydell/node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInitSupportsConfiguredDatabase,
  createInstallTelemetryConfig,
  isFreshInitState,
  parseInitialAgenticTools,
  shouldDeferAdminSetup,
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
  delete env.PORT;
  delete env.AGOR_CONFIG_PATH;
  return env as Record<string, string>;
}

async function runInteractiveInit(
  home: string,
  fixtureBin: string
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
      PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ''}`,
    }),
  });

  let output = '';
  let skippedAdmin = false;
  let declinedSandbox = false;
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
      // Fresh init offers the OS-level executor sandbox (single y/N) before tool
      // selection. Decline it here to keep this fixture's assertions focused.
      if (!declinedSandbox && plain.includes('Sandbox agents')) {
        declinedSandbox = true;
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

async function runInteractiveReinit(home: string): Promise<{
  exitCode: number;
  output: string;
}> {
  const cliRoot = join(import.meta.dirname, '..', '..');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const terminal = spawnPty(process.execPath, [tsxCli, join(cliRoot, 'bin', 'dev.ts'), 'init'], {
    cwd: cliRoot,
    cols: 100,
    rows: 40,
    env: createInitEnvironment(home),
  });

  let output = '';
  let confirmedDeletion = false;
  let skippedAdmin = false;
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
      if (!confirmedDeletion && plain.includes('Delete all existing data and re-initialize?')) {
        confirmedDeletion = true;
        terminal.write('y\r');
      }
      if (!skippedAdmin && plain.includes('Set up your admin account now?')) {
        skippedAdmin = true;
        terminal.write('n\r');
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
  it('treats a pre-created empty .agor mount as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
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
        databaseExists: true,
        reposExist: true,
        branchesExist: true,
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
    expect(shouldDeferAdminSetup(true, 'development')).toBe(true);
    expect(shouldDeferAdminSetup(true, undefined)).toBe(true);
  });

  it('retains the explicit local force-init development convenience', () => {
    expect(shouldDeferAdminSetup(false, 'development')).toBe(false);
    expect(shouldDeferAdminSetup(false, 'test')).toBe(false);
    expect(shouldDeferAdminSetup(false, '')).toBe(true);
    expect(shouldDeferAdminSetup(false, 'production')).toBe(true);
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
    await mkdir(home, { recursive: true });

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

      const refused = await runInteractiveReinit(home);
      expect(refused.exitCode, refused.output).toBe(2);
      expect(refused.output).toContain('The Agor daemon is running');
      expect(refused.output).toContain('agor daemon stop');
      await expect(access(join(home, '.agor', 'agor.db'))).resolves.toBeUndefined();

      await closeServer(server);
      await writeFile(join(home, '.agor', 'agor.db-wal'), 'stale WAL fixture');
      await writeFile(join(home, '.agor', 'agor.db-shm'), 'stale SHM fixture');

      const reinitialized = await runInteractiveReinit(home);
      expect(reinitialized.exitCode, reinitialized.output).toBe(0);
      expect(reinitialized.output).toContain('Migrations complete');
      expect(reinitialized.output).toContain('Agor initialized successfully');
      const config = loadYaml(await readFile(join(home, '.agor', 'config.yaml'), 'utf8')) as {
        agentic_tools?: { installed?: string[] };
      };
      expect(config.agentic_tools?.installed).toEqual([]);
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
