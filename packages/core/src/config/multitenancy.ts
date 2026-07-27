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

function readHeaderValues(
  headers: Record<string, unknown> | undefined,
  header: string | undefined
): TenantID[] {
  if (!headers || !header) return [];
  const wanted = header.toLowerCase();
  const values: TenantID[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    for (const rawValue of Array.isArray(value) ? value : [value]) {
      // A trusted tenant header contains one identifier, never an HTTP list.
      // Reject coalesced duplicates even if an adapter discarded their
      // original on-wire multiplicity.
      if (typeof rawValue === 'string' && rawValue.includes(',')) {
        throw new TenantResolutionError(`Invalid trusted tenant header ${header}`);
      }
      const tenantId = normalizeTenantId(rawValue);
      if (!tenantId) {
        throw new TenantResolutionError(`Invalid trusted tenant header ${header}`);
      }
      values.push(tenantId);
    }
  }
  if (values.length > 1) {
    if (new Set(values).size > 1) {
      throw new TenantResolutionError('Conflicting tenant identities');
    }
    throw new TenantResolutionError(`Invalid trusted tenant header ${header}`);
  }
  return values;
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
  const candidates: TenantContext[] = [];
  const paramsTenantId = normalizeTenantId(params?.tenant?.tenant_id);
  if (paramsTenantId) {
    candidates.push({ tenant_id: paramsTenantId, source: params?.tenant?.source ?? 'explicit' });
  }
  const explicit = normalizeTenantId(params?.tenant_id);
  if (explicit) candidates.push({ tenant_id: explicit, source: 'explicit' });

  if (resolved.mode === 'static') {
    candidates.push({ tenant_id: resolved.static_tenant_id, source: 'static' });
  } else {
    for (const tenantId of [
      readClaim(input.authPayload, resolved.auth_claim),
      readClaim(readAuthenticationPayload(params?.authentication), resolved.auth_claim),
      readClaim(params?.user, resolved.auth_claim),
    ]) {
      if (tenantId) candidates.push({ tenant_id: tenantId, source: 'auth_claim' });
    }

    for (const tenantId of [
      ...readHeaderValues(input.headers, resolved.trusted_header),
      ...readHeaderValues(params?.headers, resolved.trusted_header),
    ]) {
      candidates.push({ tenant_id: tenantId, source: 'trusted_header' });
    }
  }

  if (candidates.length > 0) {
    const tenantId = candidates[0].tenant_id;
    if (candidates.some((candidate) => candidate.tenant_id !== tenantId)) {
      throw new TenantResolutionError('Conflicting tenant identities');
    }
    return candidates[0];
  }

  throw new TenantResolutionError('Missing tenant context for multi_tenancy.required_from_auth');
}
