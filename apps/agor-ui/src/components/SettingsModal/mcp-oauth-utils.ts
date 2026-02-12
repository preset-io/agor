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

  // OAuth mode defaults to shared
  config.oauth_mode = values.oauth_mode === 'per_user' ? 'per_user' : 'shared';

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
