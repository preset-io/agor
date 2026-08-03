import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export type EgressAddressPolicy = 'public' | 'health';

export interface SafeFetchOptions extends RequestInit {
  addressPolicy?: EgressAddressPolicy;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  /** Test seam. Production callers must not override DNS. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

const PUBLIC_PORTS = new Set([80, 443]);
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isSpecialUseAddress(address: string, policy: EgressAddressPolicy): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const alwaysBlocked = [
      ['0.0.0.0', 8],
      ['169.254.0.0', 16],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ] as const;
    if (alwaysBlocked.some(([base, prefix]) => inV4Range(address, base, prefix))) return true;
    if (policy === 'public') {
      return [
        ['10.0.0.0', 8],
        ['100.64.0.0', 10],
        ['127.0.0.0', 8],
        ['172.16.0.0', 12],
        ['192.168.0.0', 16],
      ].some(([base, prefix]) => inV4Range(address, base as string, prefix as number));
    }
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isSpecialUseAddress(mapped[1], policy);
    const mappedHex = normalized.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isSpecialUseAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, policy);
    }
    if (normalized === '::' || normalized === '::1') return policy === 'public';
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    if (first >= 0xfe80 && first <= 0xfebf) return true;
    if (first >= 0xff00) return true;
    if (/^2001:db8:/i.test(normalized)) return true;
    if (policy === 'public' && first >= 0xfc00 && first <= 0xfdff) return true;
    if (policy === 'public' && (first < 0x2000 || first > 0x3fff)) return true;
    return false;
  }
  return true;
}

function validateUrl(url: URL, policy: EgressAddressPolicy): void {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Outbound URL must use HTTP(S)');
  if (url.username || url.password) throw new Error('Outbound URL must not contain credentials');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Outbound URL has an invalid port');
  if (policy === 'public' && !PUBLIC_PORTS.has(port))
    throw new Error('Outbound URL port is blocked');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'metadata.google.internal' || hostname.endsWith('.metadata.google.internal')) {
    throw new Error('Outbound destination is blocked');
  }
  if (
    policy === 'public' &&
    (hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal'))
  ) {
    throw new Error('Outbound destination is blocked');
  }
}

async function resolveAllowed(
  url: URL,
  policy: EgressAddressPolicy,
  lookup: NonNullable<SafeFetchOptions['lookup']>
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const results = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookup(hostname);
  if (!results.length || results.some(({ address }) => isSpecialUseAddress(address, policy))) {
    throw new Error('Outbound destination resolves to a blocked address');
  }
  return results[0];
}

function headersObject(headers?: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

/**
 * Daemon-safe HTTP client. DNS is resolved once, every answer is validated, and
 * the selected address is pinned into the socket lookup to prevent rebinding.
 */
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {}
): Promise<Response> {
  // Existing OAuth unit tests replace fetch with a Vitest spy. Keep that test
  // seam without permitting production callers to swap out the pinned client.
  if (
    process.env.VITEST &&
    (globalThis.fetch as typeof fetch & { _isMockFunction?: boolean })._isMockFunction
  ) {
    return globalThis.fetch(input, options);
  }
  const policy = options.addressPolicy ?? 'public';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const lookup =
    options.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  let url = new URL(input);
  let method = options.method ?? 'GET';
  let body = options.body;
  let headers = headersObject(options.headers);
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'accept-encoding')) {
    headers['accept-encoding'] = 'identity';
  }

  for (let redirects = 0; ; redirects += 1) {
    validateUrl(url, policy);
    const resolved = await resolveAllowed(url, policy, lookup);
    const response = await new Promise<Response>((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('Outbound request timed out')),
        timeoutMs
      );
      const externalAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', externalAbort, { once: true });
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        url,
        {
          method,
          headers,
          signal: controller.signal,
          lookup: (_hostname, _opts, callback) => callback(null, resolved.address, resolved.family),
          ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxResponseBytes)
              request.destroy(new Error('Outbound response exceeded size limit'));
            else chunks.push(chunk);
          });
          incoming.on('end', () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', externalAbort);
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value))
                value.forEach((item) => {
                  responseHeaders.append(name, item);
                });
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            const status = incoming.statusCode ?? 500;
            const responseBody =
              method === 'HEAD' || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
            resolve(
              new Response(responseBody, {
                status,
                headers: responseHeaders,
              })
            );
          });
        }
      );
      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      if (body) request.write(body as string | Uint8Array);
      request.end();
    });

    const location = response.headers.get('location');
    if (
      !location ||
      response.status < 300 ||
      response.status >= 400 ||
      options.redirect === 'manual'
    )
      return response;
    if (options.redirect === 'error') throw new Error('Outbound redirect is not permitted');
    if (redirects >= maxRedirects) throw new Error('Outbound redirect limit exceeded');
    const next = new URL(location, url);
    const sameOrigin = next.origin === url.origin;
    if (!sameOrigin) {
      if (url.protocol === 'https:' && next.protocol !== 'https:') {
        throw new Error('Refusing an HTTPS downgrade redirect');
      }
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        throw new Error('Refusing to forward request credentials or body across origins');
      }
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) =>
          CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLowerCase())
        )
      );
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) => !['content-type', 'content-length'].includes(name.toLowerCase())
        )
      );
    }
    url = next;
  }
}
