import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireAgenticToolInstallLock,
  findRestorableAgenticTools,
  listInstalledAgenticTools,
  listManagedAgorVersions,
  listManagedToolDirectories,
  removeManagedAgorVersion,
  removeManagedInstallDebris,
  removeManagedIntegration,
  writeAgenticToolSelectionManifest,
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
  it('lists and removes broken current-version tool directories', async () => {
    const root = await createRoot();
    await mkdir(join(root, '0.24.0', 'codex'), { recursive: true });

    expect(await listManagedToolDirectories('0.24.0')).toEqual(['codex']);
    await removeManagedIntegration('codex', '0.24.0');
    await expect(access(join(root, '0.24.0', 'codex'))).rejects.toThrow();
  });

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
      expect((await stat(join(root, 'selection.json'))).mode & 0o777).toBe(0o600);
    }

    const release = await acquireAgenticToolInstallLock();
    await expect(acquireAgenticToolInstallLock()).rejects.toThrow(
      'Another `agor install` is already updating agentic tools'
    );
    await release();
    const releaseAgain = await acquireAgenticToolInstallLock();
    await releaseAgain();
  });

  it('recovers a lock left by a dead process', async () => {
    const root = await createRoot();
    const lock = join(root, '.install.lock');
    await mkdir(lock);
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, createdAt: '2020-01-01T00:00:00.000Z' })
    );

    const release = await acquireAgenticToolInstallLock();
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).pid).toBe(process.pid);
    await release();
  });

  it('allows only one of two simultaneous stale-lock reclaimers to acquire', async () => {
    const root = await createRoot();
    const lock = join(root, '.install.lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647 }));

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

  it('does not reclaim a live lock that replaces the stale lock after inspection', async () => {
    const root = await createRoot();
    const lock = join(root, '.install.lock');
    const displacedStale = join(root, '.displaced-stale');
    await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647 }));

    let inspected!: () => void;
    const inspectionReached = new Promise<void>((resolve) => {
      inspected = resolve;
    });
    let resume!: () => void;
    const resumeRecovery = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const staleReclaimer = acquireAgenticToolInstallLock({
      afterStaleInspection: async () => {
        inspected();
        await resumeRecovery;
      },
    });
    await inspectionReached;
    await rename(lock, displacedStale);
    const releaseLiveLock = await acquireAgenticToolInstallLock();
    resume();

    await expect(staleReclaimer).rejects.toThrow('Another `agor install`');
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).pid).toBe(process.pid);
    await releaseLiveLock();
    await rm(displacedStale, { recursive: true, force: true });
  });
});
