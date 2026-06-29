import type { TenantContext, TenantID } from '../types/tenant';
import type { AgorConfig, AgorMultiTenancySettings } from './types';

export const DEFAULT_STATIC_TENANT_ID = 'default' as TenantID;
const RESERVED_AUTH_CLAIMS = new Set(['aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'sub', 'type']);

export interface ResolvedMultiTenancyConfig {
  mode: 'static' | 'required_from_auth';
  static_tenant_id: TenantID;
  auth_claim?: string;
  trusted_header?: string;
}

export interface TenantResolutionInput {
  /** Authenticated Feathers params or socket-auth state. */
  params?: {
    tenant?: TenantContext;
    tenant_id?: string;
    user?: { tenant_id?: string };
    authentication?: unknown;
    headers?: Record<string, unknown>;
  };
  /** Decoded JWT payload from socket handshake/auth middleware. */
  authPayload?: unknown;
  /** Trusted request headers, lower-case or original-case. */
  headers?: Record<string, unknown>;
}

export class TenantResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantResolutionError';
  }
}

function normalizeTenantId(value: unknown): TenantID | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? (trimmed as TenantID) : null;
}

function detectPostgresUrl(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.startsWith('postgresql://') ||
    lower.startsWith('postgres://') ||
    lower.startsWith('pg://')
  );
}

export function resolveMultiTenancyDatabaseDialect(
  config: Pick<AgorConfig, 'database'> = {}
): 'sqlite' | 'postgresql' {
  if (process.env.AGOR_DB_DIALECT === 'postgresql' || process.env.AGOR_DB_DIALECT === 'sqlite') {
    return process.env.AGOR_DB_DIALECT;
  }
  if (detectPostgresUrl(process.env.DATABASE_URL)) return 'postgresql';
  if (config.database?.dialect === 'postgresql' || config.database?.dialect === 'sqlite') {
    return config.database.dialect;
  }
  if (detectPostgresUrl(config.database?.postgresql?.url) || config.database?.postgresql?.host) {
    return 'postgresql';
  }
  return 'sqlite';
}

function readAuthenticationPayload(authentication: unknown): unknown {
  if (!authentication || typeof authentication !== 'object') return undefined;
  return (authentication as { payload?: unknown }).payload;
}

function readClaim(payload: unknown, claim: string | undefined): TenantID | null {
  if (!claim || !payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[claim];
  return normalizeTenantId(value);
}

function readHeader(
  headers: Record<string, unknown> | undefined,
  header: string | undefined
): TenantID | null {
  if (!headers || !header) return null;
  const wanted = header.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return normalizeTenantId(value[0]);
    return normalizeTenantId(value);
  }
  return null;
}

export function resolveMultiTenancyConfig(
  config: Pick<AgorConfig, 'multi_tenancy'>
): ResolvedMultiTenancyConfig {
  const raw: AgorMultiTenancySettings = config.multi_tenancy ?? {};
  const mode = raw.mode ?? 'static';
  return {
    mode,
    static_tenant_id: (raw.static_tenant_id?.trim() || DEFAULT_STATIC_TENANT_ID) as TenantID,
    ...(raw.auth_claim ? { auth_claim: raw.auth_claim } : {}),
    ...(raw.trusted_header ? { trusted_header: raw.trusted_header } : {}),
  };
}

export function assertValidMultiTenancyConfig(
  config: Pick<AgorConfig, 'multi_tenancy' | 'database'>
): void {
  const resolved = resolveMultiTenancyConfig(config);
  if (resolved.mode !== 'static' && resolved.mode !== 'required_from_auth') {
    throw new Error('Config error: multi_tenancy.mode must be one of: static, required_from_auth');
  }
  if (!resolved.static_tenant_id) {
    throw new Error('Config error: multi_tenancy.static_tenant_id must not be empty');
  }
  if (resolved.auth_claim && RESERVED_AUTH_CLAIMS.has(resolved.auth_claim)) {
    throw new Error(
      `Config error: multi_tenancy.auth_claim cannot be reserved JWT claim '${resolved.auth_claim}'`
    );
  }
  if (resolved.mode === 'required_from_auth') {
    if (resolveMultiTenancyDatabaseDialect(config) !== 'postgresql') {
      throw new Error(
        'Config error: multi_tenancy.required_from_auth requires database.dialect: postgresql'
      );
    }
    if (!resolved.auth_claim && !resolved.trusted_header) {
      throw new Error(
        'Config error: multi_tenancy.required_from_auth requires multi_tenancy.auth_claim or multi_tenancy.trusted_header'
      );
    }
  }
}

export function resolveTenantContext(
  config: Pick<AgorConfig, 'multi_tenancy'> | ResolvedMultiTenancyConfig,
  input: TenantResolutionInput = {}
): TenantContext {
  const resolved = 'static_tenant_id' in config ? config : resolveMultiTenancyConfig(config);
  const params = input.params;
  if (params?.tenant) return params.tenant;
  const explicit = normalizeTenantId(params?.tenant_id);
  if (explicit) return { tenant_id: explicit, source: 'explicit' };

  if (resolved.mode === 'static') {
    return { tenant_id: resolved.static_tenant_id, source: 'static' };
  }

  const claimTenant =
    readClaim(input.authPayload, resolved.auth_claim) ??
    readClaim(readAuthenticationPayload(params?.authentication), resolved.auth_claim) ??
    readClaim(params?.user, resolved.auth_claim);
  if (claimTenant) return { tenant_id: claimTenant, source: 'auth_claim' };

  const headerTenant =
    readHeader(input.headers, resolved.trusted_header) ??
    readHeader(params?.headers, resolved.trusted_header);
  if (headerTenant) return { tenant_id: headerTenant, source: 'trusted_header' };

  throw new TenantResolutionError('Missing tenant context for multi_tenancy.required_from_auth');
}
