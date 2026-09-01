/**
 * Secret-safe PATCH semantics for MCP authentication configuration.
 *
 * The public read path replaces stored secrets with the shared redaction
 * sentinel.  A caller can therefore round-trip a read result without learning
 * the secret: the sentinel means "preserve", omission means "preserve", and
 * an explicit null means "clear this field".  Switching authentication type
 * is intentionally a replacement so credentials from the old mode never
 * survive as dead configuration.
 */

import {
  containsTemplate,
  hasTemplateMarker,
  isValidMCPHttpUrlTemplate,
} from '../../mcp/template-patterns';
import {
  assertPublicMCPOAuthCompatibilityMode,
  type MCPAuth,
  type MCPAuthPatch,
} from '../../types/mcp';
import { MCP_AUTH_SECRET_FIELDS } from './auth-secrets';
import { MCP_HEADER_REDACTED_SENTINEL } from './http-headers';

const secretFields = new Set<keyof MCPAuth>(MCP_AUTH_SECRET_FIELDS);

const AUTH_FIELDS = new Set<keyof MCPAuth>([
  'type',
  'token',
  'api_url',
  'api_token',
  'api_secret',
  'oauth_authorization_url',
  'oauth_token_url',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_scope',
  'oauth_grant_type',
  'oauth_compatibility_mode',
  'oauth_dcr_mode',
  'oauth_access_token',
  'oauth_token_expires_at',
  'oauth_refresh_token',
  'oauth_mode',
  'insecure',
]);

const STRING_AUTH_FIELDS = new Set<keyof MCPAuth>([
  'token',
  'api_url',
  'api_token',
  'api_secret',
  'oauth_authorization_url',
  'oauth_token_url',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_scope',
  'oauth_grant_type',
  'oauth_access_token',
  'oauth_refresh_token',
]);

const URL_AUTH_FIELDS = new Set<keyof MCPAuth>([
  'api_url',
  'oauth_authorization_url',
  'oauth_token_url',
]);
const MAX_AUTH_VALUE_LENGTH = 65_536;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/** Stable closed-auth input failure for REST/socket error mapping. */
export class MCPAuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPAuthValidationError';
  }
}

const AUTH_FIELDS_BY_TYPE = {
  none: new Set<keyof MCPAuth>(['type']),
  bearer: new Set<keyof MCPAuth>(['type', 'token', 'insecure']),
  jwt: new Set<keyof MCPAuth>(['type', 'api_url', 'api_token', 'api_secret', 'insecure']),
  oauth: new Set<keyof MCPAuth>([
    'type',
    'oauth_authorization_url',
    'oauth_token_url',
    'oauth_client_id',
    'oauth_client_secret',
    'oauth_scope',
    'oauth_grant_type',
    'oauth_compatibility_mode',
    'oauth_dcr_mode',
    'oauth_access_token',
    'oauth_token_expires_at',
    'oauth_refresh_token',
    'oauth_mode',
    'insecure',
  ]),
} satisfies Record<MCPAuth['type'], ReadonlySet<keyof MCPAuth>>;

const AUTH_FIELD_FAMILY = new Map<keyof MCPAuth, MCPAuth['type']>([
  ['token', 'bearer'],
  ['api_url', 'jwt'],
  ['api_token', 'jwt'],
  ['api_secret', 'jwt'],
  ['oauth_authorization_url', 'oauth'],
  ['oauth_token_url', 'oauth'],
  ['oauth_client_id', 'oauth'],
  ['oauth_client_secret', 'oauth'],
  ['oauth_scope', 'oauth'],
  ['oauth_grant_type', 'oauth'],
  ['oauth_compatibility_mode', 'oauth'],
  ['oauth_dcr_mode', 'oauth'],
  ['oauth_access_token', 'oauth'],
  ['oauth_token_expires_at', 'oauth'],
  ['oauth_refresh_token', 'oauth'],
  ['oauth_mode', 'oauth'],
]);

function assertAuthFieldFamilies(auth: Record<string, unknown>): void {
  const requestedType = auth.type as MCPAuth['type'] | undefined;
  const activeFields = Object.entries(auth)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([field]) => field as keyof MCPAuth);

  if (requestedType) {
    const allowed = AUTH_FIELDS_BY_TYPE[requestedType];
    const invalid = activeFields.find((field) => !allowed.has(field));
    if (invalid) {
      throw new Error(`auth.${invalid} does not apply when auth.type is '${requestedType}'`);
    }
    return;
  }

  // A PATCH may omit type, but it still cannot combine fields belonging to
  // different modes. The repository validates the merged object against the
  // stored type before persistence, which closes the remaining partial-update
  // case without forcing callers to resend a redacted auth object.
  const families = new Set(
    activeFields.map((field) => AUTH_FIELD_FAMILY.get(field)).filter((value) => value !== undefined)
  );
  if (families.size > 1) {
    throw new Error('auth patch cannot combine fields from different authentication modes');
  }
}

/**
 * Runtime validation for the public REST/socket boundary. TypeScript types do
 * not close JSON objects, so without this check a misspelled secret field can
 * be persisted and later published without participating in redaction.
 */
export interface MCPAuthValidationOptions {
  /** Require a complete, closed auth object and reject clear/sentinel values. */
  create?: boolean;
  /** Public CREATE only: require credentials needed to use bearer/JWT immediately. */
  requireConfiguredCredentials?: boolean;
}

function validateMCPAuthPatch(value: unknown, options: MCPAuthValidationOptions = {}): void {
  // Explicit auth:null means "no authentication" on CREATE and "clear the
  // whole auth object" on PATCH/PUT. It is distinct from omission.
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('auth must be an object');
  }
  const auth = value as Record<string, unknown>;
  for (const key of Object.keys(auth)) {
    if (!AUTH_FIELDS.has(key as keyof MCPAuth)) throw new Error(`Unknown auth field: ${key}`);
  }
  if (options.create && !['none', 'bearer', 'jwt', 'oauth'].includes(String(auth.type))) {
    throw new Error('auth.type must be one of none, bearer, jwt, or oauth');
  }
  if (auth.type !== undefined && !['none', 'bearer', 'jwt', 'oauth'].includes(String(auth.type))) {
    throw new Error('auth.type must be one of none, bearer, jwt, or oauth');
  }
  assertAuthFieldFamilies(auth);
  for (const [key, raw] of Object.entries(auth)) {
    if (raw === undefined) continue;
    if (raw === null) {
      if (options.create) throw new Error(`auth.${key} cannot be null on create`);
      continue;
    }
    if (STRING_AUTH_FIELDS.has(key as keyof MCPAuth) && typeof raw !== 'string') {
      throw new Error(`auth.${key} must be a string${options.create ? '' : ' or null'}`);
    }
    if (typeof raw === 'string') {
      if (raw.length > MAX_AUTH_VALUE_LENGTH || hasControlCharacter(raw)) {
        throw new Error(`auth.${key} is too long or contains control characters`);
      }
      if (hasTemplateMarker(raw) && !containsTemplate(raw)) {
        throw new Error(`auth.${key} contains an unbalanced template delimiter`);
      }
      if (URL_AUTH_FIELDS.has(key as keyof MCPAuth)) {
        if (raw.includes('{{') || raw.includes('}}')) {
          if (isValidMCPHttpUrlTemplate(raw)) continue;
          throw new Error(`auth.${key} must be an HTTP(S) URL using only user.env templates`);
        }
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          throw new Error(`auth.${key} must be a valid HTTP(S) URL`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error(`auth.${key} must be an HTTP(S) URL without embedded credentials`);
        }
      }
    }
    if (
      options.create &&
      secretFields.has(key as keyof MCPAuth) &&
      typeof raw === 'string' &&
      raw.trim() === MCP_HEADER_REDACTED_SENTINEL
    ) {
      throw new Error(`auth.${key} cannot use the redaction sentinel on create`);
    }
  }
  if (
    auth.oauth_token_expires_at !== undefined &&
    auth.oauth_token_expires_at !== null &&
    (!Number.isSafeInteger(auth.oauth_token_expires_at) || Number(auth.oauth_token_expires_at) < 0)
  ) {
    throw new Error('auth.oauth_token_expires_at must be a non-negative safe integer or null');
  }
  if (auth.insecure !== undefined && auth.insecure !== null && typeof auth.insecure !== 'boolean') {
    throw new Error('auth.insecure must be boolean or null');
  }
  if (
    auth.oauth_mode !== undefined &&
    auth.oauth_mode !== null &&
    !['per_user', 'shared'].includes(String(auth.oauth_mode))
  ) {
    throw new Error('auth.oauth_mode must be per_user, shared, or null');
  }
  if (
    auth.oauth_compatibility_mode !== undefined &&
    auth.oauth_compatibility_mode !== null &&
    !['strict', 'legacy'].includes(String(auth.oauth_compatibility_mode))
  ) {
    throw new Error(
      'auth.oauth_compatibility_mode must be either strict or legacy (or null on patch)'
    );
  }
  if (
    auth.oauth_dcr_mode !== undefined &&
    auth.oauth_dcr_mode !== null &&
    !['disabled', 'advertised', 'fallback'].includes(String(auth.oauth_dcr_mode))
  ) {
    throw new Error('auth.oauth_dcr_mode must be disabled, advertised, fallback, or null');
  }
  if (
    auth.oauth_grant_type !== undefined &&
    auth.oauth_grant_type !== null &&
    !['client_credentials', 'authorization_code'].includes(String(auth.oauth_grant_type))
  ) {
    throw new Error(
      'auth.oauth_grant_type must be client_credentials, authorization_code, or null'
    );
  }
  if (
    options.requireConfiguredCredentials &&
    auth.type === 'bearer' &&
    !nonEmptyString(auth.token)
  ) {
    throw new Error("auth.token is required when auth.type is 'bearer'");
  }
  if (options.requireConfiguredCredentials && auth.type === 'jwt') {
    for (const field of ['api_url', 'api_token', 'api_secret'] as const) {
      if (!nonEmptyString(auth[field])) {
        throw new Error(`auth.${field} is required when auth.type is 'jwt'`);
      }
    }
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertValidMCPAuthPatch(
  value: unknown,
  options: MCPAuthValidationOptions = {}
): void {
  try {
    validateMCPAuthPatch(value, options);
  } catch (error) {
    if (error instanceof MCPAuthValidationError) throw error;
    throw new MCPAuthValidationError(error instanceof Error ? error.message : 'Invalid MCP auth');
  }
}

/**
 * PUT replacement semantics with secret-safe readback round-tripping.
 * Non-secret omissions are replaced; a redacted secret sentinel restores only
 * the corresponding value from the current row when the auth type is unchanged.
 */
export function replaceMCPAuth(
  current: MCPAuth | undefined,
  replacement: MCPAuthPatch | null | undefined
): MCPAuth | undefined {
  if (replacement === null || replacement === undefined) return undefined;
  assertValidMCPAuthPatch(replacement);
  if (!replacement.type) {
    throw new MCPAuthValidationError('auth.type is required when replacing authentication');
  }
  const next = definedAuthPatch(replacement) as MCPAuth;
  for (const field of MCP_AUTH_SECRET_FIELDS) {
    if (next[field] !== MCP_HEADER_REDACTED_SENTINEL) continue;
    const stored = current?.type === next.type ? current[field] : undefined;
    if (stored === undefined) {
      delete (next as unknown as Record<string, unknown>)[field];
    } else {
      (next as unknown as Record<string, unknown>)[field] = stored;
    }
  }
  if (
    current?.type === 'oauth' &&
    next.type === 'oauth' &&
    (next.oauth_mode ?? 'per_user') !== (current.oauth_mode ?? 'per_user')
  ) {
    delete next.oauth_access_token;
    delete next.oauth_refresh_token;
    delete next.oauth_token_expires_at;
  }
  assertPublicMCPOAuthCompatibilityMode(next);
  return next;
}

function definedAuthPatch(patch: MCPAuthPatch): Partial<MCPAuth> {
  const next: Partial<MCPAuth> = {};
  for (const [rawField, value] of Object.entries(patch)) {
    const field = rawField as keyof MCPAuth;
    if (value === undefined || value === null) continue;
    (next as Record<string, unknown>)[field] = value;
  }
  return next;
}

/** Apply one auth patch without ever treating a redaction sentinel as data. */
export function mergeMCPAuth(
  current: MCPAuth | undefined,
  patch: MCPAuthPatch | null | undefined
): MCPAuth | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  assertValidMCPAuthPatch(patch);

  const requestedType = patch.type;
  const changesType = requestedType !== undefined && requestedType !== current?.type;
  if (!current || changesType) {
    if (!requestedType) {
      throw new MCPAuthValidationError('auth.type is required when configuring authentication');
    }
    const replacement = definedAuthPatch(patch) as MCPAuth;
    // A sentinel can only refer to a value from the same stored auth mode. On
    // create/type-switch there is nothing authorized to restore, so drop it.
    for (const field of MCP_AUTH_SECRET_FIELDS) {
      if (replacement[field] === MCP_HEADER_REDACTED_SENTINEL) {
        delete (replacement as unknown as Record<string, unknown>)[field];
      }
    }
    assertPublicMCPOAuthCompatibilityMode(replacement);
    return replacement;
  }

  const merged: MCPAuth = { ...current };
  for (const [rawField, value] of Object.entries(patch)) {
    const field = rawField as keyof MCPAuth;
    if (value === undefined) continue;
    if (value === null) {
      delete (merged as unknown as Record<string, unknown>)[field];
      continue;
    }
    if (secretFields.has(field) && value === MCP_HEADER_REDACTED_SENTINEL) continue;
    (merged as unknown as Record<string, unknown>)[field] = value;
  }
  if (
    current.type === 'oauth' &&
    'oauth_mode' in patch &&
    (patch.oauth_mode ?? 'per_user') !== (current.oauth_mode ?? 'per_user')
  ) {
    // Shared tokens and per-user grants have incompatible authority. Never let
    // a mode flip accidentally retain a static bearer from the previous mode.
    delete merged.oauth_access_token;
    delete merged.oauth_refresh_token;
    delete merged.oauth_token_expires_at;
  }
  // A type-less PATCH is checked again after merging with the stored mode so
  // `{ token: ... }` cannot append a bearer field to an OAuth object.
  assertValidMCPAuthPatch(merged, { create: true });
  assertPublicMCPOAuthCompatibilityMode(merged);
  return merged;
}
