import type { UserID } from './id';

/** Resource id used by the singleton tenant CORS settings service. */
export const TENANT_CORS_SETTINGS_ID = 'current' as const;

/**
 * Resource limit rather than an operator policy knob. A normal workspace
 * should need only a handful of frontend origins; this keeps accidental or
 * malicious mutations bounded without complicating operator configuration.
 */
export const MAX_TENANT_CORS_ORIGINS = 100;
export const MAX_TENANT_CORS_ORIGIN_LENGTH = 512;

export class TenantCorsOriginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantCorsOriginValidationError';
  }
}

/**
 * Parse a tenant-managed value into the exact serialized origin browsers use.
 *
 * Operator origins retain their existing exact/regex compatibility behavior.
 * This stricter parser is only for tenant-managed entries.
 */
export function normalizeTenantCorsOrigin(input: unknown): string {
  if (typeof input !== 'string') {
    throw new TenantCorsOriginValidationError('Origin must be a string');
  }

  const value = input.trim();
  if (!value) {
    throw new TenantCorsOriginValidationError('Origin is required');
  }
  if (new TextEncoder().encode(value).length > MAX_TENANT_CORS_ORIGIN_LENGTH) {
    throw new TenantCorsOriginValidationError(
      `Origin must be at most ${MAX_TENANT_CORS_ORIGIN_LENGTH} bytes`
    );
  }
  if (value === 'null' || value === '*' || (value.startsWith('/') && value.endsWith('/'))) {
    throw new TenantCorsOriginValidationError(
      'Use an exact HTTP or HTTPS origin; wildcards, regular expressions, and null origins are not supported'
    );
  }
  const hasWhitespaceOrControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (hasWhitespaceOrControl) {
    throw new TenantCorsOriginValidationError('Origin must not contain whitespace or controls');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    throw new TenantCorsOriginValidationError('Origin must include http:// or https://');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]+\/?$/iu.test(value)) {
    throw new TenantCorsOriginValidationError(
      'Enter an origin only, without a path, query string, or fragment'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TenantCorsOriginValidationError('Enter a valid HTTP or HTTPS origin');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TenantCorsOriginValidationError('Only HTTP and HTTPS origins are supported');
  }
  if (!parsed.hostname) {
    throw new TenantCorsOriginValidationError('Origin must include a hostname');
  }
  if (parsed.hostname.includes('*')) {
    throw new TenantCorsOriginValidationError('Origin hostname must not contain wildcards');
  }
  if (value.includes('@') || parsed.username || parsed.password) {
    throw new TenantCorsOriginValidationError('Origin must not include a username or password');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TenantCorsOriginValidationError(
      'Enter an origin only, without a path, query string, or fragment'
    );
  }
  if (parsed.hostname.endsWith('.')) {
    throw new TenantCorsOriginValidationError('Origin hostname must not end with a dot');
  }
  if (parsed.origin === 'null') {
    throw new TenantCorsOriginValidationError('Opaque origins are not supported');
  }

  return parsed.origin;
}

export function normalizeTenantCorsOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new TenantCorsOriginValidationError('origins must be an array');
  }
  if (input.length > MAX_TENANT_CORS_ORIGINS) {
    throw new TenantCorsOriginValidationError(
      `A tenant may configure at most ${MAX_TENANT_CORS_ORIGINS} origins`
    );
  }

  const normalized = input.map(normalizeTenantCorsOrigin);
  return [...new Set(normalized)].sort();
}

/** Database-backed tenant CORS state before operator policy is added. */
export interface StoredTenantCorsSettings {
  revision: number;
  origins: string[];
  updated_by?: UserID;
  updated_at?: string;
}

/** Public Settings API response for the authenticated tenant. */
export interface TenantCorsSettings {
  id: typeof TENANT_CORS_SETTINGS_ID;
  /** Operator feature gate. */
  enabled: boolean;
  /** Whether pre-auth tenant routing is available for preflight/handshakes. */
  routing_ready: boolean;
  revision: number;
  origins: string[];
  credentials: boolean;
  updated_by?: UserID;
  updated_at?: string;
}

export interface TenantCorsSettingsPatch {
  expected_revision: number;
  origins: string[];
}

export interface TenantCorsAuditEvent {
  event_id: string;
  revision: number;
  added_origins: string[];
  removed_origins: string[];
  actor_user_id?: UserID;
  created_at: string;
}
