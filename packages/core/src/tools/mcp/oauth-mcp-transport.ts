/**
 * MCP OAuth 2.1 Transport Wrapper
 *
 * Implements RFC 9728 (OAuth 2.0 Protected Resource Metadata) for MCP servers
 * Handles 401 responses with WWW-Authenticate headers and performs OAuth 2.1
 * Authorization Code flow with PKCE.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { MCPOAuthDCRDiagnostic, MCPOAuthDCRMode } from '../../types/mcp.js';
import { assertSafeOAuthUrl, safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import type { OAuthTokenResponse } from './oauth-auth.js';
import { resolveTokenExpiry } from './oauth-token-expiry.js';

export interface OAuthMetadata {
  resource?: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

interface CachedAuthCodeToken {
  token: string;
  expiresAt: number;
  fetchedAt: number;
}

// Legacy standalone/CLI cache for Authorization Code flow tokens. This key is
// NOT a tenant/user/server namespace. Daemon paths therefore pass
// cacheToken:false and never consult this Map.
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

/**
 * Classified authorization-code exchange failure.
 *
 * `ambiguous=true` means the request may have reached the provider and the
 * single-use authorization code may already be consumed. Callers must not
 * replay it automatically.
 */
export class OAuthCodeExchangeError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    readonly failureCode: 'provider_rejected' | 'transport_ambiguous' | 'response_ambiguous'
  ) {
    super(message);
    this.name = 'OAuthCodeExchangeError';
  }
}

/**
 * Known authorization-response validation failure before token-endpoint I/O.
 * The provider code has not been submitted, so callers must persist `failed`,
 * never the non-replayable `ambiguous` exchange outcome.
 */
export class OAuthCallbackValidationError extends Error {
  readonly ambiguous = false;
  readonly afterProviderExchange = false;

  constructor(
    readonly failureCode:
      | 'callback_state_mismatch'
      | 'callback_issuer_missing'
      | 'callback_issuer_mismatch'
  ) {
    super(`OAuth callback validation failed (${failureCode})`);
    this.name = 'OAuthCallbackValidationError';
  }
}

/**
 * A safe, actionable Dynamic Client Registration failure.
 *
 * The diagnostic is intentionally structured so daemon/UI callers do not need
 * to parse provider response text. Only sanitized `error` fields are carried;
 * response bodies and registration credentials are never retained.
 */
export class OAuthDCRFailure extends Error {
  constructor(
    message: string,
    readonly diagnostic: MCPOAuthDCRDiagnostic
  ) {
    super(message);
    this.name = 'OAuthDCRFailure';
  }
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
  authorization_response_iss_parameter_supported?: boolean;
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
export async function discoverResourceMetadataUrl(
  mcpUrl: string,
  options: { allowLocalhostHttp?: boolean } = {}
): Promise<string | null> {
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
      const response = await safeOutboundFetch(candidate, {
        redirect: 'follow',
        timeoutMs: 10_000,
        allowLocalhostHttp: options.allowLocalhostHttp,
      });
      if (response.ok) {
        // Validate it looks like proper metadata
        const data = (await response.json()) as Record<string, unknown>;
        if (data.authorization_servers && Array.isArray(data.authorization_servers)) {
          console.log('[MCP OAuth] Resource metadata discovered');
          return candidate;
        }
      }
    } catch {
      console.log('[MCP OAuth] Resource metadata discovery candidate failed');
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
  mcpUrl: string,
  options: { allowLocalhostHttp?: boolean } = {}
): Promise<{ metadataUrl: string; source: 'header' | 'well-known' } | null> {
  // Strategy 1: Parse from WWW-Authenticate header
  if (wwwAuthenticateHeader) {
    const parsed = parseWWWAuthenticate(wwwAuthenticateHeader);
    if (parsed) {
      return { metadataUrl: parsed, source: 'header' };
    }
  }

  // Strategy 2: Auto-discover via .well-known endpoint
  const discovered = await discoverResourceMetadataUrl(mcpUrl, options);
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
  mcpUrl: string,
  options: { allowLocalhostHttp?: boolean } = {}
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
      const response = await safeOutboundFetch(candidate, {
        redirect: 'follow',
        timeoutMs: 10_000,
        allowLocalhostHttp: options.allowLocalhostHttp,
      });
      if (!response.ok) continue;
      const data = (await response.json()) as Partial<AuthorizationServerMetadata>;
      // Minimal validation: must have authorization_endpoint + token_endpoint
      if (
        typeof data.authorization_endpoint === 'string' &&
        typeof data.token_endpoint === 'string'
      ) {
        console.log('[MCP OAuth] Authorization-server metadata discovered');
        return {
          metadata: data as AuthorizationServerMetadata,
          discoveredAt: candidate,
        };
      }
    } catch {
      console.log('[MCP OAuth] Authorization-server discovery candidate failed');
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
  mcpUrl: string,
  options: { compatibilityMode?: 'strict' | 'legacy'; allowLocalhostHttp?: boolean } = {}
): Promise<MCPOAuthDiscoveryResult | null> {
  // Strategies 1 + 2: RFC 9728 (header hint, then well-known fallback)
  const rfc9728 = await resolveResourceMetadataUrl(wwwAuthenticateHeader, mcpUrl, options);
  if (rfc9728) {
    return { kind: 'resource-metadata', ...rfc9728 };
  }

  // Strategies 3 + 4: AS metadata directly at MCP origin (RFC 8414 / OIDC)
  if ((options.compatibilityMode ?? 'strict') !== 'legacy') return null;
  const asDirect = await discoverAuthorizationServerFromMcpOrigin(mcpUrl, options);
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
async function fetchResourceMetadata(
  metadataUrl: string,
  options: { allowLocalhostHttp?: boolean } = {}
): Promise<OAuthMetadata> {
  const response = await safeOutboundFetch(metadataUrl, {
    redirect: 'follow',
    timeoutMs: 15_000,
    allowLocalhostHttp: options.allowLocalhostHttp,
  });
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

const MAX_DCR_RESPONSE_BODY_CHARS = 16 * 1024;
const MAX_DCR_PROVIDER_DETAIL_CHARS = 280;

const SECRET_VALUE_PATTERN =
  /(["']?(?:client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|authorization[_ -]?code|code[_ -]?verifier|api[_ -]?key|password|secret|token)["']?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SECRET_QUERY_PARAMETER_PATTERN =
  /([?&](?:client_secret|access_token|refresh_token|code|code_verifier|api_key|password|secret|token)=)[^&\s]+/gi;

function sanitizeProviderDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;

  const sanitized = normalized
    .replace(SECRET_VALUE_PATTERN, '$1=[redacted]')
    .replace(SECRET_QUERY_PARAMETER_PATTERN, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]');

  return sanitized.length > MAX_DCR_PROVIDER_DETAIL_CHARS
    ? `${sanitized.slice(0, MAX_DCR_PROVIDER_DETAIL_CHARS - 1)}…`
    : sanitized;
}

async function readDcrResponseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    // `safeOutboundFetch` bounds the response in production. Slice again here
    // so test doubles and future transports cannot turn provider text into an
    // unbounded diagnostic.
    let body: string;
    if (typeof response.text === 'function') {
      body = (await response.text()).slice(0, MAX_DCR_RESPONSE_BODY_CHARS);
    } else {
      body = JSON.stringify(await response.json()).slice(0, MAX_DCR_RESPONSE_BODY_CHARS);
    }
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function registrationDiagnostic(
  httpStatus: number,
  providerResponse: Record<string, unknown> | null
): MCPOAuthDCRDiagnostic {
  const diagnostic: MCPOAuthDCRDiagnostic = {
    stage: 'dcr_registration',
    http_status: httpStatus,
  };
  const error = sanitizeProviderDetail(providerResponse?.error);
  const errorDescription = sanitizeProviderDetail(providerResponse?.error_description);
  if (error) diagnostic.error = error;
  if (errorDescription) diagnostic.error_description = errorDescription;
  return diagnostic;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Parse only the fields the OAuth flow understands from an untrusted body. */
function parseDynamicClientRegistrationResponse(
  body: Record<string, unknown>
): DynamicClientRegistrationResponse | null {
  if (typeof body.client_id !== 'string') return null;

  const result: DynamicClientRegistrationResponse = { client_id: body.client_id };
  const stringFields = ['client_secret', 'token_endpoint_auth_method', 'client_name'] as const;
  for (const field of stringFields) {
    const value = body[field];
    if (value !== undefined && typeof value !== 'string') return null;
    if (typeof value === 'string') result[field] = value;
  }

  const numberFields = ['client_id_issued_at', 'client_secret_expires_at'] as const;
  for (const field of numberFields) {
    const value = body[field];
    if (value !== undefined && typeof value !== 'number') return null;
    if (typeof value === 'number') result[field] = value;
  }

  const arrayFields = ['redirect_uris', 'grant_types', 'response_types'] as const;
  for (const field of arrayFields) {
    const value = body[field];
    if (value !== undefined && !isStringArray(value)) return null;
    if (isStringArray(value)) result[field] = value;
  }

  return result;
}

function diagnosticStatus(diagnostic: MCPOAuthDCRDiagnostic): string {
  return diagnostic.http_status === undefined ? '' : ` (HTTP ${diagnostic.http_status})`;
}

function diagnosticDetails(diagnostic: MCPOAuthDCRDiagnostic): string {
  const details = [diagnostic.error, diagnostic.error_description].filter(Boolean);
  return details.length > 0 ? ` Provider response: ${details.join(' — ')}.` : '';
}

function isRedirectUriRejection(diagnostic: MCPOAuthDCRDiagnostic): boolean {
  return (
    `${diagnostic.error ?? ''} ${diagnostic.error_description ?? ''}`.match(
      /redirect[ _-]?uri|redirect[ _-]?url|approved redirect/i
    ) !== null
  );
}

function dcrRecoveryGuidance(diagnostic: MCPOAuthDCRDiagnostic): string {
  const manualClient =
    'enter the Client ID and Client Secret for a pre-registered OAuth app in Advanced — OAuth settings, then retry.';

  if (isRedirectUriRejection(diagnostic)) {
    return `The provider rejected the configured OAuth redirect URI. Approve that callback URL in the provider application, or ${manualClient}`;
  }
  if (diagnostic.http_status === 404) {
    return `The advertised registration endpoint returned HTTP 404 and is unavailable or stale. Verify the provider OAuth metadata, or ${manualClient}`;
  }
  return `The provider rejected Dynamic Client Registration. Review its client-registration requirements, or ${manualClient}`;
}

function registrationFailure(
  diagnostic: MCPOAuthDCRDiagnostic,
  lead = 'Dynamic Client Registration failed'
): OAuthDCRFailure {
  const failureLead = lead.startsWith('Dynamic Client Registration failed')
    ? lead
    : `Dynamic Client Registration failed: ${lead}`;
  return new OAuthDCRFailure(
    `${failureLead}${diagnosticStatus(diagnostic)} at stage ${diagnostic.stage}.${diagnosticDetails(diagnostic)} ${dcrRecoveryGuidance(diagnostic)}`,
    diagnostic
  );
}

function missingRegistrationEndpointFailure(): OAuthDCRFailure {
  const diagnostic: MCPOAuthDCRDiagnostic = { stage: 'dcr_endpoint_discovery' };
  return new OAuthDCRFailure(
    'OAuth client_id is required because the authorization server does not advertise a Dynamic Client Registration endpoint (stage: dcr_endpoint_discovery). The provider may require a pre-registered OAuth app. Enter the Client ID and Client Secret in Advanced — OAuth settings, then retry.',
    diagnostic
  );
}

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
  scope?: string,
  reuseLocalCache = true,
  allowLocalhostHttp = false
): Promise<DynamicClientRegistrationResponse> {
  // Check cache first
  const cacheKey = registrationEndpoint;
  const cached = reuseLocalCache ? dynamicClientCache.get(cacheKey) : undefined;
  if (cached && cached.redirect_uri === redirectUri) {
    console.log('[MCP OAuth] Using cached dynamic client registration');
    return { client_id: cached.client_id, client_secret: cached.client_secret };
  }

  console.log('[MCP OAuth] Performing Dynamic Client Registration');

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
  }

  const response = await safeOutboundFetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(registrationRequest),
    redirect: 'error',
    timeoutMs: 15_000,
    maxResponseBytes: MAX_DCR_RESPONSE_BODY_CHARS,
    allowLocalhostHttp,
  });

  if (!response.ok) {
    throw registrationFailure(
      registrationDiagnostic(response.status, await readDcrResponseJson(response))
    );
  }

  const responseBody = await readDcrResponseJson(response);
  if (!responseBody) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration returned an invalid response'
    );
  }
  const result = parseDynamicClientRegistrationResponse(responseBody);

  if (!result) {
    const invalidClientId = responseBody.client_id;
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      typeof invalidClientId !== 'string' || !invalidClientId.trim()
        ? 'Dynamic Client Registration returned an invalid client ID'
        : 'Dynamic Client Registration returned an invalid response'
    );
  }

  if (typeof result.client_id !== 'string' || !result.client_id.trim()) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration returned an invalid client ID'
    );
  }
  if (!result.redirect_uris?.includes(redirectUri)) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration did not bind the required redirect URI'
    );
  }
  const authMethod = result.token_endpoint_auth_method ?? 'none';
  if (!['none', 'client_secret_basic'].includes(authMethod)) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration returned an unsupported token auth method'
    );
  }
  if (authMethod === 'client_secret_basic' && !result.client_secret) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration omitted the required client secret'
    );
  }
  if (authMethod === 'none' && result.client_secret) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration returned incompatible public-client credentials'
    );
  }
  if (result.grant_types && !result.grant_types.includes('authorization_code')) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration did not enable the authorization-code grant'
    );
  }
  if (result.response_types && !result.response_types.includes('code')) {
    throw registrationFailure(
      { stage: 'dcr_registration', http_status: response.status },
      'Dynamic Client Registration did not enable the code response type'
    );
  }

  if (reuseLocalCache) {
    dynamicClientCache.set(cacheKey, {
      client_id: result.client_id,
      client_secret: result.client_secret,
      redirect_uri: redirectUri,
    });
  }

  console.log('[MCP OAuth] Dynamic client registered');

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
  authServerUrl: string,
  options: { compatibilityMode?: 'strict' | 'legacy'; allowLocalhostHttp?: boolean } = {}
): Promise<AuthorizationServerMetadata> {
  const cleanUrl = authServerUrl.replace(/\/$/, '');
  const urlsToTry: { url: string; label: string }[] = [];

  // 1. RFC 8414 path-aware discovery (correct per spec)
  const rfc8414Url = buildWellKnownUrl(cleanUrl, 'oauth-authorization-server');
  urlsToTry.push({ url: rfc8414Url, label: 'RFC 8414 (path-aware)' });

  const legacy = options.compatibilityMode === 'legacy';
  // Narrow opt-in legacy probes for non-compliant issuers.
  const naiveUrl = `${cleanUrl}/.well-known/oauth-authorization-server`;
  if (legacy && naiveUrl !== rfc8414Url) {
    urlsToTry.push({ url: naiveUrl, label: 'RFC 8414 (naive append)' });
  }

  // 3. OIDC discovery — path-aware
  const oidcUrl = buildWellKnownUrl(cleanUrl, 'openid-configuration');
  if (legacy) urlsToTry.push({ url: oidcUrl, label: 'OIDC (path-aware)' });

  // 4. OIDC discovery — naive append
  const naiveOidcUrl = `${cleanUrl}/.well-known/openid-configuration`;
  if (legacy && naiveOidcUrl !== oidcUrl) {
    urlsToTry.push({ url: naiveOidcUrl, label: 'OIDC (naive append)' });
  }

  const errors: string[] = [];
  for (const { url, label } of urlsToTry) {
    try {
      const response = await safeOutboundFetch(url, {
        redirect: 'follow',
        timeoutMs: 15_000,
        allowLocalhostHttp: options.allowLocalhostHttp,
      });
      if (response.ok) {
        console.log(`[MCP OAuth] ✓ Fetched metadata via ${label}`);
        const metadata = (await response.json()) as AuthorizationServerMetadata;
        if (!legacy && metadata.issuer !== authServerUrl) {
          throw new Error(
            'Authorization server metadata issuer does not match the advertised issuer'
          );
        }
        return metadata;
      }
      errors.push(`${label}: HTTP ${response.status}`);
    } catch {
      errors.push(`${label}: request failed`);
    }
  }

  throw new Error(
    'Failed to fetch authorization server metadata.\n' +
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
  clientSecret?: string,
  resourceUri?: string,
  allowLocalhostHttp = false
): Promise<OAuthTokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (resourceUri) body.resource = resourceUri;

  // Build headers — use HTTP Basic auth when client_secret is available (RFC 6749 §2.3.1),
  // fall back to body params for public clients or providers that don't support Basic auth.
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    // GitHub's classic OAuth endpoint returns a form-encoded response by
    // default. Request JSON explicitly so the response follows the OAuth token
    // response shape parsed below.
    Accept: 'application/json',
  };

  if (clientSecret) {
    // Slack and other providers recommend HTTP Basic auth for credentials
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    // Public client — send client_id in body
    body.client_id = clientId;
  }

  console.log('[MCP OAuth] Starting authorization-code exchange');

  let response: Response;
  try {
    response = await safeOutboundFetch(tokenEndpoint, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
      redirect: 'error',
      timeoutMs: 15_000,
      allowLocalhostHttp,
    });
  } catch {
    throw new OAuthCodeExchangeError(
      'The provider exchange outcome is unknown. Start a new OAuth flow.',
      true,
      'transport_ambiguous'
    );
  }

  console.log('[MCP OAuth] Token exchange response status:', response.status);

  if (!response.ok) {
    // Do not log or reflect the provider body: OAuth error responses are not
    // guaranteed secret-free. Only a well-formed OAuth token error on the
    // protocol's 400/401 statuses proves that the provider rejected this
    // request. A bare 4xx (including timeout/rate-limit/proxy responses) may
    // still arrive after the authorization code was consumed.
    let explicitOAuthError = false;
    if (response.status === 400 || response.status === 401) {
      try {
        const errorResponse = (await response.json()) as { error?: unknown };
        explicitOAuthError =
          typeof errorResponse.error === 'string' && /^[A-Za-z0-9._~-]+$/.test(errorResponse.error);
      } catch {
        // An unusable error response cannot prove the provider's code state.
      }
    }
    const ambiguous = !explicitOAuthError;
    throw new OAuthCodeExchangeError(
      ambiguous
        ? 'The provider exchange outcome is unknown. Start a new OAuth flow.'
        : 'The provider rejected the authorization code. Start a new OAuth flow.',
      ambiguous,
      ambiguous ? 'transport_ambiguous' : 'provider_rejected'
    );
  }

  let json: OAuthRawTokenResponse;
  try {
    json = (await response.json()) as OAuthRawTokenResponse;
  } catch {
    throw new OAuthCodeExchangeError(
      'The provider exchange response was unusable. Start a new OAuth flow.',
      true,
      'response_ambiguous'
    );
  }
  console.log('[MCP OAuth] Token exchange response parsed');

  // Some providers (e.g. Slack) return HTTP 200 with {"ok": false, "error": "..."} on failure
  if (json.ok === false && json.error) {
    throw new OAuthCodeExchangeError(
      'The provider rejected the authorization code. Start a new OAuth flow.',
      false,
      'provider_rejected'
    );
  }

  // Standard OAuth 2.0 response has access_token at top level.
  // Some providers (e.g. Slack) nest user tokens under authed_user.access_token.
  const accessToken = json.access_token || json.authed_user?.access_token;
  if (!accessToken) {
    throw new OAuthCodeExchangeError(
      'The provider exchange response was unusable. Start a new OAuth flow.',
      true,
      'response_ambiguous'
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
  const resourceMetadata = await fetchResourceMetadata(metadataUrl, { allowLocalhostHttp: true });
  console.log('[MCP OAuth] Resource metadata resolved');

  if (
    !resourceMetadata.authorization_servers ||
    resourceMetadata.authorization_servers.length === 0
  ) {
    throw new Error('No authorization servers found in resource metadata');
  }

  // Use first authorization server
  const authServerUrl = resourceMetadata.authorization_servers[0];
  // Step 3: Fetch Authorization Server Metadata (RFC 8414)
  const authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl, {
    allowLocalhostHttp: true,
  });
  console.log('[MCP OAuth] Authorization server metadata resolved');

  // Step 4: Start local callback server
  const callback = await startCallbackServer();
  console.log('[MCP OAuth] Local callback server ready');

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
          scopeString,
          true,
          true
        );
        actualClientId = registration.client_id;
        clientSecret = registration.client_secret;
      } else {
        throw new Error(
          'OAuth client_id is required but the authorization server does not advertise ' +
            'a Dynamic Client Registration endpoint (RFC 7591).\n\n' +
            "Register an OAuth app in the provider's developer portal and enter " +
            'the Client ID (and Client Secret if required) in the MCP server configuration.'
        );
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
      clientSecret,
      resourceMetadata.resource,
      true
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

  let mcpOrigin: string;
  try {
    mcpOrigin = new URL(mcpUrl).origin;
  } catch {
    return undefined;
  }

  // Check all cached tokens for a match
  for (const [metadataUrl, cached] of authCodeTokenCache.entries()) {
    // Check if token is still valid
    if (cached.expiresAt <= now) {
      continue;
    }

    // Check if the metadata URL is from the same origin as the MCP URL
    try {
      const metadataOrigin = new URL(metadataUrl).origin;

      if (metadataOrigin === mcpOrigin || metadataUrl.includes(mcpOrigin)) {
        return cached.token;
      }
    } catch {}
  }

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
  resourceUri: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  pkceVerifier: string;
  clientId: string;
  clientSecret?: string;
  state: string;
  authorizationUrl: string;
  compatibilityMode: 'strict' | 'legacy';
  /** Narrow standalone-development exception; durable daemon flows leave this false. */
  allowLocalhostHttp: boolean;
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
  /** Daemons disable the process-global DCR cache; legacy local CLI flows may reuse it. */
  reuseDynamicClientRegistration?: boolean;
  resourceUri: string;
  issuer: string;
  compatibilityMode: 'strict' | 'legacy';
  dcrMode: MCPOAuthDCRMode;
  allowLocalhostHttp: boolean;
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
    resourceUri,
    issuer,
    compatibilityMode,
    dcrMode,
    allowLocalhostHttp,
  } = opts;

  const hasFullOverrides = !!(authorizationUrlOverride && tokenUrlOverride);

  // PKCE
  const pkce = generatePKCE();

  // Redirect URI default — preserved for legacy CLI callers
  const actualRedirectUri = redirectUri || 'http://127.0.0.1:0/oauth/callback';
  // Validate before registration: DCR sends this value to an external service
  // and must not turn an unsafe configured callback into durable provider-side
  // client metadata.
  assertSafeOAuthUrl(actualRedirectUri, { allowLocalhostHttp });

  // Scope: explicit option > resource-metadata advertised scopes > none
  // (Skip auto-populating when client_id is pre-registered — see comment in
  // the RFC 9728 path for the rationale.)
  const scopeString = opts.scope
    ? opts.scope
    : !clientId && resourceScopesSupported && resourceScopesSupported.length > 0
      ? resourceScopesSupported.join(' ')
      : undefined;

  // Validate the authorization contract before DCR creates durable state at
  // the provider. A strict-profile rejection must not leave an unused client
  // registration behind.
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
  console.log('[MCP OAuth] OAuth endpoints resolved');

  assertSafeOAuthUrl(tokenEndpoint, { allowLocalhostHttp });
  assertSafeOAuthUrl(authorizationEndpoint, { allowLocalhostHttp });
  if (compatibilityMode === 'strict') {
    if (!authServerMetadata) {
      throw new Error('Strict MCP OAuth requires authorization-server metadata');
    }
    if (authServerMetadata.issuer !== issuer) {
      throw new Error('Authorization server issuer mismatch');
    }
    if (!authServerMetadata.code_challenge_methods_supported?.includes('S256')) {
      throw new Error('Authorization server does not advertise required PKCE S256 support');
    }
    if (authServerMetadata.authorization_response_iss_parameter_supported !== true) {
      throw new Error(
        'Authorization server does not advertise the required callback issuer parameter'
      );
    }
    if (
      authorizationUrlOverride &&
      authorizationUrlOverride !== authServerMetadata.authorization_endpoint
    ) {
      throw new Error('Strict MCP OAuth authorization endpoint override does not match metadata');
    }
    if (tokenUrlOverride && tokenUrlOverride !== authServerMetadata.token_endpoint) {
      throw new Error('Strict MCP OAuth token endpoint override does not match metadata');
    }
  }

  // Client ID resolution (DCR if available)
  let actualClientId = clientId;
  let resolvedClientSecret = opts.clientSecret;

  if (!actualClientId && dcrMode !== 'disabled') {
    const registrationEndpoint =
      authServerMetadata?.registration_endpoint ||
      (dcrMode === 'fallback' ? fallbackRegistrationEndpoint : undefined);
    if (registrationEndpoint) {
      console.log('[MCP OAuth] Using Dynamic Client Registration');
      try {
        const registration = await registerDynamicClient(
          registrationEndpoint,
          actualRedirectUri,
          'Agor MCP Client',
          scopeString,
          opts.reuseDynamicClientRegistration !== false,
          allowLocalhostHttp
        );
        actualClientId = registration.client_id;
        resolvedClientSecret = registration.client_secret;
      } catch (error) {
        if (error instanceof OAuthDCRFailure) throw error;
        throw registrationFailure({ stage: 'dcr_registration' });
      }
    } else if (hasFullOverrides) {
      throw new Error(
        'OAuth client_id is required when using manual OAuth URL overrides.\n\n' +
          'Please provide a client_id in the MCP server configuration.'
      );
    } else {
      throw missingRegistrationEndpointFailure();
    }
  } else if (!actualClientId) {
    throw new Error(
      'OAuth client_id is required because Dynamic Client Registration is disabled for this server.'
    );
  }

  // CSRF state
  const state = crypto.randomUUID();

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', actualClientId!);
  authUrl.searchParams.set('redirect_uri', actualRedirectUri);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', resourceUri);
  if (scopeString) {
    authUrl.searchParams.set('scope', scopeString);
  }

  return {
    metadataUrl: cacheKey,
    resourceUri,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    redirectUri: actualRedirectUri,
    pkceVerifier: pkce.verifier,
    clientId: actualClientId!,
    clientSecret: resolvedClientSecret,
    state,
    authorizationUrl: authUrl.toString(),
    compatibilityMode,
    allowLocalhostHttp,
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
    /** Disable process-global DCR credential reuse in multi-user daemons. */
    reuseDynamicClientRegistration?: boolean;
    /** Exact protected resource identifier sent to authorization/token endpoints. */
    resourceUri?: string;
    compatibilityMode?: 'strict' | 'legacy';
    dcrMode?: MCPOAuthDCRMode;
    /** Exact loopback HTTP exception for standalone development only. */
    allowLocalhostHttp?: boolean;
  }
): Promise<OAuthFlowContext> {
  console.log('[MCP OAuth] Starting two-phase OAuth 2.1 flow');
  const compatibilityMode = options?.compatibilityMode ?? 'strict';
  const dcrMode = options?.dcrMode ?? 'advertised';
  const allowLocalhostHttp = options?.allowLocalhostHttp === true;
  const resourceUri = options?.resourceUri;
  if (!resourceUri) throw new Error('MCP OAuth requires an exact protected resource URI');
  assertSafeOAuthUrl(resourceUri, { allowLocalhostHttp });

  // When AS metadata is prefetched (Reo.Dev-style discovery), there's no RFC
  // 9728 resource metadata to fetch. Take the short path and skip directly to
  // PKCE / DCR / auth-URL construction.
  if (options?.prefetchedAuthServerMetadata) {
    if (compatibilityMode !== 'legacy') {
      throw new Error('Authorization-server-direct discovery requires explicit legacy mode');
    }
    if (!options.cacheKey) {
      // Without a cache key, `getCachedOAuth21Token` can't find the token on
      // future requests — every MCP call would re-trigger the browser flow.
      // The daemon callsites have the MCP URL handy and should pass it.
      throw new Error(
        'startMCPOAuthFlow: cacheKey is required when prefetchedAuthServerMetadata is provided ' +
          '(typically pass the MCP server URL).'
      );
    }
    console.log('[MCP OAuth] Using prefetched AS metadata (RFC 9728 skipped)');
    return startMCPOAuthFlowWithAS({
      authServerMetadata: options.prefetchedAuthServerMetadata,
      cacheKey: options.cacheKey,
      clientId,
      redirectUri,
      authorizationUrlOverride: options.authorizationUrlOverride,
      tokenUrlOverride: options.tokenUrlOverride,
      clientSecret: options.clientSecret,
      scope: options.scope,
      reuseDynamicClientRegistration: options.reuseDynamicClientRegistration,
      resourceUri,
      issuer: options.prefetchedAuthServerMetadata.issuer,
      compatibilityMode,
      dcrMode,
      allowLocalhostHttp,
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
  console.log('[MCP OAuth] Resource metadata resolved');

  // Step 2: Fetch Protected Resource Metadata (RFC 9728)
  const resourceMetadata = await fetchResourceMetadata(metadataUrl, { allowLocalhostHttp });

  if (compatibilityMode === 'strict' && resourceMetadata.resource !== resourceUri) {
    throw new Error('Protected resource metadata does not match the MCP resource URI');
  }

  if (
    !resourceMetadata.authorization_servers ||
    resourceMetadata.authorization_servers.length === 0
  ) {
    throw new Error('No authorization servers found in resource metadata');
  }

  // Use first authorization server
  const authServerUrl = resourceMetadata.authorization_servers[0];
  console.log('[MCP OAuth] Authorization server resolved');

  // Step 3: Fetch Authorization Server Metadata (RFC 8414)
  // Skip auto-discovery when both authorization URL and token URL overrides are provided.
  // Many OAuth providers (e.g. custom internal services) don't implement RFC 8414
  // (.well-known/oauth-authorization-server) or OIDC discovery.
  const hasFullOverrides = options?.authorizationUrlOverride && options?.tokenUrlOverride;
  let authServerMetadata: AuthorizationServerMetadata | null = null;

  if (hasFullOverrides && compatibilityMode === 'legacy') {
    console.log('[MCP OAuth] Skipping auth server metadata fetch — manual overrides provided');
  } else {
    try {
      authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl, {
        compatibilityMode,
        allowLocalhostHttp,
      });
      console.log('[MCP OAuth] Authorization server metadata resolved');
    } catch (metadataError) {
      // If we have at least partial overrides, we can continue without metadata
      if (
        compatibilityMode === 'legacy' &&
        (options?.authorizationUrlOverride || options?.tokenUrlOverride)
      ) {
        console.log('[MCP OAuth] Auth server metadata unavailable; using configured overrides');
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
    fallbackRegistrationEndpoint:
      compatibilityMode === 'legacy' && !hasFullOverrides
        ? `${authServerUrl.replace(/\/$/, '')}/register`
        : undefined,
    resourceScopesSupported: resourceMetadata.scopes_supported,
    reuseDynamicClientRegistration: options?.reuseDynamicClientRegistration,
    resourceUri,
    issuer: authServerUrl,
    compatibilityMode,
    dcrMode,
    allowLocalhostHttp,
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
  state: string,
  options: { cacheToken?: boolean; issuer?: string } = {}
): Promise<OAuthTokenResponse> {
  console.log('[MCP OAuth] Completing OAuth flow with authorization code');

  // Verify state to prevent CSRF
  if (state !== context.state) {
    throw new OAuthCallbackValidationError('callback_state_mismatch');
  }
  if (context.compatibilityMode === 'strict' && options.issuer == null) {
    throw new OAuthCallbackValidationError('callback_issuer_missing');
  }
  if (context.compatibilityMode === 'strict' && options.issuer !== context.issuer) {
    throw new OAuthCallbackValidationError('callback_issuer_mismatch');
  }

  // Exchange code for token
  const tokenResponse = await exchangeCodeForToken(
    context.tokenEndpoint,
    code,
    context.redirectUri,
    context.pkceVerifier,
    context.clientId,
    context.clientSecret,
    context.resourceUri,
    context.allowLocalhostHttp
  );

  console.log('[MCP OAuth] Access token received successfully');

  if (options.cacheToken === false) return tokenResponse;

  // Legacy local CLI cache. Daemon callers pass cacheToken:false so a raw
  // bearer is never put in an origin-only process-global namespace; daemon
  // persisted-token paths resolve against durable storage instead.
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
export function parseOAuthCallback(callbackUrl: string): {
  code: string;
  state: string;
  issuer?: string;
} {
  try {
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code) {
      const error = url.searchParams.get('error');
      if (error) {
        throw new Error('OAuth provider rejected authorization');
      }
      throw new Error('No authorization code in callback URL');
    }

    if (!state) {
      throw new Error('No state parameter in callback URL');
    }

    return { code, state, issuer: url.searchParams.get('iss') ?? undefined };
  } catch (e) {
    if (e instanceof Error && e.message === 'OAuth provider rejected authorization') {
      throw e;
    }
    // The URL can contain the one-shot authorization code and state. Never
    // copy either capability into an exception that a caller may later log.
    throw new Error('Invalid OAuth callback URL');
  }
}
