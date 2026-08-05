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
import { createPinnedFetch, isOutboundRefusal } from '../utils/pinned-fetch';
import { isPublicHttpUrl } from '../utils/url';

/** Protocol version sent in the probe handshake. */
const PROBE_PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC id the probe sends, and the only id an accepted answer may carry. */
const PROBE_REQUEST_ID = 1;

/** Default per-probe budget. A catalog sweep must not stall on one slow host. */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Cap on a metadata document, which is a handful of JSON keys. */
const MAX_METADATA_BYTES = 256 * 1024;

export interface AuthProbeOptions {
  timeoutMs?: number;
  /** Injected so tests and the ingestion run share one clock. */
  now?: () => Date;
  /**
   * Transport seam, so the status-to-verdict rules can be exercised without a
   * network. Production leaves it unset and gets {@link createPinnedFetch},
   * which is where the outbound destination filter lives and is tested; a caller
   * that supplies its own is supplying its own guarantees with it.
   */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The fetch every probe request goes through, including the ones the shared
 * discovery cascade makes on the probe's behalf.
 *
 * The interactive connect flow's default fetch is deliberately more permissive:
 * the user chose that server. Here the input is whatever an anonymous stranger
 * published to a public registry, so every request — the initial handshake, the
 * `.well-known` probes discovery derives from the origin, and the metadata URL
 * a `WWW-Authenticate` header names — is held to the same rules: a destination
 * that is public both as a URL and as a resolved address, no redirect
 * following, and a bounded body.
 *
 * Rejecting by throwing is deliberate. Discovery already treats a thrown fetch
 * as "this candidate failed" and moves on, so a refused host degrades to no
 * discovery rather than needing new error plumbing.
 */
function createProbeFetch(
  timeoutMs: number
): (input: string, init?: RequestInit) => Promise<Response> {
  return createPinnedFetch({ timeoutMs, maxBytes: MAX_METADATA_BYTES });
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a body carries the JSON-RPC 2.0 `initialize` result this probe
 * asked for.
 *
 * Status alone says nothing about what answered. A marketing page, a captive
 * portal, and an API gateway's "healthy" stub all return 200, and recording
 * that as `none` would put a connect-directly button in front of something that
 * is not an MCP server at all. Only a complete handshake means the endpoint
 * both speaks MCP and accepted an unauthenticated client.
 *
 * Every prescribed member of `InitializeResult` is required, and the response
 * `id` must be the one this probe sent — an unsolicited notification or an
 * answer to somebody else's request says nothing about whether *this* request
 * was accepted. `serverInfo.version` is the exception: it carries no signal the
 * name does not, so demanding it would only misreport servers that trim it.
 *
 * Every rejection lands on `unknown`, never `none`, so a server this is too
 * strict about is under-advertised rather than wrongly advertised as open.
 */
function isInitializeResult(body: string, requestId: number = PROBE_REQUEST_ID): boolean {
  for (const candidate of jsonPayloadsIn(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.jsonrpc !== '2.0') continue;
    // JSON-RPC permits a string id; compare by rendering rather than by type so
    // a server that echoes `"1"` is not treated as answering a different call.
    if (String(parsed.id) !== String(requestId)) continue;
    const result = parsed.result;
    if (!isRecord(result)) continue;
    if (typeof result.protocolVersion !== 'string' || !result.protocolVersion) continue;
    if (!isRecord(result.capabilities)) continue;
    if (!isRecord(result.serverInfo)) continue;
    if (typeof result.serverInfo.name !== 'string' || !result.serverInfo.name) continue;
    return true;
  }
  return false;
}

/**
 * Candidate JSON documents inside a response body.
 *
 * Streamable HTTP servers may answer either as plain JSON or as an SSE stream
 * whose payload sits in `data:` lines, and the probe accepts both, so both
 * framings have to be unwrapped before anything can be parsed. Consecutive
 * `data:` lines belong to one event and are rejoined per the SSE grammar.
 */
function* jsonPayloadsIn(body: string): Generator<string> {
  yield body;
  let event: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.startsWith('data:')) {
      event.push(line.slice(5).replace(/^ /, ''));
      continue;
    }
    if (event.length > 0) {
      yield event.join('\n');
      event = [];
    }
  }
  if (event.length > 0) yield event.join('\n');
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
    probed_url: remoteUrl,
  });

  if (!isPublicHttpUrl(remoteUrl)) return unresolved();

  const discoveryFetch = options.fetchImpl ?? createProbeFetch(timeoutMs);
  const handshakeFetch =
    options.fetchImpl ??
    createPinnedFetch({
      timeoutMs,
      maxBytes: MAX_METADATA_BYTES,
      // A server that answers over SSE holds the stream open for the rest of
      // the session, so waiting for `end` would time out on exactly the servers
      // that answered correctly.
      isBodyComplete: isInitializeResult,
    });

  let response: Response;
  try {
    response = await handshakeFetch(remoteUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP servers negotiate between JSON and SSE replies.
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: PROBE_REQUEST_ID,
        method: 'initialize',
        params: {
          protocolVersion: PROBE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'agor-catalog-probe', version: '1' },
        },
      }),
    });
  } catch (error) {
    // A destination the outbound filter declined was never contacted, so
    // "unreachable" would be a claim about a host nothing was learned about.
    if (isOutboundRefusal(error)) return unresolved();
    // Timeout, DNS failure, connection refused, TLS error.
    return unresolved('unreachable');
  }

  if (isOAuthRequired(response.status, response.headers)) {
    const origin = await resolveAuthServerOrigin(
      response.headers.get('www-authenticate'),
      remoteUrl,
      discoveryFetch
    );
    return {
      ...unresolved('oauth'),
      ...(origin ? { auth_server_origin: origin } : {}),
    };
  }

  // A 401/403 without an OAuth challenge needs credentials the browser flow
  // cannot obtain. The scheme it names is what the connect form should ask for.
  if (response.status === 401 || response.status === 403) {
    const scheme = parseChallengeScheme(response.headers.get('www-authenticate'));
    return {
      ...unresolved('credentials'),
      ...(scheme ? { probed_auth_scheme: scheme } : {}),
    };
  }

  if (response.ok) {
    // `none` is the one verdict that renders a connect-directly button, so it
    // has to be earned by a real handshake rather than by a 2xx. Anything else
    // answering on this URL is something the probe failed to identify.
    return unresolved(isInitializeResult(await response.text()) ? 'none' : 'unknown');
  }

  return unresolved('unreachable');
}
