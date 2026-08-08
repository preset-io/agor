import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findRestorableAgenticTools,
  listInstalledAgenticTools,
  listManagedAgorVersions,
  removeManagedAgorVersion,
} from './agentic-tool-integrations.js';

const originalRoot = process.env.AGOR_AGENTIC_TOOLS_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.AGOR_AGENTIC_TOOLS_DIR;
  else process.env.AGOR_AGENTIC_TOOLS_DIR = originalRoot;
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
