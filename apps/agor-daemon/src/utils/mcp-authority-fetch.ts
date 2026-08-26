/**
 * Fetch adapter for the MCP SDK's multi-request Streamable HTTP handshake.
 *
 * `Client.connect()` is not one network operation: the SDK can POST
 * `initialize`, then POST `notifications/initialized`, and later issue more
 * requests before the aggregate promise resolves. Guard each dispatch rather
 * than trusting a wrapper around `connect()`.
 */

export type AuthorityAwareFetch = (
  input: string | URL | Request,
  init?: RequestInit,
  assertCurrent?: () => void
) => Promise<Response>;

export function createAuthorityGuardedMCPFetch(
  outboundFetch: AuthorityAwareFetch,
  assertCurrent?: () => void
): typeof fetch {
  let sessionId: string | undefined;

  return async (input, init) => {
    assertCurrent?.();

    let effectiveInit = init;
    if (sessionId) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      if (!headers.has('mcp-session-id')) headers.set('mcp-session-id', sessionId);
      effectiveInit = { ...init, headers };
    }

    try {
      // `outboundFetch` threads the same assertion into redirect handling, so
      // every physical hop is fenced as well as every SDK-level request.
      const response = await outboundFetch(input, effectiveInit, assertCurrent);
      assertCurrent?.();
      const responseSessionId = response.headers.get('mcp-session-id');
      if (responseSessionId) sessionId = responseSessionId;
      return response;
    } catch (error) {
      // Authority loss wins over a simultaneous transport error. Callers must
      // not interpret identity replacement as a retryable MCP failure.
      assertCurrent?.();
      throw error;
    }
  };
}
