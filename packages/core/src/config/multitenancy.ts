import { MAX_TENANT_ID_LENGTH, type TenantContext, type TenantID } from '../types/tenant';
import type { AgorConfig, AgorMultiTenancySettings } from './types';

export const DEFAULT_STATIC_TENANT_ID = 'default' as TenantID;
const RESERVED_AUTH_CLAIMS = new Set(['aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'sub', 'type']);

/** Placeholder replaced by the trusted tenant id in `multi_tenancy.tenant_base_url_template`. */
export const TENANT_BASE_URL_TEMPLATE_PLACEHOLDER = '{tenant_id}';

/**
 * A tenant id that is safe to splice into a URL template: exactly one DNS
 * label. Anything else (dots, slashes, `@`, spaces, …) could redirect a link
 * to a different host or path, so it is never substituted.
 */
const TENANT_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Sample id used only to validate the template shape at config load. */
const TENANT_BASE_URL_TEMPLATE_PROBE_ID = 'tenant-probe';

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
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TENANT_ID_LENGTH) {
    throw new TenantResolutionError(`Tenant ID must not exceed ${MAX_TENANT_ID_LENGTH} characters`);
  }
  return trimmed as TenantID;
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

/**
 * Thrown by {@link resolveBootstrapTenantId} when a single-tenant bootstrap tool
 * is run under `required_from_auth`. A distinct type so CLI callers can present
 * this actionable message directly instead of routing it through database-error
 * sanitization (which would flatten it to a generic "operation failed").
 */
export class BootstrapTenantUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapTenantUnsupportedError';
  }
}

/**
 * Resolve the tenant id for local bootstrap / single-tenant CLI tooling
 * (`local create-admin`, dev fixtures, admin-id lookup). These tools operate on
 * exactly one tenant — the static tenant.
 *
 * In `required_from_auth` there is no implicit bootstrap tenant: users are
 * provisioned per authenticated tenant (typically via external launch), so
 * these tools FAIL CLOSED with a clear {@link BootstrapTenantUnsupportedError}
 * here rather than entering a tenant database scope with an undefined tenant id.
 * The latter would trip the armed scope guard mid-operation with an opaque
 * "Missing tenant database scope" error instead of explaining that the command
 * is single-tenant only.
 */
export function resolveBootstrapTenantId(config: Pick<AgorConfig, 'multi_tenancy'>): TenantID {
  const resolved = resolveMultiTenancyConfig(config);
  if (resolved.mode === 'static') return resolved.static_tenant_id;
  throw new BootstrapTenantUnsupportedError(
    'This command operates on the static single tenant and is not supported when ' +
      'multi_tenancy.mode=required_from_auth. Provision users through the authenticated ' +
      'per-tenant path (external launch) instead.'
  );
}

export function isTenantHostLabel(tenantId: string): boolean {
  return TENANT_HOST_LABEL_PATTERN.test(tenantId);
}

function renderTenantBaseUrlTemplate(template: string, tenantId: string): string {
  return template.split(TENANT_BASE_URL_TEMPLATE_PLACEHOLDER).join(tenantId);
}

/**
 * Parse a rendered tenant base URL. Returns the origin plus any path, without
 * a trailing slash, or `null` when the value is not a plain HTTP(S) URL.
 */
function normalizeRenderedTenantBaseUrl(rendered: string): string | null {
  const trimmed = rendered.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

const warnedUnsafeTenantIds = new Set<string>();

/**
 * Resolve the browser-reachable base URL for user-facing links of the given
 * tenant from `multi_tenancy.tenant_base_url_template`.
 *
 * Returns `undefined` when no template is configured, when the deployment is
 * not `required_from_auth`, when no tenant id is available (system/global
 * work), or when the tenant id is not a single DNS label. Callers fall back to
 * the deployment-wide base URL in every one of those cases.
 */
export function resolveTenantBaseUrl(
  config: Pick<AgorConfig, 'multi_tenancy'>,
  tenantId: TenantID | string | undefined
): string | undefined {
  const template = config.multi_tenancy?.tenant_base_url_template?.trim();
  if (!template || !tenantId) return undefined;
  if (resolveMultiTenancyConfig(config).mode !== 'required_from_auth') return undefined;

  if (!isTenantHostLabel(tenantId)) {
    if (!warnedUnsafeTenantIds.has(tenantId)) {
      warnedUnsafeTenantIds.add(tenantId);
      console.warn(
        `⚠️  multi_tenancy.tenant_base_url_template ignored for tenant "${tenantId}": ` +
          'tenant id is not a single DNS label; falling back to the deployment base URL'
      );
    }
    return undefined;
  }

  return (
    normalizeRenderedTenantBaseUrl(renderTenantBaseUrlTemplate(template, tenantId)) ?? undefined
  );
}

function assertValidTenantBaseUrlTemplate(
  template: string | undefined,
  mode: ResolvedMultiTenancyConfig['mode']
): void {
  if (template === undefined) return;
  const trimmed = template.trim();
  if (!trimmed) {
    throw new Error('Config error: multi_tenancy.tenant_base_url_template must not be empty');
  }
  if (mode !== 'required_from_auth') {
    throw new Error(
      'Config error: multi_tenancy.tenant_base_url_template requires multi_tenancy.mode: required_from_auth'
    );
  }
  if (!trimmed.includes(TENANT_BASE_URL_TEMPLATE_PLACEHOLDER)) {
    throw new Error(
      `Config error: multi_tenancy.tenant_base_url_template must contain ${TENANT_BASE_URL_TEMPLATE_PLACEHOLDER}`
    );
  }
  const probe = renderTenantBaseUrlTemplate(trimmed, TENANT_BASE_URL_TEMPLATE_PROBE_ID);
  if (normalizeRenderedTenantBaseUrl(probe) === null) {
    throw new Error(
      'Config error: multi_tenancy.tenant_base_url_template must render to a plain http(s) URL ' +
        `without credentials, query string, or fragment (e.g. https://${TENANT_BASE_URL_TEMPLATE_PLACEHOLDER}.agor.example.com)`
    );
  }
}

export function assertValidMultiTenancyConfig(
  config: Pick<AgorConfig, 'multi_tenancy' | 'database' | 'execution'>
): void {
  const resolved = resolveMultiTenancyConfig(config);
  assertValidTenantBaseUrlTemplate(config.multi_tenancy?.tenant_base_url_template, resolved.mode);
  if (resolved.mode !== 'static' && resolved.mode !== 'required_from_auth') {
    throw new Error('Config error: multi_tenancy.mode must be one of: static, required_from_auth');
  }
  if (!resolved.static_tenant_id) {
    throw new Error('Config error: multi_tenancy.static_tenant_id must not be empty');
  }
  if (resolved.static_tenant_id.length > MAX_TENANT_ID_LENGTH) {
    throw new Error(
      `Config error: multi_tenancy.static_tenant_id must not exceed ${MAX_TENANT_ID_LENGTH} characters`
    );
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
    if (config.multi_tenancy?.filesystem_isolation_enabled !== true) {
      throw new Error(
        'Config error: multi_tenancy.required_from_auth requires multi_tenancy.filesystem_isolation_enabled: true'
      );
    }
    const branchStorage = config.execution?.branch_storage;
    if (
      branchStorage?.default_mode !== 'clone' ||
      branchStorage.allowed_modes?.length !== 1 ||
      branchStorage.allowed_modes[0] !== 'clone'
    ) {
      throw new Error(
        'Config error: multi_tenancy.required_from_auth requires clone-only execution.branch_storage ' +
          '(default_mode: clone, allowed_modes: [clone]); worktree storage is unavailable in hosted multi-tenant mode.'
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
    const staticTenantId = normalizeTenantId(resolved.static_tenant_id);
    if (!staticTenantId) throw new TenantResolutionError('Invalid static tenant context');
    candidates.push({ tenant_id: staticTenantId, source: 'static' });
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
