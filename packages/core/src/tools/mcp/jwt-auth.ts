/**
 * JWT Authentication for MCP Servers
 *
 * Handles JWT token fetching and caching for MCP servers that require JWT authentication.
 * Tokens are cached for 15 minutes to avoid excessive API calls.
 */

import type { MCPAuth } from '../../types/mcp';

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
 * command and args with the Bearer token header.
 *
 * @param serverUrl - The MCP server URL
 * @param jwtConfig - JWT configuration
 * @returns Object with command and args for spawning the MCP connection
 */
export async function getMCPRemoteArgsWithJWT(
  serverUrl: string,
  jwtConfig: JWTConfig
): Promise<{ command: string; args: string[] }> {
  const token = await fetchJWTToken(jwtConfig);

  return {
    command: 'npx',
    args: ['mcp-remote', serverUrl, '--header', `Authorization: Bearer ${token}`],
  };
}

/**
 * Build Authorization headers for an MCP server based on its auth config.
 *
 * @param auth - MCP authentication configuration
 * @returns Header map including Authorization when applicable
 */
export async function resolveMCPAuthHeaders(
  auth?: MCPAuth
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

  return undefined;
}
