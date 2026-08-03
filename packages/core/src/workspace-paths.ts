import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function assertRelativeIdentity(value: string, label: string): void {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is not a safe workspace identity`);
  }
}

/** Derive the only valid persisted path for a managed branch workspace. */
export function deriveManagedBranchPath(
  root: string,
  repoSlug: string,
  branchName: string
): string {
  assertRelativeIdentity(repoSlug, 'Repository slug');
  assertRelativeIdentity(branchName, 'Branch name');
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, repoSlug, branchName);
  if (candidate === resolvedRoot || !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Derived branch workspace escapes the managed root');
  }
  return candidate;
}

async function nearestExistingPath(candidate: string, floor: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current === floor) return floor;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Revalidate a stored workspace at a filesystem sink. Exact derivation catches
 * stale/caller-controlled rows; canonical ancestor comparison catches symlink
 * escapes before a missing workspace is created.
 */
export async function assertManagedBranchPath(options: {
  root: string;
  repoSlug: string;
  branchName: string;
  storedPath: string;
}): Promise<string> {
  const expected = deriveManagedBranchPath(options.root, options.repoSlug, options.branchName);
  if (path.resolve(options.storedPath) !== expected || options.storedPath !== expected) {
    throw new Error('Stored branch workspace does not match the trusted storage layout');
  }

  const root = path.resolve(options.root);
  const existingRoot = await nearestExistingPath(root, path.parse(root).root);
  // If the tenant root itself has not been created yet, there cannot be a
  // symlink below it. The lifecycle identity will create the derived path.
  if (existingRoot !== root) return expected;
  const existingCandidate = await nearestExistingPath(expected, root);
  const [canonicalRootBase, canonicalCandidate] = await Promise.all([
    realpath(existingRoot),
    realpath(existingCandidate),
  ]);
  const canonicalRoot = path.join(canonicalRootBase, path.relative(existingRoot, root));
  if (
    canonicalCandidate !== canonicalRoot &&
    !canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)
  ) {
    throw new Error('Branch workspace resolves outside the managed root');
  }
  return expected;
}
