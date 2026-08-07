import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export {
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolInstallDir,
  getAgenticToolsRoot,
  type InstallableAgenticTool,
  isInstallableAgenticTool,
} from '@agor/core/agentic-integrations';

import {
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolInstallDir,
  getAgenticToolsRoot,
  type InstallableAgenticTool,
  isInstallableAgenticTool,
} from '@agor/core/agentic-integrations';

export function normalizeAgenticToolName(value: string): InstallableAgenticTool | undefined {
  const normalized = value === 'claude' ? 'claude-code' : value;
  return isInstallableAgenticTool(normalized) ? normalized : undefined;
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
