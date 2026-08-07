#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..');

export function ensureInternalPackageLinks() {
  try {
    // Create node_modules/@agor directory
    const nodeModulesAgor = join(packageRoot, 'node_modules', '@agor');

    // Create @agor directory
    if (!existsSync(nodeModulesAgor)) {
      mkdirSync(nodeModulesAgor, { recursive: true });
    }

    for (const packageName of ['agentic-tool-opencode', 'agentic-tools', 'core', 'git']) {
      const symlinkPath = join(nodeModulesAgor, packageName);
      // Use relative path from node_modules/@agor to dist/<package>
      const target = join('..', '..', 'dist', packageName);

      // Remove existing symlink/directory if it exists. Use lstatSync rather
      // than existsSync so broken symlinks are cleaned up too.
      try {
        lstatSync(symlinkPath);
        try {
          unlinkSync(symlinkPath);
        } catch (_err) {
          // If unlinkSync fails (e.g., it's a directory, not a symlink), try rmSync
          try {
            rmSync(symlinkPath, { recursive: true, force: true });
          } catch (_rmErr) {
            throw new Error(`EEXIST: file already exists, symlink '${target}' -> '${symlinkPath}'`);
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }

      // Create symlink
      symlinkSync(target, symlinkPath, 'dir');
      // Intentionally quiet during normal CLI/daemon startup.
    }
  } catch (error) {
    throw new Error(`Could not prepare Agor's internal package links: ${error.message}`, {
      cause: error,
    });
  }
}

ensureInternalPackageLinks();
