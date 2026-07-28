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
import {
  fetchResourceMetadata,
  isOAuthRequired,
  resolveMCPOAuthDiscovery,
} from '../tools/mcp/oauth-mcp-transport';

/** Protocol version sent in the probe handshake. */
const PROBE_PROTOCOL_VERSION = '2025-06-18';

/** Default per-probe budget. A catalog sweep must not stall on one slow host. */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export interface AuthProbeOptions {
  timeoutMs?: number;
  /** Injected so tests and the ingestion run share one clock. */
  now?: () => Date;
}

/**
 * Hostnames the daemon must never be induced to fetch.
 *
 * Remote URLs come from an open, unauthenticated public registry: anybody can
 * publish a server pointing at `http://169.254.169.254/` or at a service on the
 * daemon's private network. Probing is the one place Agor makes an outbound
 * request to a registry-supplied URL, so the SSRF filter belongs here.
 */
function isProbeableUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Credentials in a registry-published URL are never something to replay.
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === 'metadata.google.internal') return false;

  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd'))
    return false;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }

  return true;
}

/** Origin of the first authorization server the discovery cascade found. */
async function resolveAuthServerOrigin(
  wwwAuthenticate: string | null,
  remoteUrl: string
): Promise<string | undefined> {
  const discovery = await resolveMCPOAuthDiscovery(wwwAuthenticate, remoteUrl);
  if (!discovery) return undefined;

  try {
    if (discovery.kind === 'authorization-server') {
      return new URL(discovery.authServerMetadata.issuer).origin;
    }
    const metadata = await fetchResourceMetadata(discovery.metadataUrl);
    const [authServer] = metadata.authorization_servers ?? [];
    return authServer ? new URL(authServer).origin : undefined;
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
  const unresolved = (type: MCPCatalogProbedAuthType = 'unknown'): MCPCatalogProbeResult => ({
    probed_auth_type: type,
    probed_at: now(),
  });

  if (!isProbeableUrl(remoteUrl)) return unresolved();

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
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
  } catch {
    return unresolved();
  }

  if (isOAuthRequired(response.status, response.headers)) {
    const origin = await resolveAuthServerOrigin(
      response.headers.get('www-authenticate'),
      remoteUrl
    );
    return {
      probed_auth_type: 'oauth',
      probed_at: now(),
      ...(origin ? { auth_server_origin: origin } : {}),
    };
  }

  // A 401/403 without an OAuth challenge still needs credentials, just not ones
  // this probe can characterize — the connect flow has to ask.
  if (response.status === 401 || response.status === 403) return unresolved();

  if (response.ok) return unresolved('none');

  return unresolved();
}
