import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexAuthJson } from '@agor/core/codex/auth-file';
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
      const parsed = parseCodexAuthJson(await readFile(target, 'utf8'));
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
    await rm(target, { force: true });
    return { success: true, data: { status: 'deleted' } };
  }

  const dir = join(target, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = join(dir, `.auth.json.${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(temporary, payload.params.content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  let readBack: string;
  try {
    readBack = await readFile(target, 'utf8');
  } catch {
    readBack = await readFile(target, 'utf8');
  }
  if (readBack !== payload.params.content) {
    return {
      success: false,
      error: { code: 'AUTH_FILE_VERIFY_FAILED', message: 'Codex auth file could not be verified' },
    };
  }
  const parsed = parseCodexAuthJson(readBack);
  return parsed.ok
    ? {
        success: true,
        data: {
          status: 'written',
          authMode: parsed.summary.authMode,
          ...(parsed.summary.planType ? { planType: parsed.summary.planType } : {}),
          ...(parsed.summary.lastRefresh ? { lastRefresh: parsed.summary.lastRefresh } : {}),
        },
      }
    : {
        success: false,
        error: {
          code: 'AUTH_FILE_VERIFY_FAILED',
          message: 'Codex auth file could not be verified',
        },
      };
}
