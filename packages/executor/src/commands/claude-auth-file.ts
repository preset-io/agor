import { rm } from 'node:fs/promises';
import type { ClaudeAuthFilePayload, ExecutorResult } from '../payload-types.js';
import { resolveClaudeCredentialsPath } from '../user-runtime-paths.js';
import { writeCredentialFileAtomically } from './credential-file-io.js';
import type { CommandOptions } from './index.js';

/**
 * Write/delete the Claude Code subscription login file
 * (`~/.claude/.credentials.json`) for the effective Unix user. Runs AS the target
 * identity (the daemon selects it via `asUser`), so ownership and 0600 hold in
 * insulated/strict modes. Mirrors `codex.auth-file`; see
 * `context/explorations/claude-code-oauth-signin.md`.
 *
 * The content is the daemon-built `{ claudeAiOauth: {...} }` document. This
 * handler does not parse or echo token material — it writes bytes, verifies the
 * read-back, and returns only a non-secret status.
 */
export async function handleClaudeAuthFile(
  payload: ClaudeAuthFilePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { operation } = payload.params;
  if (options.dryRun) return { success: true, data: { operation, dryRun: true } };

  const target = resolveClaudeCredentialsPath();

  if (operation === 'delete') {
    await rm(target, { force: true });
    return { success: true, data: { status: 'deleted' } };
  }

  const readBack = await writeCredentialFileAtomically(target, payload.params.content);
  if (readBack !== payload.params.content) {
    return {
      success: false,
      error: {
        code: 'AUTH_FILE_VERIFY_FAILED',
        message: 'Claude credentials file could not be verified',
      },
    };
  }
  return { success: true, data: { status: 'written' } };
}
