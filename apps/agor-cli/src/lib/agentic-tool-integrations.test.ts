import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireAgenticToolInstallLock,
  assertManagedIntegrationPermissions,
  findRestorableAgenticTools,
  installManagedIntegration,
  listInstalledAgenticTools,
  listManagedAgorVersions,
  listManagedToolDirectories,
  removeManagedAgorVersion,
  removeManagedInstallDebris,
  removeManagedIntegration,
  repairManagedIntegrationPermissions,
  writeAgenticToolSelectionManifest,
} from './agentic-tool-integrations.js';

const originalRoot = process.env.AGOR_AGENTIC_TOOLS_DIR;
const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.AGOR_AGENTIC_TOOLS_DIR;
  else process.env.AGOR_AGENTIC_TOOLS_DIR = originalRoot;
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agor-agentic-tools-'));
  temporaryDirectories.push(directory);
  process.env.AGOR_AGENTIC_TOOLS_DIR = directory;
  return directory;
}

async function installFixture(
  root: string,
  version: string,
  tool: string,
  packageName: string,
  manifest?: Record<string, unknown>
): Promise<string> {
  const directory = join(root, version, tool);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'agor-integration.json'),
    JSON.stringify(
      manifest ?? {
        agorVersion: version,
        packageName,
        packageVersion: version,
        installedAt: new Date().toISOString(),
      }
    )
  );
  return directory;
}

describe('listManagedAgorVersions', () => {
  it('returns an empty list when the root does not exist', async () => {
    const root = await createRoot();
    await rm(root, { recursive: true, force: true });

    expect(await listManagedAgorVersions()).toEqual([]);
  });

  it('orders versions numerically, not lexically', async () => {
    const root = await createRoot();
    for (const version of ['0.9.0', '0.24.0', '0.10.0']) {
      await mkdir(join(root, version), { recursive: true });
    }

    // A plain string sort would put 0.10.0 before 0.9.0.
    expect(await listManagedAgorVersions()).toEqual(['0.9.0', '0.10.0', '0.24.0']);
  });

  it('ignores in-flight staging and backup directories', async () => {
    const root = await createRoot();
    await mkdir(join(root, '0.24.0'), { recursive: true });
    await mkdir(join(root, '.codex.staging-abc'), { recursive: true });
    await mkdir(join(root, '.codex.previous-def'), { recursive: true });

    expect(await listManagedAgorVersions()).toEqual(['0.24.0']);
  });

  it('ignores arbitrary operator directories that are not semver-managed roots', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'shared-cache'), { recursive: true });
    await mkdir(join(root, '0.24.0'), { recursive: true });

    expect(await listManagedAgorVersions()).toEqual(['0.24.0']);
  });
});

describe('listInstalledAgenticTools', () => {
  it('lists tools that have a verified manifest', async () => {
    const root = await createRoot();
    await installFixture(root, '0.24.0', 'claude-code', '@agor-live/claude');
    await installFixture(root, '0.24.0', 'codex', '@agor-live/codex');

    expect((await listInstalledAgenticTools('0.24.0')).sort()).toEqual(['claude-code', 'codex']);
  });

  it('skips directories whose manifest is missing or misaligned', async () => {
    const root = await createRoot();
    await installFixture(root, '0.24.0', 'claude-code', '@agor-live/claude');
    // A half-finished install: directory exists, no manifest.
    await mkdir(join(root, '0.24.0', 'codex'), { recursive: true });
    // A manifest that disagrees with the directory it lives in.
    await installFixture(root, '0.24.0', 'gemini', '@agor-live/gemini', {
      agorVersion: '0.23.0',
      packageName: '@agor-live/gemini',
      packageVersion: '0.23.0',
      installedAt: new Date().toISOString(),
    });

    expect(await listInstalledAgenticTools('0.24.0')).toEqual(['claude-code']);
  });

  it('ignores directory names that are not known tools', async () => {
    const root = await createRoot();
    await installFixture(root, '0.24.0', 'claude-code', '@agor-live/claude');
    await mkdir(join(root, '0.24.0', 'not-a-tool'), { recursive: true });

    expect(await listInstalledAgenticTools('0.24.0')).toEqual(['claude-code']);
  });
});

describe('managed integration cleanup', () => {
  it.runIf(process.platform !== 'win32')(
    'disables lifecycle scripts before accepting an install',
    async () => {
      const root = await createRoot();
      const bin = join(root, 'fixture-bin');
      const capturedArguments = join(root, 'npm-arguments.json');
      await mkdir(bin);
      const npm = join(bin, 'npm');
      await writeFile(
        npm,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const project = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
if (project.private !== true || project.allowScripts !== undefined || project.dependencies['@agor-live/codex'] !== '0.24.0') process.exit(65);
const writePackage = (name, source) => {
  const directory = path.join(prefix, 'node_modules', ...name.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js', version: '0.24.0' }));
  fs.writeFileSync(path.join(directory, 'index.js'), source);
};
writePackage('@agor-live/codex', "export const AGOR_INTEGRATION_VERSION = '0.24.0'; export const sdk = {};");
writePackage('@openai/codex-sdk', 'export const fixture = true;');
const privatePackage = path.join(prefix, 'node_modules', '@agor-live', 'codex');
fs.chmodSync(privatePackage, 0o700);
fs.chmodSync(path.join(privatePackage, 'package.json'), 0o600);
fs.chmodSync(path.join(privatePackage, 'index.js'), 0o600);
fs.writeFileSync(${JSON.stringify(capturedArguments)}, JSON.stringify(args));
`
      );
      await chmod(npm, 0o755);
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;

      await expect(installManagedIntegration('codex', '0.24.0')).resolves.toMatchObject({
        packageName: '@agor-live/codex',
        packageVersion: '0.24.0',
      });
      for (const directory of [root, join(root, '0.24.0'), join(root, '0.24.0', 'codex')]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o755);
      }
      const installedPackage = join(root, '0.24.0', 'codex', 'node_modules', '@agor-live', 'codex');
      expect((await stat(installedPackage)).mode & 0o777).toBe(0o755);
      expect((await stat(join(installedPackage, 'index.js'))).mode & 0o004).toBe(0o004);
      await expect(assertManagedIntegrationPermissions('codex', '0.24.0')).resolves.toBeUndefined();
      const args = JSON.parse(await readFile(capturedArguments, 'utf8')) as string[];
      expect(args).toContain('--ignore-scripts');
      expect(args).toContain('--include=optional');
      expect(args).toContain('--no-audit');
      expect(
        args.some(
          (argument) =>
            argument.startsWith('--allow-scripts') || argument.startsWith('--strict-allow-scripts')
        )
      ).toBe(false);
    }
  );

  it.runIf(process.platform !== 'win32')(
    'preserves the previous package and cleans staging when npm fails',
    async () => {
      const root = await createRoot();
      const destination = await installFixture(root, '0.24.0', 'codex', '@agor-live/codex');
      await writeFile(join(destination, 'previous-marker'), 'preserve me');
      const bin = join(root, 'fixture-bin');
      await mkdir(bin);
      const npm = join(bin, 'npm');
      await writeFile(npm, '#!/bin/sh\nexit 42\n');
      await chmod(npm, 0o755);
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;

      await expect(installManagedIntegration('codex', '0.24.0')).rejects.toThrow(
        'npm install failed with exit code 42'
      );

      await expect(readFile(join(destination, 'previous-marker'), 'utf8')).resolves.toBe(
        'preserve me'
      );
      expect((await readdir(join(root, '0.24.0'))).filter((name) => name.startsWith('.'))).toEqual(
        []
      );
    }
  );

  it('lists and removes broken current-version tool directories', async () => {
    const root = await createRoot();
    await mkdir(join(root, '0.24.0', 'codex'), { recursive: true });

    expect(await listManagedToolDirectories('0.24.0')).toEqual(['codex']);
    await removeManagedIntegration('codex', '0.24.0');
    await expect(access(join(root, '0.24.0', 'codex'))).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'repairs an existing managed path for non-daemon executor traversal',
    async () => {
      const root = await createRoot();
      const version = join(root, '0.24.0');
      const destination = await installFixture(root, '0.24.0', 'codex', '@agor-live/codex');
      const privateDirectory = join(destination, 'node_modules', '@agor-live', 'codex');
      const privateSource = join(privateDirectory, 'index.js');
      const privateExecutable = join(privateDirectory, 'bin.js');
      await mkdir(privateDirectory, { recursive: true });
      await writeFile(privateSource, 'export {};');
      await writeFile(privateExecutable, '#!/usr/bin/env node\n');
      await chmod(root, 0o700);
      await chmod(version, 0o700);
      await chmod(destination, 0o700);
      await chmod(privateDirectory, 0o700);
      await chmod(privateSource, 0o600);
      await chmod(privateExecutable, 0o700);

      await expect(assertManagedIntegrationPermissions('codex', '0.24.0')).rejects.toThrow(
        'not readable and traversable'
      );
      await repairManagedIntegrationPermissions('codex', '0.24.0');

      for (const directory of [root, version, destination]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o755);
      }
      expect((await stat(privateDirectory)).mode & 0o005).toBe(0o005);
      expect((await stat(privateSource)).mode & 0o004).toBe(0o004);
      expect((await stat(privateExecutable)).mode & 0o005).toBe(0o005);
      await expect(assertManagedIntegrationPermissions('codex', '0.24.0')).resolves.toBeUndefined();
    }
  );

  it('removes interrupted staging and backup directories', async () => {
    const root = await createRoot();
    await mkdir(join(root, '0.24.0', '.codex.staging-one'), { recursive: true });
    await mkdir(join(root, '0.24.0', '.codex.previous-two'), { recursive: true });
    await mkdir(join(root, '0.24.0', 'codex'), { recursive: true });

    expect((await removeManagedInstallDebris('0.24.0')).sort()).toEqual([
      '.codex.previous-two',
      '.codex.staging-one',
    ]);
    expect(await listManagedToolDirectories('0.24.0')).toEqual(['codex']);
  });
});

describe('findRestorableAgenticTools', () => {
  it('returns the newest older version that still has tools', async () => {
    const root = await createRoot();
    await installFixture(root, '0.22.0', 'gemini', '@agor-live/gemini');
    await installFixture(root, '0.23.0', 'claude-code', '@agor-live/claude');
    await installFixture(root, '0.23.0', 'codex', '@agor-live/codex');

    const restorable = await findRestorableAgenticTools('0.24.0');

    expect(restorable?.version).toBe('0.23.0');
    expect(restorable?.tools.sort()).toEqual(['claude-code', 'codex']);
  });

  it('skips older versions whose directories hold nothing usable', async () => {
    const root = await createRoot();
    await installFixture(root, '0.22.0', 'gemini', '@agor-live/gemini');
    await mkdir(join(root, '0.23.0', 'codex'), { recursive: true }); // no manifest

    expect((await findRestorableAgenticTools('0.24.0'))?.version).toBe('0.22.0');
  });

  it('never restores from the current or a newer version', async () => {
    const root = await createRoot();
    await installFixture(root, '0.24.0', 'claude-code', '@agor-live/claude');
    await installFixture(root, '0.25.0', 'codex', '@agor-live/codex');

    expect(await findRestorableAgenticTools('0.24.0')).toBeNull();
  });

  it('returns null when nothing is installed', async () => {
    await createRoot();

    expect(await findRestorableAgenticTools('0.24.0')).toBeNull();
  });
});

describe('removeManagedAgorVersion', () => {
  it('removes a version directory and leaves the others intact', async () => {
    const root = await createRoot();
    await installFixture(root, '0.23.0', 'claude-code', '@agor-live/claude');
    await installFixture(root, '0.24.0', 'claude-code', '@agor-live/claude');

    await removeManagedAgorVersion('0.23.0');

    expect(await listManagedAgorVersions()).toEqual(['0.24.0']);
  });

  it('is a no-op for a version that is not installed', async () => {
    const root = await createRoot();
    await installFixture(root, '0.24.0', 'claude-code', '@agor-live/claude');

    await expect(removeManagedAgorVersion('0.19.0')).resolves.toBeUndefined();
    expect(await listManagedAgorVersions()).toEqual(['0.24.0']);
  });
});

describe('local selection persistence', () => {
  it('writes an atomic private manifest and rejects a concurrent install', async () => {
    const root = await createRoot();
    await writeAgenticToolSelectionManifest(['codex', 'codex']);
    expect(JSON.parse(await readFile(join(root, 'selection.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      installed: ['codex'],
    });
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o755);
      expect((await stat(join(root, 'selection.json'))).mode & 0o777).toBe(0o600);
    }

    const release = await acquireAgenticToolInstallLock();
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o755);
      expect((await stat(join(root, '.install.lock'))).mode & 0o777).toBe(0o700);
    }
    await expect(acquireAgenticToolInstallLock()).rejects.toThrow(
      'Another `agor install` is already updating agentic tools'
    );
    await release();
    const releaseAgain = await acquireAgenticToolInstallLock();
    await releaseAgain();
  });

  it('recovers a lock whose heartbeat is stale', async () => {
    const root = await createRoot();
    const lock = join(root, '.install.lock');
    await mkdir(lock);
    await utimes(lock, new Date(0), new Date(0));

    const release = await acquireAgenticToolInstallLock();
    await expect(access(lock)).resolves.toBeUndefined();
    await release();
  });

  it('allows only one of two simultaneous stale-lock reclaimers to acquire', async () => {
    const root = await createRoot();
    const lock = join(root, '.install.lock');
    await mkdir(lock);
    await utimes(lock, new Date(0), new Date(0));

    const results = await Promise.allSettled([
      acquireAgenticToolInstallLock(),
      acquireAgenticToolInstallLock(),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find(
      (result): result is PromiseFulfilledResult<() => Promise<void>> =>
        result.status === 'fulfilled'
    );
    await winner?.value();
  });
});
