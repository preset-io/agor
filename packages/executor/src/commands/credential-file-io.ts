import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Write a credential file privately and atomically as the effective Unix user,
 * then read it back for verification. Shared by the Codex (`auth.json`) and
 * Claude (`.credentials.json`) executor commands so both get the same 0600,
 * private-dir, temp-then-rename guarantees.
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
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  try {
    return await readFile(target, 'utf8');
  } catch {
    return await readFile(target, 'utf8');
  }
}
