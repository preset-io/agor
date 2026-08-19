/**
 * Auth probe for one remote MCP endpoint.
 *
 * Nothing states in a form worth trusting whether a server requires
 * authorization — a catalog entry says what was true when it was last edited,
 * and the vendor may since have changed it — so the only way to know is to try:
 * send an unauthenticated `initialize` and read the answer. A `401` carrying an
 * OAuth `WWW-Authenticate` challenge means a browser OAuth dance would have to
 * run; a completed handshake means a client can connect straight away. Connect
 * runs this against the endpoint it is about to install and installs only on
 * the second answer, so this is where "can this be connected" is decided.
 */

import type { MCPCatalogProbedAuthType } from '@agor/core/types';
import { isOAuthRequired } from '../tools/mcp/oauth-mcp-transport';
import { createPinnedFetch, isOutboundRefusal } from '../utils/pinned-fetch';
import { isPublicHttpUrl } from '../utils/url';

/** Protocol version sent in the probe handshake. */
const PROBE_PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC id the probe sends, and the only id an accepted answer may carry. */
const PROBE_REQUEST_ID = 1;

/** Default probe budget. A user is waiting on this, behind a Connect press. */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Cap on the handshake response, which is a handful of JSON keys. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface AuthProbeOptions {
  timeoutMs?: number;
  /**
   * Transport seam, so the status-to-verdict rules can be exercised without a
   * network. Production leaves it unset and gets {@link createPinnedFetch},
   * which is where the outbound destination filter lives and is tested; a caller
   * that supplies its own is supplying its own guarantees with it.
   */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
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
 * portal, and an API gateway's "healthy" stub all return 200, and reading that
 * as `none` would attach something that is not an MCP server at all to a
 * session. Only a complete handshake means the endpoint both speaks MCP and
 * accepted an unauthenticated client.
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
 * Probe one remote MCP URL.
 *
 * Exactly one request is issued, to the URL given and nowhere else. Never
 * throws: an unreachable host, a timeout, or a malformed URL resolves to
 * `unknown` or `unreachable`, so a connect gets a clean refusal rather than a
 * stack trace. `unknown` means "not determined", never "open".
 */
export async function probeRemoteAuthType(
  remoteUrl: string,
  options: AuthProbeOptions = {}
): Promise<MCPCatalogProbedAuthType> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  if (!isPublicHttpUrl(remoteUrl)) return 'unknown';

  // Review vouches for the URL as a string, not for where it lands. The host is
  // resolved at request time by whoever runs the domain and a redirect can name
  // any destination at all, either of which can point back inside the daemon's
  // own network — so the request goes through the pinned transport: a
  // destination that is public both as a URL and as the address actually dialled,
  // no redirect following, and a bounded body.
  const probeFetch =
    options.fetchImpl ??
    createPinnedFetch({
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      // A server that answers over SSE holds the stream open for the rest of
      // the session, so waiting for `end` would time out on exactly the servers
      // that answered correctly.
      isBodyComplete: isInitializeResult,
    });

  let response: Response;
  try {
    response = await probeFetch(remoteUrl, {
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
    if (isOutboundRefusal(error)) return 'unknown';
    // Timeout, DNS failure, connection refused, TLS error.
    return 'unreachable';
  }

  if (isOAuthRequired(response.status, response.headers)) return 'oauth';

  // A 401/403 without an OAuth challenge needs credentials the browser flow
  // cannot obtain, which is a different refusal to write than "sign in".
  if (response.status === 401 || response.status === 403) return 'credentials';

  if (response.ok) {
    // `none` is the one verdict that installs anything, so it has to be earned
    // by a real handshake rather than by a 2xx. Anything else answering on this
    // URL is something the probe failed to identify.
    return isInitializeResult(await response.text()) ? 'none' : 'unknown';
  }

  return 'unreachable';
}
