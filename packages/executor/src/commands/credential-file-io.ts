import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** fsync a path's own descriptor, used for both the temp file and its directory. */
async function syncPath(path: string, flags: string): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write a credential file privately and atomically as the effective Unix user,
 * then read it back for verification. Shared by the Codex (`auth.json`) and
 * Claude (`.credentials.json`) executor commands so both get the same 0600,
 * private-dir, temp-then-rename guarantees.
 *
 * Durability: the bytes are fsynced before the rename publishes them, and the
 * parent directory is fsynced after it, so a node that dies once this resolves
 * cannot come back with the credential missing or truncated. Without the file
 * fsync a rename can be durable while its contents are not — the caller would
 * have reported a successful sign-in over a credential that no longer exists.
 *
 * Returns the read-back contents; the caller compares against what it wrote and
 * runs any format-specific verification. The read-back is retried once because
 * some networked/overlay filesystems briefly surface a rename before the new
 * bytes are visible.
 */
export async function writeCredentialFileAtomically(
  target: string,
  content: string
): Promise<string> {
  const dir = join(target, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = join(dir, `.${basename(target)}.${randomBytes(6).toString('hex')}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      // Explicit chmod defeats a umask that could have narrowed the open mode.
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    // Persist the directory entry itself; the rename is only durable once its
    // parent is flushed.
    await syncPath(dir, 'r');
  } finally {
    await rm(temporary, { force: true });
  }
  try {
    return await readFile(target, 'utf8');
  } catch {
    return await readFile(target, 'utf8');
  }
}
