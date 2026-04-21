import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type AgorConfig, resolveApiKey, resolveCodexHomeForUser } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { runAsUser, type UnixUserMode } from '@agor/core/unix';

export type CodexCredentialStore = 'file' | 'keyring' | 'auto' | 'unknown';
export type CodexAuthStatusKind =
  | 'using_api_key'
  | 'signed_in_with_chatgpt'
  | 'not_signed_in'
  | 'unknown';
export type CodexApiKeySource = 'user' | 'config' | 'env';

export interface CodexAuthStatusContext {
  agorUserId: UserID;
  codexHome: string;
  executionUnixUser: string | null;
  apiKeySource?: CodexApiKeySource;
}

export interface CodexAuthStatus {
  agorUserId: UserID;
  status: CodexAuthStatusKind;
  label:
    | 'Using API key'
    | 'Signed in with ChatGPT'
    | 'Not signed in'
    | 'Unknown / needs verification';
  description: string;
  guidance: string[];
  warnings: string[];
  codexHome: string;
  apiKeySource?: CodexApiKeySource;
  credentialStore: CodexCredentialStore;
  unixUserMode: UnixUserMode;
  executionUnixUser: string | null;
  decryptionFailed?: boolean;
}

interface DeriveCodexAuthStatusInput {
  apiKeySource?: CodexApiKeySource;
  authJsonExists: boolean;
  credentialStore: CodexCredentialStore;
  unixUserMode: UnixUserMode;
  codexHome: string;
  scope: 'user';
  executionUnixUser: string | null;
  decryptionFailed?: boolean;
}

export interface ResolveCodexAuthStatusOptions {
  agorUserId: UserID;
  sessionUnixUsername?: string | null;
  probeNativeAuthStatus?: (context: CodexAuthStatusContext) => Promise<CodexNativeProbeResult>;
}

export type CodexNativeProbeResult = 'logged_in' | 'not_logged_in' | 'unknown';

function getLoginGuidance(codexHome: string): string[] {
  return [
    `Run \`CODEX_HOME="${codexHome}" codex login\` in the daemon environment.`,
    `For headless hosts, run \`CODEX_HOME="${codexHome}" codex login --device-auth\`.`,
  ];
}

async function executeCodexLoginStatus(command: string, asUser?: string | null): Promise<string> {
  try {
    return runAsUser(command, { asUser: asUser ?? undefined }).trim();
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    const output = [execError.stdout, execError.stderr]
      .map((value) => (typeof value === 'string' ? value : value?.toString('utf-8')))
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
      .trim();

    if (output) {
      return output;
    }

    throw error;
  }
}

export async function probeCodexLoginStatus(
  context: Pick<CodexAuthStatusContext, 'codexHome' | 'executionUnixUser'>,
  execute: (command: string, asUser?: string | null) => Promise<string> = executeCodexLoginStatus
): Promise<CodexNativeProbeResult> {
  const escapedCodexHome = context.codexHome.replace(/'/g, "'\\''");
  const output = await execute(
    `CODEX_HOME='${escapedCodexHome}' codex login status`,
    context.executionUnixUser
  );

  if (output.includes('Logged in using ChatGPT')) {
    return 'logged_in';
  }

  if (output.includes('Not logged in')) {
    return 'not_logged_in';
  }

  return 'unknown';
}

export function parseCodexCredentialStore(
  configToml: string | null | undefined
): CodexCredentialStore {
  if (!configToml) {
    return 'unknown';
  }

  const match = configToml.match(/cli_auth_credentials_store\s*=\s*"([^"]+)"/);
  const value = match?.[1];

  if (value === 'file' || value === 'keyring' || value === 'auto') {
    return value;
  }

  return 'unknown';
}

export function resolveCodexAuthStatusContext(
  _config: AgorConfig,
  options: { agorUserId: UserID; sessionUnixUsername?: string | null }
): CodexAuthStatusContext {
  return {
    agorUserId: options.agorUserId,
    codexHome: resolveCodexHomeForUser(options.agorUserId),
    executionUnixUser: options.sessionUnixUsername ?? null,
    apiKeySource: undefined,
  };
}

export function deriveCodexAuthStatus(
  input: DeriveCodexAuthStatusInput
): Omit<CodexAuthStatus, 'agorUserId'> {
  if (input.apiKeySource) {
    const descriptionBySource: Record<CodexApiKeySource, string> = {
      user: 'A user-specific OPENAI_API_KEY is configured and overrides native Codex auth.',
      config:
        'An app-level OPENAI_API_KEY is configured in Agor settings and overrides native Codex auth.',
      env: 'An environment OPENAI_API_KEY is configured for the daemon and overrides native Codex auth.',
    };

    const warnings = input.decryptionFailed
      ? [
          'A stored user API key exists but could not be decrypted; native Codex auth is still bypassed.',
        ]
      : [];

    return {
      status: 'using_api_key',
      label: 'Using API key',
      description: descriptionBySource[input.apiKeySource],
      guidance: [],
      warnings,
      codexHome: input.codexHome,
      apiKeySource: input.apiKeySource,
      credentialStore: input.credentialStore,
      unixUserMode: input.unixUserMode,
      executionUnixUser: input.executionUnixUser,
      ...(input.decryptionFailed && { decryptionFailed: true }),
    };
  }

  if (input.authJsonExists) {
    return {
      status: 'signed_in_with_chatgpt',
      label: 'Signed in with ChatGPT',
      description: 'Native Codex auth was detected in the Agor-managed per-user Codex home.',
      guidance: [],
      warnings: [],
      codexHome: input.codexHome,
      credentialStore: input.credentialStore,
      unixUserMode: input.unixUserMode,
      executionUnixUser: input.executionUnixUser,
    };
  }

  if (input.credentialStore === 'file') {
    return {
      status: 'not_signed_in',
      label: 'Not signed in',
      description:
        'Codex is configured to use file-backed credentials, but no auth.json was found.',
      guidance: getLoginGuidance(input.codexHome),
      warnings: [],
      codexHome: input.codexHome,
      credentialStore: input.credentialStore,
      unixUserMode: input.unixUserMode,
      executionUnixUser: input.executionUnixUser,
    };
  }

  return {
    status: 'unknown',
    label: 'Unknown / needs verification',
    description: 'Agor could not verify native Codex auth from the current per-user Codex home.',
    guidance: getLoginGuidance(input.codexHome),
    warnings: ['No file-backed Codex auth was detected. Keyring-backed auth may still work.'],
    codexHome: input.codexHome,
    credentialStore: input.credentialStore,
    unixUserMode: input.unixUserMode,
    executionUnixUser: input.executionUnixUser,
  };
}

export async function getCodexAuthStatus(
  db: Database,
  config: AgorConfig,
  options: ResolveCodexAuthStatusOptions
): Promise<CodexAuthStatus> {
  const keyResolution = await resolveApiKey('OPENAI_API_KEY', {
    userId: options.agorUserId,
    db,
  });
  const apiKeySource = keyResolution.source === 'none' ? undefined : keyResolution.source;
  const context = {
    ...resolveCodexAuthStatusContext(config, options),
    apiKeySource,
  };
  const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;

  let configToml: string | undefined;
  let authJsonExists = false;
  let nativeProbeResult: CodexNativeProbeResult = 'unknown';

  try {
    configToml = await fs.readFile(path.join(context.codexHome, 'config.toml'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`⚠️ Failed to read Codex config.toml from ${context.codexHome}:`, error);
    }
  }

  try {
    await fs.access(path.join(context.codexHome, 'auth.json'));
    authJsonExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`⚠️ Failed to inspect Codex auth.json in ${context.codexHome}:`, error);
    }
  }

  const credentialStore = parseCodexCredentialStore(configToml);
  const shouldProbeNativeAuth =
    !apiKeySource &&
    !authJsonExists &&
    (credentialStore === 'keyring' || credentialStore === 'auto');

  if (shouldProbeNativeAuth) {
    try {
      nativeProbeResult = options.probeNativeAuthStatus
        ? await options.probeNativeAuthStatus(context)
        : await probeCodexLoginStatus(context);
    } catch (error) {
      console.warn('⚠️ Failed to probe Codex login status:', error);
    }
  }

  if (nativeProbeResult === 'logged_in') {
    return {
      agorUserId: options.agorUserId,
      status: 'signed_in_with_chatgpt',
      label: 'Signed in with ChatGPT',
      description: 'Codex CLI reported native auth available for this Agor user.',
      guidance: [],
      warnings: [],
      codexHome: context.codexHome,
      apiKeySource,
      credentialStore,
      unixUserMode,
      executionUnixUser: context.executionUnixUser,
    };
  }

  if (nativeProbeResult === 'not_logged_in') {
    return {
      agorUserId: options.agorUserId,
      status: 'not_signed_in',
      label: 'Not signed in',
      description: 'Codex CLI reported that native auth is not configured for this Agor user.',
      guidance: getLoginGuidance(context.codexHome),
      warnings: [],
      codexHome: context.codexHome,
      apiKeySource,
      credentialStore,
      unixUserMode,
      executionUnixUser: context.executionUnixUser,
    };
  }

  return {
    agorUserId: options.agorUserId,
    ...deriveCodexAuthStatus({
      apiKeySource,
      authJsonExists,
      credentialStore,
      unixUserMode,
      codexHome: context.codexHome,
      scope: 'user',
      executionUnixUser: context.executionUnixUser,
      decryptionFailed: keyResolution.decryptionFailed,
    }),
  };
}

export class CodexAuthStatusManager {
  constructor(
    private readonly db: Database,
    private readonly config: AgorConfig
  ) {}

  async getStatusForUser(userId: UserID): Promise<CodexAuthStatus> {
    return getCodexAuthStatus(this.db, this.config, { agorUserId: userId });
  }
}
