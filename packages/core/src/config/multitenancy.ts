import type { TenantContext, TenantID } from '../types/tenant';
import type { AgorConfig, AgorMultiTenancySettings } from './types';

export const DEFAULT_STATIC_TENANT_ID = 'default' as TenantID;

export interface ResolvedMultiTenancyConfig {
  mode: 'static' | 'required_from_auth';
  static_tenant_id: TenantID;
  auth_claim?: string;
  trusted_header?: string;
  host_base_domain?: string;
  trusted_host_header?: string;
}

export interface TenantResolutionInput {
  /** Authenticated Feathers params or socket-auth state. */
  params?: {
    tenant?: TenantContext;
    tenant_id?: string;
    user?: { tenant_id?: string };
    authentication?: { payload?: unknown };
    headers?: Record<string, unknown>;
  };
  /** Express/Feathers request host, when already parsed by the caller. */
  host?: string;
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

function readClaim(payload: unknown, claim: string | undefined): TenantID | null {
  if (!claim || !payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[claim];
  return normalizeTenantId(value);
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  header: string | undefined
): string | null {
  if (!headers || !header) return null;
  const wanted = header.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function readHeader(
  headers: Record<string, unknown> | undefined,
  header: string | undefined
): TenantID | null {
  return normalizeTenantId(readHeaderValue(headers, header));
}

function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!first) return null;
  const withoutProtocol = first.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const withoutPath = withoutProtocol.split('/')[0] ?? '';
  const withoutPort = withoutPath.startsWith('[')
    ? withoutPath.slice(0, withoutPath.indexOf(']') + 1)
    : withoutPath.split(':')[0];
  return withoutPort.replace(/\.$/, '') || null;
}

function readHost(
  input: TenantResolutionInput,
  trustedHostHeader: string | undefined
): string | null {
  if (input.host) return normalizeHost(input.host);
  const headers = input.headers ?? input.params?.headers;
  return (
    normalizeHost(readHeaderValue(headers, trustedHostHeader)) ??
    normalizeHost(readHeaderValue(headers, 'host'))
  );
}

function readTenantFromHost(
  input: TenantResolutionInput,
  hostBaseDomain: string | undefined,
  trustedHostHeader: string | undefined
): TenantID | null {
  const base = normalizeHost(hostBaseDomain);
  if (!base) return null;
  const host = readHost(input, trustedHostHeader);
  if (!host || host === base || !host.endsWith(`.${base}`)) return null;
  const tenantPart = host.slice(0, -(base.length + 1));
  const leftmostLabel = tenantPart.split('.').filter(Boolean)[0];
  return normalizeTenantId(leftmostLabel);
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
    ...(raw.host_base_domain ? { host_base_domain: raw.host_base_domain } : {}),
    ...(raw.trusted_host_header ? { trusted_host_header: raw.trusted_host_header } : {}),
  };
}

export function assertValidMultiTenancyConfig(config: Pick<AgorConfig, 'multi_tenancy'>): void {
  const resolved = resolveMultiTenancyConfig(config);
  if (resolved.mode !== 'static' && resolved.mode !== 'required_from_auth') {
    throw new Error('Config error: multi_tenancy.mode must be one of: static, required_from_auth');
  }
  if (!resolved.static_tenant_id) {
    throw new Error('Config error: multi_tenancy.static_tenant_id must not be empty');
  }
  if (
    resolved.mode === 'required_from_auth' &&
    !resolved.auth_claim &&
    !resolved.trusted_header &&
    !resolved.host_base_domain
  ) {
    throw new Error(
      'Config error: multi_tenancy.required_from_auth requires multi_tenancy.auth_claim, multi_tenancy.trusted_header, or multi_tenancy.host_base_domain'
    );
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
    readClaim(params?.authentication?.payload, resolved.auth_claim);
  if (claimTenant) return { tenant_id: claimTenant, source: 'auth_claim' };

  const hostTenant = readTenantFromHost(
    input,
    resolved.host_base_domain,
    resolved.trusted_host_header
  );
  if (hostTenant) return { tenant_id: hostTenant, source: 'trusted_host' };

  const headerTenant =
    readHeader(input.headers, resolved.trusted_header) ??
    readHeader(params?.headers, resolved.trusted_header);
  if (headerTenant) return { tenant_id: headerTenant, source: 'trusted_header' };

  const legacyUserTenant = readClaim(params?.user, resolved.auth_claim);
  if (legacyUserTenant) return { tenant_id: legacyUserTenant, source: 'auth_claim' };

  throw new TenantResolutionError('Missing tenant context for multi_tenancy.required_from_auth');
}
