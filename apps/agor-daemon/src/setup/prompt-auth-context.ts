import { resolveApiKey, resolveCodexHome, resolveCodexHomeForUser } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { UserID } from '@agor/core/types';

export type PromptToolType = 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot';

export interface PromptAuthContext {
  apiKeyEnvVar: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'COPILOT_GITHUB_TOKEN';
  apiKey?: string;
  source: 'user' | 'config' | 'env' | 'none';
  useNativeAuth: boolean;
  decryptionFailed?: boolean;
  nativeAuthContext?: {
    stableCodexHome?: string;
  };
}

const TOOL_API_KEY_ENV_VARS: Partial<Record<PromptToolType, PromptAuthContext['apiKeyEnvVar']>> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  codex: 'OPENAI_API_KEY',
  copilot: 'COPILOT_GITHUB_TOKEN',
};

export async function resolvePromptAuthContext(
  db: Database,
  options: {
    userId?: UserID;
    tool: PromptToolType;
  }
): Promise<PromptAuthContext | undefined> {
  const apiKeyEnvVar = TOOL_API_KEY_ENV_VARS[options.tool];
  if (!apiKeyEnvVar) {
    return undefined;
  }

  const resolution = await resolveApiKey(apiKeyEnvVar, {
    userId: options.userId,
    db,
  });

  const nativeAuthContext =
    options.tool === 'codex' && resolution.useNativeAuth
      ? {
          stableCodexHome: options.userId
            ? resolveCodexHomeForUser(options.userId)
            : await resolveCodexHome(),
        }
      : undefined;

  return {
    apiKeyEnvVar,
    apiKey: resolution.apiKey,
    source: resolution.source,
    useNativeAuth: resolution.useNativeAuth,
    ...(resolution.decryptionFailed && { decryptionFailed: true }),
    ...(nativeAuthContext && { nativeAuthContext }),
  };
}
