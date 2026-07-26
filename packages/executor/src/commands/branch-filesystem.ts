import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Branch } from '@agor/core/types';
import type { AgorClient } from '../services/feathers-client.js';

export async function resolveExecutorBranch(client: AgorClient, branchId: string): Promise<Branch> {
  const branch = await client.service('branches').get(branchId);
  if (!branch?.path) throw new Error(`Branch not found: ${branchId}`);
  return branch;
}

export function isPathInsideRoot(
  root: string,
  candidate: string,
  options: { allowRoot?: boolean } = {}
): boolean {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === '') return options.allowRoot === true;
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

/**
 * Resolve a branch-relative path without allowing absolute paths, traversal,
 * or symlink escapes. When the final path does not exist, canonicalize its
 * nearest existing ancestor so write destinations remain safe.
 */
export async function resolvePathInsideBranch(
  branchPath: string,
  relativePath: string,
  options: { allowRoot?: boolean; mustExist?: boolean } = {}
): Promise<{ branchRoot: string; absolute: string; relative: string }> {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (normalized.includes('\0')) throw new Error('Invalid branch-relative path');
  if (isAbsolute(normalized)) throw new Error('Path must be relative to the branch root');
  if (!normalized && !options.allowRoot) throw new Error('Branch-relative path is required');

  const branchRoot = await realpath(branchPath);
  const absolute = resolve(branchRoot, normalized || '.');
  if (!isPathInsideRoot(branchRoot, absolute, { allowRoot: options.allowRoot })) {
    throw new Error('Path escapes branch root');
  }

  let canonical = absolute;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if (options.mustExist) throw error;
    let prefix = absolute;
    const suffix: string[] = [];
    while (prefix !== branchRoot) {
      try {
        const realPrefix = await realpath(prefix);
        canonical = resolve(realPrefix, ...suffix.reverse());
        break;
      } catch {
        const parent = resolve(prefix, '..');
        suffix.push(relative(parent, prefix));
        prefix = parent;
      }
    }
    canonical ??= resolve(branchRoot, ...suffix.reverse());
  }

  if (!isPathInsideRoot(branchRoot, canonical, { allowRoot: options.allowRoot })) {
    throw new Error('Path escapes branch root through a symlink');
  }
  return {
    branchRoot,
    absolute,
    relative: relative(branchRoot, absolute).split(sep).join('/'),
  };
}

export async function filesystemStatus(branchPath: string): Promise<{
  exists: boolean;
  kind: 'directory' | 'file' | 'other' | 'missing';
}> {
  try {
    const stats = await lstat(branchPath);
    return {
      exists: true,
      kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { exists: false, kind: 'missing' };
    throw error;
  }
}
