import { type OutboundDnsLookup, safeOutboundFetch } from '@agor/core/utils/safe-outbound-fetch';
import {
  MCPEgressGatewayError,
  publicResponseHeaders,
  validateBufferedMCPResponse,
} from './gateway.js';

/**
 * Discovery/non-task companion to the gateway. Acquisition is not admission:
 * the caller must reload local authority and verify the signed authorization
 * for this exact bearer at the pre-socket assertion on EVERY physical request.
 * There is no GET/event channel, redirect, endpoint handoff or raw SDK fallback.
 */
export function createManagedMCPFetch(options: {
  url: string;
  authorization: string;
  assertCurrent: (authorization: string) => Promise<void>;
  resolveDns?: OutboundDnsLookup;
  /** Owned fake-provider tests only; production callers leave this absent. */
  allowLocalhostHttp?: boolean;
}): typeof globalThis.fetch {
  const destination = new URL(options.url).href;
  if (!/^Bearer [^\s]+$/.test(options.authorization)) {
    throw new MCPEgressGatewayError(
      401,
      'managed_authority_invalid',
      'Managed authority unavailable'
    );
  }
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== destination || (request.method !== 'POST' && request.method !== 'DELETE')) {
      throw new MCPEgressGatewayError(
        403,
        'managed_transport_not_mediated',
        'Agor-managed sign-in requires bounded Streamable HTTP.'
      );
    }
    // Ignore SDK authentication/custom headers. The fixed bearer is daemon-owned.
    const headers = new Headers({ Authorization: options.authorization });
    for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    let body: Uint8Array | undefined;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 4 * 1024 * 1024) {
            cancel();
            throw new MCPEgressGatewayError(413, 'request_too_large', 'MCP request is too large');
          }
          chunks.push(chunk.value);
        }
        body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
    }
    const response = await safeOutboundFetch(destination, {
      method: request.method,
      headers,
      body: request.method === 'DELETE' ? undefined : body,
      redirect: 'error',
      timeoutMs: 30_000,
      maxResponseBytes: 16 * 1024 * 1024,
      signal,
      resolveDns: options.resolveDns,
      allowLocalhostHttp: options.allowLocalhostHttp === true,
      assertCurrent: () => options.assertCurrent(options.authorization),
    });
    const secrets = [options.authorization, options.authorization.slice('Bearer '.length)];
    const released = validateBufferedMCPResponse(
      response,
      new Uint8Array(await response.arrayBuffer()),
      secrets,
      body
    );
    return new Response(released.byteLength ? released : null, {
      status: response.status,
      headers: publicResponseHeaders(response.headers, secrets),
    });
  };
}
