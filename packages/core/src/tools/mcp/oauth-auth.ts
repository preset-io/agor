/**
 * OAuth 2.0 Authentication for MCP Servers
 *
 * Handles OAuth 2.0 token fetching and caching for MCP servers that require OAuth authentication.
 * Supports Client Credentials flow with automatic token expiry handling.
 *
 * Debug Features:
 * - Detailed step-by-step diagnostics
 * - Request/response logging with sanitized credentials
 * - Auto-detection tracking
 * - Cache hit/miss tracking
 */

export interface OAuthConfig {
  token_url: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  grant_type?: string;
  insecure?: boolean;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  fetchedAt: number;
}

export interface OAuthDebugStep {
  step: string;
  status: 'success' | 'error' | 'warning' | 'info';
  details: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface OAuthDebugInfo {
  steps: OAuthDebugStep[];
  tokenUrl: string;
  tokenUrlSource: 'provided' | 'auto-detected' | 'template';
  credentialsSource: 'explicit' | 'env_vars' | 'partial';
  clientIdMasked: string;
  scope?: string;
  grantType: string;
  tokenExpiresIn?: number;
  cacheKey: string;
  cacheHit: boolean;
  tokenFetchedAt?: Date;
  tokenExpiresAt?: Date;
}

// Cache tokens per unique credential set to avoid cross-tenant leakage
const oauthTokenCache = new Map<string, CachedToken>();

// Default token validity: 15 minutes if not specified by OAuth server
const DEFAULT_TOKEN_TTL_SECONDS = 900;

// Buffer before expiry to avoid using soon-to-expire tokens
const EXPIRY_BUFFER_SECONDS = 30;

/**
 * Generate cache key for OAuth credentials
 * Uses all credential fields to ensure per-tenant isolation
 */
function getCacheKey(config: OAuthConfig): string {
  return `${config.token_url}::${config.client_id || 'none'}::${config.client_secret || 'none'}::${config.scope || ''}`;
}

/**
 * Mask sensitive credential for logging
 */
function maskCredential(credential?: string): string {
  if (!credential) return '<not-provided>';
  if (credential.length <= 8) return '***';
  return `${credential.substring(0, 4)}...${credential.substring(credential.length - 4)}`;
}

/**
 * Sanitize OAuth config for logging (mask secrets)
 */
function sanitizeConfigForLogging(config: OAuthConfig): Record<string, unknown> {
  return {
    token_url: config.token_url,
    client_id: maskCredential(config.client_id),
    client_secret: maskCredential(config.client_secret),
    scope: config.scope || '<none>',
    grant_type: config.grant_type || 'client_credentials',
    insecure: config.insecure || false,
  };
}

/**
 * Fetch OAuth 2.0 access token from token endpoint
 *
 * Supports Client Credentials flow with automatic caching based on expires_in.
 * Returns detailed debug information for troubleshooting OAuth issues.
 *
 * @param config - OAuth configuration
 * @param debug - Enable detailed debug tracking
 * @returns Object with token and optional debug info
 * @throws Error if token fetch fails
 */
export async function fetchOAuthToken(
  config: OAuthConfig,
  debug: boolean = false
): Promise<{ token: string; debugInfo?: OAuthDebugInfo }> {
  const debugSteps: OAuthDebugStep[] = [];
  const startTime = Date.now();

  const addDebugStep = (
    step: string,
    status: OAuthDebugStep['status'],
    details: string,
    data?: Record<string, unknown>
  ) => {
    if (debug) {
      debugSteps.push({
        step,
        status,
        details,
        timestamp: Date.now() - startTime,
        data,
      });
    }
  };

  // Step 1: Validate configuration
  addDebugStep(
    'validate_config',
    'info',
    'Validating OAuth configuration',
    sanitizeConfigForLogging(config)
  );

  if (!config.token_url) {
    addDebugStep('validate_config', 'error', 'Token URL is required but not provided');
    throw new Error('OAuth token URL is required');
  }

  if (!config.client_id || !config.client_secret) {
    addDebugStep(
      'validate_config',
      'error',
      'Client credentials missing. Ensure client_id and client_secret are provided or resolved from environment variables.'
    );
    throw new Error(
      'OAuth credentials not configured. Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET environment variables or provide explicit values.'
    );
  }

  addDebugStep('validate_config', 'success', 'Configuration validated');

  // Step 2: Check cache
  const cacheKey = getCacheKey(config);
  const cached = oauthTokenCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    const ttlRemaining = Math.floor((cached.expiresAt - Date.now()) / 1000);
    addDebugStep('check_cache', 'success', `Cache hit! Token still valid for ${ttlRemaining}s`, {
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      expiresAt: new Date(cached.expiresAt).toISOString(),
    });

    if (debug) {
      return {
        token: cached.token,
        debugInfo: {
          steps: debugSteps,
          tokenUrl: config.token_url,
          tokenUrlSource: 'provided',
          credentialsSource: 'explicit',
          clientIdMasked: maskCredential(config.client_id),
          scope: config.scope,
          grantType: config.grant_type || 'client_credentials',
          cacheKey: maskCredential(cacheKey),
          cacheHit: true,
          tokenFetchedAt: new Date(cached.fetchedAt),
          tokenExpiresAt: new Date(cached.expiresAt),
        },
      };
    }

    return { token: cached.token };
  }

  if (cached) {
    addDebugStep('check_cache', 'info', 'Cached token expired, fetching new token');
  } else {
    addDebugStep('check_cache', 'info', 'No cached token found, fetching new token');
  }

  // Step 3: Prepare request
  const grantType = config.grant_type || 'client_credentials';
  const body = new URLSearchParams({
    grant_type: grantType,
    client_id: config.client_id,
    client_secret: config.client_secret,
  });

  if (config.scope) {
    body.append('scope', config.scope);
  }

  addDebugStep('prepare_request', 'info', `Preparing OAuth request to ${config.token_url}`, {
    grant_type: grantType,
    scope: config.scope || '<none>',
    content_type: 'application/x-www-form-urlencoded',
  });

  // Step 4: Fetch token
  let response: Response;
  try {
    addDebugStep('fetch_token', 'info', `Sending POST request to ${config.token_url}`);

    response = await fetch(config.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    addDebugStep('fetch_token', 'info', `Received response with status ${response.status}`, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'content-type': response.headers.get('content-type'),
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    addDebugStep('fetch_token', 'error', `Network error: ${errorMessage}`, {
      error: errorMessage,
      tokenUrl: config.token_url,
    });
    throw new Error(`OAuth token fetch failed - Network error: ${errorMessage}`);
  }

  // Step 5: Handle response
  if (!response.ok) {
    const errorText = await response.text();
    addDebugStep('handle_response', 'error', `Token fetch failed with status ${response.status}`, {
      status: response.status,
      statusText: response.statusText,
      errorBody: errorText,
    });

    // Provide helpful error messages
    let errorMessage = `OAuth token fetch failed (${response.status} ${response.statusText})`;

    if (response.status === 401) {
      errorMessage +=
        ' - Invalid client credentials. Check OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.';
    } else if (response.status === 400) {
      errorMessage += ' - Bad request. Check grant_type, scope, or other parameters.';
    } else if (response.status === 403) {
      errorMessage += ' - Access forbidden. Client may not have permission for requested scope.';
    }

    throw new Error(`${errorMessage}\n\nServer response: ${errorText}`);
  }

  // Step 6: Parse response
  let data: OAuthTokenResponse;
  try {
    data = (await response.json()) as OAuthTokenResponse;
    addDebugStep('parse_response', 'success', 'Successfully parsed OAuth response', {
      token_type: data.token_type,
      expires_in: data.expires_in,
      has_refresh_token: !!data.refresh_token,
      scope: data.scope,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    addDebugStep('parse_response', 'error', `Failed to parse JSON response: ${errorMessage}`);
    throw new Error(`OAuth response is not valid JSON: ${errorMessage}`);
  }

  if (!data.access_token) {
    addDebugStep('parse_response', 'error', 'Response missing access_token field', {
      response: data,
    });
    throw new Error('OAuth response missing access_token field');
  }

  // Step 7: Cache token
  const expiresInSeconds = data.expires_in || DEFAULT_TOKEN_TTL_SECONDS;
  const expiresAt = Date.now() + (expiresInSeconds - EXPIRY_BUFFER_SECONDS) * 1000;
  const fetchedAt = Date.now();

  oauthTokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt,
    fetchedAt,
  });

  addDebugStep(
    'cache_token',
    'success',
    `Token cached for ${expiresInSeconds}s (${EXPIRY_BUFFER_SECONDS}s buffer)`,
    {
      expiresIn: expiresInSeconds,
      expiresAt: new Date(expiresAt).toISOString(),
      buffer: EXPIRY_BUFFER_SECONDS,
    }
  );

  if (debug) {
    return {
      token: data.access_token,
      debugInfo: {
        steps: debugSteps,
        tokenUrl: config.token_url,
        tokenUrlSource: 'provided',
        credentialsSource: config.client_id?.includes('{{') ? 'env_vars' : 'explicit',
        clientIdMasked: maskCredential(config.client_id),
        scope: config.scope,
        grantType: grantType,
        tokenExpiresIn: expiresInSeconds,
        cacheKey: maskCredential(cacheKey),
        cacheHit: false,
        tokenFetchedAt: new Date(fetchedAt),
        tokenExpiresAt: new Date(expiresAt),
      },
    };
  }

  return { token: data.access_token };
}

/**
 * Infer OAuth token URL from MCP server URL
 *
 * Tries common OAuth token endpoint patterns based on the MCP URL path structure.
 * Common patterns:
 * - /oauth/token (standard OAuth 2.0)
 * - /token (simplified path)
 * - Same path as MCP with /oauth/token suffix (e.g., /mcp -> /mcp/oauth/token)
 *
 * @param mcpUrl - MCP server URL (e.g., "https://example.com/mcp")
 * @returns Inferred token URL (e.g., "https://example.com/oauth/token")
 *
 * @example
 * inferOAuthTokenUrl("https://api.example.com/mcp")
 * // Returns: "https://api.example.com/oauth/token"
 *
 * @example
 * inferOAuthTokenUrl("https://example.com/v1/mcp")
 * // Returns: "https://example.com/oauth/token"
 */
export function inferOAuthTokenUrl(mcpUrl: string): string {
  try {
    const url = new URL(mcpUrl);

    // Strategy 1: If MCP is at /mcp, try /oauth/token at root
    // Most common pattern: MCP at /mcp, OAuth at /oauth/token
    if (url.pathname === '/mcp' || url.pathname.endsWith('/mcp')) {
      return `${url.origin}/oauth/token`;
    }

    // Strategy 2: If MCP is in a versioned path (e.g., /v1/mcp), use root /oauth/token
    if (url.pathname.match(/^\/v\d+\//)) {
      return `${url.origin}/oauth/token`;
    }

    // Strategy 3: Try token endpoint relative to MCP path
    // e.g., /services/mcp -> /services/oauth/token
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length > 1) {
      pathParts.pop(); // Remove last segment (e.g., "mcp")
      return `${url.origin}/${pathParts.join('/')}/oauth/token`;
    }

    // Strategy 4: Default to /oauth/token at origin
    return `${url.origin}/oauth/token`;
  } catch {
    return '';
  }
}

/**
 * Clear cached OAuth token for specific credentials
 *
 * Use this when you need to force token refresh, such as when:
 * - Credentials have been updated
 * - Token has been revoked server-side
 * - User is switching accounts
 *
 * @param config - OAuth config to clear (optional, clears all tokens if not provided)
 *
 * @example
 * // Clear specific server's token
 * clearOAuthCache({ token_url: "https://api.example.com/oauth/token", client_id: "..." })
 *
 * @example
 * // Clear all cached tokens (e.g., on logout)
 * clearOAuthCache()
 */
export function clearOAuthCache(config?: OAuthConfig): void {
  if (config) {
    const cacheKey = getCacheKey(config);
    oauthTokenCache.delete(cacheKey);
  } else {
    oauthTokenCache.clear();
  }
}

/**
 * Get OAuth token cache statistics for debugging and monitoring
 *
 * Useful for:
 * - Monitoring cache efficiency
 * - Debugging token expiry issues
 * - Understanding token refresh patterns
 *
 * @returns Object with totalEntries, validEntries, and expiredEntries counts
 *
 * @example
 * const stats = getOAuthCacheStats();
 * console.log(`Cache: ${stats.validEntries}/${stats.totalEntries} valid tokens`);
 */
export function getOAuthCacheStats(): {
  totalEntries: number;
  validEntries: number;
  expiredEntries: number;
} {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  for (const cached of oauthTokenCache.values()) {
    if (cached.expiresAt > now) {
      validEntries++;
    } else {
      expiredEntries++;
    }
  }

  return {
    totalEntries: oauthTokenCache.size,
    validEntries,
    expiredEntries,
  };
}
