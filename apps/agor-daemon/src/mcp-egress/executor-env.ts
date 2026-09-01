import { AGOR_USER_ENV_KEYS_VAR } from '@agor/core/config';
import { extractMCPTemplateDependencies } from '@agor/core/mcp';
import type { MCPServer } from '@agor/core/types';

function highSignal(value: string): boolean {
  return value.length >= 8 && new Set(value).size >= 4;
}

function highSignalUrlValue(value: string): boolean {
  return value.length >= 16 && new Set(value).size >= 8;
}

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
  return [];
}

function urlValues(url?: string): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    return [
      ...parsed.pathname.split('/').map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      }),
      ...parsed.searchParams.values(),
    ];
  } catch {
    return [];
  }
}

function credentialVariants(value: string): string[] {
  return [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')];
}

function authSecrets(auth: MCPServer['auth']): string[] {
  if (!auth) return [];
  return [
    auth.token,
    auth.api_token,
    auth.api_secret,
    auth.oauth_client_id,
    auth.oauth_client_secret,
    auth.oauth_access_token,
    auth.oauth_refresh_token,
  ].filter((value): value is string => typeof value === 'string');
}

/**
 * Defense in depth for every mediated task, including servers that projection
 * later omits. Removing DEBUG=1-style values would be a collision, not secrecy.
 */
export function scrubMCPSecretsFromExecutorEnv(
  executorEnv: Record<string, string>,
  servers: MCPServer[]
): void {
  const referencedKeys = new Set<string>();
  const literalValues = new Set<string>();
  for (const server of servers) {
    const dependencies = extractMCPTemplateDependencies(server);
    if (!dependencies.valid && dependencies.mightReferenceUserEnv) {
      for (const key of (executorEnv[AGOR_USER_ENV_KEYS_VAR] ?? '').split(',').filter(Boolean)) {
        delete executorEnv[key];
      }
      delete executorEnv[AGOR_USER_ENV_KEYS_VAR];
      continue;
    }
    for (const key of dependencies.keys) referencedKeys.add(key);
    const candidates = [
      ...leaves(server.env),
      ...leaves(server.headers),
      ...authSecrets(server.auth),
      ...urlValues(server.url).filter(highSignalUrlValue),
    ];
    for (const value of candidates.flatMap(credentialVariants)) {
      if (highSignal(value) && !value.includes('{{')) literalValues.add(value);
    }
  }
  for (const [key, value] of Object.entries(executorEnv)) {
    if (referencedKeys.has(key) || literalValues.has(value)) delete executorEnv[key];
  }
  const remainingKeys = (executorEnv[AGOR_USER_ENV_KEYS_VAR] ?? '')
    .split(',')
    .filter((key) => key && !referencedKeys.has(key) && key in executorEnv);
  if (remainingKeys.length) executorEnv[AGOR_USER_ENV_KEYS_VAR] = remainingKeys.join(',');
  else delete executorEnv[AGOR_USER_ENV_KEYS_VAR];
}
