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

/**
 * Revalidate a stored workspace against trusted identity. Filesystem-owning
 * execution substrates must additionally canonicalize existing ancestors.
 */
export function assertManagedBranchPath(options: {
  root: string;
  repoSlug: string;
  branchName: string;
  storedPath: string;
}): string {
  const expected = deriveManagedBranchPath(options.root, options.repoSlug, options.branchName);
  if (path.resolve(options.storedPath) !== expected || options.storedPath !== expected) {
    throw new Error('Stored branch workspace does not match the trusted storage layout');
  }
  return expected;
}
