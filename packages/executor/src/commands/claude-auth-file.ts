import { readFile, rm } from 'node:fs/promises';
import type { ClaudeAuthFilePayload, ExecutorResult } from '../payload-types.js';
import { resolveClaudeCredentialsPath } from '../user-runtime-paths.js';
import { writeCredentialFileAtomically } from './credential-file-io.js';
import type { CommandOptions } from './index.js';

/**
 * Inspect/write/delete the Claude Code subscription login file
 * (`~/.claude/.credentials.json`) for the effective Unix user. Runs in the
 * execution home the daemon routes to (via the delegated home key), so ownership
 * and 0600 hold in sandbox/delegated modes. Mirrors `codex.auth-file`; see
 * `context/explorations/claude-code-oauth-signin.md`.
 *
 * The content is the daemon-built `{ claudeAiOauth: {...} }` document. This
 * handler does not echo token material — it returns only a non-secret status.
 */
export async function handleClaudeAuthFile(
  payload: ClaudeAuthFilePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { operation } = payload.params;
  if (options.dryRun) return { success: true, data: { operation, dryRun: true } };

  const target = resolveClaudeCredentialsPath();

  if (operation === 'inspect') {
    let raw: string;
    try {
      raw = await readFile(target, 'utf8');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { success: true, data: { status: 'not-found' } }
        : {
            success: false,
            error: {
              code: 'AUTH_FILE_UNREADABLE',
              message: 'Claude credentials file could not be read',
            },
          };
    }
    // A present-but-malformed file is not a usable login. Confirm the shape the
    // SDK reads (`claudeAiOauth.accessToken`) without returning any token bytes.
    try {
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
      return typeof parsed.claudeAiOauth?.accessToken === 'string' &&
        parsed.claudeAiOauth.accessToken
        ? { success: true, data: { status: 'found' } }
        : { success: true, data: { status: 'malformed' } };
    } catch {
      return { success: true, data: { status: 'malformed' } };
    }
  }

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
