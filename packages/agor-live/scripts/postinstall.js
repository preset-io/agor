#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..');

try {
  // Create node_modules/@agor directory
  const nodeModulesAgor = join(packageRoot, 'node_modules', '@agor');

  // Create @agor directory
  if (!existsSync(nodeModulesAgor)) {
    mkdirSync(nodeModulesAgor, { recursive: true });
  }

  for (const packageName of ['core', 'git']) {
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
    console.log(chalk.green(`✓ Created @agor/${packageName} symlink for package resolution`));
  }
} catch (error) {
  // Don't fail the install if symlink creation fails
  console.warn(chalk.yellow('⚠️  Could not create @agor package symlink:'), error.message);
  console.warn(chalk.dim('   The package may still work if dependencies are resolved another way'));
}
