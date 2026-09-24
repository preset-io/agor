import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Narrow, path-only preflight for a native checkpoint tree. Do not import the
 * portable archive walker into the daemon's DB surface: it hashes file bytes
 * and makes archive write capabilities daemon-reachable.
 */
export async function hasTenantNativeStateFilesystemTree(root: string): Promise<boolean> {
  const inspect = async (path: string): Promise<'missing' | 'symlink' | 'directory' | 'other'> => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return 'symlink';
      return info.isDirectory() ? 'directory' : 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  };

  const rootKind = await inspect(root);
  if (rootKind === 'symlink') throw new Error('Refusing a symlinked tenant filesystem root');
  if (rootKind !== 'directory') return false;

  for (const homeName of ['home', 'homes']) {
    const home = join(root, homeName);
    const homeKind = await inspect(home);
    if (homeKind === 'symlink') return true; // Could hide native state.
    if (homeKind !== 'directory') continue;
    for (const userName of await readdir(home)) {
      const userHome = join(home, userName);
      const userKind = await inspect(userHome);
      if (userKind === 'symlink') return true;
      if (userKind !== 'directory') continue;
      let parent = userHome;
      for (const part of ['.local', 'share', 'agor', 'opencode']) {
        parent = join(parent, part);
        const kind = await inspect(parent);
        if (kind === 'symlink') return true;
        if (part === 'opencode' && kind !== 'missing') return true;
        if (kind !== 'directory') break;
      }
    }
  }
  return false;
}
