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

/**
 * Ambient environment surface (beyond the tool's own connection fields) that
 * can steer THAT tool's SDK toward a credential other than the resolved
 * connection. Scoped per tool on purpose: `GITHUB_TOKEN` is a governance
 * bypass for Copilot but a legitimate user-configured `gh`/git credential in
 * every other session, and `AWS_*`/`GOOGLE_APPLICATION_CREDENTIALS` are inert
 * for the Claude SDK once the `CLAUDE_CODE_USE_*` switches are stripped.
 */
const PROVIDER_AMBIENT_ENV: Record<
  ProviderConnectionTool,
  { keys: readonly string[]; prefixes: readonly string[] }
> = {
  'claude-code': {
    keys: [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLOUD_ML_REGION',
      'VERTEX_REGION_CLAUDE_3_5_HAIKU',
    ],
    prefixes: ['ANTHROPIC_VERTEX_'],
  },
  codex: { keys: [], prefixes: [] },
  gemini: {
    // The Gemini CLI also authenticates via GOOGLE_API_KEY and Vertex ADC.
    keys: ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI'],
    prefixes: [],
  },
  copilot: {
    // The Copilot CLI falls back to ambient GH_TOKEN / GITHUB_TOKEN.
    keys: ['GITHUB_TOKEN', 'GH_TOKEN'],
    prefixes: [],
  },
  cursor: { keys: [], prefixes: [] },
};

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

/**
 * Remove the running tool's provider-credential surface from an environment
 * map so the policy-resolved connection is the ONLY credential that tool's
 * SDK can see. Deliberately tool-scoped: user-configured env vars that are
 * generic dev credentials for this session (GITHUB_TOKEN in a Claude session,
 * AWS_* for terraform work, …) must survive — see the 2026-07-13 regression
 * where a global strip deleted GITHUB_TOKEN from every session.
 */
export function stripProviderCredentialEnvironment<T extends Record<string, string | undefined>>(
  input: T,
  tool: AgenticToolName
): Record<string, string> {
  const canonical = canonicalTenantAgenticTool(tool);
  const stripKeys = new Set<string>();
  const stripPrefixes: string[] = [];
  if (isProviderConnectionTool(canonical)) {
    for (const field of PROVIDER_CONNECTION_FIELDS[canonical]) {
      stripKeys.add(field);
    }
    const ambient = PROVIDER_AMBIENT_ENV[canonical];
    for (const key of ambient.keys) {
      stripKeys.add(key);
    }
    stripPrefixes.push(...ambient.prefixes);
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (stripKeys.has(key)) continue;
    if (stripPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    output[key] = value;
  }
  return output;
}
