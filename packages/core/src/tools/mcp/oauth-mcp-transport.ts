/**
 * MCP OAuth 2.1 Transport Wrapper
 *
 * Implements RFC 9728 (OAuth 2.0 Protected Resource Metadata) for MCP servers
 * Handles 401 responses with WWW-Authenticate headers and performs OAuth 2.1
 * Authorization Code flow with PKCE.
 */

import crypto from 'node:crypto';
import http from 'node:http';

export interface OAuthMetadata {
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

interface CachedAuthCodeToken {
  token: string;
  expiresAt: number;
  fetchedAt: number;
}

// Cache tokens from Authorization Code flow (per resource metadata URL)
// Key is the resource metadata URL to avoid cross-tenant leakage
const authCodeTokenCache = new Map<string, CachedAuthCodeToken>();

// Default token validity: 1 hour if not specified by OAuth server
const DEFAULT_AUTHCODE_TOKEN_TTL_SECONDS = 3600;

// Buffer before expiry to avoid using soon-to-expire tokens
const EXPIRY_BUFFER_SECONDS = 60;

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Parse WWW-Authenticate header to extract OAuth metadata URL
 */
function parseWWWAuthenticate(header: string): string | null {
  const match = header.match(/resource_metadata="([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Fetch Protected Resource Metadata (RFC 9728)
 */
async function fetchResourceMetadata(metadataUrl: string): Promise<OAuthMetadata> {
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OAuth resource metadata from ${metadataUrl} (${response.status}). ` +
        `The MCP server advertised OAuth support but the metadata endpoint is not available. ` +
        `This indicates an incomplete OAuth implementation on the server side.`
    );
  }
  return (await response.json()) as OAuthMetadata;
}

/**
 * Fetch Authorization Server Metadata (RFC 8414)
 */
async function fetchAuthorizationServerMetadata(
  authServerUrl: string
): Promise<AuthorizationServerMetadata> {
  // Try OIDC discovery first
  let metadataUrl = `${authServerUrl}/.well-known/openid-configuration`;
  let response = await fetch(metadataUrl);

  // Fall back to OAuth 2.0 discovery
  if (!response.ok) {
    metadataUrl = `${authServerUrl}/.well-known/oauth-authorization-server`;
    response = await fetch(metadataUrl);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch authorization server metadata: ${response.status}`);
  }

  return (await response.json()) as AuthorizationServerMetadata;
}

/**
 * Start local HTTP server to receive OAuth callback
 */
function startCallbackServer(port: number = 0): Promise<{
  server: http.Server;
  port: number;
  url: string;
  waitForCallback: () => Promise<{ code: string; state: string }>;
}> {
  return new Promise((resolve, reject) => {
    let callbackResolve: (value: { code: string; state: string }) => void;
    const callbackPromise = new Promise<{ code: string; state: string }>((res) => {
      callbackResolve = res;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);

      if (url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authentication Failed</h1><p>Error: ${error}</p></body></html>`);
          callbackResolve({ code: '', state: '' });
          return;
        }

        if (code && state) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>Authentication Successful</h1><p>You can close this window.</p></body></html>'
          );
          callbackResolve({ code, state });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>Invalid Callback</h1><p>Missing code or state parameter.</p></body></html>'
          );
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start callback server'));
        return;
      }

      const actualPort = address.port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}/oauth/callback`,
        waitForCallback: () => callbackPromise,
      });
    });

    server.on('error', reject);
  });
}

/**
 * Open browser for user authentication
 *
 * @param url - URL to open in browser
 * @throws Error with helpful message if browser fails to open
 */
async function openBrowser(url: string): Promise<void> {
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to open browser automatically: ${errorMessage}\n\n` +
        `Please open this URL manually in your browser:\n${url}`
    );
  }
}

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  clientId: string
): Promise<OAuthTokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as OAuthTokenResponse;
}

/**
 * Perform MCP OAuth 2.1 Authorization Code flow with PKCE
 *
 * Uses token caching to avoid repeated browser-based authentication flows.
 * Tokens are cached per resource metadata URL with automatic expiry handling.
 *
 * @param wwwAuthenticateHeader - The WWW-Authenticate header from 401 response
 * @param clientId - OAuth client ID (optional, generated if not provided)
 * @param onBrowserOpen - Callback when browser is opened (for UI notification)
 * @returns Access token to use for authenticated requests
 */
export async function performMCPOAuthFlow(
  wwwAuthenticateHeader: string,
  clientId?: string,
  onBrowserOpen?: (url: string) => void
): Promise<string> {
  console.log('[MCP OAuth] Starting OAuth 2.1 Authorization Code flow with PKCE');

  // Step 1: Parse WWW-Authenticate header
  const metadataUrl = parseWWWAuthenticate(wwwAuthenticateHeader);
  if (!metadataUrl) {
    throw new Error('WWW-Authenticate header missing resource_metadata parameter');
  }

  console.log('[MCP OAuth] Resource metadata URL:', metadataUrl);

  // Check cache first
  const cached = authCodeTokenCache.get(metadataUrl);
  if (cached && cached.expiresAt > Date.now()) {
    const ttlRemaining = Math.floor((cached.expiresAt - Date.now()) / 1000);
    console.log(`[MCP OAuth] Using cached token (valid for ${ttlRemaining}s)`);
    return cached.token;
  }

  if (cached) {
    console.log('[MCP OAuth] Cached token expired, performing new OAuth flow');
  }

  // Step 2: Fetch Protected Resource Metadata (RFC 9728)
  const resourceMetadata = await fetchResourceMetadata(metadataUrl);
  console.log('[MCP OAuth] Resource metadata:', resourceMetadata);

  if (
    !resourceMetadata.authorization_servers ||
    resourceMetadata.authorization_servers.length === 0
  ) {
    throw new Error('No authorization servers found in resource metadata');
  }

  // Use first authorization server
  const authServerUrl = resourceMetadata.authorization_servers[0];
  console.log('[MCP OAuth] Authorization server:', authServerUrl);

  // Step 3: Fetch Authorization Server Metadata (RFC 8414)
  const authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl);
  console.log('[MCP OAuth] Authorization server metadata:', authServerMetadata);

  // Step 4: Start local callback server
  const callback = await startCallbackServer();
  console.log('[MCP OAuth] Callback server listening on:', callback.url);

  try {
    // Step 5: Generate PKCE challenge
    const pkce = generatePKCE();

    // Generate client_id if not provided
    const actualClientId = clientId || crypto.randomUUID();

    // Generate state for CSRF protection
    const state = crypto.randomUUID();

    // Step 6: Build authorization URL
    const authUrl = new URL(authServerMetadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', actualClientId);
    authUrl.searchParams.set('redirect_uri', callback.url);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    // Add scopes if available
    if (resourceMetadata.scopes_supported && resourceMetadata.scopes_supported.length > 0) {
      authUrl.searchParams.set('scope', resourceMetadata.scopes_supported.join(' '));
    }

    console.log('[MCP OAuth] Opening browser for user authentication...');
    console.log('[MCP OAuth] Authorization URL:', authUrl.toString());

    // Step 7: Open browser
    if (onBrowserOpen) {
      onBrowserOpen(authUrl.toString());
    }
    await openBrowser(authUrl.toString());

    // Step 8: Wait for callback
    console.log('[MCP OAuth] Waiting for user to complete authentication...');
    const callbackResult = await callback.waitForCallback();

    // Verify state
    if (callbackResult.state !== state) {
      throw new Error('State mismatch - possible CSRF attack');
    }

    if (!callbackResult.code) {
      throw new Error('No authorization code received');
    }

    console.log('[MCP OAuth] Authorization code received, exchanging for token...');

    // Step 9: Exchange code for token
    const tokenResponse = await exchangeCodeForToken(
      authServerMetadata.token_endpoint,
      callbackResult.code,
      callback.url,
      pkce.verifier,
      actualClientId
    );

    console.log('[MCP OAuth] Access token received successfully');

    // Step 10: Cache token
    const expiresInSeconds = tokenResponse.expires_in || DEFAULT_AUTHCODE_TOKEN_TTL_SECONDS;
    const expiresAt = Date.now() + (expiresInSeconds - EXPIRY_BUFFER_SECONDS) * 1000;
    const fetchedAt = Date.now();

    authCodeTokenCache.set(metadataUrl, {
      token: tokenResponse.access_token,
      expiresAt,
      fetchedAt,
    });

    console.log(
      `[MCP OAuth] Token cached for ${expiresInSeconds}s (${EXPIRY_BUFFER_SECONDS}s buffer)`
    );

    return tokenResponse.access_token;
  } finally {
    // Always close callback server, even on error
    callback.server.close();
  }
}

/**
 * Check if HTTP response indicates OAuth is required
 */
export function isOAuthRequired(status: number, headers: Headers): boolean {
  return status === 401 && headers.get('www-authenticate')?.includes('resource_metadata=') === true;
}

/**
 * Clear cached OAuth tokens from Authorization Code flow
 *
 * Useful when switching accounts or forcing re-authentication.
 *
 * @param metadataUrl - Optional metadata URL to clear specific token, clears all if not provided
 */
export function clearAuthCodeTokenCache(metadataUrl?: string): void {
  if (metadataUrl) {
    authCodeTokenCache.delete(metadataUrl);
  } else {
    authCodeTokenCache.clear();
  }
}

/**
 * Get Authorization Code token cache statistics for debugging
 *
 * @returns Cache statistics including total, valid, and expired entries
 */
export function getAuthCodeTokenCacheStats(): {
  totalEntries: number;
  validEntries: number;
  expiredEntries: number;
} {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  for (const cached of authCodeTokenCache.values()) {
    if (cached.expiresAt > now) {
      validEntries++;
    } else {
      expiredEntries++;
    }
  }

  return {
    totalEntries: authCodeTokenCache.size,
    validEntries,
    expiredEntries,
  };
}
