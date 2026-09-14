import { parseCodexAuthJson } from '@agor/core/codex/auth-file';
import {
  mutateCredentialFile,
  readCredentialFile,
  type VerifiedCodexAuthWrite,
  writeVerifiedCodexAuthFile,
} from '@agor/core/codex/credential-file';
import type { CodexAuthFilePayload, ExecutorResult } from '../payload-types.js';
import { resolveCodexAuthPath } from '../user-runtime-paths.js';
import type { CommandOptions } from './index.js';

export async function handleCodexAuthFile(
  payload: CodexAuthFilePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { operation } = payload.params;
  if (options.dryRun) return { success: true, data: { operation, dryRun: true } };

  const target = resolveCodexAuthPath();
  if (operation === 'inspect') {
    try {
      const parsed = parseCodexAuthJson(await readCredentialFile(target));
      if (!parsed.ok) return { success: true, data: { status: 'malformed' } };
      const inspection = parsed.summary;
      if (inspection.authMode !== 'api_key') {
        return {
          success: true,
          data: {
            status: 'found',
            authMode: 'chatgpt',
            ...(inspection.planType ? { planType: inspection.planType } : {}),
            ...(inspection.lastRefresh ? { lastRefresh: inspection.lastRefresh } : {}),
          },
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
          /\/$/,
          ''
        );
        const response = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${inspection.apiKey}` },
          signal: controller.signal,
        });
        return {
          success: true,
          data: {
            status: 'found',
            authMode: 'api_key',
            apiKeyStatus:
              response.status === 401 || response.status === 403
                ? 'unauthenticated'
                : response.ok
                  ? 'authenticated'
                  : 'unknown',
          },
        };
      } catch {
        return {
          success: true,
          data: { status: 'found', authMode: 'api_key', apiKeyStatus: 'unknown' },
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { success: true, data: { status: 'not-found' } }
        : {
            success: false,
            error: { code: 'AUTH_FILE_UNREADABLE', message: 'Codex auth file could not be read' },
          };
    }
  }
  if (operation === 'delete') {
    const outcome = await mutateCredentialFile({
      target,
      generation: payload.params.generation,
    });
    if (outcome === 'stale') {
      return {
        success: false,
        error: { code: 'AUTH_FILE_STALE', message: 'A newer credential mutation already won' },
      };
    }
    return { success: true, data: { status: 'deleted' } };
  }

  let written: VerifiedCodexAuthWrite;
  try {
    written = await writeVerifiedCodexAuthFile({
      target,
      content: payload.params.content,
      generation: payload.params.generation,
    });
  } catch {
    return {
      success: false,
      error: { code: 'AUTH_FILE_VERIFY_FAILED', message: 'Codex auth file could not be verified' },
    };
  }
  if (written.outcome === 'stale') {
    return {
      success: false,
      error: { code: 'AUTH_FILE_STALE', message: 'A newer credential mutation already won' },
    };
  }
  return {
    success: true,
    data: {
      status: 'written',
      authMode: written.authMode,
      ...(written.planType ? { planType: written.planType } : {}),
      ...(written.lastRefresh ? { lastRefresh: written.lastRefresh } : {}),
    },
  };
}
