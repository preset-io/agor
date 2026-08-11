import {
  bindMCPOAuthRedirectUriToIssuer,
  startMCPOAuthFlow,
} from '@agor/core/tools/mcp/oauth-mcp-transport';
import type { MCPOAuthAttemptID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStartedMCPOAuthFlowResult } from './mcp-oauth-start-result.js';

vi.mock('@agor/core/utils/safe-outbound-fetch', () => ({
  assertSafeOAuthUrl: (input: string) => new URL(input),
  safeOutboundFetch: (input: string | URL, options: Record<string, unknown> = {}) => {
    const {
      timeoutMs: _timeout,
      maxRedirects: _maxRedirects,
      maxResponseBytes: _maxResponseBytes,
      allowLocalhostHttp: _allowLocalhostHttp,
      ...init
    } = options;
    return globalThis.fetch(input, init as RequestInit);
  },
}));

describe('daemon MCP OAuth start result', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the issuer-bound URI used by authorization and DCR', async () => {
    const issuer = 'https://provider.example.test';
    const resourceUri = 'https://mcp.example.test/mcp';
    const metadataUri = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
    const callbackBase = 'https://agor.example.test/mcp-oauth-v2/callback';
    let registeredRedirectUri: string | undefined;
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === metadataUri) {
        return new Response(
          JSON.stringify({ resource: resourceUri, authorization_servers: [issuer] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === `${issuer}/.well-known/oauth-authorization-server`) {
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      expect(url).toBe(`${issuer}/register`);
      const registration = JSON.parse(String(init?.body)) as { redirect_uris?: string[] };
      registeredRedirectUri = registration.redirect_uris?.[0];
      return new Response(
        JSON.stringify({
          client_id: 'registered-client',
          redirect_uris: registration.redirect_uris,
          token_endpoint_auth_method: 'none',
          response_types: ['code'],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const context = await startMCPOAuthFlow(
      `Bearer resource_metadata="${metadataUri}"`,
      undefined,
      callbackBase,
      {
        resourceUri,
        compatibilityMode: 'issuer_redirect',
        dcrMode: 'advertised',
        reuseDynamicClientRegistration: false,
        useIssuerDistinctRedirectUri: true,
      }
    );
    const result = createStartedMCPOAuthFlowResult(context, 'attempt-1' as MCPOAuthAttemptID);
    const expected = bindMCPOAuthRedirectUriToIssuer(callbackBase, issuer);

    expect(result.redirectUri).toBe(expected);
    expect(new URL(result.authorizationUrl).searchParams.get('redirect_uri')).toBe(expected);
    expect(registeredRedirectUri).toBe(expected);
  });
});
