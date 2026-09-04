import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectWorkspace,
  WORKLOAD_PACKAGE_JSON_MAX_BYTES,
  WORKLOAD_TOOL_VERSION_MAX_BYTES,
} from './workspace-inspection.js';

const fixtures: string[] = [];
const originalPath = process.env.PATH;
const originalSecretMarker = process.env.WORKLOAD_TEST_SECRET;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agor-workspace-inspection-test-'));
  fixtures.push(root);
  return root;
}

async function installTool(root: string, name: 'npm' | 'pnpm', body: string): Promise<void> {
  const bin = join(root, 'bin');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(bin, { recursive: true }));
  await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

async function fixtureDigest(root: string): Promise<string> {
  const records: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        records.push(`link\0${relative}\0${await readlink(path)}`);
      } else if (stats.isDirectory()) {
        records.push(`dir\0${relative}\0${stats.mode & 0o777}`);
        await walk(path);
      } else {
        const bytes = await readFile(path);
        records.push(
          `file\0${relative}\0${stats.mode & 0o777}\0${createHash('sha256').update(bytes).digest('hex')}`
        );
      }
    }
  }
  await walk(root);
  return createHash('sha256').update(records.join('\n')).digest('hex');
}

describe('workspace inspection', () => {
  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalSecretMarker === undefined) delete process.env.WORKLOAD_TEST_SECRET;
    else process.env.WORKLOAD_TEST_SECRET = originalSecretMarker;
    await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('returns fixed bounded root facts without mutating the workspace or forwarding ambient env', async () => {
    const root = await fixture();
    const packageBytes = Buffer.from(
      JSON.stringify({ name: 'fixture', packageManager: 'pnpm@11.17.0' })
    );
    const lockBytes = Buffer.from('lockfileVersion: 9.0\n');
    await writeFile(join(root, 'package.json'), packageBytes);
    await writeFile(join(root, 'pnpm-lock.yaml'), lockBytes);
    await writeFile(join(root, '.git'), 'gitdir: deliberately-not-returned\n');
    const toolScript = [
      'if [ "$#" -ne 1 ] || [ "$1" != "--version" ] || [ "$COREPACK_ENABLE_NETWORK" != "0" ] || [ -n "$' +
        '{WORKLOAD_TEST_SECRET:-}" ]; then',
      '  exit 9',
      'fi',
      "printf '%s\\n' VERSION_PLACEHOLDER",
    ].join('\n');
    await installTool(root, 'npm', toolScript.replace('VERSION_PLACEHOLDER', '10.9.0'));
    await installTool(root, 'pnpm', toolScript.replace('VERSION_PLACEHOLDER', '11.17.0'));
    process.env.WORKLOAD_TEST_SECRET = 'do-not-forward-or-return';
    const before = await fixtureDigest(root);

    const result = await inspectWorkspace(root, new AbortController().signal);

    expect(await fixtureDigest(root)).toBe(before);
    expect(result).toEqual({
      node: { state: 'available', version: process.versions.node },
      npm: { state: 'available', version: '10.9.0' },
      pnpm: { state: 'available', version: '11.17.0' },
      packageJson: {
        state: 'present',
        sha256: createHash('sha256').update(packageBytes).digest('hex'),
      },
      packageManager: { state: 'valid', name: 'pnpm', version: '11.17.0' },
      lockfiles: [
        {
          name: 'pnpm-lock.yaml',
          file: {
            state: 'present',
            sha256: createHash('sha256').update(lockBytes).digest('hex'),
          },
        },
        { name: 'package-lock.json', file: { state: 'absent' } },
        { name: 'npm-shrinkwrap.json', file: { state: 'absent' } },
        { name: 'yarn.lock', file: { state: 'absent' } },
        { name: 'bun.lock', file: { state: 'absent' } },
        { name: 'bun.lockb', file: { state: 'absent' } },
      ],
      repositoryMarkerPresent: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('fixture');
    expect(serialized).not.toContain('do-not-forward-or-return');
    expect(serialized).not.toContain('deliberately-not-returned');
  });

  it('keeps Corepack networking disabled when fixed version lookup fails', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', packageManager: 'pnpm@11.17.0' })
    );
    const expectedFixedEnvironment = [
      'COREPACK_ENABLE_NETWORK',
      'COREPACK_ENABLE_DOWNLOAD_PROMPT',
      'NO_UPDATE_NOTIFIER',
      'NPM_CONFIG_AUDIT',
      'NPM_CONFIG_FUND',
      'NPM_CONFIG_IGNORE_SCRIPTS',
    ];
    const failureScript = [
      'if [ "$#" -ne 1 ] || [ "$1" != "--version" ] ||',
      ...expectedFixedEnvironment.map((name) => `   [ "$${name}" = "" ] ||`),
      '   [ "$COREPACK_ENABLE_NETWORK" != "0" ] ||',
      '   [ -n "$' + '{WORKLOAD_TEST_SECRET:-}" ]; then',
      '  exit 9',
      'fi',
      'exit 7',
    ].join('\n');
    await installTool(root, 'npm', failureScript);
    await installTool(root, 'pnpm', "printf '11.17.0\\n'");
    process.env.WORKLOAD_TEST_SECRET = 'must-not-cross-the-process-boundary';

    const result = await inspectWorkspace(root, new AbortController().signal);

    expect(result?.npm).toEqual({ state: 'failed' });
    expect(result?.pnpm).toEqual({ state: 'available', version: '11.17.0' });
  });

  it('reports inspected symlinks without following targets outside the workspace', async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, 'package.json'), '{"packageManager":"npm@99.99.99"}');
    await writeFile(join(outside, 'lock'), 'outside-lock-secret');
    await symlink(join(outside, 'package.json'), join(root, 'package.json'));
    await symlink(join(outside, 'lock'), join(root, 'pnpm-lock.yaml'));
    await symlink(outside, join(root, '.git'));
    await installTool(root, 'npm', "printf '10.9.0\\n'");
    await installTool(root, 'pnpm', "printf '11.17.0\\n'");

    const result = await inspectWorkspace(root, new AbortController().signal);

    expect(result?.packageJson).toEqual({ state: 'unsafe-symlink' });
    expect(result?.packageManager).toEqual({ state: 'unavailable' });
    expect(result?.lockfiles[0]).toEqual({
      name: 'pnpm-lock.yaml',
      file: { state: 'unsafe-symlink' },
    });
    expect(result?.repositoryMarkerPresent).toBe(false);
    expect(JSON.stringify(result)).not.toContain('99.99.99');
    expect(JSON.stringify(result)).not.toContain('outside-lock-secret');
  });

  it('uses explicit invalid and bounded tool-output states', async () => {
    const root = await fixture();
    await writeFile(join(root, 'package.json'), '{not-json');
    await installTool(root, 'npm', `head -c ${WORKLOAD_TOOL_VERSION_MAX_BYTES + 1} /dev/zero`);

    const result = await inspectWorkspace(root, new AbortController().signal);

    expect(result?.packageJson.state).toBe('present');
    expect(result?.packageManager).toEqual({ state: 'invalid' });
    expect(result?.npm).toEqual({ state: 'invalid-output' });
    expect(result?.pnpm).toEqual({ state: 'unavailable' });
  });

  it('does not read a package manifest beyond its fixed byte cap', async () => {
    const root = await fixture();
    await writeFile(join(root, 'package.json'), Buffer.alloc(WORKLOAD_PACKAGE_JSON_MAX_BYTES + 1));
    await installTool(root, 'npm', "printf '10.9.0\\n'");
    await installTool(root, 'pnpm', "printf '11.17.0\\n'");

    const result = await inspectWorkspace(root, new AbortController().signal);

    expect(result?.packageJson).toEqual({ state: 'too-large' });
    expect(result?.packageManager).toEqual({ state: 'unavailable' });
  });

  it('kills fixed tool process groups and returns no fact after Stop', async () => {
    const root = await fixture();
    await installTool(root, 'npm', 'sleep 30');
    await installTool(root, 'pnpm', 'sleep 30');
    const abortController = new AbortController();
    const inspection = inspectWorkspace(root, abortController.signal);
    setTimeout(() => abortController.abort(), 25);

    await expect(
      Promise.race([
        inspection,
        new Promise((_, reject) => setTimeout(() => reject(new Error('child still alive')), 2_000)),
      ])
    ).resolves.toBeUndefined();
  });

  it('kills a fixed tool process group at the version deadline', async () => {
    const root = await fixture();
    await installTool(root, 'npm', 'sleep 30');
    await installTool(root, 'pnpm', "printf '11.17.0\\n'");

    const result = await inspectWorkspace(root, new AbortController().signal);

    expect(result?.npm).toEqual({ state: 'timed-out' });
    expect(result?.pnpm).toEqual({ state: 'available', version: '11.17.0' });
  }, 6_000);

  it('refuses a non-authoritative relative cwd', async () => {
    await expect(
      inspectWorkspace(basename('/not-authoritative'), new AbortController().signal)
    ).rejects.toThrow('WORKLOAD_WORKSPACE_UNAVAILABLE');
  });
});
