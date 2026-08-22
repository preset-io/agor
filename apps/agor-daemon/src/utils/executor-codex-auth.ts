import { join } from 'node:path';
import { parseCodexAuthJson } from '@agor/core/codex/auth-file';
import { mutateCredentialFile, readCredentialFile } from '@agor/core/codex/credential-file';
import { requestExecutor } from './spawn-executor.js';

export interface CodexAuthCredentialRouting {
  delegatedHomeKey: string | null;
  userId: string;
  /**
   * Explicit `CODEX_HOME` (the `.codex` dir) for the auth-file route. HA
   * generation-fenced mutations use it directly; executor operations receive
   * it as `CODEX_HOME`. Unset routes the executor to its effective user's
   * `~/.codex`.
   */
  codexHome?: string;
}

export type CodexAuthInspection =
  | {
      ok: true;
      authMode: 'chatgpt' | 'api_key';
      planType?: string;
      lastRefresh?: string;
      apiKeyStatus?: 'authenticated' | 'unauthenticated' | 'unknown';
    }
  | { ok: false; reason: 'not-found' | 'malformed' | 'unreadable' };

const options = (routing: CodexAuthCredentialRouting) => ({
  delegatedHomeKey: routing.delegatedHomeKey ?? undefined,
  templateVariables: {
    unix_user: routing.delegatedHomeKey ?? undefined,
    user_id: routing.userId,
  },
  // Executor-routed operations resolve the auth file from CODEX_HOME. Point
  // them at the caller's per-user store `.codex` so they inspect the same file
  // as the sandboxed session (with that store overlaid at ~). Merge OVER
  // process.env because options.env replaces the spawn environment.
  ...(routing.codexHome
    ? { env: { ...(process.env as Record<string, string>), CODEX_HOME: routing.codexHome } }
    : {}),
  sensitiveOutput: true,
  timeoutMs: 10_000,
  logPrefix: '[CodexAuthExecutor]',
});

async function mutateViaExecutor(
  payload: Record<string, unknown>,
  routing: CodexAuthCredentialRouting
) {
  return requestExecutor(payload, options(routing));
}

/**
 * HA sandbox mutations run inside the authority-owning daemon instead of a
 * detached helper. A daemon crash therefore stops the writer; retry can safely
 * supersede it. The shared credential-file primitive anchors Linux operations
 * to an opened directory so the daemon cannot follow a cross-home symlink.
 */
async function writeCodexAuthLocally(
  content: string,
  codexHome: string,
  authorityGeneration: number
): Promise<{ authMode: 'chatgpt' | 'api_key'; planType?: string; lastRefresh?: string }> {
  const target = join(codexHome, 'auth.json');
  if (
    (await mutateCredentialFile({ target, content, generation: authorityGeneration })) === 'stale'
  ) {
    throw new Error('Codex credential write was superseded');
  }
  const readBack = await readCredentialFile(target);
  if (readBack !== content) throw new Error('Codex credential write verification failed');
  const parsed = parseCodexAuthJson(readBack);
  if (!parsed.ok) throw new Error('Codex credential write verification failed');
  return {
    authMode: parsed.summary.authMode,
    ...(parsed.summary.planType ? { planType: parsed.summary.planType } : {}),
    ...(parsed.summary.lastRefresh ? { lastRefresh: parsed.summary.lastRefresh } : {}),
  };
}

export async function inspectCodexAuthViaExecutor(
  routing: CodexAuthCredentialRouting
): Promise<CodexAuthInspection> {
  const result = await requestExecutor(
    { command: 'codex.auth-file', params: { operation: 'inspect' } },
    options(routing)
  );
  if (!result.success) return { ok: false, reason: 'unreadable' };
  const data = result.data as Record<string, unknown>;
  if (data.status === 'not-found') return { ok: false, reason: 'not-found' };
  if (data.status === 'malformed') return { ok: false, reason: 'malformed' };
  if (data.status !== 'found' || (data.authMode !== 'chatgpt' && data.authMode !== 'api_key')) {
    return { ok: false, reason: 'unreadable' };
  }
  return {
    ok: true,
    authMode: data.authMode,
    ...(typeof data.planType === 'string' ? { planType: data.planType } : {}),
    ...(typeof data.lastRefresh === 'string' ? { lastRefresh: data.lastRefresh } : {}),
    ...(data.apiKeyStatus === 'authenticated' ||
    data.apiKeyStatus === 'unauthenticated' ||
    data.apiKeyStatus === 'unknown'
      ? { apiKeyStatus: data.apiKeyStatus }
      : {}),
  };
}

export async function writeCodexAuthCredential(
  content: string,
  routing: CodexAuthCredentialRouting,
  authorityGeneration?: number
): Promise<{ authMode: 'chatgpt' | 'api_key'; planType?: string; lastRefresh?: string }> {
  if (authorityGeneration !== undefined && routing.codexHome) {
    return writeCodexAuthLocally(content, routing.codexHome, authorityGeneration);
  }
  const result = await mutateViaExecutor(
    {
      command: 'codex.auth-file',
      params: { operation: 'write', content, generation: authorityGeneration },
    },
    routing
  );
  if (!result.success) throw new Error('Executor credential write failed');
  const data = result.data as Record<string, unknown>;
  if (data.status !== 'written' || (data.authMode !== 'chatgpt' && data.authMode !== 'api_key')) {
    throw new Error('Executor credential write verification failed');
  }
  return {
    authMode: data.authMode,
    ...(typeof data.planType === 'string' ? { planType: data.planType } : {}),
    ...(typeof data.lastRefresh === 'string' ? { lastRefresh: data.lastRefresh } : {}),
  };
}

export async function deleteCodexAuthCredential(
  routing: CodexAuthCredentialRouting,
  authorityGeneration?: number
): Promise<void> {
  if (authorityGeneration !== undefined && routing.codexHome) {
    const outcome = await mutateCredentialFile({
      target: join(routing.codexHome, 'auth.json'),
      generation: authorityGeneration,
    });
    if (outcome === 'stale') throw new Error('Codex credential delete was superseded');
    return;
  }
  const result = await mutateViaExecutor(
    {
      command: 'codex.auth-file',
      params: { operation: 'delete', generation: authorityGeneration },
    },
    routing
  );
  if (!result.success) throw new Error('Executor credential delete failed');
}
