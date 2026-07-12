import type { Database } from '../db/client';
import type { AgenticToolName, ApiKeyName, ProviderConnection, UserID } from '../types';
import { providerToolForField } from '../types';
import { resolveProviderConnection } from './tenant-agentic-tool-resolver';

export type { ApiKeyName } from '../types';

export interface KeyResolutionContext {
  userId?: UserID;
  db?: Database;
  tool?: AgenticToolName;
}

export interface KeyResolutionResult {
  apiKey: string | undefined;
  source: 'user' | 'tenant' | 'none';
  useNativeAuth: boolean;
  connection?: ProviderConnection;
  decryptionFailed?: boolean;
}

/** Resolve a key through the atomic user → ambient tenant connection policy. */
export async function resolveApiKey(
  keyName: ApiKeyName,
  context: KeyResolutionContext = {}
): Promise<KeyResolutionResult> {
  const inferredTool = providerToolForField(keyName);
  const requestedTool = context.tool ?? inferredTool;
  if (!requestedTool) {
    return { apiKey: undefined, source: 'none', useNativeAuth: false };
  }
  const resolved = await resolveProviderConnection(requestedTool, context);
  return {
    apiKey: (resolved.connection as Record<string, string | undefined>)[keyName],
    connection: resolved.connection,
    source: resolved.source,
    useNativeAuth: resolved.useNativeAuth,
    ...(resolved.decryptionFailed ? { decryptionFailed: true } : {}),
  };
}

/** Local synchronous credential fallback was removed with global provider config. */
export function resolveApiKeySync(_keyName: ApiKeyName): KeyResolutionResult {
  return { apiKey: undefined, source: 'none', useNativeAuth: false };
}
