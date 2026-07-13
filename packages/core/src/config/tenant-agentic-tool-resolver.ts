import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { decryptApiKey } from '../db/encryption';
import { TenantAgenticToolSettingsRepository } from '../db/repositories/tenant-agentic-tools';
import { users } from '../db/schema';
import type {
  AgenticAuthMethod,
  AgenticToolName,
  ProviderConnection,
  ProviderConnectionTool,
  ProviderResolutionPolicy,
  StoredAgenticTools,
  TenantAgenticToolName,
  UserID,
} from '../types';
import {
  canonicalTenantAgenticTool,
  DEFAULT_PROVIDER_RESOLUTION_POLICY,
  isProviderConnectionTool,
  PROVIDER_CONNECTION_FIELDS,
  PROVIDER_CREDENTIAL_FIELDS,
} from '../types';

const PROVIDER_ENV_KEYS = new Set<string>([
  ...Object.values(PROVIDER_CONNECTION_FIELDS).flat(),
  'GOOGLE_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

export type ProviderConnectionSource = 'user' | 'tenant' | 'none';

export interface ResolvedProviderConnection {
  tool: ProviderConnectionTool;
  connection: ProviderConnection;
  source: ProviderConnectionSource;
  policy: ProviderResolutionPolicy;
  useNativeAuth: boolean;
  decryptionFailed?: boolean;
}

function hasCredential(tool: ProviderConnectionTool, connection: ProviderConnection): boolean {
  return PROVIDER_CREDENTIAL_FIELDS[tool].some((field) =>
    Boolean((connection as Record<string, string>)[field])
  );
}

async function resolveUserConnection(
  tool: ProviderConnectionTool,
  userId: UserID,
  db: Database
): Promise<{
  connection: ProviderConnection;
  useNativeAuth: boolean;
  decryptionFailed?: boolean;
} | null> {
  const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
  if (!row) return null;
  const data = row.data as {
    agentic_tools?: StoredAgenticTools;
    agentic_auth_methods?: Partial<Record<'claude-code' | 'codex', AgenticAuthMethod>>;
  };
  const stored = data.agentic_tools?.[tool];
  const configuredMethod =
    tool === 'claude-code' || tool === 'codex' ? data.agentic_auth_methods?.[tool] : undefined;
  const method =
    configuredMethod ??
    (tool === 'claude-code' && stored?.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : 'api_key');
  if (tool === 'codex' && method === 'subscription') {
    return { connection: {}, useNativeAuth: true };
  }
  if (!stored || Object.keys(stored).length === 0) return null;

  const connection: Record<string, string> = {};
  try {
    for (const field of PROVIDER_CONNECTION_FIELDS[tool]) {
      if (tool === 'claude-code') {
        if (method === 'subscription' && field !== 'CLAUDE_CODE_OAUTH_TOKEN') continue;
        if (method === 'api_key' && field === 'CLAUDE_CODE_OAUTH_TOKEN') continue;
      }
      const encrypted = stored[field];
      if (!encrypted) continue;
      const value = decryptApiKey(encrypted).trim();
      if (value) connection[field] = value;
    }
  } catch {
    return { connection: {}, useNativeAuth: false, decryptionFailed: true };
  }
  return { connection, useNativeAuth: false };
}

/** Resolve one complete provider connection according to the tenant's explicit policy. */
export async function resolveProviderConnection(
  requestedTool: AgenticToolName,
  context: { userId?: UserID; db?: Database } = {}
): Promise<ResolvedProviderConnection> {
  const canonical = canonicalTenantAgenticTool(requestedTool);
  if (!isProviderConnectionTool(canonical)) {
    throw new Error(`Tool ${requestedTool} does not use a provider connection`);
  }

  const repository = context.db ? new TenantAgenticToolSettingsRepository(context.db) : null;
  const policy = repository
    ? await repository.resolutionPolicy(canonical)
    : DEFAULT_PROVIDER_RESOLUTION_POLICY;
  const user =
    context.userId && context.db
      ? await resolveUserConnection(canonical, context.userId, context.db)
      : null;
  const tenantConnection = repository ? await repository.connection(canonical) : null;
  const userCandidate = user
    ? {
        source: 'user' as const,
        connection: user.connection,
        useNativeAuth: user.useNativeAuth,
        decryptionFailed: user.decryptionFailed,
      }
    : null;
  const tenantCandidate = tenantConnection
    ? { source: 'tenant' as const, connection: tenantConnection }
    : null;
  const candidates =
    policy === 'user_required'
      ? [userCandidate]
      : policy === 'tenant_required'
        ? [tenantCandidate]
        : policy === 'tenant_preferred'
          ? [tenantCandidate, userCandidate]
          : [userCandidate, tenantCandidate];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const { connection, source } = candidate;
    const useNativeAuth = 'useNativeAuth' in candidate && candidate.useNativeAuth;
    if ('decryptionFailed' in candidate && candidate.decryptionFailed) {
      return {
        tool: canonical,
        connection: {},
        source,
        policy,
        useNativeAuth: false,
        decryptionFailed: true,
      };
    }
    if ((connection && hasCredential(canonical, connection)) || useNativeAuth) {
      return {
        tool: canonical,
        connection,
        source,
        policy,
        useNativeAuth,
        ...('decryptionFailed' in candidate && candidate.decryptionFailed
          ? { decryptionFailed: true }
          : {}),
      };
    }
  }

  return { tool: canonical, connection: {}, source: 'none', policy, useNativeAuth: false };
}

export async function isTenantAgenticToolEnabled(
  tool: AgenticToolName,
  db: Database
): Promise<boolean> {
  const canonical: TenantAgenticToolName = canonicalTenantAgenticTool(tool);
  return new TenantAgenticToolSettingsRepository(db).isEnabled(canonical);
}

export function stripProviderCredentialEnvironment<T extends Record<string, string | undefined>>(
  input: T
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const isCloudProviderState =
      key.startsWith('AWS_') ||
      key.startsWith('ANTHROPIC_VERTEX_') ||
      key === 'CLAUDE_CODE_USE_BEDROCK' ||
      key === 'CLAUDE_CODE_USE_VERTEX' ||
      key === 'GOOGLE_APPLICATION_CREDENTIALS' ||
      key === 'CLOUD_ML_REGION' ||
      key === 'VERTEX_REGION_CLAUDE_3_5_HAIKU';
    if (value !== undefined && !PROVIDER_ENV_KEYS.has(key) && !isCloudProviderState) {
      output[key] = value;
    }
  }
  return output;
}
