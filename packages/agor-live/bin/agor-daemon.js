#!/usr/bin/env node

/**
 * Agor Daemon Entry Point (Production)
 *
 * This entry point loads the bundled daemon from dist/daemon.
 * The daemon is compiled from apps/agor-daemon and bundled during build.
 */

// Check Node.js version requirement before loading any dependencies
import { checkNodeVersion } from './version-check.js';

checkNodeVersion();

const { readFileSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { dirname: pathDirname, join: pathJoin } = await import('node:path');
const { fileURLToPath: toFilePath } = await import('node:url');
const packageRoot = pathJoin(pathDirname(toFilePath(import.meta.url)), '..');
const packageMetadata = JSON.parse(readFileSync(pathJoin(packageRoot, 'package.json'), 'utf8'));
// The installed package is the authority for its managed-integration version.
// Do not inherit a stale value when an older Agor executor upgrades the host.
process.env.AGOR_VERSION = packageMetadata.version;
process.env.AGOR_AGENTIC_TOOLS_DIR ??= pathJoin(homedir(), '.agor', 'agentic-tools');
process.env.AGOR_MANAGED_AGENTIC_TOOLS ??= '1';

// Use dynamic imports to ensure version check runs first
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

// Get directory of this file
const dirname = path.dirname(fileURLToPath(import.meta.url));

// Daemon is bundled in dist/daemon relative to bin/
const daemonPath = path.resolve(dirname, '../dist/daemon/main.js');

// Import and run the daemon
await import(daemonPath);
