import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export {
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolInstallDir,
  getAgenticToolSelectionManifestPath,
  getAgenticToolsRoot,
  type InstallableAgenticTool,
  isInstallableAgenticTool,
  resolveManagedAgenticToolVersion,
} from '@agor/core/agentic-integrations';

import {
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolInstallDir,
  getAgenticToolSelectionManifestPath,
  getAgenticToolsRoot,
  type InstallableAgenticTool,
  isInstallableAgenticTool,
} from '@agor/core/agentic-integrations';

export function normalizeAgenticToolName(value: string): InstallableAgenticTool | undefined {
  const normalized = value === 'claude' ? 'claude-code' : value;
  return isInstallableAgenticTool(normalized) ? normalized : undefined;
}

/** Deployment-owned, host-local selection; atomic, private, and serialized. */
export async function writeAgenticToolSelectionManifest(
  installed: readonly InstallableAgenticTool[]
): Promise<void> {
  const root = getAgenticToolsRoot();
  const destination = getAgenticToolSelectionManifestPath();
  const temporary = join(root, `.selection-${randomUUID()}.tmp`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, installed: [...new Set(installed)] }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Hold this deployment-local lock across selection and the complete reconciliation. */
export async function acquireAgenticToolInstallLock(): Promise<() => Promise<void>> {
  const root = getAgenticToolsRoot();
  const lock = join(root, '.install.lock');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const createLock = async () => {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 }
    );
  };
  try {
    await createLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as {
        pid?: unknown;
      };
      if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0)
        ownerPid = owner.pid;
    } catch {
      // Missing/corrupt owner metadata is an interrupted lock and may be reclaimed.
    }
    let ownerAlive = false;
    if (ownerPid !== undefined) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'EPERM') ownerAlive = true;
      }
    }
    if (ownerAlive)
      throw new Error(
        `Another \`agor install\` is already updating agentic tools (PID ${ownerPid}). Try again when it finishes.`
      );
    await rm(lock, { recursive: true, force: true });
    try {
      await createLock();
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'Another `agor install` acquired the lock while recovering an interrupted install. Try again when it finishes.'
        );
      throw retryError;
    }
  }
  return async () => rm(lock, { recursive: true, force: true });
}

export function getAgenticToolInstallSlug(tool: InstallableAgenticTool): string {
  return tool === 'claude-code' ? 'claude' : tool;
}

export type ManagedIntegrationManifest = {
  agorVersion: string;
  packageName: string;
  packageVersion: string;
  installedAt: string;
};

export async function readManagedIntegrationManifest(
  tool: InstallableAgenticTool,
  agorVersion: string
): Promise<ManagedIntegrationManifest | undefined> {
  try {
    const value = JSON.parse(
      await readFile(
        join(getAgenticToolInstallDir(tool, agorVersion), 'agor-integration.json'),
        'utf8'
      )
    ) as ManagedIntegrationManifest;
    if (
      value.agorVersion !== agorVersion ||
      value.packageName !== AGENTIC_TOOL_INTEGRATIONS[tool].packageName ||
      value.packageVersion !== agorVersion
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Sort key for an Agor version directory name. Non-numeric segments (e.g. the
 * `0-rc` in `1.0-rc.2`) parse to their leading digits, which is enough to order
 * release directories; anything unparseable sorts lowest rather than throwing.
 */
function versionSortKey(version: string): number[] {
  return version.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : -1;
  });
}

function compareVersions(a: string, b: string): number {
  const left = versionSortKey(a);
  const right = versionSortKey(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Agor versions that have a managed tool directory on disk, oldest first.
 * Staging/backup directories are dot-prefixed and therefore skipped.
 */
export async function listManagedAgorVersions(): Promise<string[]> {
  try {
    const entries = await readdir(getAgenticToolsRoot(), { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name)
      )
      .map((entry) => entry.name)
      .sort(compareVersions);
  } catch {
    return [];
  }
}

/**
 * Tools with a verified manifest under a given Agor version. Directories whose
 * manifest is absent or misaligned are ignored, so a half-written install is
 * never reported as something worth restoring.
 */
export async function listInstalledAgenticTools(
  agorVersion: string
): Promise<InstallableAgenticTool[]> {
  let entries: string[];
  try {
    entries = (await readdir(join(getAgenticToolsRoot(), agorVersion), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const tools = entries.filter(isInstallableAgenticTool);
  const verified = await Promise.all(
    tools.map(async (tool) =>
      (await readManagedIntegrationManifest(tool, agorVersion)) ? tool : undefined
    )
  );
  return verified.filter((tool): tool is InstallableAgenticTool => tool !== undefined);
}

/** Known tool directories present for a version, including broken installs. */
export async function listManagedToolDirectories(
  agorVersion: string
): Promise<InstallableAgenticTool[]> {
  try {
    return (await readdir(join(getAgenticToolsRoot(), agorVersion), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isInstallableAgenticTool(entry.name))
      .map((entry) => entry.name as InstallableAgenticTool);
  } catch {
    return [];
  }
}

/**
 * The newest version older than `currentVersion` that still has tools installed,
 * i.e. the set a user had before upgrading Agor.
 */
export async function findRestorableAgenticTools(currentVersion: string): Promise<{
  version: string;
  tools: InstallableAgenticTool[];
} | null> {
  const candidates = (await listManagedAgorVersions())
    .filter((version) => compareVersions(version, currentVersion) < 0)
    .reverse();
  for (const version of candidates) {
    const tools = await listInstalledAgenticTools(version);
    if (tools.length > 0) return { version, tools };
  }
  return null;
}

/** Remove a managed version directory wholesale. */
export async function removeManagedAgorVersion(version: string): Promise<void> {
  await rm(join(getAgenticToolsRoot(), version), { recursive: true, force: true });
}

/** Remove one current-version integration that is no longer deployment-configured. */
export async function removeManagedIntegration(
  tool: InstallableAgenticTool,
  version: string
): Promise<void> {
  await rm(getAgenticToolInstallDir(tool, version), { recursive: true, force: true });
}

/** Remove staging/backup debris left by an interrupted install. */
export async function removeManagedInstallDebris(version: string): Promise<string[]> {
  const parent = join(getAgenticToolsRoot(), version);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return [];
  }
  const debris = entries.filter(
    (entry) =>
      entry.startsWith('.') && (entry.includes('.staging-') || entry.includes('.previous-'))
  );
  await Promise.all(
    debris.map((entry) => rm(join(parent, entry), { recursive: true, force: true }))
  );
  return debris;
}

function runNpmInstall(prefix: string, packageSpec: string): Promise<void> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    const child = spawn(
      npm,
      ['install', '--prefix', prefix, '--save-exact', '--no-fund', packageSpec],
      { stdio: 'inherit', env: process.env }
    );
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`npm install failed${signal ? ` (${signal})` : ` with exit code ${code}`}`)
        );
    });
  });
}

export async function installManagedIntegration(
  tool: InstallableAgenticTool,
  agorVersion: string
): Promise<ManagedIntegrationManifest> {
  const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
  const destination = getAgenticToolInstallDir(tool, agorVersion);
  const parent = join(getAgenticToolsRoot(), agorVersion);
  const staging = join(parent, `.${tool}.staging-${randomUUID()}`);
  const backup = join(parent, `.${tool}.previous-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  await rm(staging, { recursive: true, force: true });

  try {
    await runNpmInstall(staging, `${definition.packageName}@${agorVersion}`);
    const installedPackage = JSON.parse(
      await readFile(
        join(staging, 'node_modules', ...definition.packageName.split('/'), 'package.json'),
        'utf8'
      )
    ) as { name?: string; version?: string };
    if (
      installedPackage.name !== definition.packageName ||
      installedPackage.version !== agorVersion
    ) {
      throw new Error(
        `Installed ${installedPackage.name ?? 'unknown package'}@${installedPackage.version ?? 'unknown'}; expected ${definition.packageName}@${agorVersion}`
      );
    }
    const manifest: ManagedIntegrationManifest = {
      agorVersion,
      packageName: definition.packageName,
      packageVersion: agorVersion,
      installedAt: new Date().toISOString(),
    };
    await writeFile(
      join(staging, 'agor-integration.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );

    let hadPrevious = false;
    try {
      await rename(destination, backup);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, destination);
      if (hadPrevious) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (hadPrevious) await rename(backup, destination).catch(() => undefined);
      throw error;
    }
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
