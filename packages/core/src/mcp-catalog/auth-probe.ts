/**
 * Auth probe for catalog entries.
 *
 * The MCP registry does not declare whether a server requires authorization, so
 * the only way to know is to try: send an unauthenticated `initialize` and read
 * the response. A `401` carrying an OAuth `WWW-Authenticate` challenge means
 * the connect flow has to run the browser OAuth dance; a successful handshake
 * means it can connect straight away. Caching the verdict on the row is what
 * lets the marketplace render the right connect button before the user clicks.
 *
 * The discovery cascade itself is not reimplemented here — `oauth-mcp-transport`
 * already owns RFC 9728 / 8414 / OIDC discovery and this calls into it.
 */

import type { MCPCatalogProbedAuthType, MCPCatalogProbeResult } from '@agor/core/types';
import { isOAuthRequired, resolveMCPOAuthDiscovery } from '../tools/mcp/oauth-mcp-transport';
import { isPublicHttpUrl } from '../utils/url';
import { readCappedBody } from './capped-body';

/** Protocol version sent in the probe handshake. */
const PROBE_PROTOCOL_VERSION = '2025-06-18';

/** Default per-probe budget. A catalog sweep must not stall on one slow host. */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Cap on a metadata document, which is a handful of JSON keys. */
const MAX_METADATA_BYTES = 256 * 1024;

export interface AuthProbeOptions {
  timeoutMs?: number;
  /** Injected so tests and the ingestion run share one clock. */
  now?: () => Date;
}

/**
 * The fetch every probe request goes through, including the ones the shared
 * discovery cascade makes on the probe's behalf.
 *
 * The interactive connect flow's default fetch is deliberately more permissive:
 * the user chose that server. Here the input is whatever an anonymous stranger
 * published to a public registry, so every request — the initial handshake, the
 * `.well-known` probes discovery derives from the origin, and the metadata URL
 * a `WWW-Authenticate` header names — is held to the same three rules: a public
 * destination, no redirect following, and a bounded body.
 *
 * Rejecting by throwing is deliberate. Discovery already treats a thrown fetch
 * as "this candidate failed" and moves on, so a refused host degrades to no
 * discovery rather than needing new error plumbing.
 */
function createProbeFetch(
  timeoutMs: number
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    if (!isPublicHttpUrl(input)) {
      throw new Error(`Refusing to fetch non-public URL: ${input}`);
    }
    const response = await fetch(input, {
      ...init,
      // A redirect is not re-validated by re-entering this function, so refuse
      // it outright rather than trusting a `Location` the daemon never sees.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const capped = await readCappedBody(response, MAX_METADATA_BYTES);
    if (capped === null) {
      throw new Error(`Response exceeded ${MAX_METADATA_BYTES} bytes: ${input}`);
    }
    // Re-wrap so downstream `.json()` sees the bounded body, not the socket.
    return new Response(capped, { status: response.status, headers: response.headers });
  };
}

/**
 * Name the auth scheme a non-OAuth challenge asked for, e.g. `Basic`, `ApiKey`.
 *
 * Bounded and character-restricted because it is stored and later rendered:
 * an unbounded header value is attacker-controlled text.
 */
function parseChallengeScheme(header: string | null): string | undefined {
  const scheme = /^\s*([A-Za-z][A-Za-z0-9._-]{0,31})\b/.exec(header ?? '')?.[1];
  return scheme || undefined;
}

/**
 * Origin of the first authorization server the discovery cascade found.
 *
 * Every URL reached here is third-party-controlled, and not only at the first
 * hop: discovery derives `.well-known` candidates from the probed origin,
 * `resource_metadata="..."` is read verbatim out of that server's own
 * `WWW-Authenticate` header, and the authorization server list comes out of
 * whatever those return. The cascade guards its own requests — it resolves and
 * pins every destination and revalidates each redirect — so only the metadata
 * URL this function fetches directly needs the probe's own transport.
 */
async function resolveAuthServerOrigin(
  wwwAuthenticate: string | null,
  remoteUrl: string,
  probeFetch: (input: string, init?: RequestInit) => Promise<Response>
): Promise<string | undefined> {
  const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, remoteUrl);
  if (!discovery) return undefined;

  try {
    if (discovery.kind === 'authorization-server') {
      const issuer = discovery.authServerMetadata.issuer;
      return isPublicHttpUrl(issuer) ? new URL(issuer).origin : undefined;
    }
    // `probeFetch` re-checks this, but returning early keeps a refused host out
    // of the logs discovery would otherwise emit for a thrown candidate.
    if (!isPublicHttpUrl(discovery.metadataUrl)) return undefined;
    const response = await probeFetch(discovery.metadataUrl, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as { authorization_servers?: string[] };
    const [authServer] = metadata?.authorization_servers ?? [];
    if (!authServer || !isPublicHttpUrl(authServer)) return undefined;
    return new URL(authServer).origin;
  } catch {
    // The entry is still known to need OAuth; only the AS origin is unknown.
    return undefined;
  }
}

/**
 * Probe one remote MCP URL.
 *
 * Never throws: an unreachable host, a timeout, or a malformed URL resolves to
 * `unknown` so one bad entry cannot abort a catalog-wide sweep. `unknown` means
 * "not determined", never "open".
 */
export async function probeRemoteAuthType(
  remoteUrl: string,
  options: AuthProbeOptions = {}
): Promise<MCPCatalogProbeResult> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const unresolved = (type: MCPCatalogProbedAuthType = 'unknown'): MCPCatalogProbeResult => ({
    probed_auth_type: type,
    probed_at: now(),
  });

  if (!isPublicHttpUrl(remoteUrl)) return unresolved();

  let response: Response;
  try {
    response = await fetch(remoteUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP servers negotiate between JSON and SSE replies.
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROBE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'agor-catalog-probe', version: '1' },
        },
      }),
      // Never follow a redirect: the registry-supplied URL is the only host the
      // operator implicitly trusted, and a redirect could aim at a private one.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Timeout, DNS failure, connection refused, TLS error.
    return unresolved('unreachable');
  }

  if (isOAuthRequired(response.status, response.headers)) {
    const origin = await resolveAuthServerOrigin(
      response.headers.get('www-authenticate'),
      remoteUrl,
      createProbeFetch(timeoutMs)
    );
    return {
      probed_auth_type: 'oauth',
      probed_at: now(),
      ...(origin ? { auth_server_origin: origin } : {}),
    };
  }

  // A 401/403 without an OAuth challenge needs credentials the browser flow
  // cannot obtain. The scheme it names is what the connect form should ask for.
  if (response.status === 401 || response.status === 403) {
    const scheme = parseChallengeScheme(response.headers.get('www-authenticate'));
    return {
      probed_auth_type: 'credentials',
      probed_at: now(),
      ...(scheme ? { probed_auth_scheme: scheme } : {}),
    };
  }

  if (response.ok) return unresolved('none');

  return unresolved('unreachable');
}
