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

export interface SafeOutboundFetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  redirect?: 'error' | 'follow';
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  /** Exact localhost/loopback HTTP exception for standalone development. */
  allowLocalhostHttp?: boolean;
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
  allowLocalhostHttp: boolean
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
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

function requestBody(body: unknown): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return body;
  throw new UnsafeOutboundUrlError('Unsupported outbound OAuth request body');
}

async function requestOnce(url: URL, options: SafeOutboundFetchOptions): Promise<Response> {
  assertSafeParsedUrl(url, options.allowLocalhostHttp === true);
  const pinned = await resolvePinnedAddress(url, options.allowLocalhostHttp === true);
  const body = requestBody(options.body);
  const headers = new Headers(options.headers);
  if (body != null && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)));
  }
  const requestImpl = url.protocol === 'https:' ? https.request : http.request;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = requestImpl(
      url,
      {
        method: options.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        // The TLS SNI/Host remain the validated URL hostname, while connection
        // address selection cannot perform a second DNS lookup.
        lookup: (_hostname, _lookupOptions, callback) =>
          callback(null, pinned.address, pinned.family),
        servername: isIP(normalizedHostname(url)) ? undefined : normalizedHostname(url),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            const error = new UnsafeOutboundUrlError('Outbound OAuth response is too large');
            response.destroy();
            request.destroy();
            fail(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
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
    request.setTimeout(timeoutMs, () => {
      const error = new Error('Outbound OAuth timeout');
      request.destroy();
      fail(error);
    });
    request.on('error', fail);
    if (body != null) request.write(body);
    request.end();
  });
}

export async function safeOutboundFetch(
  input: string | URL,
  options: SafeOutboundFetchOptions = {}
): Promise<Response> {
  let url = new URL(input);
  const redirectMode = options.redirect ?? 'error';
  const maxRedirects = options.maxRedirects ?? 3;
  for (let hop = 0; ; hop += 1) {
    const response = await requestOnce(url, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectMode !== 'follow' || hop >= maxRedirects) {
      throw new UnsafeOutboundUrlError('Outbound OAuth redirect is not allowed');
    }
    const location = response.headers.get('location');
    if (!location) throw new UnsafeOutboundUrlError('Outbound OAuth redirect is invalid');
    url = new URL(location, url);
    // Metadata fetches are GET. Secret-bearing POST endpoints use redirect:error.
    if ((options.method ?? 'GET').toUpperCase() !== 'GET') {
      throw new UnsafeOutboundUrlError('Secret-bearing OAuth requests cannot redirect');
    }
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
