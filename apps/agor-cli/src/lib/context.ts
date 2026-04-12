/**
 * Context Detection - Determine if running in dev or production mode
 *
 * Used to control daemon lifecycle command availability:
 * - Development: daemon managed manually via pnpm dev
 * - Production: daemon lifecycle commands available (start/stop/etc)
 */

import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Check if CLI is running from installed npm package
 *
 * @returns true if running from npm package (not monorepo source)
 */
export function isInstalledPackage(): boolean {
  // Get directory of the currently executing file
  const dirname =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

  // Check if we're in the monorepo source (development mode)
  // Dev path: /Users/max/code/agor/apps/agor-cli/dist/...
  // Prod path: /usr/local/lib/node_modules/agor-live/dist/cli/...
  const isInMonorepoSource =
    dirname.includes('/apps/agor-cli/') || dirname.includes('\\apps\\agor-cli\\');

  // If in monorepo source = development mode
  // Otherwise = production (installed package)
  return !isInMonorepoSource;
}

/**
 * Get path to bundled daemon binary (production only)
 *
 * @returns path to daemon binary, or null if in development
 */
export function getDaemonPath(): string | null {
  if (!isInstalledPackage()) {
    // Development mode: no bundled daemon
    return null;
  }

  // Production: bundled daemon in dist/
  // Due to tsup inlining, import.meta.url could be anywhere in dist/cli/
  // So we find 'dist/cli' in the path and replace with 'dist/daemon'
  const dirname =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

  // Find the agor-live package root by looking for dist/cli in the path
  // Then construct path to daemon from there
  const cliDistIndex = dirname.indexOf(`${path.sep}dist${path.sep}cli`);
  if (cliDistIndex === -1) {
    // Fallback: couldn't find dist/cli, use relative path
    return path.resolve(dirname, '../../daemon/main.js');
  }

  // Get package root (everything before /dist/cli)
  const packageRoot = dirname.substring(0, cliDistIndex);

  // Construct daemon path from package root
  return path.join(packageRoot, 'dist', 'daemon', 'main.js');
}

/**
 * Get path to bundled daemon module (library entrypoint for startDaemon import)
 *
 * @returns path to daemon module, or null if in development
 */
export function getDaemonModulePath(): string | null {
  if (!isInstalledPackage()) {
    // Development mode: use workspace package import
    return null;
  }

  const dirname =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

  const cliDistIndex = dirname.indexOf(`${path.sep}dist${path.sep}cli`);
  if (cliDistIndex === -1) {
    return path.resolve(dirname, '../../daemon/index.js');
  }

  const packageRoot = dirname.substring(0, cliDistIndex);
  return path.join(packageRoot, 'dist', 'daemon', 'index.js');
}

/**
 * Check if running in GitHub Codespaces
 *
 * @returns true if running in Codespaces
 */
export function isCodespaces(): boolean {
  return !!process.env.CODESPACE_NAME && !!process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
}

/**
 * Get appropriate UI URL based on context
 *
 * @returns UI URL for current context
 */
export function getUIUrl(): string {
  // Codespaces: use port forwarding URL
  if (isCodespaces()) {
    const codespaceName = process.env.CODESPACE_NAME;
    const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;

    if (isInstalledPackage()) {
      // Production in Codespaces: daemon serves UI at /ui
      return `https://${codespaceName}-3030.${domain}/ui`;
    } else {
      // Development in Codespaces: Vite dev server
      return `https://${codespaceName}-5173.${domain}`;
    }
  }

  // Local environment
  if (isInstalledPackage()) {
    // Production: UI served by daemon at /ui
    return 'http://localhost:3030/ui';
  } else {
    // Development: Vite dev server
    return 'http://localhost:5173';
  }
}

/**
 * Check if Agor has been initialized
 *
 * A valid Agor initialization requires:
 * 1. ~/.agor/ directory exists
 * 2. ~/.agor/agor.db database file exists
 *
 * @returns true if Agor is initialized, false otherwise
 */
export async function isAgorInitialized(): Promise<boolean> {
  try {
    const agorDir = path.join(homedir(), '.agor');
    const dbPath = path.join(agorDir, 'agor.db');

    // Check if both directory and database exist
    await access(agorDir, constants.F_OK);
    await access(dbPath, constants.F_OK);

    return true;
  } catch {
    // Either directory or database doesn't exist
    return false;
  }
}
