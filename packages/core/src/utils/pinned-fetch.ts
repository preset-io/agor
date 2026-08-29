/**
 * Outbound HTTP for destinations the daemon does not trust.
 *
 * `isPublicHttpUrl` can only judge the URL it was handed. `https://evil.example`
 * passes it and then resolves to 169.254.169.254, so a filter that inspects the
 * string and hands the string to `fetch` never sees the address it connects to.
 * Closing that means the check and the connection must observe the same answer:
 * resolve the name once, reject unless *every* address is public, and connect to
 * an address that was checked.
 *
 * Node's `lookup` hook on `http(s).request` is that seam — `net` calls it and
 * connects to whatever it returns, so there is no second resolution to race.
 * Global `fetch` exposes no equivalent without pulling in a dispatcher library,
 * which is why this is built on `node:https` instead. TLS is unaffected:
 * `servername` still comes from the URL, so SNI and certificate validation see
 * the real hostname while the socket goes to the pinned address.
 *
 * Node-only, and deliberately not in `utils/url.ts`: that module is imported by
 * the browser bundle. The address classifier it shares lives there.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPrivateIpAddress, isPublicHttpUrl } from './url';

/**
 * `code` on every error raised because a destination was refused, as opposed to
 * one that was attempted and failed. Callers distinguish "we declined to go
 * there" from "the host did not answer", which are different things to report.
 */
export const OUTBOUND_REFUSED_CODE = 'EAGOROUTBOUND';

/** True when an error came from the outbound filter rather than the network. */
export function isOutboundRefusal(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === OUTBOUND_REFUSED_CODE;
}

function refuse(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = OUTBOUND_REFUSED_CODE;
  return error;
}

/** Shape of `dns.lookup` when asked for every answer. */
export type DnsLookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

/**
 * Wrap a resolver so a name that answers with any non-public address fails to
 * connect at all.
 *
 * Every answer is checked, not just the one returned. A resolver that hands back
 * both a public and a loopback address would otherwise be a coin flip, and
 * `autoSelectFamily` makes Node try more than the first entry anyway.
 *
 * Failing the lookup — rather than filtering the list down to the public
 * entries — is what makes this safe against a rebinding record: there is no
 * "some of these were fine" outcome to be talked into.
 */
export function createGuardedLookup(resolve: DnsLookupAll = dns.lookup as unknown as DnsLookupAll) {
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      const answers = Array.isArray(addresses) ? addresses : [];
      if (answers.length === 0) {
        callback(new Error(`No address for ${hostname}`), '', 4);
        return;
      }
      const blocked = answers.find((answer) => isPrivateIpAddress(answer.address));
      if (blocked) {
        callback(refuse(`Refusing to connect: ${hostname} resolves to ${blocked.address}`), '', 4);
        return;
      }
      if (options?.all) {
        callback(null, answers as never);
        return;
      }
      callback(null, answers[0].address, answers[0].family);
    });
  };
  return lookup;
}

export interface PinnedFetchOptions {
  /** Wall-clock budget for the whole request, headers and body together. */
  timeoutMs: number;
  /** Cap on the response body. A refused body is an error, never a truncation. */
  maxBytes: number;
  /**
   * Resolver seam. Tests substitute one to exercise the HTTP mechanics against a
   * loopback server; production leaves it alone and gets the guarded default.
   */
  lookup?: LookupFunction;
  /**
   * Stop reading once the body so far is all the caller needed.
   *
   * A streamable-HTTP MCP server answers `initialize` over an SSE stream it then
   * holds open for the rest of the session. Reading to `end` would stall until
   * the timeout and report a healthy server as unreachable, so a caller that can
   * recognise a complete answer says so here.
   */
  isBodyComplete?: (text: string) => boolean;
}

function toOutgoingHeaders(init: RequestInit['headers']): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!init) return headers;
  new Headers(init).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** Statuses that must not carry a body, per the `Response` constructor. */
function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/**
 * Build a fetch-shaped function that only ever connects to public addresses.
 *
 * Redirects are never followed — `http.request` does not follow them — so a
 * `3xx` is returned to the caller as-is. That is the same contract as
 * `redirect: 'manual'`, and it means every hop a caller chooses to follow comes
 * back through this function and is re-checked.
 *
 * Rejects rather than returning an error response, because the discovery code
 * this feeds already treats a thrown fetch as "that candidate failed".
 */
export function createPinnedFetch(
  options: PinnedFetchOptions
): (input: string, init?: RequestInit) => Promise<Response> {
  const lookup = options.lookup ?? createGuardedLookup();

  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      if (!isPublicHttpUrl(input)) {
        reject(refuse(`Refusing to fetch non-public URL: ${input}`));
        return;
      }
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
        return;
      }
      const url = new URL(input);
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== 'string') {
        reject(new Error('Pinned fetch only sends string bodies'));
        return;
      }

      const transport = url.protocol === 'https:' ? https : http;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let request: http.ClientRequest | undefined;
      const abort = () => {
        request?.destroy(
          signal?.reason instanceof Error ? signal.reason : new Error('Request aborted')
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        run();
      };

      request = transport.request(
        url,
        {
          method: init?.method ?? 'GET',
          headers: toOutgoingHeaders(init?.headers),
          lookup,
          // A one-off socket, never the shared global agent. That agent pools by
          // `host:port` across the whole process, so a keep-alive socket opened
          // by any other caller would be handed to this request and `lookup`
          // would never run — the guard silently skipped for exactly the hosts
          // most likely to be requested twice.
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;

          const complete = (): void => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status > 599) {
              finish(() => reject(new Error(`Unusable status ${status} from ${input}`)));
              return;
            }
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(key, item);
              else if (value !== undefined) headers.set(key, value);
            }
            const text = Buffer.concat(chunks).toString('utf8');
            finish(() =>
              resolve(new Response(isNullBodyStatus(status) ? null : text, { status, headers }))
            );
          };

          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > options.maxBytes) {
              response.destroy();
              finish(() =>
                reject(new Error(`Response exceeded ${options.maxBytes} bytes: ${input}`))
              );
              return;
            }
            chunks.push(chunk);
            if (settled || !options.isBodyComplete) return;
            // Decoding the accumulated bytes each chunk is affordable at these
            // caps, and splitting a multi-byte character across chunks would
            // otherwise make the predicate see mojibake.
            if (options.isBodyComplete(Buffer.concat(chunks).toString('utf8'))) {
              complete();
              response.destroy();
            }
          });
          response.on('end', complete);
          response.on('error', (error) => finish(() => reject(error)));
        }
      );

      // `request.setTimeout` is an idle-socket timer, which a host trickling one
      // byte at a time never trips. This bounds the whole exchange.
      timer = setTimeout(() => {
        request?.destroy(new Error(`Timed out after ${options.timeoutMs}ms: ${input}`));
      }, options.timeoutMs);

      request.on('error', (error) => finish(() => reject(error)));
      if (typeof body === 'string') request.write(body);
      request.end();
    });
}
