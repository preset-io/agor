#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..');

try {
  // Create node_modules/@agor directory
  const nodeModulesAgor = join(packageRoot, 'node_modules', '@agor');
  const coreSymlink = join(nodeModulesAgor, 'core');
  // Use relative path from node_modules/@agor to dist/core
  const coreTarget = join('..', '..', 'dist', 'core');

  // Create @agor directory
  if (!existsSync(nodeModulesAgor)) {
    mkdirSync(nodeModulesAgor, { recursive: true });
  }

  // Remove existing symlink/directory if it exists
  if (existsSync(coreSymlink)) {
    try {
      unlinkSync(coreSymlink);
    } catch (_err) {
      // If unlinkSync fails (e.g., it's a directory, not a symlink), try rmSync
      try {
        rmSync(coreSymlink, { recursive: true, force: true });
      } catch (_rmErr) {
        // If we can't remove it, skip symlink creation - the imports field will handle it
        throw new Error(`EEXIST: file already exists, symlink '${coreTarget}' -> '${coreSymlink}'`);
      }
    }
  }

  // Create symlink
  symlinkSync(coreTarget, coreSymlink, 'dir');
  console.log(chalk.green('✓ Created @agor/core symlink for package resolution'));
} catch (error) {
  // Don't fail the install if symlink creation fails
  console.warn(chalk.yellow('⚠️  Could not create @agor/core symlink:'), error.message);
  console.warn(chalk.dim('   The package may still work via the "imports" field'));
}
