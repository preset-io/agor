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
 *
 * {@link probeRemoteApiKey} asks the same question of the same endpoint with a
 * key attached: not "what does this server want" but "does this key work". Both
 * send one `initialize` through the pinned transport and read the answer the
 * same way, because the thing that makes an answer trustworthy — a complete
 * JSON-RPC handshake rather than a 2xx — does not change when a credential is
 * added.
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

export interface RemoteAuthProbeResult {
  authType: MCPCatalogProbedAuthType;
  /** Present only for an OAuth challenge; never contains a caller credential. */
  wwwAuthenticate?: string;
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

/** What one `initialize` attempt came back with, or why it never happened. */
type ProbeAttempt = { response: Response } | { failure: 'refused' | 'unreachable' };

/**
 * Send one `initialize` to `remoteUrl` and hand back whatever answered.
 *
 * Exactly one request is issued, to the URL given and nowhere else. Never
 * throws — a malformed URL, a destination the outbound filter declined, a
 * timeout, or a TLS error all come back as a `failure` for the caller to
 * classify, because "the request was refused before it left" and "nothing
 * answered" are different facts and only the caller knows what to call them.
 *
 * `authorization`, when given, is a credential. It is passed to the transport
 * and never anywhere else: nothing in this module logs a request, a header, or
 * a response body, and {@link createPinnedFetch} does not follow redirects — so
 * the header reaches the host that was resolved and checked, and no other. A
 * followed redirect would be a credential handed to whatever the vendor's DNS
 * points at next, which is the whole reason the pinned transport is the default
 * rather than `fetch`.
 */
async function sendInitialize(
  remoteUrl: string,
  options: AuthProbeOptions,
  authorization?: string
): Promise<ProbeAttempt> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // Review vouches for the URL as a string, not for where it lands. The host is
  // resolved at request time by whoever runs the domain and a redirect can name
  // any destination at all, either of which can point back inside the daemon's
  // own network — so the request goes through the pinned transport: a
  // destination that is public both as a URL and as the address actually dialled,
  // no redirect following, and a bounded body.
  if (!isPublicHttpUrl(remoteUrl)) return { failure: 'refused' };

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

  try {
    const response = await probeFetch(remoteUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP servers negotiate between JSON and SSE replies.
        accept: 'application/json, text/event-stream',
        ...(authorization ? { authorization } : {}),
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
    return { response };
  } catch (error) {
    // A destination the outbound filter declined was never contacted, so
    // "unreachable" would be a claim about a host nothing was learned about.
    if (isOutboundRefusal(error)) return { failure: 'refused' };
    // Timeout, DNS failure, connection refused, TLS error.
    return { failure: 'unreachable' };
  }
}

/**
 * Probe one remote MCP URL.
 *
 * Exactly one request is issued, to the URL given and nowhere else. Never
 * throws: an unreachable host, a timeout, or a malformed URL resolves to
 * `unknown` or `unreachable`, so a connect gets a clean refusal rather than a
 * stack trace. `unknown` means "not determined", never "open".
 */
export async function probeRemoteAuth(
  remoteUrl: string,
  options: AuthProbeOptions = {}
): Promise<RemoteAuthProbeResult> {
  const attempt = await sendInitialize(remoteUrl, options);
  if ('failure' in attempt) {
    return { authType: attempt.failure === 'refused' ? 'unknown' : 'unreachable' };
  }
  const { response } = attempt;

  if (isOAuthRequired(response.status, response.headers))
    return {
      authType: 'oauth',
      wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
    };

  // A 401/403 without an OAuth challenge needs credentials the browser flow
  // cannot obtain, which is a different refusal to write than "sign in".
  if (response.status === 401 || response.status === 403) return { authType: 'credentials' };

  if (response.ok) {
    // `none` is the one verdict that installs anything, so it has to be earned
    // by a real handshake rather than by a 2xx. Anything else answering on this
    // URL is something the probe failed to identify.
    return { authType: isInitializeResult(await response.text()) ? 'none' : 'unknown' };
  }

  return { authType: 'unreachable' };
}

export async function probeRemoteAuthType(
  remoteUrl: string,
  options: AuthProbeOptions = {}
): Promise<MCPCatalogProbedAuthType> {
  return (await probeRemoteAuth(remoteUrl, options)).authType;
}

/**
 * What an endpoint made of a key that was presented to it.
 *
 * Three answers rather than a boolean, because "this key is wrong" and "nothing
 * usable answered" call for different sentences and only one of them is the
 * user's to fix. Collapsing them would tell somebody their key was rejected
 * because the vendor was having an outage.
 */
export type MCPApiKeyProbeVerdict = 'accepted' | 'rejected' | 'unusable';

/**
 * Try `apiKey` against a remote MCP endpoint before anything is installed with
 * it.
 *
 * A key that is wrong at install time produces a server whose every tool fails,
 * at a moment far from the paste that caused it — the agent reports a broken
 * tool, not a bad credential, and the row sits in Settings looking configured.
 * The endpoint has already told us it wants credentials by this point, so one
 * more `initialize` is the cheapest question that distinguishes a working key
 * from a typo, and it is the same handshake the client will perform anyway.
 *
 * `accepted` has to be earned by a complete JSON-RPC handshake, exactly as
 * `none` is in {@link probeRemoteAuthType}: a 2xx from a marketing page or an
 * API gateway stub is not a server that will answer `tools/list`. Everything
 * unrecognised lands on `unusable`, never on `accepted`, so the failure mode is
 * a refused install rather than a broken one.
 *
 * `rejected` covers every authentication answer, OAuth challenge included. A
 * key was presented and the endpoint still would not let the client in, which
 * is one fact from the user's side however the server chose to phrase it.
 */
export async function probeRemoteBearerToken(
  remoteUrl: string,
  apiKey: string,
  options: AuthProbeOptions = {}
): Promise<MCPApiKeyProbeVerdict> {
  const attempt = await sendInitialize(remoteUrl, options, `Bearer ${apiKey}`);
  if ('failure' in attempt) return 'unusable';
  const { response } = attempt;

  if (response.status === 401 || response.status === 403) return 'rejected';
  if (isOAuthRequired(response.status, response.headers)) return 'rejected';

  if (response.ok) {
    return isInitializeResult(await response.text()) ? 'accepted' : 'unusable';
  }

  return 'unusable';
}

/** @deprecated Use the scheme-explicit name. */
export const probeRemoteApiKey = probeRemoteBearerToken;
