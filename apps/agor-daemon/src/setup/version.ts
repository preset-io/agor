/**
 * Daemon Version Loader
 *
 * Reads package version at startup for /health endpoint and API docs.
 * Supports both development (../package.json) and production (../../package.json) layouts.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VERSION = '0.0.0';

/**
 * Load daemon version from package.json
 *
 * Tries multiple paths to support different deployment structures:
 * - Development: ../package.json (relative to src/)
 * - Production (agor-live): ../../package.json (relative to dist/)
 *
 * @param importMetaUrl - Pass `import.meta.url` from the calling module
 * @returns The version string, or '0.0.0' if not found
 */
export async function loadDaemonVersion(importMetaUrl: string): Promise<string> {
  try {
    const currentDir = dirname(fileURLToPath(importMetaUrl));

    // Try to read from ../package.json (development) or ../../package.json (agor-live)
    const pathsToTry = [
      join(currentDir, '../package.json'),
      join(currentDir, '../../package.json'),
    ];

    for (const pkgPath of pathsToTry) {
      try {
        const pkgData = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgData);
        if (pkg.version) {
          return pkg.version;
        }
      } catch {
        // Try next path
      }
    }

    return DEFAULT_VERSION;
  } catch (err) {
    console.warn('⚠️  Could not read package.json for version - using fallback 0.0.0', err);
    return DEFAULT_VERSION;
  }
}
