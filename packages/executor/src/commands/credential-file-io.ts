import { mutateCredentialFile, readCredentialFile } from '@agor/core/codex/credential-file';

/**
 * Write a credential file privately and atomically as the effective Unix user,
 * then read it back for verification. Shared by the Codex (`auth.json`) and
 * Claude (`.credentials.json`) executor commands so both get the same 0600,
 * private-dir, no-follow, fsync, and temp-then-rename guarantees.
 *
 * Returns the read-back contents; the caller compares against what it wrote and
 * runs any format-specific verification. The read-back is retried once because
 * some networked/overlay filesystems briefly surface a rename before the new
 * bytes are visible. This compatibility wrapper lets the Claude command share
 * the current credential-file primitive without adopting Codex-specific parsing.
 */
export async function writeCredentialFileAtomically(
  target: string,
  content: string,
  generation?: number
): Promise<string | null> {
  const outcome = await mutateCredentialFile({ target, content, generation });
  if (outcome === 'stale') return null;
  try {
    return await readCredentialFile(target);
  } catch {
    return await readCredentialFile(target);
  }
}
