import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

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
    current = path.dirname(current);
  }
}

/** Canonical containment check owned by the filesystem execution substrate. */
export async function assertCanonicalWorkspaceContainment(
  rootPath: string,
  workspacePath: string
): Promise<void> {
  const root = path.resolve(rootPath);
  const existingRoot = await nearestExistingPath(root, path.parse(root).root);
  if (existingRoot !== root) return;
  const existingWorkspace = await nearestExistingPath(workspacePath, root);
  const [canonicalRoot, canonicalWorkspace] = await Promise.all([
    realpath(root),
    realpath(existingWorkspace),
  ]);
  if (
    canonicalWorkspace !== canonicalRoot &&
    !canonicalWorkspace.startsWith(`${canonicalRoot}${path.sep}`)
  ) {
    throw new Error('Branch workspace resolves outside the managed root');
  }
}
