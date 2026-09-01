/**
 * Narrow outbound HTTP primitive for secret-bearing OAuth traffic.
 *
 * It validates every destination, resolves all addresses before connecting,
 * rejects non-public destinations, pins the validated address into the socket
 * lookup callback (DNS-rebinding defense), and revalidates every redirect.
 */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  // Transition/tunnel ranges can encode an IPv4 destination and bypass an
  // IPv4-only denylist. Fail closed instead of recursively decoding every
  // operating-system resolver representation.
  ['2001::', 32],
  ['2002::', 16],
  ['2001:db8::', 32],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

export class UnsafeOutboundUrlError extends Error {
  readonly code = 'unsafe_outbound_url';
  constructor(message = 'Outbound OAuth destination is not allowed') {
    super(message);
    this.name = 'UnsafeOutboundUrlError';
  }
}

/**
 * The caller-owned authority/cancellation fence rejected before a socket was
 * constructed. This is deliberately distinct from a transport failure after
 * dispatch: no request bytes could have reached the destination.
 */
export class OutboundPreDispatchAuthorityError extends Error {
  readonly code = 'outbound_pre_dispatch_authority_rejected';

  constructor(readonly authorityCause: unknown) {
    super('Outbound request authority changed before dispatch');
    this.name = 'OutboundPreDispatchAuthorityError';
  }
}

export interface SafeOutboundFetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  redirect?: 'error' | 'follow';
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  /** Exact localhost/loopback HTTP exception for standalone development. */
  allowLocalhostHttp?: boolean;
  /**
   * Optional caller-owned authority fence for credential-bearing requests.
   * Checked once immediately before every physical dispatch. Redirects are
   * separate dispatches and therefore receive a separate check.
   */
  assertCurrent?: () => void | Promise<void>;
  /** Abort an already-admitted provider request as an availability accelerator. */
  signal?: AbortSignal;
  /** Injectable DNS boundary for deterministic authority-race tests. */
  resolveDns?: OutboundDnsLookup;
}

export type OutboundDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: number }>>;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647;

function outboundTimeoutError(): Error {
  return new Error('Outbound OAuth timeout');
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : outboundTimeoutError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Race work such as DNS lookup that does not itself accept an AbortSignal. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function isLoopback(address: string, family: 4 | 6): boolean {
  if (family === 4) return address.startsWith('127.');
  return address === '::1';
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function assertSafeParsedUrl(url: URL, allowLocalhostHttp: boolean): void {
  if (url.username || url.password || url.hash) throw new UnsafeOutboundUrlError();
  const hostname = normalizedHostname(url).toLowerCase();
  const literalFamily = isIP(hostname) as 0 | 4 | 6;
  const literalLoopback =
    literalFamily === 4 ? isLoopback(hostname, 4) : literalFamily === 6 && isLoopback(hostname, 6);
  const loopbackHttpException = allowLocalhostHttp && url.protocol === 'http:' && literalLoopback;
  if (url.protocol !== 'https:') {
    const localhostName = hostname.toLowerCase() === 'localhost';
    if (!(allowLocalhostHttp && url.protocol === 'http:' && (localhostName || literalLoopback))) {
      throw new UnsafeOutboundUrlError('OAuth endpoints require HTTPS');
    }
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal'
  ) {
    if (allowLocalhostHttp && url.protocol === 'http:' && hostname === 'localhost') return;
    throw new UnsafeOutboundUrlError();
  }
  if (
    literalFamily !== 0 &&
    !loopbackHttpException &&
    (literalFamily === 4
      ? blocked.check(hostname, 'ipv4')
      : !publicIpv6.check(hostname, 'ipv6') || blocked.check(hostname, 'ipv6'))
  ) {
    throw new UnsafeOutboundUrlError();
  }
}

async function resolvePinnedAddress(
  url: URL,
  allowLocalhostHttp: boolean,
  signal: AbortSignal,
  resolveDns: OutboundDnsLookup
): Promise<{ address: string; family: 4 | 6 }> {
  throwIfAborted(signal);
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await withAbort(resolveDns(hostname, { all: true, verbatim: true }), signal);
  throwIfAborted(signal);
  if (addresses.length === 0) throw new UnsafeOutboundUrlError('OAuth destination did not resolve');
  for (const candidate of addresses) {
    const family = candidate.family as 4 | 6;
    const loopbackDev =
      allowLocalhostHttp && url.protocol === 'http:' && isLoopback(candidate.address, family);
    if (allowLocalhostHttp && url.protocol === 'http:' && !loopbackDev) {
      throw new UnsafeOutboundUrlError('Localhost HTTP must resolve only to loopback addresses');
    }
    const nonPublicIpv6 = family === 6 && !publicIpv6.check(candidate.address, 'ipv6');
    if (
      !loopbackDev &&
      (nonPublicIpv6 || blocked.check(candidate.address, family === 4 ? 'ipv4' : 'ipv6'))
    ) {
      throw new UnsafeOutboundUrlError();
    }
  }
  return addresses[0] as { address: string; family: 4 | 6 };
}

async function resolveSafeOutboundTarget(
  input: string | URL,
  options: Pick<SafeOutboundFetchOptions, 'allowLocalhostHttp' | 'resolveDns'>,
  signal: AbortSignal
): Promise<{ url: URL; pinned: { address: string; family: 4 | 6 } }> {
  const url = new URL(input);
  const allowLocalhostHttp = options.allowLocalhostHttp === true;
  assertSafeParsedUrl(url, allowLocalhostHttp);
  const pinned = await resolvePinnedAddress(
    url,
    allowLocalhostHttp,
    signal,
    options.resolveDns ?? lookup
  );
  return { url, pinned };
}

/**
 * Adapt one already-validated address to Node's two lookup callback contracts.
 * `http(s).request` asks for `all: true` when auto-selecting a family and
 * requires an address array in that mode; returning a scalar makes Node read
 * an undefined address before it opens the socket.
 */
export function createPinnedLookup(pinned: { address: string; family: 4 | 6 }): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function requestBody(body: unknown): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return body;
  throw new UnsafeOutboundUrlError('Unsupported outbound OAuth request body');
}

function hasCallerHeaders(headers: RequestInit['headers']): boolean {
  return !new Headers(headers).keys().next().done;
}

async function requestOnce(
  url: URL,
  options: SafeOutboundFetchOptions,
  signal: AbortSignal
): Promise<Response> {
  let pinned: { address: string; family: 4 | 6 };
  try {
    throwIfAborted(signal);
    ({ pinned } = await resolveSafeOutboundTarget(url, options, signal));
  } catch (error) {
    // A caller cancellation while validating DNS is known to precede socket
    // construction. Preserve that fact instead of classifying it as an
    // ambiguous transport failure. The deadline signal is intentionally not
    // included: only the explicit caller-owned authority signal qualifies.
    if (options.signal?.aborted) {
      throw new OutboundPreDispatchAuthorityError(options.signal.reason ?? error);
    }
    throw error;
  }
  const body = requestBody(options.body);
  const headers = new Headers(options.headers);
  if (body != null && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)));
  }
  const requestImpl = url.protocol === 'https:' ? https.request : http.request;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  const pinnedLookup = createPinnedLookup(pinned);

  // DNS validation may itself have awaited. Re-ask immediately before opening
  // the socket so a caller cannot lose authority during lookup and still send
  // the captured headers/body.
  try {
    await options.assertCurrent?.();
  } catch (error) {
    throw new OutboundPreDispatchAuthorityError(error);
  }
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseStream: http.IncomingMessage | undefined;
    let request: http.ClientRequest | undefined;
    const cleanup = () => signal.removeEventListener('abort', abortRequest);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortRequest = () => {
      const error = abortReason(signal);
      fail(error);
      responseStream?.destroy();
      request?.destroy();
    };
    signal.addEventListener('abort', abortRequest, { once: true });
    if (signal.aborted) {
      abortRequest();
      return;
    }
    request = requestImpl(
      url,
      {
        method: options.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        // The TLS SNI/Host remain the validated URL hostname, while connection
        // address selection cannot perform a second DNS lookup.
        lookup: pinnedLookup,
        // Never reuse a socket opened before this request's DNS validation. A
        // pooled global agent can bypass the lookup callback entirely.
        agent: false,
        servername: isIP(normalizedHostname(url)) ? undefined : normalizedHostname(url),
      },
      (response) => {
        responseStream = response;
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            const error = new UnsafeOutboundUrlError('Outbound OAuth response is too large');
            response.destroy();
            request?.destroy();
            fail(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
            else if (value != null) responseHeaders.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage,
              headers: responseHeaders,
            })
          );
        });
        response.on('error', fail);
      }
    );
    request.on('error', fail);
    if (body != null) request.write(body);
    request.end();
  });
}

export async function safeOutboundFetch(
  input: string | URL,
  options: SafeOutboundFetchOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new UnsafeOutboundUrlError('Outbound OAuth timeout is invalid');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(outboundTimeoutError()), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([deadline.signal, options.signal])
    : deadline.signal;
  try {
    let url = new URL(input);
    const callerHeadersPresent = hasCallerHeaders(options.headers);
    const redirectMode = options.redirect ?? 'error';
    const maxRedirects = options.maxRedirects ?? 3;
    for (let hop = 0; ; hop += 1) {
      // requestOnce performs the single authority check immediately after DNS
      // validation and before it constructs the socket. Do not add checks on
      // response/error paths: they do not fence another outbound side effect
      // and would multiply admission queries for every call.
      const response = await requestOnce(url, options, signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirectMode !== 'follow' || hop >= maxRedirects) {
        throw new UnsafeOutboundUrlError('Outbound OAuth redirect is not allowed');
      }
      const location = response.headers.get('location');
      if (!location) throw new UnsafeOutboundUrlError('Outbound OAuth redirect is invalid');
      const redirectUrl = new URL(location, url);
      // Metadata fetches are GET. Secret-bearing POST endpoints use redirect:error.
      if ((options.method ?? 'GET').toUpperCase() !== 'GET') {
        throw new UnsafeOutboundUrlError('Secret-bearing OAuth requests cannot redirect');
      }
      // Custom MCP headers may be API keys even when their names are not
      // standardized. Unlike ambient fetch headers, they must never cross an
      // origin boundary. Same-origin redirects retain the caller's contract;
      // headerless metadata discovery may continue to a separately hosted
      // public origin after the normal destination checks run on the next hop.
      if (callerHeadersPresent && redirectUrl.origin !== url.origin) {
        throw new UnsafeOutboundUrlError(
          'Cross-origin OAuth redirects cannot forward caller headers'
        );
      }
      url = redirectUrl;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate and resolve an OAuth destination without opening a socket.
 *
 * This is for read-only readiness checks. It deliberately shares the exact
 * parsed-URL, HTTPS, DNS, and public-address predicate used by
 * {@link safeOutboundFetch}. Callers that subsequently send a request must
 * still use `safeOutboundFetch`: it repeats this resolution and pins that
 * checked address into the request lookup, avoiding a check/use DNS race.
 */
export async function assertSafeOutboundUrl(
  input: string | URL,
  options: Pick<
    SafeOutboundFetchOptions,
    'allowLocalhostHttp' | 'resolveDns' | 'signal' | 'timeoutMs'
  > = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new UnsafeOutboundUrlError('Outbound OAuth timeout is invalid');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(outboundTimeoutError()), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([deadline.signal, options.signal])
    : deadline.signal;
  try {
    throwIfAborted(signal);
    await resolveSafeOutboundTarget(input, options, signal);
  } finally {
    clearTimeout(timer);
  }
}

export function assertSafeOAuthUrl(
  input: string,
  options: { allowLocalhostHttp?: boolean } = {}
): URL {
  const url = new URL(input);
  assertSafeParsedUrl(url, options.allowLocalhostHttp === true);
  return url;
}
