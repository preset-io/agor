import { join } from 'node:path';
import { mutateCredentialFile, writeVerifiedCodexAuthFile } from '@agor/core/codex/credential-file';
import { buildAllowlistedEnv } from '@agor/core/config';
import { requestExecutor } from './spawn-executor.js';

export interface CodexAuthCredentialRouting {
  delegatedHomeKey: string | null;
  userId: string;
  /**
   * Explicit native Codex state root for the auth-file route. HA
   * generation-fenced mutations use it directly; executor operations receive
   * it as `CODEX_HOME`. Set for the built-in local `simple` executor to the
   * caller's Agor-managed namespace, or in `sandbox` to the caller's per-user
   * store. Unset for templated/external routes, whose substrate owns the home.
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
  // them at the daemon-authorized simple namespace or sandbox home so auth
  // helpers and later task execution agree. The option env replaces the spawn
  // environment, so seed it from the secret-free runtime allowlist rather than
  // copying the daemon's deployment credential bag. The explicit value comes
  // last and cannot be replaced by an ambient CODEX_HOME.
  ...(routing.codexHome
    ? { env: { ...buildAllowlistedEnv(), CODEX_HOME: routing.codexHome } }
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
  const written = await writeVerifiedCodexAuthFile({
    target: join(codexHome, 'auth.json'),
    content,
    generation: authorityGeneration,
  });
  if (written.outcome === 'stale') {
    throw new Error('Codex credential write was superseded');
  }
  return {
    authMode: written.authMode,
    ...(written.planType ? { planType: written.planType } : {}),
    ...(written.lastRefresh ? { lastRefresh: written.lastRefresh } : {}),
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
