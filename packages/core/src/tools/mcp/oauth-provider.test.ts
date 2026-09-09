import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import { asMCPExternalError, sanitizeMCPExternalError } from './external-error';
import { getOAuthDCRDiagnostic, OAuthDCRFailure, startMCPOAuthFlow } from './oauth-mcp-transport';
import { OAUTH_PROVIDER_FIXTURES } from './oauth-provider.test-fixtures';

vi.mock('../../utils/safe-outbound-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/safe-outbound-fetch')>()),
  safeOutboundFetch: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const redirect = 'https://cell.example.test/mcp-servers/oauth-callback';

function resolve(provider: (typeof OAUTH_PROVIDER_FIXTURES)[number] = OAUTH_PROVIDER_FIXTURES[0]) {
  const registration = vi.mocked(safeOutboundFetch).getMockImplementation()!;
  const metadataUrl = new URL('/.well-known/oauth-protected-resource', provider.url).href;
  vi.mocked(safeOutboundFetch).mockImplementation((url, options) => {
    if (options?.method === 'POST') return registration(url, options);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          String(url) === metadataUrl
            ? { resource: provider.url, authorization_servers: [provider.metadata.issuer] }
            : provider.metadata
        ),
        { status: 200 }
      )
    );
  });
  return startMCPOAuthFlow('', undefined, redirect, {
    resourceMetadataUrl: metadataUrl,
    resourceUri: provider.url,
    compatibilityMode: 'marketplace',
    reuseDynamicClientRegistration: false,
  });
}

describe('provider-shaped DCR boundaries (no live registrations)', () => {
  it.each(OAUTH_PROVIDER_FIXTURES)(
    '$label preserves the registration boundary',
    async (provider) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const rejected = provider.modeledRegistration === 'rejected';
      vi.mocked(safeOutboundFetch).mockResolvedValue(
        new Response(
          JSON.stringify(
            rejected
              ? {
                  error: 'invalid_redirect_uri',
                  error_description: 'SENTINEL tenant/secret?token=private',
                }
              : {
                  client_id: 'synthetic-client',
                  redirect_uris: [redirect],
                  token_endpoint_auth_method: 'none',
                }
          ),
          { status: rejected ? 400 : 201 }
        )
      );
      if (rejected) {
        const error = await resolve(provider).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(OAuthDCRFailure);
        const safe = sanitizeMCPExternalError(error, { stage: 'oauth' });
        expect(safe).toMatchObject({
          category: 'provider_rejected',
          diagnostic: {
            stage: 'dcr_registration',
            type: 'OAuthDCRFailure',
            status: 400,
            reason: 'invalid_redirect_uri',
            registration_endpoint_source: 'metadata',
          },
        });
        // Re-wrapping at another boundary cannot lose DCR status/provenance.
        expect(
          sanitizeMCPExternalError(asMCPExternalError(error, { stage: 'oauth' }), {
            stage: 'runtime',
          })
        ).toEqual(safe);
        expect(JSON.stringify(safe)).not.toMatch(/SENTINEL|https:|synthetic-client/);
      } else {
        // An echo can be validated, not a vendor's private authorization allowlist.
        await expect(resolve(provider)).resolves.toMatchObject({ clientId: 'synthetic-client' });
      }
      const posts = vi
        .mocked(safeOutboundFetch)
        .mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(1);
      const [endpoint, request] = posts[0]!;
      expect(endpoint).toBe(provider.metadata.registration_endpoint);
      expect(request).toMatchObject({ method: 'POST', redirect: 'error', maxResponseBytes: 16384 });
      expect(JSON.parse(request?.body as string)).toMatchObject({
        application_type: 'web',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }
  );

  it.each([
    [
      {
        client_id: 'x',
        client_secret: 'SENTINEL',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'client_secret_post',
      },
      'registration_auth_method_unsupported',
    ],
    [{ client_id: 'x' }, 'registration_redirect_mismatch'],
    [
      { client_id: 'x', redirect_uris: ['https://other.example/callback'] },
      'registration_redirect_mismatch',
    ],
    [{ redirect_uris: [redirect] }, 'registration_response_invalid'],
    [
      { client_id: 'x', redirect_uris: [redirect], token_endpoint_auth_method: 'private_key_jwt' },
      'registration_auth_method_unsupported',
    ],
  ])(
    'rejects incompatible DCR responses without weakening redirect/auth checks (%#)',
    async (body, reason) => {
      vi.mocked(safeOutboundFetch).mockResolvedValue(
        new Response(JSON.stringify(body), { status: 201 })
      );
      const error = await resolve().catch((error: unknown) => error);
      expect(sanitizeMCPExternalError(error, { stage: 'oauth' })).toMatchObject({
        category: 'invalid_response',
        diagnostic: { status: 201, reason, type: 'OAuthDCRFailure' },
      });
    }
  );

  it.each([401, 403, 404, 429, 500, 503])(
    'retains closed HTTP %i, not arbitrary provider codes',
    async (status) => {
      vi.mocked(safeOutboundFetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'SENTINEL', error_description: 'SENTINEL' }), {
          status,
        })
      );
      const error = await resolve().catch((error: unknown) => error);
      const safe = sanitizeMCPExternalError(error, { stage: 'oauth' });
      expect(safe.diagnostic).toMatchObject({ status, reason: 'registration_rejected' });
      expect(safe.category).toBe(
        status === 429 || status >= 500 ? 'provider_unavailable' : 'provider_rejected'
      );
      expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    }
  );

  it('bounds network, invalid JSON and missing-endpoint diagnostics', async () => {
    vi.mocked(safeOutboundFetch).mockRejectedValue(new Error('SENTINEL https://private/?secret'));
    const network = await resolve().catch((error: unknown) => error);
    expect(sanitizeMCPExternalError(network, { stage: 'oauth' })).toMatchObject({
      category: 'provider_unavailable',
      diagnostic: { reason: 'registration_transport_failed' },
    });
    vi.mocked(safeOutboundFetch).mockResolvedValue(
      new Response('SENTINEL invalid JSON', { status: 200 })
    );
    const malformed = await resolve().catch((error: unknown) => error);
    expect(getOAuthDCRDiagnostic(malformed)).toMatchObject({
      reason: 'registration_response_invalid',
      http_status: 200,
    });
  });
});

describe('nominal closed diagnostics', () => {
  it('rejects forged errors, proxies, accessors and subsequent mutation', () => {
    const getter = vi.fn(() => {
      throw new Error('SENTINEL');
    });
    const diagnostic = {
      stage: 'dcr_registration' as const,
      http_status: 400,
      reason: 'invalid_redirect_uri' as const,
    };
    const real = new OAuthDCRFailure('SENTINEL', diagnostic);
    diagnostic.http_status = 500;
    Object.defineProperty(real, 'diagnostic', { get: getter });
    expect(sanitizeMCPExternalError(real, { stage: 'oauth' }).diagnostic.status).toBe(400);
    for (const fake of [
      { name: 'OAuthDCRFailure', diagnostic },
      Object.create(OAuthDCRFailure.prototype),
      new Proxy({}, { get: getter, getPrototypeOf: getter, getOwnPropertyDescriptor: getter }),
    ]) {
      const safe = sanitizeMCPExternalError(fake, { stage: 'oauth' });
      expect(safe.diagnostic.type).not.toBe('OAuthDCRFailure');
      expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    }
    const poison = new OAuthDCRFailure(
      'SENTINEL',
      Object.defineProperties(
        {},
        {
          http_status: { get: getter },
          reason: { value: 'SENTINEL' },
          registration_endpoint_source: { value: 'https://SENTINEL' },
        }
      ) as never
    );
    expect(JSON.stringify(sanitizeMCPExternalError(poison, { stage: 'oauth' }))).not.toContain(
      'SENTINEL'
    );
  });
});
