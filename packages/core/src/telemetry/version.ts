import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_PACKAGE_NAMES = new Set(['agor-live', '@agor-live/client']);

async function readProductVersion(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    if (pkg.version && pkg.name && PRODUCT_PACKAGE_NAMES.has(pkg.name)) {
      return pkg.version;
    }
  } catch {
    // Try next candidate.
  }
  return null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Resolve the user-facing Agor product version for open-source telemetry.
 *
 * Workspace package versions such as @agor/daemon and @agor/cli are internal
 * and currently remain at 0.1.0. The installable product package is agor-live
 * (mirrored by @agor-live/client), so telemetry should report that version.
 */
export async function loadOpenSourceTelemetryAgorVersion(
  fallback: string,
  importMetaUrl?: string
): Promise<string> {
  const currentDir = importMetaUrl ? dirname(fileURLToPath(importMetaUrl)) : process.cwd();
  const cwd = process.cwd();
  const candidates = unique([
    join(cwd, 'packages/agor-live/package.json'),
    join(cwd, 'packages/client/package.json'),
    join(cwd, '../../packages/agor-live/package.json'),
    join(cwd, '../../packages/client/package.json'),
    join(currentDir, '../../package.json'),
    join(currentDir, '../../../package.json'),
    join(currentDir, '../../../../packages/agor-live/package.json'),
    join(currentDir, '../../../../packages/client/package.json'),
  ]);

  for (const candidate of candidates) {
    const version = await readProductVersion(candidate);
    if (version) return version;
  }

  return fallback;
}
