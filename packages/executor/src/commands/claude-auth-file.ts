import {
  mutateCredentialFile,
  readCredentialAuthorityFile,
} from '@agor/core/codex/credential-file';
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
      raw = await readCredentialAuthorityFile(target);
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
    // The sandbox pre-creates a real empty credential leaf so required bwrap
    // masks cannot materialize/truncate it implicitly. Empty is therefore the
    // signed-out tombstone, not a malformed managed login.
    if (raw.length === 0) return { success: true, data: { status: 'not-found' } };
    // A present file is not itself proof of a usable login. Confirm the complete
    // refreshable OAuth shape the SDK reads without returning any token bytes.
    try {
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: {
          accessToken?: unknown;
          refreshToken?: unknown;
          expiresAt?: unknown;
        };
      };
      const oauth = parsed.claudeAiOauth;
      return typeof oauth?.accessToken === 'string' &&
        oauth.accessToken.startsWith('sk-ant-oat') &&
        typeof oauth.refreshToken === 'string' &&
        oauth.refreshToken.startsWith('sk-ant-ort') &&
        typeof oauth.expiresAt === 'number' &&
        Number.isFinite(oauth.expiresAt) &&
        oauth.expiresAt > 0
        ? { success: true, data: { status: 'found' } }
        : { success: true, data: { status: 'malformed' } };
    } catch {
      return { success: true, data: { status: 'malformed' } };
    }
  }

  if (operation === 'delete') {
    if (
      (await mutateCredentialFile({
        target,
        generation: payload.params.generation,
        preserveAuthorityInodes: true,
      })) === 'stale'
    ) {
      return {
        success: false,
        error: { code: 'AUTH_FILE_STALE', message: 'Claude credential mutation was superseded' },
      };
    }
    return { success: true, data: { status: 'deleted' } };
  }

  const readBack = await writeCredentialFileAtomically(
    target,
    payload.params.content,
    payload.params.generation,
    { preserveAuthorityInodes: true }
  );
  if (readBack === null) {
    return {
      success: false,
      error: { code: 'AUTH_FILE_STALE', message: 'Claude credential mutation was superseded' },
    };
  }
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
