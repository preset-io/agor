/**
 * MCP OAuth 2.1 Transport Wrapper
 *
 * Implements RFC 9728 (OAuth 2.0 Protected Resource Metadata) for MCP servers
 * Handles 401 responses with WWW-Authenticate headers and performs OAuth 2.1
 * Authorization Code flow with PKCE.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import type {
  MCPOAuthDCRDiagnostic,
  MCPOAuthDCRMode,
  MCPOAuthRuntimeCompatibilityMode,
} from '../../types/mcp.js';
import { assertSafeOAuthUrl, safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import { asMCPExternalError } from './external-error.js';
import type { OAuthTokenResponse } from './oauth-auth.js';
import { resolveTokenExpiry } from './oauth-token-expiry.js';

export interface OAuthMetadata {
  /** RFC 9728 says string; marketplace compatibility also recognizes one observed singleton array. */
  resource?: string | string[];
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
 * to parse provider response text. Only closed diagnostic fields are carried;
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

/** Stable classification for OAuth discovery/configuration policy failures. */
export class OAuthConfigurationError extends Error {
  constructor(
    readonly failureCode:
      | 'metadata_unavailable'
      | 'metadata_incompatible'
      | 'endpoint_override_mismatch'
      | 'issuer_mismatch'
      | 'pkce_required'
      | 'client_registration_required',
    message = `OAuth configuration failed (${failureCode})`
  ) {
    super(message);
    this.name = 'OAuthConfigurationError';
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
 *   1. {origin}/.well-known/oauth-protected-resource{path}  (path-aware per RFC)
 *   2. {origin}/.well-known/oauth-protected-resource  (root fallback)
 *
 * @param mcpUrl - The MCP server URL
 * @returns The resource metadata URL if discoverable, null otherwise
 */
export async function discoverResourceMetadataUrl(
  mcpUrl: string,
  options: {
    allowLocalhostHttp?: boolean;
    assertCurrent?: () => void;
    /** When set, only return metadata bound to this exact MCP resource policy. */
    resourceUri?: string;
    compatibilityMode?: MCPOAuthRuntimeCompatibilityMode;
  } = {}
): Promise<string | null> {
  options.assertCurrent?.();
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
    options.assertCurrent?.();
    let response: Response;
    try {
      response = await safeOutboundFetch(candidate, {
        redirect: 'follow',
        timeoutMs: 10_000,
        allowLocalhostHttp: options.allowLocalhostHttp,
        assertCurrent: options.assertCurrent,
      });
    } catch {
      // Keep the authority/deadline check outside the provider-error catch:
      // an expired daemon reservation is terminal, never another discovery
      // candidate to try.
      options.assertCurrent?.();
      console.log('[MCP OAuth] Resource metadata discovery candidate failed');
      continue;
    }
    options.assertCurrent?.();
    if (response.ok) {
      let data: OAuthMetadata;
      try {
        data = (await response.json()) as OAuthMetadata;
      } catch {
        options.assertCurrent?.();
        console.log('[MCP OAuth] Resource metadata discovery candidate failed');
        continue;
      }
      options.assertCurrent?.();
      if (
        data.authorization_servers &&
        Array.isArray(data.authorization_servers) &&
        resourceMetadataMatches(
          candidate,
          data.resource,
          options.resourceUri,
          options.compatibilityMode
        )
      ) {
        console.log('[MCP OAuth] Resource metadata discovered');
        return candidate;
      }
    }
  }

  options.assertCurrent?.();
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
  options: {
    allowLocalhostHttp?: boolean;
    assertCurrent?: () => void;
    /** When set, reject a header hint that is not bound to this MCP resource. */
    resourceUri?: string;
    compatibilityMode?: MCPOAuthRuntimeCompatibilityMode;
  } = {}
): Promise<{ metadataUrl: string; source: 'header' | 'well-known' } | null> {
  options.assertCurrent?.();
  // Strategy 1: Parse from WWW-Authenticate header
  if (wwwAuthenticateHeader) {
    const parsed = parseWWWAuthenticate(wwwAuthenticateHeader);
    if (parsed) {
      // A tool-level 401 can advertise metadata for a coarser resource than
      // the configured MCP endpoint. Validate the binding before accepting
      // the hint so discovery can safely continue to the endpoint-specific
      // RFC 9728 location when the hint is not applicable.
      if (!options.resourceUri) {
        return { metadataUrl: parsed, source: 'header' };
      }
      try {
        const response = await safeOutboundFetch(parsed, {
          redirect: 'follow',
          timeoutMs: 10_000,
          allowLocalhostHttp: options.allowLocalhostHttp,
          assertCurrent: options.assertCurrent,
        });
        options.assertCurrent?.();
        if (response.ok) {
          const data = (await response.json()) as OAuthMetadata;
          options.assertCurrent?.();
          if (
            Array.isArray(data.authorization_servers) &&
            resourceMetadataMatches(
              parsed,
              data.resource,
              options.resourceUri,
              options.compatibilityMode
            )
          ) {
            return { metadataUrl: parsed, source: 'header' };
          }
        }
      } catch {
        // Keep the authority/deadline check outside the provider-error catch:
        // an expired daemon reservation is terminal, never another discovery
        // candidate to try.
        options.assertCurrent?.();
        // Continue to endpoint-specific well-known discovery below.
      }
      console.log('[MCP OAuth] Advertised resource metadata does not bind the MCP endpoint');
    }
  }

  // Strategy 2: Auto-discover via .well-known endpoint
  const discovered = await discoverResourceMetadataUrl(mcpUrl, options);
  options.assertCurrent?.();
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
  options: { allowLocalhostHttp?: boolean; assertCurrent?: () => void } = {}
): Promise<{ metadata: AuthorizationServerMetadata; discoveredAt: string } | null> {
  options.assertCurrent?.();
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
    options.assertCurrent?.();
    let response: Response;
    try {
      response = await safeOutboundFetch(candidate, {
        redirect: 'follow',
        timeoutMs: 10_000,
        allowLocalhostHttp: options.allowLocalhostHttp,
        assertCurrent: options.assertCurrent,
      });
    } catch {
      options.assertCurrent?.();
      console.log('[MCP OAuth] Authorization-server discovery candidate failed');
      continue;
    }
    options.assertCurrent?.();
    if (!response.ok) continue;
    let data: Partial<AuthorizationServerMetadata>;
    try {
      data = (await response.json()) as Partial<AuthorizationServerMetadata>;
    } catch {
      options.assertCurrent?.();
      console.log('[MCP OAuth] Authorization-server discovery candidate failed');
      continue;
    }
    options.assertCurrent?.();
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
  }

  options.assertCurrent?.();
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
  options: {
    compatibilityMode?: MCPOAuthRuntimeCompatibilityMode;
    allowLocalhostHttp?: boolean;
    /** Daemon-owned authority/deadline assertion between discovery requests. */
    assertCurrent?: () => void;
  } = {}
): Promise<MCPOAuthDiscoveryResult | null> {
  options.assertCurrent?.();
  // Strategies 1 + 2: RFC 9728 (header hint, then well-known fallback)
  const rfc9728 = await resolveResourceMetadataUrl(wwwAuthenticateHeader, mcpUrl, {
    ...options,
    resourceUri: mcpUrl,
  });
  options.assertCurrent?.();
  if (rfc9728) {
    return { kind: 'resource-metadata', ...rfc9728 };
  }

  // Strategies 3 + 4: AS metadata directly at MCP origin (RFC 8414 / OIDC)
  if ((options.compatibilityMode ?? 'strict') === 'strict') return null;
  const asDirect = await discoverAuthorizationServerFromMcpOrigin(mcpUrl, options);
  options.assertCurrent?.();
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
  options: { allowLocalhostHttp?: boolean; assertCurrent?: () => void } = {}
): Promise<OAuthMetadata> {
  options.assertCurrent?.();
  let response: Response;
  try {
    response = await safeOutboundFetch(metadataUrl, {
      redirect: 'follow',
      timeoutMs: 15_000,
      allowLocalhostHttp: options.allowLocalhostHttp,
      assertCurrent: options.assertCurrent,
    });
  } catch (error) {
    options.assertCurrent?.();
    throw asMCPExternalError(error, { stage: 'oauth_metadata' });
  }
  options.assertCurrent?.();
  if (!response.ok) {
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      `The OAuth resource metadata endpoint returned status ${response.status}. ` +
        `The MCP server advertised OAuth support but its metadata is not available. ` +
        `This indicates an incomplete OAuth implementation on the server side.`
    );
  }
  let metadata: OAuthMetadata;
  try {
    metadata = (await response.json()) as OAuthMetadata;
  } catch (error) {
    options.assertCurrent?.();
    throw asMCPExternalError(error, {
      stage: 'oauth_metadata',
      category: 'invalid_response',
    });
  }
  options.assertCurrent?.();
  return metadata;
}

// Cache for dynamically registered clients (per authorization server)
const dynamicClientCache = new Map<
  string,
  { client_id: string; client_secret?: string; redirect_uri: string }
>();

const MAX_DCR_RESPONSE_BYTES = 16 * 1024;

const dynamicClientRegistrationSchema = z.object({
  client_id: z.string().trim().min(1),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

type DynamicClientRegistrationResponse = z.infer<typeof dynamicClientRegistrationSchema>;

function registrationDiagnostic(
  httpStatus: number,
  registrationEndpointSource: 'metadata' | 'legacy_fallback'
): MCPOAuthDCRDiagnostic {
  return {
    stage: 'dcr_registration',
    http_status: httpStatus,
    registration_endpoint_source: registrationEndpointSource,
  };
}

function dcrRecoveryGuidance(diagnostic: MCPOAuthDCRDiagnostic): string {
  const manualClient =
    'enter the Client ID and Client Secret for a pre-registered OAuth app in Advanced — OAuth settings, then retry.';

  if (diagnostic.http_status === 404) {
    if (diagnostic.registration_endpoint_source === 'metadata') {
      return `The advertised registration endpoint returned HTTP 404 and is unavailable or stale. Verify the provider OAuth metadata, or ${manualClient}`;
    }
    if (diagnostic.registration_endpoint_source === 'legacy_fallback') {
      return `The legacy guessed /register endpoint returned HTTP 404. Disable the legacy fallback, or ${manualClient}`;
    }
    return `The registration endpoint used for this attempt returned HTTP 404, or ${manualClient}`;
  }
  if (diagnostic.http_status === undefined) {
    return `Dynamic Client Registration could not complete. Verify the provider's registration endpoint, or ${manualClient}`;
  }
  if (diagnostic.http_status >= 400) {
    return `The provider rejected Dynamic Client Registration. Review its client-registration requirements, or ${manualClient}`;
  }
  return `The provider returned an incompatible registration response. Review its client-registration requirements, or ${manualClient}`;
}

function registrationFailure(
  diagnostic: MCPOAuthDCRDiagnostic,
  lead = 'Dynamic Client Registration failed'
): OAuthDCRFailure {
  const failureLead = lead.startsWith('Dynamic Client Registration failed')
    ? lead
    : `Dynamic Client Registration failed: ${lead}`;
  const status = diagnostic.http_status === undefined ? '' : ` (HTTP ${diagnostic.http_status})`;
  return new OAuthDCRFailure(
    `${failureLead}${status} at stage ${diagnostic.stage}. ${dcrRecoveryGuidance(diagnostic)}`,
    diagnostic
  );
}

function missingRegistrationEndpointFailure(): OAuthDCRFailure {
  const diagnostic: MCPOAuthDCRDiagnostic = { stage: 'dcr_endpoint_discovery' };
  return new OAuthDCRFailure(
    'OAuth client credentials required: this authorization server does not support Dynamic Client Registration (stage: dcr_endpoint_discovery). Create or select a pre-registered OAuth app, enter its Client ID and provider-required Client Secret in Advanced — OAuth settings, then retry.',
    diagnostic
  );
}

function oauthClientApplicationType(redirectUri: string): 'native' | 'web' {
  const hostname = new URL(redirectUri).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
    ? 'native'
    : 'web';
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
  allowLocalhostHttp = false,
  registrationEndpointSource: 'metadata' | 'legacy_fallback' = 'metadata',
  assertCurrent?: () => void
): Promise<DynamicClientRegistrationResponse> {
  assertCurrent?.();
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
    application_type: oauthClientApplicationType(redirectUri),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // Public client (no client_secret)
  };

  // Include scope in registration so the client is authorized to request them later.
  // Per RFC 7591 §2, the scope field is a space-separated string of scope values.
  if (scope) {
    registrationRequest.scope = scope;
  }

  let response: Response;
  try {
    response = await safeOutboundFetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(registrationRequest),
      redirect: 'error',
      timeoutMs: 15_000,
      maxResponseBytes: MAX_DCR_RESPONSE_BYTES,
      allowLocalhostHttp,
      assertCurrent,
    });
  } catch (error) {
    assertCurrent?.();
    throw error;
  }
  assertCurrent?.();

  if (!response.ok) {
    throw registrationFailure(registrationDiagnostic(response.status, registrationEndpointSource));
  }

  const diagnostic = registrationDiagnostic(response.status, registrationEndpointSource);
  const responseBody = await response.json().catch(() => null);
  assertCurrent?.();
  const parsed = dynamicClientRegistrationSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw registrationFailure(
      diagnostic,
      'Dynamic Client Registration returned an invalid response'
    );
  }
  const result: DynamicClientRegistrationResponse = parsed.data;

  if (!result.redirect_uris?.includes(redirectUri)) {
    throw registrationFailure(
      diagnostic,
      'Dynamic Client Registration did not bind the required redirect URI'
    );
  }
  // We request a public client (`token_endpoint_auth_method: 'none'`), but some providers
  // (e.g. Atlassian) ignore that and register a *confidential* client — returning HTTP 201
  // with a `client_secret` while either omitting the auth method or echoing 'none'. A returned
  // secret is the authoritative signal that the client is confidential, so treat it as
  // client_secret_basic regardless of the advertised method. The token exchange already routes
  // any present secret through HTTP Basic auth (RFC 6749 §2.3.1), so these credentials are
  // usable as-is.
  const authMethod = result.client_secret
    ? 'client_secret_basic'
    : (result.token_endpoint_auth_method ?? 'none');
  if (!['none', 'client_secret_basic'].includes(authMethod)) {
    throw registrationFailure(
      diagnostic,
      'Dynamic Client Registration returned an unsupported token auth method'
    );
  }
  if (authMethod === 'client_secret_basic' && !result.client_secret) {
    throw registrationFailure(
      diagnostic,
      'Dynamic Client Registration omitted the required client secret'
    );
  }
  if (result.grant_types && !result.grant_types.includes('authorization_code')) {
    throw registrationFailure(
      diagnostic,
      'Dynamic Client Registration did not enable the authorization-code grant'
    );
  }
  if (result.response_types && !result.response_types.includes('code')) {
    throw registrationFailure(
      diagnostic,
      'Dynamic Client Registration did not enable the code response type'
    );
  }

  if (reuseLocalCache) {
    assertCurrent?.();
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
 * A few reviewed providers (e.g. Google) disagree only about a trailing slash
 * between their protected-resource `authorization_servers` entry and their
 * authorization-server metadata `issuer`. Treat that spelling difference as
 * equivalent in every non-legacy compatibility mode, including `strict` — see
 * the Gmail/Calendar fixtures in oauth-mcp-transport.test.ts. Host, scheme,
 * port, path, query, username and password must still agree.
 */
function oauthIssuerIdentifiersMatch(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left === right) return true;
  try {
    // Parse only to reject non-URL issuer identifiers. Do not compare the
    // parsed values: URL serialization also folds host case, removes default
    // ports, and resolves dot segments, none of which this reviewed exception
    // intends to accept.
    new URL(left);
    new URL(right);
    const differsByOneTrailingSlash = (withSlash: string, withoutSlash: string): boolean =>
      withSlash.endsWith('/') &&
      !withSlash.slice(0, -1).endsWith('/') &&
      withSlash.slice(0, -1) === withoutSlash;
    return differsByOneTrailingSlash(left, right) || differsByOneTrailingSlash(right, left);
  } catch {
    return false;
  }
}

function oauthIssuerOriginMatchesResource(issuer: unknown, resourceUri: string): boolean {
  if (typeof issuer !== 'string') return false;
  try {
    return new URL(issuer).origin === new URL(resourceUri).origin;
  } catch {
    return false;
  }
}

/**
 * Fetch Authorization Server Metadata (RFC 8414)
 *
 * Implements path-aware discovery per RFC 8414 Section 3.
 * Falls back to OIDC discovery and naive URL construction.
 */
export async function fetchAuthorizationServerMetadata(
  authServerUrl: string,
  options: {
    compatibilityMode?: MCPOAuthRuntimeCompatibilityMode;
    allowLocalhostHttp?: boolean;
    /** Daemon-owned authority/deadline assertion between discovery requests. */
    assertCurrent?: () => void;
  } = {}
): Promise<AuthorizationServerMetadata> {
  options.assertCurrent?.();
  const cleanUrl = authServerUrl.replace(/\/$/, '');
  const urlsToTry: { url: string; label: string }[] = [];

  // 1. RFC 8414 path-aware discovery (correct per spec)
  const rfc8414Url = buildWellKnownUrl(cleanUrl, 'oauth-authorization-server');
  urlsToTry.push({ url: rfc8414Url, label: 'RFC 8414 (path-aware)' });

  const compatibilityMode = options.compatibilityMode ?? 'strict';
  const compatibilityProbes = compatibilityMode !== 'strict';
  // Narrow opt-in legacy probes for non-compliant issuers.
  const naiveUrl = `${cleanUrl}/.well-known/oauth-authorization-server`;
  if (compatibilityProbes && naiveUrl !== rfc8414Url) {
    urlsToTry.push({ url: naiveUrl, label: 'RFC 8414 (naive append)' });
  }

  // 3. OIDC discovery — path-aware
  const oidcUrl = buildWellKnownUrl(cleanUrl, 'openid-configuration');
  if (compatibilityProbes) urlsToTry.push({ url: oidcUrl, label: 'OIDC (path-aware)' });

  // 4. OIDC discovery — naive append
  const naiveOidcUrl = `${cleanUrl}/.well-known/openid-configuration`;
  if (compatibilityProbes && naiveOidcUrl !== oidcUrl) {
    urlsToTry.push({ url: naiveOidcUrl, label: 'OIDC (naive append)' });
  }

  const errors: string[] = [];
  for (const { url, label } of urlsToTry) {
    options.assertCurrent?.();
    let response: Response;
    try {
      response = await safeOutboundFetch(url, {
        redirect: 'follow',
        timeoutMs: 15_000,
        allowLocalhostHttp: options.allowLocalhostHttp,
        assertCurrent: options.assertCurrent,
      });
    } catch {
      options.assertCurrent?.();
      errors.push(`${label}: request failed`);
      continue;
    }
    options.assertCurrent?.();
    if (!response.ok) {
      errors.push(`${label}: HTTP ${response.status}`);
      continue;
    }
    let metadata: AuthorizationServerMetadata;
    try {
      metadata = (await response.json()) as AuthorizationServerMetadata;
    } catch {
      options.assertCurrent?.();
      errors.push(`${label}: request failed`);
      continue;
    }
    options.assertCurrent?.();
    if (
      compatibilityMode !== 'legacy' &&
      !oauthIssuerIdentifiersMatch(metadata.issuer, authServerUrl)
    ) {
      errors.push(`${label}: request failed`);
      continue;
    }
    console.log(`[MCP OAuth] ✓ Fetched metadata via ${label}`);
    return metadata;
  }

  options.assertCurrent?.();
  throw new OAuthConfigurationError(
    'metadata_unavailable',
    'Failed to fetch authorization server metadata.\n' +
      `Tried:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
      'The authorization server may not support RFC 8414 or OIDC metadata discovery.\n' +
      'You can manually provide oauth_authorization_url and oauth_token_url in the MCP server config.'
  );
}

// Timeout for waiting for the OAuth callback (2 minutes)
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;

const OAUTH_CALLBACK_HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
} as const;

const OAUTH_CALLBACK_SUCCESS_HTML =
  '<!doctype html><html><body><h1>Authentication Successful</h1><p>You can close this window.</p></body></html>';
const OAUTH_CALLBACK_FAILURE_HTML =
  '<!doctype html><html><body><h1>Authentication Failed</h1><p>The provider did not complete authentication. Return to Agor and try again.</p></body></html>';
const OAUTH_CALLBACK_INVALID_HTML =
  '<!doctype html><html><body><h1>Invalid Callback</h1><p>The authentication callback could not be validated. Return to Agor and try again.</p></body></html>';

/**
 * Start local HTTP server to receive OAuth callback
 */
function startCallbackServer(
  expectedState: string,
  port: number = 0
): Promise<{
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
        const hasProviderError = url.searchParams.has('error');

        // Validate the CSRF capability before interpreting any provider-controlled
        // callback parameter. Error values are never reflected into HTML or the
        // promise result, even when state is valid.
        if (state !== expectedState) {
          res.writeHead(400, OAUTH_CALLBACK_HTML_HEADERS);
          res.end(OAUTH_CALLBACK_INVALID_HTML);
          callbackResolve({ code: '', state: state ?? '' });
          return;
        }

        if (hasProviderError) {
          res.writeHead(400, OAUTH_CALLBACK_HTML_HEADERS);
          res.end(OAUTH_CALLBACK_FAILURE_HTML);
          callbackResolve({ code: '', state: expectedState });
          return;
        }

        if (code) {
          res.writeHead(200, OAUTH_CALLBACK_HTML_HEADERS);
          res.end(OAUTH_CALLBACK_SUCCESS_HTML);
          callbackResolve({ code, state: expectedState });
        } else {
          res.writeHead(400, OAUTH_CALLBACK_HTML_HEADERS);
          res.end(OAUTH_CALLBACK_INVALID_HTML);
          callbackResolve({ code: '', state: expectedState });
        }
      } else {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
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
    // The browser launcher can include the full authorization URL (including
    // state) in its exception. Do not reflect either value.
    throw asMCPExternalError(error, { stage: 'oauth_callback' });
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
    throw new OAuthConfigurationError(
      'metadata_unavailable',
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
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      'No authorization servers found in resource metadata'
    );
  }

  // Use first authorization server
  const authServerUrl = resourceMetadata.authorization_servers[0];
  // Step 3: Fetch Authorization Server Metadata (RFC 8414)
  const authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl, {
    allowLocalhostHttp: true,
  });
  console.log('[MCP OAuth] Authorization server metadata resolved');

  // Generate the CSRF capability before starting the listener so every
  // callback response validates state before considering provider parameters.
  const state = crypto.randomUUID();

  // Step 4: Start local callback server
  const callback = await startCallbackServer(state);
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
      typeof resourceMetadata.resource === 'string' ? resourceMetadata.resource : undefined,
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
  compatibilityMode: MCPOAuthRuntimeCompatibilityMode;
  /** Require `iss` when the AS advertised RFC 9207 support for this flow. */
  authorizationResponseIssuerParameterSupported: boolean;
  /** Narrow outbound-endpoint exception; durable daemon flows leave this false. */
  allowLocalhostHttp: boolean;
}

/**
 * Bounded RFC 9728 compatibility for reviewed marketplace endpoints.
 *
 * Exact equality remains the strict/default rule. The marketplace may also
 * accept an origin-level (or parent-path) resource identifier, but only when
 * both the metadata document and that identifier are served by the exact MCP
 * origin. This covers providers that publish one origin-scoped PRM for
 * `/mcp`, without accepting a cross-origin metadata document or resource that
 * could redirect a grant to an attacker. The authorization and token requests
 * still carry the exact MCP URL as their RFC 8707 `resource` value.
 *
 * One provider currently emits the singular RFC field as a singleton array;
 * accepting exactly one string preserves the same unambiguous binding. A list
 * of alternatives is rejected rather than guessing which resource was meant.
 */
function marketplaceResourceMetadataMatches(
  metadataUrl: string,
  statedResource: OAuthMetadata['resource'],
  resourceUri: string
): boolean {
  const identifiers =
    typeof statedResource === 'string'
      ? [statedResource]
      : Array.isArray(statedResource) &&
          statedResource.length === 1 &&
          typeof statedResource[0] === 'string'
        ? statedResource
        : [];
  if (identifiers.length !== 1) return false;
  const [identifier] = identifiers;
  if (identifier === resourceUri) return true;

  try {
    const metadata = new URL(metadataUrl);
    const stated = new URL(identifier);
    const requested = new URL(resourceUri);
    if (metadata.origin !== requested.origin || stated.origin !== requested.origin) return false;
    if (stated.search || stated.hash) return false;
    const basePath = stated.pathname.replace(/\/+$/, '') || '/';
    const requestedPath = requested.pathname.replace(/\/+$/, '') || '/';
    return (
      requestedPath === basePath || basePath === '/' || requestedPath.startsWith(`${basePath}/`)
    );
  } catch {
    return false;
  }
}

/**
 * Apply the same resource-binding policy during discovery and flow startup.
 * Legacy mode intentionally preserves its historical permissive behavior;
 * strict and reviewed-marketplace modes must never select mismatched metadata.
 */
function resourceMetadataMatches(
  metadataUrl: string,
  statedResource: OAuthMetadata['resource'],
  resourceUri: string | undefined,
  compatibilityMode: MCPOAuthRuntimeCompatibilityMode = 'strict'
): boolean {
  if (!resourceUri || compatibilityMode === 'legacy') return true;
  return compatibilityMode === 'strict'
    ? statedResource === resourceUri
    : marketplaceResourceMetadataMatches(metadataUrl, statedResource, resourceUri);
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
 *   - `cacheKey`: becomes `context.metadataUrl` — the exact key
 *     `completeMCPOAuthFlow` writes its legacy CLI cache entry under, and the
 *     metadata URI the daemon persists as the grant's binding
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
  compatibilityMode: MCPOAuthRuntimeCompatibilityMode;
  dcrMode: MCPOAuthDCRMode;
  /** Permit an exact HTTP loopback redirect without permitting loopback provider endpoints. */
  allowLoopbackRedirectUri: boolean;
  allowLocalhostHttp: boolean;
  /** Daemon-owned authority/deadline assertion around provider side effects. */
  assertCurrent?: () => void;
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
    allowLoopbackRedirectUri,
    allowLocalhostHttp,
  } = opts;

  const hasFullOverrides = !!(authorizationUrlOverride && tokenUrlOverride);
  opts.assertCurrent?.();

  // PKCE
  const pkce = generatePKCE();

  // Redirect URI default — preserved for legacy CLI callers
  const actualRedirectUri = redirectUri || 'http://127.0.0.1:0/oauth/callback';
  // Validate before registration: DCR sends this value to an external service
  // and must not turn an unsafe configured callback into durable provider-side
  // client metadata.
  assertSafeOAuthUrl(actualRedirectUri, { allowLocalhostHttp: allowLoopbackRedirectUri });

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
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      'No token endpoint available. Either provide oauth_token_url in the MCP server config, ' +
        'or ensure the authorization server supports RFC 8414 metadata discovery.'
    );
  }
  const authorizationEndpoint =
    authorizationUrlOverride || authServerMetadata?.authorization_endpoint;
  if (!authorizationEndpoint) {
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      'No authorization endpoint available. Either provide oauth_authorization_url in the MCP server config, ' +
        'or ensure the authorization server supports RFC 8414 metadata discovery.'
    );
  }
  console.log('[MCP OAuth] OAuth endpoints resolved');

  assertSafeOAuthUrl(tokenEndpoint, { allowLocalhostHttp });
  assertSafeOAuthUrl(authorizationEndpoint, { allowLocalhostHttp });
  if (compatibilityMode !== 'legacy') {
    if (!authServerMetadata) {
      throw new OAuthConfigurationError(
        'metadata_unavailable',
        'MCP OAuth issuer validation requires authorization-server metadata'
      );
    }
    assertSafeOAuthUrl(authServerMetadata.issuer, { allowLocalhostHttp });
    const issuerMatches = oauthIssuerIdentifiersMatch(authServerMetadata.issuer, issuer);
    if (!issuerMatches) {
      throw new OAuthConfigurationError('issuer_mismatch', 'Authorization server issuer mismatch');
    }
    const advertisedPKCEMethods = authServerMetadata.code_challenge_methods_supported;
    if (
      compatibilityMode === 'strict'
        ? !advertisedPKCEMethods?.includes('S256')
        : advertisedPKCEMethods !== undefined && !advertisedPKCEMethods.includes('S256')
    ) {
      throw new OAuthConfigurationError(
        'pkce_required',
        'Authorization server does not advertise required PKCE S256 support'
      );
    }
    if (
      authorizationUrlOverride &&
      authorizationUrlOverride !== authServerMetadata.authorization_endpoint
    ) {
      throw new OAuthConfigurationError(
        'endpoint_override_mismatch',
        'MCP OAuth authorization endpoint override does not match metadata'
      );
    }
    if (tokenUrlOverride && tokenUrlOverride !== authServerMetadata.token_endpoint) {
      throw new OAuthConfigurationError(
        'endpoint_override_mismatch',
        'MCP OAuth token endpoint override does not match metadata'
      );
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
      opts.assertCurrent?.();
      console.log('[MCP OAuth] Using Dynamic Client Registration');
      const registrationEndpointSource = authServerMetadata?.registration_endpoint
        ? 'metadata'
        : 'legacy_fallback';
      try {
        const registration = await registerDynamicClient(
          registrationEndpoint,
          actualRedirectUri,
          'Agor MCP Client',
          scopeString,
          opts.reuseDynamicClientRegistration !== false,
          allowLocalhostHttp,
          registrationEndpointSource,
          opts.assertCurrent
        );
        actualClientId = registration.client_id;
        resolvedClientSecret = registration.client_secret;
      } catch (error) {
        // An authority/deadline assertion is not a provider DCR diagnostic.
        // Reassert first so it escapes this compatibility wrapper unchanged.
        opts.assertCurrent?.();
        if (error instanceof OAuthDCRFailure) throw error;
        throw registrationFailure({
          stage: 'dcr_registration',
          registration_endpoint_source: registrationEndpointSource,
        });
      }
      // Keep authority/deadline failures out of the DCR diagnostic wrapper.
      opts.assertCurrent?.();
    } else if (hasFullOverrides) {
      throw new OAuthConfigurationError(
        'client_registration_required',
        'OAuth client_id is required when using manual OAuth URL overrides.\n\n' +
          'Please provide a client_id in the MCP server configuration.'
      );
    } else {
      throw missingRegistrationEndpointFailure();
    }
  } else if (!actualClientId) {
    throw new OAuthConfigurationError(
      'client_registration_required',
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

  opts.assertCurrent?.();
  return {
    metadataUrl: cacheKey,
    resourceUri,
    // RFC 8414 metadata is the callback issuer authority. Marketplace mode
    // admits only a trailing-slash spelling difference from the resource's
    // advertised AS identifier; persist the metadata spelling so an `iss`
    // callback is compared with the value the AS itself promised to send.
    issuer: authServerMetadata?.issuer ?? issuer,
    authorizationEndpoint,
    tokenEndpoint,
    redirectUri: actualRedirectUri,
    pkceVerifier: pkce.verifier,
    clientId: actualClientId!,
    clientSecret: resolvedClientSecret,
    state,
    authorizationUrl: authUrl.toString(),
    compatibilityMode,
    authorizationResponseIssuerParameterSupported:
      authServerMetadata?.authorization_response_iss_parameter_supported === true,
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
    /** Pre-discovered resource metadata URL. Takes precedence over the raw challenge. */
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
     * Metadata URL stand-in. When `prefetchedAuthServerMetadata` is provided
     * there's no real RFC 9728 metadata URL, so the caller passes a stable
     * string (typically the MCP URL itself). It lands on
     * `OAuthFlowContext.metadataUrl` and must be the same value on every flow
     * for the server: lookups against it are exact-match, never by origin.
     */
    cacheKey?: string;
    /** Disable process-global DCR credential reuse in multi-user daemons. */
    reuseDynamicClientRegistration?: boolean;
    /** Exact protected resource identifier sent to authorization/token endpoints. */
    resourceUri?: string;
    compatibilityMode?: MCPOAuthRuntimeCompatibilityMode;
    dcrMode?: MCPOAuthDCRMode;
    /** Exact loopback HTTP exception for standalone development only. */
    allowLocalhostHttp?: boolean;
    /**
     * Optional daemon authority/deadline assertion. Called before and after
     * discovery and DCR boundaries; standalone/CLI callers omit it.
     */
    assertCurrent?: () => void;
    /**
     * Permit an exact HTTP loopback callback without permitting private OAuth
     * metadata, authorization, registration, or token endpoints.
     */
    allowLoopbackRedirectUri?: boolean;
  }
): Promise<OAuthFlowContext> {
  console.log('[MCP OAuth] Starting two-phase OAuth 2.1 flow');
  const compatibilityMode = options?.compatibilityMode ?? 'strict';
  const dcrMode = options?.dcrMode ?? 'advertised';
  const allowLocalhostHttp = options?.allowLocalhostHttp === true;
  // Preserve the legacy standalone helper contract while allowing daemons to
  // grant only the redirect exception. This distinction matters for local
  // PostgreSQL: its browser callback is loopback, but provider egress must
  // retain the durable/multi-tenant private-network denial.
  const allowLoopbackRedirectUri = options?.allowLoopbackRedirectUri ?? allowLocalhostHttp;
  const resourceUri = options?.resourceUri;
  options?.assertCurrent?.();
  if (!resourceUri) {
    throw new OAuthConfigurationError(
      'metadata_incompatible',
      'MCP OAuth requires an exact protected resource URI'
    );
  }
  assertSafeOAuthUrl(resourceUri, { allowLocalhostHttp });

  // When AS metadata is prefetched (Reo.Dev-style discovery), there's no RFC
  // 9728 resource metadata to fetch. Take the short path and skip directly to
  // PKCE / DCR / auth-URL construction.
  if (options?.prefetchedAuthServerMetadata) {
    if (compatibilityMode === 'strict') {
      throw new OAuthConfigurationError(
        'metadata_incompatible',
        'Authorization-server-direct discovery requires explicit marketplace or legacy mode'
      );
    }
    if (!options.cacheKey) {
      // Without it there is no `context.metadataUrl` to carry through the
      // flow — the daemon persists that as the grant's metadata URI. The
      // daemon callsites have the MCP URL handy and should pass it.
      throw new Error(
        'startMCPOAuthFlow: cacheKey is required when prefetchedAuthServerMetadata is provided ' +
          '(typically pass the MCP server URL).'
      );
    }
    // With no RFC 9728 document there is no independently advertised AS
    // identifier to bind. The marketplace fallback is therefore safe only
    // when the directly discovered issuer remains on the protected resource's
    // origin. Legacy mode retains its explicitly broader behavior.
    if (
      compatibilityMode === 'marketplace' &&
      !oauthIssuerOriginMatchesResource(options.prefetchedAuthServerMetadata.issuer, resourceUri)
    ) {
      throw new OAuthConfigurationError(
        'issuer_mismatch',
        'Authorization-server-direct discovery issuer does not match the MCP resource origin'
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
      allowLoopbackRedirectUri,
      allowLocalhostHttp,
      assertCurrent: options.assertCurrent,
    });
  }

  // Step 1: Prefer the resolver's validated choice over the raw challenge.
  // Tool-level challenges can point at metadata for a different (coarser)
  // resource; the daemon passes the endpoint-bound candidate selected by
  // `resolveMCPOAuthDiscovery` here.
  const metadataUrl = options?.resourceMetadataUrl || parseWWWAuthenticate(wwwAuthenticateHeader);
  if (!metadataUrl) {
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      'Could not determine OAuth resource metadata URL. ' +
        'The WWW-Authenticate header does not contain resource_metadata, ' +
        'and no pre-discovered metadata URL was provided.'
    );
  }
  console.log('[MCP OAuth] Resource metadata resolved');

  // Step 2: Fetch Protected Resource Metadata (RFC 9728)
  options?.assertCurrent?.();
  const resourceMetadata = await fetchResourceMetadata(metadataUrl, {
    allowLocalhostHttp,
    assertCurrent: options?.assertCurrent,
  });
  options?.assertCurrent?.();

  if (
    !resourceMetadataMatches(metadataUrl, resourceMetadata.resource, resourceUri, compatibilityMode)
  ) {
    throw new OAuthConfigurationError(
      'metadata_incompatible',
      'Protected resource metadata does not match the MCP resource URI'
    );
  }

  if (
    !resourceMetadata.authorization_servers ||
    resourceMetadata.authorization_servers.length === 0
  ) {
    throw new OAuthConfigurationError(
      'metadata_unavailable',
      'No authorization servers found in resource metadata'
    );
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
      options?.assertCurrent?.();
      authServerMetadata = await fetchAuthorizationServerMetadata(authServerUrl, {
        compatibilityMode,
        allowLocalhostHttp,
        assertCurrent: options?.assertCurrent,
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
    // This is deliberately outside the metadata fallback catch: authority or
    // reservation expiry must never be treated as a recoverable legacy
    // discovery failure.
    options?.assertCurrent?.();
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
    allowLoopbackRedirectUri,
    allowLocalhostHttp,
    assertCurrent: options?.assertCurrent,
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
  if (context.authorizationResponseIssuerParameterSupported && options.issuer == null) {
    throw new OAuthCallbackValidationError('callback_issuer_missing');
  }
  if (options.issuer != null && options.issuer !== context.issuer) {
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
