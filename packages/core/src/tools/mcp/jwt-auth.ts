/**
 * JWT Authentication for MCP Servers
 *
 * Handles JWT token fetching and caching for MCP servers that require JWT authentication.
 * Tokens are cached for 15 minutes to avoid excessive API calls.
 */

import type { MCPAuth } from '../../types/mcp';
import { fetchOAuthToken, inferOAuthTokenUrl } from './oauth-auth';
import { getCachedOAuth21Token } from './oauth-mcp-transport';

interface JWTConfig {
  api_url: string;
  api_token: string;
  api_secret: string;
  insecure?: boolean;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Cache tokens per unique credential set to avoid cross-tenant leakage
const tokenCache = new Map<string, CachedToken>();

// Token validity duration: 15 minutes (in milliseconds)
const TOKEN_TTL_MS = 15 * 60 * 1000;

function getCacheKey(config: JWTConfig): string {
  return `${config.api_url}::${config.api_token}::${config.api_secret}`;
}

/**
 * Fetch a JWT token from the authentication endpoint
 *
 * @param config - JWT configuration containing api_url, api_token, and api_secret
 * @returns The access token string
 * @throws Error if token fetch fails
 */
export async function fetchJWTToken(config: JWTConfig): Promise<string> {
  const { api_url, api_token, api_secret } = config;
  const cacheKey = getCacheKey(config);

  // Check cache first
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Fetch new token
  const response = await fetch(api_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: api_token,
      secret: api_secret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `JWT token fetch failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    payload?: { access_token?: string };
  };

  // Handle different response formats
  const token = data.access_token || data.payload?.access_token;
  if (!token) {
    throw new Error('JWT response missing access_token field');
  }

  // Cache the token
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return token;
}

/**
 * Clear cached token for a specific API URL
 *
 * @param api_url - The API URL to clear from cache
 */
export function clearJWTToken(api_url: string): void {
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${api_url}::`)) {
      tokenCache.delete(key);
    }
  }
}

/**
 * Clear all cached JWT tokens
 */
export function clearAllJWTTokens(): void {
  tokenCache.clear();
}

/**
 * Get MCP server connection args with JWT authentication
 *
 * For MCP servers using JWT auth, this returns the mcp-remote compatible
 * command and args. The token is passed via environment variable to avoid
 * exposing it in process arguments (visible via ps/logs).
 *
 * @param serverUrl - The MCP server URL
 * @param jwtConfig - JWT configuration
 * @returns Object with command, args, and env for spawning the MCP connection
 */
export async function getMCPRemoteArgsWithJWT(
  serverUrl: string,
  jwtConfig: JWTConfig
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const token = await fetchJWTToken(jwtConfig);

  // SECURITY: Pass token via environment variable instead of command-line args
  // to prevent exposure in process lists (ps) and supervisor logs
  return {
    command: 'npx',
    args: ['mcp-remote', serverUrl, '--header', 'Authorization: Bearer $MCP_AUTH_TOKEN'],
    env: {
      MCP_AUTH_TOKEN: token,
    },
  };
}

/**
 * Build Authorization headers for an MCP server based on its auth config.
 *
 * @param auth - MCP authentication configuration
 * @param mcpUrl - MCP server URL (used for OAuth token URL auto-detection)
 * @returns Header map including Authorization when applicable
 */
export async function resolveMCPAuthHeaders(
  auth?: MCPAuth,
  mcpUrl?: string
): Promise<Record<string, string> | undefined> {
  if (!auth || auth.type === 'none') {
    return undefined;
  }

  if (auth.type === 'bearer') {
    if (!auth.token) {
      console.warn('MCP bearer authentication configured without a token');
      return undefined;
    }
    return {
      Authorization: `Bearer ${auth.token}`,
    };
  }

  if (auth.type === 'jwt') {
    const { api_url, api_token, api_secret } = auth;
    if (!api_url || !api_token || !api_secret) {
      console.warn('MCP JWT authentication missing api_url, api_token, or api_secret');
      return undefined;
    }

    const token = await fetchJWTToken({
      api_url,
      api_token,
      api_secret,
      insecure: auth.insecure,
    });

    return {
      Authorization: `Bearer ${token}`,
    };
  }

  if (auth.type === 'oauth') {
    // Priority 1: Check for database-stored OAuth 2.1 token (persisted from browser flow)
    if (auth.oauth_access_token) {
      // Check if token is expired
      if (auth.oauth_token_expires_at && auth.oauth_token_expires_at <= Date.now()) {
        console.log('[OAuth 2.1] Database token expired, will try other methods');
      } else {
        console.log('[OAuth 2.1] Using database-stored token');
        return {
          Authorization: `Bearer ${auth.oauth_access_token}`,
        };
      }
    }

    // Priority 2: Check for in-memory cached token from browser flow
    if (!auth.oauth_client_id && !auth.oauth_client_secret) {
      if (mcpUrl) {
        const cachedToken = getCachedOAuth21Token(mcpUrl);
        if (cachedToken) {
          console.log('[OAuth 2.1] Using in-memory cached token from browser flow');
          return {
            Authorization: `Bearer ${cachedToken}`,
          };
        }
      }
      console.log('[OAuth] No credentials and no cached token - authentication may fail');
      console.log('[OAuth] Use "Start OAuth Flow" button to authenticate via browser first');
      return undefined;
    }

    // Auto-detect token URL if not provided
    let tokenUrl = auth.oauth_token_url;
    if (!tokenUrl && mcpUrl) {
      tokenUrl = inferOAuthTokenUrl(mcpUrl);
      console.log(`[OAuth] Auto-detected token URL: ${tokenUrl}`);
    }

    if (!tokenUrl) {
      console.warn('[OAuth] Token URL could not be determined');
      return undefined;
    }

    try {
      const { token } = await fetchOAuthToken({
        token_url: tokenUrl,
        client_id: auth.oauth_client_id,
        client_secret: auth.oauth_client_secret,
        scope: auth.oauth_scope,
        grant_type: auth.oauth_grant_type,
        insecure: auth.insecure,
      });

      return {
        Authorization: `Bearer ${token}`,
      };
    } catch (error) {
      console.warn('[OAuth] Token fetch failed:', error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  return undefined;
}
