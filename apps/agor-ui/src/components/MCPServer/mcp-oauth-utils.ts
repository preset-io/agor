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

  // Only include client secret if it's provided
  if (values.oauth_client_secret && typeof values.oauth_client_secret === 'string') {
    config.oauth_client_secret = values.oauth_client_secret;
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

  return config;
}

export interface TestConfig {
  mcp_url: string;
  token_url?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  grant_type?: string;
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
    config.client_secret = values.oauth_client_secret;
  }

  // Include scope if provided
  if (values.oauth_scope && typeof values.oauth_scope === 'string') {
    config.scope = values.oauth_scope;
  }

  // Include grant type if provided
  if (values.oauth_grant_type && typeof values.oauth_grant_type === 'string') {
    config.grant_type = values.oauth_grant_type;
  }

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
}

/**
 * Build the `auth` payload from form values (auth_type + the relevant
 * per-method fields). Returns `undefined` for "none" or unrecognized types
 * so callers can do `payload.auth = buildAuthFromValues(values)` without
 * an outer if/else.
 */
export function buildAuthFromValues(values: Record<string, unknown>): BuiltAuth | undefined {
  const authType = values.auth_type;
  if (authType !== 'bearer' && authType !== 'jwt' && authType !== 'oauth') return undefined;

  const auth: BuiltAuth = { type: authType };
  if (authType === 'bearer') {
    if (typeof values.auth_token === 'string') auth.token = values.auth_token;
  } else if (authType === 'jwt') {
    if (typeof values.jwt_api_url === 'string') auth.api_url = values.jwt_api_url;
    if (typeof values.jwt_api_token === 'string') auth.api_token = values.jwt_api_token;
    if (typeof values.jwt_api_secret === 'string') auth.api_secret = values.jwt_api_secret;
  } else {
    Object.assign(auth, extractOAuthConfig(values));
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
