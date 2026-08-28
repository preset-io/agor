import {
  findDuplicateMCPCustomHeaderName,
  isReservedMCPCustomHeaderName,
  isValidMCPHeaderName,
} from '@agor/core/tools/mcp/http-headers';
import type { MCPAuthPatch, MCPOAuthDCRMode } from '@agor-live/client';
import { sanitizeSecretValue } from '@/utils/sanitizeSecret';

/**
 * OAuth utility functions extracted from MCPServersTable for testability.
 *
 * These pure functions handle OAuth configuration extraction and template detection
 * for MCP server forms.
 */

/**
 * Check if a value contains a template variable (e.g., {{ user.env.VAR }})
 */
export function isTemplateValue(value: string | undefined): boolean {
  if (!value) return false;
  return value.includes('{{') && value.includes('}}');
}

export interface OAuthConfig {
  oauth_authorization_url?: string;
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scope?: string;
  oauth_grant_type?: string;
  oauth_mode?: 'per_user' | 'shared';
  oauth_compatibility_mode?: 'strict' | 'legacy';
  oauth_dcr_mode?: MCPOAuthDCRMode;
}

/**
 * Extract OAuth configuration from form values.
 * Only includes fields that have actual values (not empty or template-only).
 */
export function extractOAuthConfig(values: Record<string, unknown>): OAuthConfig {
  const config: OAuthConfig = {};

  // Only include authorization URL if it's provided
  if (values.oauth_authorization_url && typeof values.oauth_authorization_url === 'string') {
    config.oauth_authorization_url = values.oauth_authorization_url;
  }

  // Only include token URL if it's provided (can be template or real value)
  if (values.oauth_token_url && typeof values.oauth_token_url === 'string') {
    config.oauth_token_url = values.oauth_token_url;
  }

  // Only include client ID if it's provided
  if (values.oauth_client_id && typeof values.oauth_client_id === 'string') {
    config.oauth_client_id = values.oauth_client_id;
  }

  // Only include client secret if it's provided. Template expressions (e.g.
  // `{{ user.env.VAR }}`) are left untouched; only a real pasted secret gets
  // whitespace-sanitized.
  if (values.oauth_client_secret && typeof values.oauth_client_secret === 'string') {
    config.oauth_client_secret = isTemplateValue(values.oauth_client_secret)
      ? values.oauth_client_secret
      : sanitizeSecretValue(values.oauth_client_secret);
  }

  // Only include scope if it's provided
  if (values.oauth_scope && typeof values.oauth_scope === 'string') {
    config.oauth_scope = values.oauth_scope;
  }

  // Grant type defaults to client_credentials
  config.oauth_grant_type =
    typeof values.oauth_grant_type === 'string' ? values.oauth_grant_type : 'client_credentials';

  // OAuth mode defaults to per_user — matches the form's initialValue and
  // the recommended behavior for multi-user instances. (The Advanced panel
  // is collapsed by default; combined with forceRender on the panel so the
  // initialValue actually applies, this default is a defensive fallback.)
  config.oauth_mode = values.oauth_mode === 'shared' ? 'shared' : 'per_user';
  config.oauth_compatibility_mode =
    values.oauth_compatibility_mode === 'legacy' ? 'legacy' : 'strict';
  config.oauth_dcr_mode =
    values.oauth_dcr_mode === 'disabled' || values.oauth_dcr_mode === 'fallback'
      ? values.oauth_dcr_mode
      : 'advertised';

  return config;
}

export interface TestConfig {
  mcp_url: string;
  mcp_server_id?: string;
  token_url?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  grant_type?: string;
  compatibility_mode?: 'strict' | 'legacy';
  dcr_mode?: MCPOAuthDCRMode;
}

/**
 * Extract OAuth configuration for testing (excludes template values for credentials).
 * Template values in credentials can't be tested directly as they need resolution.
 */
export function extractOAuthConfigForTesting(values: Record<string, unknown>): TestConfig | null {
  if (!values.url || typeof values.url !== 'string') {
    return null;
  }

  const config: TestConfig = {
    mcp_url: values.url,
  };

  if (typeof values.mcp_server_id === 'string') {
    config.mcp_server_id = values.mcp_server_id;
  }

  // Include token URL even if it's a template (will be resolved server-side or auto-detected)
  if (values.oauth_token_url && typeof values.oauth_token_url === 'string') {
    config.token_url = values.oauth_token_url;
  }

  // Only include credentials if they're NOT templates (templates can't be tested directly)
  if (
    values.oauth_client_id &&
    typeof values.oauth_client_id === 'string' &&
    !isTemplateValue(values.oauth_client_id)
  ) {
    config.client_id = values.oauth_client_id;
  }

  if (
    values.oauth_client_secret &&
    typeof values.oauth_client_secret === 'string' &&
    !isTemplateValue(values.oauth_client_secret)
  ) {
    config.client_secret = sanitizeSecretValue(values.oauth_client_secret);
  }

  // Include scope if provided
  if (values.oauth_scope && typeof values.oauth_scope === 'string') {
    config.scope = values.oauth_scope;
  }

  // Include grant type if provided
  if (values.oauth_grant_type && typeof values.oauth_grant_type === 'string') {
    config.grant_type = values.oauth_grant_type;
  }
  // `marketplace` is a read-only form display value. A saved-row test asks
  // the daemon to re-derive it from current catalog policy; it is never sent
  // as caller-selectable public data.
  if (values.oauth_compatibility_mode !== 'marketplace') {
    config.compatibility_mode = values.oauth_compatibility_mode === 'legacy' ? 'legacy' : 'strict';
  }
  config.dcr_mode =
    values.oauth_dcr_mode === 'disabled' || values.oauth_dcr_mode === 'fallback'
      ? values.oauth_dcr_mode
      : 'advertised';

  return config;
}

/**
 * Shape of the auth payload built from form values. A structural superset
 * that fits CreateMCPServerInput.auth, UpdateMCPServerInput.auth, and the
 * inline auth field on the `mcp-servers/discover` request.
 */
export interface BuiltAuth {
  type: 'bearer' | 'jwt' | 'oauth';
  token?: string;
  api_url?: string;
  api_token?: string;
  api_secret?: string;
  oauth_authorization_url?: string;
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scope?: string;
  oauth_grant_type?: string;
  oauth_mode?: 'per_user' | 'shared';
  oauth_compatibility_mode?: 'strict' | 'legacy';
  oauth_dcr_mode?: MCPOAuthDCRMode;
}

/**
 * Build the `auth` payload from form values (auth_type + the relevant
 * per-method fields). Returns `undefined` for "none" or unrecognized types
 * so callers can do `payload.auth = buildAuthFromValues(values)` without
 * an outer if/else.
 */
export function buildAuthFromValues(
  values: Record<string, unknown>,
  options: {
    preserveAbsentDcrMode?: boolean;
    preserveAbsentCompatibilityMode?: boolean;
    preserveAbsentGrantType?: boolean;
    forPatch: true;
  }
): MCPAuthPatch | null;
export function buildAuthFromValues(
  values: Record<string, unknown>,
  options?: {
    preserveAbsentDcrMode?: boolean;
    preserveAbsentCompatibilityMode?: boolean;
    preserveAbsentGrantType?: boolean;
    forPatch?: false;
  }
): BuiltAuth | undefined;
export function buildAuthFromValues(
  values: Record<string, unknown>,
  options: {
    preserveAbsentDcrMode?: boolean;
    preserveAbsentCompatibilityMode?: boolean;
    preserveAbsentGrantType?: boolean;
    forPatch?: boolean;
  } = {}
): BuiltAuth | MCPAuthPatch | null | undefined {
  // Authentication belongs to remote HTTP/SSE transports. A stale hidden
  // auth_type can remain in the form after switching transports, and sending
  // it would either create an invalid stdio row or prevent an existing legacy
  // row from repairing itself on edit.
  if (values.transport === 'stdio') {
    return options.forPatch ? null : undefined;
  }

  const authType = values.auth_type;
  if (authType !== 'bearer' && authType !== 'jwt' && authType !== 'oauth') {
    return options.forPatch ? null : undefined;
  }

  const auth: BuiltAuth = { type: authType };
  if (authType === 'bearer') {
    if (typeof values.auth_token === 'string') auth.token = sanitizeSecretValue(values.auth_token);
  } else if (authType === 'jwt') {
    if (typeof values.jwt_api_url === 'string') auth.api_url = values.jwt_api_url;
    if (typeof values.jwt_api_token === 'string') {
      auth.api_token = sanitizeSecretValue(values.jwt_api_token);
    }
    if (typeof values.jwt_api_secret === 'string') {
      auth.api_secret = sanitizeSecretValue(values.jwt_api_secret);
    }
  } else {
    Object.assign(auth, extractOAuthConfig(values));
    if (options.preserveAbsentDcrMode && values.oauth_dcr_mode === 'advertised') {
      delete auth.oauth_dcr_mode;
    }
    if (
      options.preserveAbsentCompatibilityMode &&
      (values.oauth_compatibility_mode === 'strict' ||
        values.oauth_compatibility_mode === 'marketplace')
    ) {
      delete auth.oauth_compatibility_mode;
    }
    if (options.preserveAbsentGrantType && values.oauth_grant_type === 'client_credentials') {
      delete auth.oauth_grant_type;
    }
  }
  if (options.forPatch) {
    const formToAuthField: Record<string, string> = {
      auth_token: 'token',
      jwt_api_url: 'api_url',
      jwt_api_token: 'api_token',
      jwt_api_secret: 'api_secret',
      oauth_authorization_url: 'oauth_authorization_url',
      oauth_token_url: 'oauth_token_url',
      oauth_client_id: 'oauth_client_id',
      oauth_client_secret: 'oauth_client_secret',
      oauth_scope: 'oauth_scope',
      oauth_grant_type: 'oauth_grant_type',
    };
    for (const [formField, authField] of Object.entries(formToAuthField)) {
      const isSecret = [
        'auth_token',
        'jwt_api_token',
        'jwt_api_secret',
        'oauth_client_secret',
      ].includes(formField);
      if (values[`${formField}_clear`] === true) {
        (auth as unknown as Record<string, unknown>)[authField] = null;
      } else if (Object.hasOwn(values, formField) && values[formField] === '' && !isSecret) {
        (auth as unknown as Record<string, unknown>)[authField] = null;
      }
    }
    for (const [field, value] of Object.entries(auth)) {
      const isSecret = ['token', 'api_token', 'api_secret', 'oauth_client_secret'].includes(field);
      if (field !== 'type' && typeof value === 'string' && value.trim() === '' && !isSecret) {
        (auth as unknown as Record<string, unknown>)[field] = null;
      } else if (isSecret && value === '') {
        delete (auth as unknown as Record<string, unknown>)[field];
      }
    }
  }
  return auth;
}

/**
 * Parse the env-vars JSON textarea value. Returns undefined for empty / invalid
 * input (matches the legacy "swallow JSON.parse errors" semantics — daemon-side
 * validation is the source of truth).
 */
export function parseEnvJSON(envValue: unknown): Record<string, string> | undefined {
  if (typeof envValue !== 'string' || !envValue.trim()) return undefined;
  try {
    return JSON.parse(envValue) as Record<string, string>;
  } catch {
    return undefined;
  }
}

/**
 * Parse the custom HTTP headers JSON textarea value. Returns undefined for
 * empty / invalid input and strips Authorization because auth config owns it.
 */
export function parseHeadersJSON(headersValue: unknown): Record<string, string> | undefined {
  if (typeof headersValue !== 'string' || !headersValue.trim()) return undefined;
  try {
    const parsed = JSON.parse(headersValue) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.toLowerCase() === 'authorization') continue;
      if (typeof value === 'string') headers[key] = value;
    }
    return headers;
  } catch {
    return undefined;
  }
}

export function validateHeadersJSON(headersValue: unknown): string | undefined {
  if (typeof headersValue !== 'string' || !headersValue.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(headersValue);
  } catch {
    return 'Custom HTTP headers must be valid JSON';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Custom HTTP headers must be a JSON object';
  }

  const duplicate = findDuplicateMCPCustomHeaderName(parsed as Record<string, unknown>);
  if (duplicate) {
    return `Duplicate case-insensitive custom HTTP header names are not allowed: ${duplicate.first} and ${duplicate.duplicate}`;
  }

  for (const [key, value] of Object.entries(parsed)) {
    const name = key.trim();
    if (!name) return 'Custom HTTP header names cannot be empty';
    if (!isValidMCPHeaderName(name)) return `Invalid custom HTTP header name: ${key}`;
    if (isReservedMCPCustomHeaderName(name))
      return `Custom HTTP header ${name} is reserved and cannot be configured here`;
    if (typeof value !== 'string') return 'Custom HTTP header values must be strings';
  }

  return undefined;
}
