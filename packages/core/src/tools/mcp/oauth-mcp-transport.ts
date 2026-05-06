/**
 * MCP OAuth 2.1 Transport Wrapper
 *
 * Implements RFC 9728 (OAuth 2.0 Protected Resource Metadata) for MCP servers
 * Handles 401 responses with WWW-Authenticate headers and performs OAuth 2.1
 * Authorization Code flow with PKCE.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { OAuthTokenResponse } from './oauth-auth.js';
import { resolveTokenExpiry } from './oauth-token-expiry.js';

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

/**
 * Test-only hook: seed the auth-code token cache so tests can verify
 * clearing behavior without performing a real OAuth flow.
 */
export function __seedAuthCodeTokenCacheForTests(
  metadataUrl: string,
  entry: { token: string; expiresAt: number; fetchedAt: number }
): void {
  authCodeTokenCache.set(metadataUrl, entry);
}

// In-memory cache TTL fallback when `resolveTokenExpiry` cannot determine an
// expiry from the token response. This bounds the lifetime of THIS module's
// `authCodeTokenCache` map only — local-cache hygiene, not a persisted DB
// value. The persisted lifecycle is handled in `oauth-cache.ts` (initial
// auth) and `oauth-refresh.ts` (refresh) which both use the resolver.
const UNKNOWN_EXPIRY_CACHE_TTL_SECONDS = 3600;

/**
 * Raw OAuth 2.0 token response shape.
 * Covers standard RFC 6749 fields and Slack-style nested authed_user tokens.
 */
interface OAuthRawTokenResponse {
  access_token?: string;
  token_type?: string;
  /** Some providers return this as a string instead of a number */
  expires_in?: number | string;
  refresh_token?: string;
  scope?: string;
  /** Slack-specific: present when request was denied at HTTP layer but body carries error */
  ok?: boolean;
  error?: string;
  error_description?: string;
  /** Slack-specific: user-scoped token nested under authed_user */
  authed_user?: {
    access_token?: string;
    token_type?: string;
    scope?: string;
  };
}

// Buffer before expiry to avoid using soon-to-expire tokens
const EXPIRY_BUFFER_SECONDS = 60;

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string; // RFC 7591 Dynamic Client Registration
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
}

// Re-export the canonical OAuthTokenResponse from oauth-auth to avoid duplication
export type { OAuthTokenResponse } from './oauth-auth.js';

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
 * Discover the OAuth Protected Resource Metadata URL for an MCP server.
 *
 * Many MCP servers (e.g. Notion) return a 401 with a plain Bearer challenge
 * that does NOT include the `resource_metadata` parameter per RFC 9728.
 * However, they DO serve the metadata at the well-known path.
 *
 * This function tries to discover it by probing:
 *   1. {origin}/.well-known/oauth-protected-resource  (root-level)
 *   2. {origin}/.well-known/oauth-protected-resource{path}  (path-aware per RFC)
 *
 * @param mcpUrl - The MCP server URL
 * @returns The resource metadata URL if discoverable, null otherwise
 */
export async function discoverResourceMetadataUrl(mcpUrl: string): Promise<string | null> {
  const url = new URL(mcpUrl);
  const origin = url.origin;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');

  // Path-aware first (more specific), then root fallback.
  // Per RFC 9728, path-scoped resources should match their specific metadata endpoint.
  const candidates: string[] = [];
  if (path) {
    candidates.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  }
  candidates.push(`${origin}/.well-known/oauth-protected-resource`);

  for (const candidate of candidates) {
    try {
      console.log('[MCP OAuth] Trying resource metadata discovery:', candidate);
      const response = await fetch(candidate, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        // Validate it looks like proper metadata
        const data = (await response.json()) as Record<string, unknown>;
        if (data.authorization_servers && Array.isArray(data.authorization_servers)) {
          console.log('[MCP OAuth] ✓ Discovered resource metadata at:', candidate);
          return candidate;
        }
      }
    } catch (err) {
      console.log(
        '[MCP OAuth] Discovery failed for',
        candidate,
        ':',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return null;
}

/**
 * Resolve the OAuth resource metadata URL for an MCP server.
 *
 * Combines two strategies:
 *   1. Parse the `resource_metadata` parameter from the WWW-Authenticate header (RFC 9728)
 *   2. Auto-discover via `.well-known/oauth-protected-resource` (fallback for servers like Notion)
 *
 * Returns the metadata URL and its source, or null if neither strategy succeeds.
 * This is the single entry point that daemon endpoints should use instead of
 * duplicating parse + fallback logic.
 */
export async function resolveResourceMetadataUrl(
  wwwAuthenticateHeader: string | null,
  mcpUrl: string
): Promise<{ metadataUrl: string; source: 'header' | 'well-known' } | null> {
  // Strategy 1: Parse from WWW-Authenticate header
  if (wwwAuthenticateHeader) {
    const parsed = parseWWWAuthenticate(wwwAuthenticateHeader);
    if (parsed) {
      return { metadataUrl: parsed, source: 'header' };
    }
  }

  // Strategy 2: Auto-discover via .well-known endpoint
  const discovered = await discoverResourceMetadataUrl(mcpUrl);
  if (discovered) {
    return { metadataUrl: discovered, source: 'well-known' };
  }

  return null;
}

/**
 * Discover OAuth Authorization Server metadata directly at the MCP server's
 * origin (RFC 8414 / OIDC fallback when RFC 9728 isn't implemented).
 *
 * Some MCP servers (e.g. Reo.Dev) skip the RFC 9728 Protected Resource Metadata
 * layer entirely and instead serve the AS metadata document at their own
 * origin. Claude Desktop's MCP client probes this path; we mirror that
 * behaviour so 'paste URL → click Connect' works without manual config.
 *
 * Probes (in order). Note that RFC 8414 and OIDC use *different* path-construction
 * rules for path-bearing issuers:
 *   - RFC 8414 §3.1: insert `.well-known/oauth-authorization-server` between
 *     the host and the issuer's path → `{origin}/.well-known/...{path}`
 *   - OIDC Discovery 1.0 §4: append `.well-known/openid-configuration` after
 *     the issuer's path → `{origin}{path}/.well-known/...`
 *
 * Probe order:
 *   1. {origin}/.well-known/oauth-authorization-server{path}   (RFC 8414 path-aware)
 *   2. {origin}/.well-known/oauth-authorization-server         (root)
 *   3. {origin}{path}/.well-known/openid-configuration         (OIDC path-aware)
 *   4. {origin}/.well-known/openid-configuration               (OIDC root)
 *
 * @param mcpUrl - The MCP server URL
 * @returns Discovered AS metadata + the URL it was fetched from, or null
 */
export async function discoverAuthorizationServerFromMcpOrigin(
  mcpUrl: string
): Promise<{ metadata: AuthorizationServerMetadata; discoveredAt: string } | null> {
  const url = new URL(mcpUrl);
  const origin = url.origin;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');

  const candidates: string[] = [];
  // RFC 8414: path-insertion (between host and path)
  if (path) {
    candidates.push(`${origin}/.well-known/oauth-authorization-server${path}`);
  }
  candidates.push(`${origin}/.well-known/oauth-authorization-server`);
  // OIDC Discovery: path-append (after the issuer's path)
  if (path) {
    candidates.push(`${origin}${path}/.well-known/openid-configuration`);
  }
  candidates.push(`${origin}/.well-known/openid-configuration`);

  // Dedupe (no path → path-aware == root)
  const unique = Array.from(new Set(candidates));

  for (const candidate of unique) {
    try {
      console.log('[MCP OAuth] Trying AS-direct discovery:', candidate);
      const response = await fetch(candidate, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const data = (await response.json()) as Partial<AuthorizationServerMetadata>;
      // Minimal validation: must have authorization_endpoint + token_endpoint
      if (
        typeof data.authorization_endpoint === 'string' &&
        typeof data.token_endpoint === 'string'
      ) {
        console.log('[MCP OAuth] ✓ Discovered AS metadata at:', candidate);
        return {
          metadata: data as AuthorizationServerMetadata,
          discoveredAt: candidate,
        };
      }
    } catch (err) {
      console.log(
        '[MCP OAuth] AS-direct discovery failed for',
        candidate,
        ':',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return null;
}

/**
 * Discriminated discovery result for MCP OAuth.
 *
 * The MCP Authorization spec layers three RFCs:
 *   - RFC 9728 (Protected Resource Metadata) — links resource server → AS list
 *   - RFC 8414 (Authorization Server Metadata) — describes the AS endpoints
 *   - RFC 7591 (Dynamic Client Registration) — register a client at runtime
 *
 * Real-world servers vary in what they actually implement. This type lets
 * callers distinguish:
 *   - 'resource-metadata': RFC 9728 worked → fetch metadata URL → derive AS
 *   - 'authorization-server': RFC 9728 absent, but AS metadata served directly
 *     at the MCP origin (Reo.Dev pattern) → use it directly, skip RFC 9728.
 */
export type MCPOAuthDiscoveryResult =
  | {
      kind: 'resource-metadata';
      metadataUrl: string;
      source: 'header' | 'well-known';
    }
  | {
      kind: 'authorization-server';
      authServerMetadata: AuthorizationServerMetadata;
      discoveredAt: string;
    };

/**
 * Full MCP OAuth discovery cascade — the single entry point new daemon
 * callsites should use.
 *
 * Walks the cascade in order:
 *   1. WWW-Authenticate `resource_metadata="..."` (RFC 9728 via header hint)
 *   2. `<origin>/.well-known/oauth-protected-resource` (RFC 9728 well-known)
 *   3. `<origin>/.well-known/oauth-authorization-server` (RFC 8414 direct)
 *   4. `<origin>/.well-known/openid-configuration` (OIDC discovery direct)
 *
 * Returns the first success. Each step's failure is logged but never thrown —
 * a clean `null` lets the caller emit a single, specific error message.
 */
export async function resolveMCPOAuthDiscovery(
  wwwAuthenticateHeader: string | null,
  mcpUrl: string
): Promise<MCPOAuthDiscoveryResult | null> {
  // Strategies 1 + 2: RFC 9728 (header hint, then well-known fallback)
  const rfc9728 = await resolveResourceMetadataUrl(wwwAuthenticateHeader, mcpUrl);
  if (rfc9728) {
    return { kind: 'resource-metadata', ...rfc9728 };
  }

  // Strategies 3 + 4: AS metadata directly at MCP origin (RFC 8414 / OIDC)
  const asDirect = await discoverAuthorizationServerFromMcpOrigin(mcpUrl);
  if (asDirect) {
    return {
      kind: 'authorization-server',
      authServerMetadata: asDirect.metadata,
      discoveredAt: asDirect.discoveredAt,
    };
  }

  return null;
}

/**
 * Fetch Protected Resource Metadata (RFC 9728)
 */
async function fetchResourceMetadata(metadataUrl: string): Promise<OAuthMetadata> {
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OAuth resource metadata from ${metadataUrl} (${response.status}). ` +
        `The MCP server advertised OAuth support but the metadata endpoint is not available. ` +
        `This indicates an incomplete OAuth implementation on the server side.`
    );
  }
  return (await response.json()) as OAuthMetadata;
}

// Cache for dynamically registered clients (per authorization server)
const dynamicClientCache = new Map<
  string,
  { client_id: string; client_secret?: string; redirect_uri: string }
>();

/**
 * Test-only hook: snapshot the DCR client cache size. Used to verify that
 * `clearAuthCodeTokenCache` clears DCR registrations on blanket clears.
 * Do NOT call from production code.
 */
export function __dynamicClientCacheSizeForTests(): number {
  return dynamicClientCache.size;
}

/**
 * Test-only hook: seed the DCR cache with a fake entry so tests can verify
 * clearing behavior without performing a real HTTP registration.
 */
export function __seedDynamicClientCacheForTests(
  registrationEndpoint: string,
  entry: { client_id: string; client_secret?: string; redirect_uri: string }
): void {
  dynamicClientCache.set(registrationEndpoint, entry);
}

/**
 * Perform Dynamic Client Registration (RFC 7591)
 *
 * Registers a new OAuth client with the authorization server.
 * Results are cached per authorization server to avoid repeated registrations.
 */
async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string = 'Agor MCP Client',
  scope?: string
): Promise<DynamicClientRegistrationResponse> {
  // Check cache first
  const cacheKey = registrationEndpoint;
  const cached = dynamicClientCache.get(cacheKey);
  if (cached && cached.redirect_uri === redirectUri) {
    console.log('[MCP OAuth] Using cached dynamic client registration');
    return { client_id: cached.client_id, client_secret: cached.client_secret };
  }

  console.log('[MCP OAuth] Performing Dynamic Client Registration at:', registrationEndpoint);

  // biome-ignore lint/suspicious/noExplicitAny: DCR request shape varies per RFC 7591
  const registrationRequest: any = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // Public client (no client_secret)
  };

  // Include scope in registration so the client is authorized to request them later.
  // Per RFC 7591 §2, the scope field is a space-separated string of scope values.
  if (scope) {
    registrationRequest.scope = scope;
    console.log('[MCP OAuth] Registering client with scope:', scope);
  }

  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(registrationRequest),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Dynamic Client Registration failed (${response.status}): ${errorText}\n\n` +
        'This MCP server does not support Dynamic Client Registration (RFC 7591). ' +
        "You need to register an OAuth app in the provider's developer portal " +
        '(e.g. figma.com/developers/apps for Figma) and enter the Client ID and ' +
        'Client Secret in the MCP server configuration.'
    );
  }

  const result = (await response.json()) as DynamicClientRegistrationResponse;

  // Cache the result
  dynamicClientCache.set(cacheKey, {
    client_id: result.client_id,
    client_secret: result.client_secret,
    redirect_uri: redirectUri,
  });

  console.log('[MCP OAuth] Dynamic client registered:', {
    client_id: result.client_id,
    client_name: result.client_name,
  });

  return result;
}

/**
 * Build RFC 8414 Section 3 well-known URL with path-aware discovery.
 *
 * Per the RFC, the well-known URI is constructed by inserting the well-known
 * segment after the authority component. For example:
 *   - https://example.com           → https://example.com/.well-known/oauth-authorization-server
 *   - https://example.com/tenant1   → https://example.com/.well-known/oauth-authorization-server/tenant1
 *   - https://example.com/a/b       → https://example.com/.well-known/oauth-authorization-server/a/b
 */
function buildWellKnownUrl(issuerUrl: string, wellKnownSuffix: string): string {
  const url = new URL(issuerUrl);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `/.well-known/${wellKnownSuffix}${path}`;
  return url.toString();
}

/**
 * Fetch Authorization Server Metadata (RFC 8414)
 *
 * Implements path-aware discovery per RFC 8414 Section 3.
 * Falls back to OIDC discovery and naive URL construction.
 */
export async function fetchAuthorizationServerMetadata(
  authServerUrl: string
): Promise<AuthorizationServerMetadata> {
  const cleanUrl = authServerUrl.replace(/\/$/, '');
  const urlsToTry: { url: string; label: string }[] = [];

  // 1. RFC 8414 path-aware discovery (correct per spec)
  const rfc8414Url = buildWellKnownUrl(cleanUrl, 'oauth-authorization-server');
  urlsToTry.push({ url: rfc8414Url, label: 'RFC 8414 (path-aware)' });

  // 2. Naive append (common non-compliant servers just append /.well-known/...)
  const naiveUrl = `${cleanUrl}/.well-known/oauth-authorization-server`;
  if (naiveUrl !== rfc8414Url) {
    urlsToTry.push({ url: naiveUrl, label: 'RFC 8414 (naive append)' });
  }

  // 3. OIDC discovery — path-aware
  const oidcUrl = buildWellKnownUrl(cleanUrl, 'openid-configuration');
  urlsToTry.push({ url: oidcUrl, label: 'OIDC (path-aware)' });

  // 4. OIDC discovery — naive append
  const naiveOidcUrl = `${cleanUrl}/.well-known/openid-configuration`;
  if (naiveOidcUrl !== oidcUrl) {
    urlsToTry.push({ url: naiveOidcUrl, label: 'OIDC (naive append)' });
  }

  const errors: string[] = [];
  for (const { url, label } of urlsToTry) {
    try {
      console.log(`[MCP OAuth] Trying ${label}: ${url}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        console.log(`[MCP OAuth] ✓ Fetched metadata via ${label}`);
        return (await response.json()) as AuthorizationServerMetadata;
      }
      errors.push(`${label} (${url}): HTTP ${response.status}`);
    } catch (err) {
      errors.push(`${label} (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `Failed to fetch authorization server metadata from ${authServerUrl}.\n` +
      `Tried:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
      'The authorization server may not support RFC 8414 or OIDC metadata discovery.\n' +
      'You can manually provide oauth_authorization_url and oauth_token_url in the MCP server config.'
  );
}

// Timeout for waiting for the OAuth callback (2 minutes)
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;

/**
 * Start local HTTP server to receive OAuth callback
 */
function startCallbackServer(port: number = 0): Promise<{
  server: http.Server;
  port: number;
  url: string;
  waitForCallback: (timeoutMs?: number) => Promise<{ code: string; state: string }>;
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
        waitForCallback: (timeoutMs: number = OAUTH_CALLBACK_TIMEOUT_MS) => {
          // Race the callback promise against a timeout
          const timeoutPromise = new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(
                new Error(
                  `OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s. ` +
                    'The browser may not have opened, or the authentication was not completed in time. ' +
                    'Please try again.'
                )
              );
            }, timeoutMs);
          });
          return Promise.race([callbackPromise, timeoutPromise]);
        },
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
    // Dynamic import with type assertion to handle ESM module
    const openModule = (await import('open')) as { default: (url: string) => Promise<unknown> };
    await openModule.default(url);
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
  clientId: string,
  clientSecret?: string
): Promise<OAuthTokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  // Build headers — use HTTP Basic auth when client_secret is available (RFC 6749 §2.3.1),
  // fall back to body params for public clients or providers that don't support Basic auth.
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (clientSecret) {
    // Slack and other providers recommend HTTP Basic auth for credentials
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    // Public client — send client_id in body
    body.client_id = clientId;
  }

  console.log('[MCP OAuth] Token exchange request:', {
    endpoint: tokenEndpoint,
    hasBasicAuth: !!headers.Authorization,
    bodyKeys: Object.keys(body),
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  console.log('[MCP OAuth] Token exchange response status:', response.status);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[MCP OAuth] Token exchange HTTP error:', response.status, errorText);
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as OAuthRawTokenResponse;
  console.log(
    '[MCP OAuth] Token response keys:',
    Object.keys(json),
    'has access_token:',
    !!json.access_token
  );

  // Some providers (e.g. Slack) return HTTP 200 with {"ok": false, "error": "..."} on failure
  if (json.ok === false && json.error) {
    console.error('[MCP OAuth] Token exchange error response:', JSON.stringify(json));
    throw new Error(
      `Token exchange failed: ${json.error}${json.error_description ? ` - ${json.error_description}` : ''}`
    );
  }

  // Standard OAuth 2.0 response has access_token at top level.
  // Some providers (e.g. Slack) nest user tokens under authed_user.access_token.
  const accessToken = json.access_token || json.authed_user?.access_token;
  if (!accessToken) {
    throw new Error(
      `Token exchange succeeded but no access_token found in response. Keys: ${Object.keys(json).join(', ')}`
    );
  }

  return {
    access_token: accessToken,
    token_type: json.token_type || json.authed_user?.token_type || 'bearer',
    expires_in:
      json.expires_in != null
        ? Number.isFinite(Number(json.expires_in))
          ? Number(json.expires_in)
          : undefined
        : undefined,
    refresh_token: json.refresh_token,
    scope: json.scope || json.authed_user?.scope,
  } as OAuthTokenResponse;
}

/**
 * Perform MCP OAuth 2.1 Authorization Code flow with PKCE.
 *
 * ⚠️  CLI-ONLY — DO NOT CALL FROM THE DAEMON.
 *
 * This helper spins up a local HTTP listener on `127.0.0.1:<random>` and uses
 * that as the OAuth `redirect_uri`. That works for the local CLI (where the
 * user's browser and the listener share `localhost`) but BREAKS for any
 * deployed daemon: the upstream OAuth provider (Notion, Linear, etc.) sends
 * the redirect to the END USER'S BROWSER, which generally cannot reach the
 * daemon's `127.0.0.1`. Symptom: per-user "Notion login redirected me to
 * localhost" bug for any user not running on the daemon host.
 *
 * Daemon-side OAuth MUST go through the two-phase flow instead:
 *   1. `startMCPOAuthFlow(...)` with a public `redirect_uri` pointing at
 *      `<daemon base_url>/mcp-servers/oauth-callback`.
 *   2. The browser completes the redirect, the daemon's callback handler
 *      exchanges the code via `completeMCPOAuthFlow(...)`, and the result
 *      is broadcast back to the originating socket.
 *
 * See `apps/agor-daemon/src/register-services.ts > startTwoPhaseMCPOAuthFlow`.
 *
 * @param wwwAuthenticateHeader - The WWW-Authenticate header from 401 response
 * @param clientId - OAuth client ID (optional, generated if not provided)
 * @param browserOpener - Callback when browser is opened (for UI notification)
 * @returns Access token to use for authenticated requests
 */
export async function performMCPOAuthFlow(
  wwwAuthenticateHeader: string,
  clientId?: string,
  /**
   * Custom browser opener function. If provided, this is called instead of the default
   * system browser opener. This allows the caller to handle browser opening in a different
   * way (e.g., via WebSocket to open on client side when daemon runs remotely).
   *
   * The function should open the provided URL in a browser. It can be async.
   * Throwing an error will abort the OAuth flow.
   */
  browserOpener?: (url: string) => void | Promise<void>,
  /** Pre-discovered resource metadata URL (used when WWW-Authenticate lacks resource_metadata) */
  resourceMetadataUrl?: string
): Promise<OAuthTokenResponse> {
  console.log('[MCP OAuth] Starting OAuth 2.1 Authorization Code flow with PKCE');

  // Step 1: Parse WWW-Authenticate header, fall back to pre-discovered URL
  const metadataUrl = parseWWWAuthenticate(wwwAuthenticateHeader) || resourceMetadataUrl;
  if (!metadataUrl) {
    throw new Error(
      'Could not determine OAuth resource metadata URL. ' +
        'The WWW-Authenticate header does not contain resource_metadata, ' +
        'and no pre-discovered metadata URL was provided.'
    );
  }

  console.log('[MCP OAuth] Resource metadata URL:', metadataUrl);

  // Check cache first
  const cached = authCodeTokenCache.get(metadataUrl);
  if (cached && cached.expiresAt > Date.now()) {
    const ttlRemaining = Math.floor((cached.expiresAt - Date.now()) / 1000);
    console.log(`[MCP OAuth] Using cached token (valid for ${ttlRemaining}s)`);
    return { access_token: cached.token, token_type: 'bearer', expires_in: ttlRemaining };
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

    // Step 5.5: Get or register client_id
    let actualClientId = clientId;
    let clientSecret: string | undefined;

    // Compute scopes early — needed for both DCR registration and auth URL.
    // Skip auto-populating from resource metadata when client_id is pre-registered.
    const scopeString =
      !actualClientId &&
      resourceMetadata.scopes_supported &&
      resourceMetadata.scopes_supported.length > 0
        ? resourceMetadata.scopes_supported.join(' ')
        : undefined;

    if (!actualClientId) {
      // Check if server supports Dynamic Client Registration (RFC 7591)
      if (authServerMetadata.registration_endpoint) {
        console.log('[MCP OAuth] Server supports Dynamic Client Registration');
        const registration = await registerDynamicClient(
          authServerMetadata.registration_endpoint,
          callback.url,
          'Agor MCP Client',
          scopeString
        );
        actualClientId = registration.client_id;
        clientSecret = registration.client_secret;
      } else {
        // No DCR support and no client_id provided - check for well-known MCP registration endpoint
        // Some MCP servers use /register at the auth server URL
        const mcpRegisterEndpoint = `${authServerUrl}/register`;
        console.log('[MCP OAuth] Trying MCP-style registration endpoint:', mcpRegisterEndpoint);

        try {
          const registration = await registerDynamicClient(
            mcpRegisterEndpoint,
            callback.url,
            'Agor MCP Client',
            scopeString
          );
          actualClientId = registration.client_id;
          clientSecret = registration.client_secret;
        } catch (regError) {
          throw new Error(
            'OAuth client_id is required but the authorization server does not support ' +
              'Dynamic Client Registration.\n\n' +
              "Register an OAuth app in the provider's developer portal and enter " +
              'the Client ID (and Client Secret if required) in the MCP server configuration.\n\n' +
              `Server: ${authServerUrl}\n` +
              `Registration error: ${regError instanceof Error ? regError.message : String(regError)}`
          );
        }
      }
    }

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

    // Add scopes if available (same scopes used during DCR registration)
    if (scopeString) {
      authUrl.searchParams.set('scope', scopeString);
    }

    console.log('[MCP OAuth] Opening browser for user authentication...');
    console.log('[MCP OAuth] Authorization URL:', authUrl.toString());

    // Step 7: Open browser (use custom opener if provided, otherwise default)
    if (browserOpener) {
      console.log('[MCP OAuth] Using custom browser opener');
      await browserOpener(authUrl.toString());
    } else {
      await openBrowser(authUrl.toString());
    }

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
      actualClientId,
      clientSecret
    );

    console.log('[MCP OAuth] Access token received successfully');

    // Step 10: Cache token. Walk the shared cascade so this site agrees with
    // the persisted-token paths on TTL resolution.
    const fetchedAt = Date.now();
    const resolved = resolveTokenExpiry(tokenResponse, tokenResponse.access_token, fetchedAt);
    const expiresInSeconds =
      resolved.expiresAt !== null
        ? Math.max(1, Math.floor((resolved.expiresAt.getTime() - fetchedAt) / 1000))
        : UNKNOWN_EXPIRY_CACHE_TTL_SECONDS;
    const expiresAt = fetchedAt + (expiresInSeconds - EXPIRY_BUFFER_SECONDS) * 1000;

    authCodeTokenCache.set(metadataUrl, {
      token: tokenResponse.access_token,
      expiresAt,
      fetchedAt,
    });

    console.log(
      `[MCP OAuth] Token cached for ${expiresInSeconds}s (${EXPIRY_BUFFER_SECONDS}s buffer)`
    );

    return tokenResponse;
  } finally {
    // Always close callback server, even on error
    callback.server.close();
  }
}

/**
 * Check if HTTP response indicates OAuth is required.
 *
 * Returns true if the response is a 401 with either:
 * - A WWW-Authenticate header containing resource_metadata (RFC 9728 compliant)
 * - A WWW-Authenticate header containing Bearer (many OAuth servers omit resource_metadata)
 */
export function isOAuthRequired(status: number, headers: Headers): boolean {
  if (status !== 401) return false;
  const wwwAuth = headers.get('www-authenticate');
  if (!wwwAuth) return false;
  // Strict check: resource_metadata present (RFC 9728 compliant)
  if (wwwAuth.includes('resource_metadata=')) return true;
  // Permissive check: Bearer auth scheme at start of challenge (may need .well-known discovery).
  // Uses word boundary to avoid matching e.g. "X-Bearer-Custom" schemes.
  if (/^\s*Bearer\b/i.test(wwwAuth)) return true;
  return false;
}

/**
 * Get a cached OAuth 2.1 token for an MCP URL
 *
 * This checks all cached tokens and returns a valid one if the metadata URL
 * matches or contains the MCP URL's origin.
 *
 * @param mcpUrl - The MCP server URL to find a cached token for
 * @returns The cached token if valid, undefined otherwise
 */
export function getCachedOAuth21Token(mcpUrl: string): string | undefined {
  const now = Date.now();

  console.log('[OAuth 2.1 Cache] Looking for token for MCP URL:', mcpUrl);
  console.log('[OAuth 2.1 Cache] Cache size:', authCodeTokenCache.size);

  let mcpOrigin: string;
  try {
    mcpOrigin = new URL(mcpUrl).origin;
    console.log('[OAuth 2.1 Cache] MCP origin:', mcpOrigin);
  } catch (e) {
    console.log('[OAuth 2.1 Cache] Invalid MCP URL:', e);
    return undefined;
  }

  // Check all cached tokens for a match
  for (const [metadataUrl, cached] of authCodeTokenCache.entries()) {
    console.log('[OAuth 2.1 Cache] Checking cache entry:', metadataUrl);
    console.log('[OAuth 2.1 Cache] Token expires at:', new Date(cached.expiresAt).toISOString());
    console.log('[OAuth 2.1 Cache] Current time:', new Date(now).toISOString());

    // Check if token is still valid
    if (cached.expiresAt <= now) {
      console.log('[OAuth 2.1 Cache] Token expired, skipping');
      continue;
    }

    // Check if the metadata URL is from the same origin as the MCP URL
    try {
      const metadataOrigin = new URL(metadataUrl).origin;
      console.log('[OAuth 2.1 Cache] Metadata origin:', metadataOrigin);
      console.log('[OAuth 2.1 Cache] Origins match:', metadataOrigin === mcpOrigin);

      if (metadataOrigin === mcpOrigin || metadataUrl.includes(mcpOrigin)) {
        console.log('[OAuth 2.1 Cache] ✅ Found cached token for:', mcpOrigin);
        return cached.token;
      }
    } catch (e) {
      console.log('[OAuth 2.1 Cache] Invalid metadata URL:', e);
    }
  }

  console.log('[OAuth 2.1 Cache] ❌ No matching token found');
  return undefined;
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
    // Also clear the DCR client cache on blanket clears (disconnect flow).
    // Stale DCR registrations cause "client_id not found" errors on re-auth
    // when the provider has evicted the registration (e.g. Birdsai).
    // Only on the blanket path — per-key callers clearing a single authCode
    // entry should not nuke unrelated DCR registrations.
    dynamicClientCache.clear();
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

// ============================================================================
// TWO-PHASE OAUTH FLOW
// Used when the daemon runs remotely and the callback server can't receive
// the OAuth redirect. The flow is split into:
// 1. startMCPOAuthFlow - Returns auth URL and context for browser
// 2. completeMCPOAuthFlow - Exchanges code for token using saved context
// ============================================================================

/**
 * Context needed to complete OAuth flow after user authentication
 * This is returned by startMCPOAuthFlow and consumed by completeMCPOAuthFlow
 */
export interface OAuthFlowContext {
  metadataUrl: string;
  tokenEndpoint: string;
  redirectUri: string;
  pkceVerifier: string;
  clientId: string;
  clientSecret?: string;
  state: string;
  authorizationUrl: string;
}

/**
 * Start the OAuth 2.1 Authorization Code flow with PKCE
 *
 * This is the first phase of a two-phase OAuth flow for remote daemon scenarios.
 * Returns the authorization URL to open in browser and context needed to complete
 * the flow later.
 *
 * @param wwwAuthenticateHeader - The WWW-Authenticate header from 401 response
 * @param clientId - OAuth client ID (optional, will use DCR if not provided)
 * @param redirectUri - Custom redirect URI (optional, defaults to a placeholder)
 * @param options - Additional options
 * @param options.authorizationUrlOverride - Override the auto-discovered authorization endpoint URL
 * @param options.tokenUrlOverride - Override the auto-discovered token endpoint URL
 * @returns Authorization URL and flow context
 */
/**
 * Build the OAuth authorization URL + cache context once we already have AS
 * metadata. Shared by both the RFC 9728 path (after fetching resource +
 * AS metadata) and the AS-direct path (Reo.Dev-style discovery, where the
 * caller hands us prefetched AS metadata).
 *
 * Inputs:
 *   - `authServerMetadata`: required when no full URL overrides are supplied
 *   - `cacheKey`: token cache key (must share origin with the MCP URL so
 *     `getCachedOAuth21Token` can find it on later requests)
 */
async function startMCPOAuthFlowWithAS(opts: {
  authServerMetadata: AuthorizationServerMetadata | null;
  cacheKey: string;
  clientId?: string;
  redirectUri?: string;
  authorizationUrlOverride?: string;
  tokenUrlOverride?: string;
  clientSecret?: string;
  scope?: string;
  /** Optional fallback registration endpoint (e.g. `${authServerUrl}/register`) */
  fallbackRegistrationEndpoint?: string;
  /** Scopes advertised by the resource server (RFC 9728 path only) */
  resourceScopesSupported?: string[];
}): Promise<OAuthFlowContext> {
  const {
    authServerMetadata,
    cacheKey,
    clientId,
    redirectUri,
    authorizationUrlOverride,
    tokenUrlOverride,
    fallbackRegistrationEndpoint,
    resourceScopesSupported,
  } = opts;

  const hasFullOverrides = !!(authorizationUrlOverride && tokenUrlOverride);

  // PKCE
  const pkce = generatePKCE();

  // Redirect URI default — preserved for legacy CLI callers
  const actualRedirectUri = redirectUri || 'http://127.0.0.1:0/oauth/callback';

  // Scope: explicit option > resource-metadata advertised scopes > none
  // (Skip auto-populating when client_id is pre-registered — see comment in
  // the RFC 9728 path for the rationale.)
  const scopeString = opts.scope
    ? opts.scope
    : !clientId && resourceScopesSupported && resourceScopesSupported.length > 0
      ? resourceScopesSupported.join(' ')
      : undefined;

  // Client ID resolution (DCR if available)
  let actualClientId = clientId;
  let resolvedClientSecret = opts.clientSecret;

  if (!actualClientId) {
    const registrationEndpoint =
      authServerMetadata?.registration_endpoint || fallbackRegistrationEndpoint;
    if (registrationEndpoint) {
      console.log('[MCP OAuth] Using DCR endpoint:', registrationEndpoint);
      try {
        const registration = await registerDynamicClient(
          registrationEndpoint,
          actualRedirectUri,
          'Agor MCP Client',
          scopeString
        );
        actualClientId = registration.client_id;
        resolvedClientSecret = registration.client_secret;
      } catch (regError) {
        const detail = regError instanceof Error ? regError.message : String(regError);
        throw new Error(
          'Dynamic Client Registration failed.\n\n' +
            `Registration endpoint: ${registrationEndpoint}\n` +
            `Error: ${detail}\n\n` +
            "Register an OAuth app in the provider's developer portal and enter " +
            'the Client ID (and Client Secret if required) in the MCP server configuration.'
        );
      }
    } else if (hasFullOverrides) {
      throw new Error(
        'OAuth client_id is required when using manual OAuth URL overrides.\n\n' +
          'Please provide a client_id in the MCP server configuration.'
      );
    } else {
      throw new Error(
        'OAuth client_id is required but the authorization server does not advertise ' +
          'a Dynamic Client Registration endpoint (RFC 7591).\n\n' +
          "Register an OAuth app in the provider's developer portal and enter " +
          'the Client ID (and Client Secret if required) in the MCP server configuration.'
      );
    }
  }

  // CSRF state
  const state = crypto.randomUUID();

  // Resolve token + auth endpoints
  const tokenEndpoint = tokenUrlOverride || authServerMetadata?.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error(
      'No token endpoint available. Either provide oauth_token_url in the MCP server config, ' +
        'or ensure the authorization server supports RFC 8414 metadata discovery.'
    );
  }
  const authorizationEndpoint =
    authorizationUrlOverride || authServerMetadata?.authorization_endpoint;
  if (!authorizationEndpoint) {
    throw new Error(
      'No authorization endpoint available. Either provide oauth_authorization_url in the MCP server config, ' +
        'or ensure the authorization server supports RFC 8414 metadata discovery.'
    );
  }
  console.log('[MCP OAuth] Using authorization endpoint:', authorizationEndpoint);
  console.log('[MCP OAuth] Using token endpoint:', tokenEndpoint);

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', actualClientId!);
  authUrl.searchParams.set('redirect_uri', actualRedirectUri);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  if (scopeString) {
    authUrl.searchParams.set('scope', scopeString);
  }

  console.log('[MCP OAuth] Authorization URL:', authUrl.toString());

  return {
    metadataUrl: cacheKey,
    tokenEndpoint,
    redirectUri: actualRedirectUri,
    pkceVerifier: pkce.verifier,
    clientId: actualClientId!,
    clientSecret: resolvedClientSecret,
    state,
    authorizationUrl: authUrl.toString(),
  };
}

export async function startMCPOAuthFlow(
  wwwAuthenticateHeader: string,
  clientId?: string,
  redirectUri?: string,
  options?: {
    authorizationUrlOverride?: string;
    tokenUrlOverride?: string;
    clientSecret?: string;
    scope?: string;
    /** Pre-discovered resource metadata URL (used when WWW-Authenticate lacks resource_metadata) */
    resourceMetadataUrl?: string;
    /**
     * Pre-discovered Authorization Server metadata. Used when the MCP server
     * doesn't implement RFC 9728 but does serve RFC 8414 / OIDC metadata
     * directly at its own origin (e.g. Reo.Dev). When provided, both
     * `fetchResourceMetadata` and `fetchAuthorizationServerMetadata` are
     * skipped — `prefetchedAuthServerMetadata` is used as-is.
     *
     * The `cacheKey` option (or the MCP URL via the caller's redirect plumbing)
     * is used as the token cache key in place of an RFC 9728 metadata URL.
     */
    prefetchedAuthServerMetadata?: AuthorizationServerMetadata;
    /**
     * Token cache key. When `prefetchedAuthServerMetadata` is provided there's
     * no real RFC 9728 metadata URL to use as the key, so the caller passes a
     * stable string (typically the MCP URL itself). `getCachedOAuth21Token`
     * matches by URL origin, so any value sharing the MCP URL's origin works.
     */
    cacheKey?: string;
  }
): Promise<OAuthFlowContext> {
  console.log('[MCP OAuth] Starting two-phase OAuth 2.1 flow');

  // When AS metadata is prefetched (Reo.Dev-style discovery), there's no RFC
  // 9728 resource metadata to fetch. Take the short path and skip directly to
  // PKCE / DCR / auth-URL construction.
  if (options?.prefetchedAuthServerMetadata) {
    if (!options.cacheKey) {
      // Without a cache key, `getCachedOAuth21Token` can't find the token on
      // future requests — every MCP call would re-trigger the browser flow.
      // The daemon callsites have the MCP URL handy and should pass it.
      throw new Error(
        'startMCPOAuthFlow: cacheKey is required when prefetchedAuthServerMetadata is provided ' +
          '(typically pass the MCP server URL).'
      );
    }
    console.log(
      '[MCP OAuth] Using prefetched AS metadata (RFC 9728 skipped):',
      options.prefetchedAuthServerMetadata
    );
    return startMCPOAuthFlowWithAS({
      authServerMetadata: options.prefetchedAuthServerMetadata,
      cacheKey: options.cacheKey,
      clientId,
      redirectUri,
      authorizationUrlOverride: options.authorizationUrlOverride,
      tokenUrlOverride: options.tokenUrlOverride,
      clientSecret: options.clientSecret,
      scope: options.scope,
    });
  }

  // Step 1: Parse WWW-Authenticate header, fall back to pre-discovered URL
  const metadataUrl = parseWWWAuthenticate(wwwAuthenticateHeader) || options?.resourceMetadataUrl;
  if (!metadataUrl) {
    throw new Error(
      'Could not determine OAuth resource metadata URL. ' +
        'The WWW-Authenticate header does not contain resource_metadata, ' +
        'and no pre-discovered metadata URL was provided.'
    );
  }
  console.log('[MCP OAuth] Resource metadata URL:', metadataUrl);

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
  // Skip auto-discovery when both authorization URL and token URL overrides are provided.
  // Many OAuth providers (e.g. custom internal services) don't implement RFC 8414
  // (.well-known/oauth-authorization-server) or OIDC discovery.
  const hasFullOverrides = options?.authorizationUrlOverride && options?.tokenUrlOverride;
  let authServerMetadata: AuthorizationServerMetadata | null = null;

  if (hasFullOverrides) {
    console.log('[MCP OAuth] Skipping auth server metadata fetch — manual overrides provided:', {
      authorization: options.authorizationUrlOverride,
      token: options.tokenUrlOverride,
    });
  } else {
    try {
      authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl);
      console.log('[MCP OAuth] Authorization server metadata:', authServerMetadata);
    } catch (metadataError) {
      // If we have at least partial overrides, we can continue without metadata
      if (options?.authorizationUrlOverride || options?.tokenUrlOverride) {
        console.log(
          '[MCP OAuth] Auth server metadata fetch failed, but partial overrides available:',
          metadataError instanceof Error ? metadataError.message : String(metadataError)
        );
      } else {
        throw metadataError;
      }
    }
  }

  // Steps 4-7: Delegate PKCE / DCR / endpoint resolution / auth URL build to
  // the shared helper. The legacy MCP-style fallback (`${authServerUrl}/register`)
  // is preserved here via `fallbackRegistrationEndpoint` so RFC 9728 servers
  // that omit a registration_endpoint in their AS metadata still get probed.
  return startMCPOAuthFlowWithAS({
    authServerMetadata,
    cacheKey: metadataUrl,
    clientId,
    redirectUri,
    authorizationUrlOverride: options?.authorizationUrlOverride,
    tokenUrlOverride: options?.tokenUrlOverride,
    clientSecret: options?.clientSecret,
    scope: options?.scope,
    fallbackRegistrationEndpoint: hasFullOverrides ? undefined : `${authServerUrl}/register`,
    resourceScopesSupported: resourceMetadata.scopes_supported,
  });
}

/**
 * Complete the OAuth 2.1 flow with authorization code
 *
 * This is the second phase of a two-phase OAuth flow for remote daemon scenarios.
 * Takes the authorization code (from the callback URL) and exchanges it for a token.
 *
 * @param context - Flow context from startMCPOAuthFlow
 * @param code - Authorization code from OAuth callback
 * @param state - State from OAuth callback (for CSRF verification)
 * @returns Access token
 */
export async function completeMCPOAuthFlow(
  context: OAuthFlowContext,
  code: string,
  state: string
): Promise<OAuthTokenResponse> {
  console.log('[MCP OAuth] Completing OAuth flow with authorization code');
  console.log('[MCP OAuth] Token endpoint:', context.tokenEndpoint);
  console.log('[MCP OAuth] Redirect URI:', context.redirectUri);
  console.log('[MCP OAuth] Client ID:', context.clientId);
  console.log('[MCP OAuth] Has client secret:', !!context.clientSecret);

  // Verify state to prevent CSRF
  if (state !== context.state) {
    throw new Error('State mismatch - possible CSRF attack');
  }

  // Exchange code for token
  const tokenResponse = await exchangeCodeForToken(
    context.tokenEndpoint,
    code,
    context.redirectUri,
    context.pkceVerifier,
    context.clientId,
    context.clientSecret
  );

  console.log('[MCP OAuth] Access token received successfully');

  // Cache token. Walk the shared cascade so this site agrees with the
  // persisted-token paths on TTL resolution.
  const fetchedAt = Date.now();
  const resolved = resolveTokenExpiry(tokenResponse, tokenResponse.access_token, fetchedAt);
  const expiresInSeconds =
    resolved.expiresAt !== null
      ? Math.max(1, Math.floor((resolved.expiresAt.getTime() - fetchedAt) / 1000))
      : UNKNOWN_EXPIRY_CACHE_TTL_SECONDS;
  const expiresAt = fetchedAt + (expiresInSeconds - EXPIRY_BUFFER_SECONDS) * 1000;

  authCodeTokenCache.set(context.metadataUrl, {
    token: tokenResponse.access_token,
    expiresAt,
    fetchedAt,
  });

  console.log(
    `[MCP OAuth] Token cached for ${expiresInSeconds}s (${EXPIRY_BUFFER_SECONDS}s buffer)`
  );

  return tokenResponse;
}

/**
 * Parse OAuth callback URL to extract code and state
 *
 * @param callbackUrl - The full callback URL from the browser (may include error page URL)
 * @returns Object with code and state, or throws if invalid
 */
export function parseOAuthCallback(callbackUrl: string): { code: string; state: string } {
  try {
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code) {
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      if (error) {
        throw new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`);
      }
      throw new Error('No authorization code in callback URL');
    }

    if (!state) {
      throw new Error('No state parameter in callback URL');
    }

    return { code, state };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('OAuth error:')) {
      throw e;
    }
    throw new Error(`Invalid callback URL: ${callbackUrl}`);
  }
}
