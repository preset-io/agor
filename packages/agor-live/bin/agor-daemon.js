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

// Use dynamic imports to ensure version check runs first
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

// Get directory of this file
const dirname = path.dirname(fileURLToPath(import.meta.url));

// Daemon is bundled in dist/daemon relative to bin/
const daemonPath = path.resolve(dirname, '../dist/daemon/main.js');

// Import and run the daemon
await import(daemonPath);
