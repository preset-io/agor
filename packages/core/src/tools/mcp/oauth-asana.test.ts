import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCatalog } from '../../mcp-catalog/catalog';
import { safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import {
  type AuthorizationServerMetadata,
  completeMCPOAuthFlow,
  resolveMCPOAuthDiscovery,
  startMCPOAuthFlow,
  validateMCPOAuthMetadata,
} from './oauth-mcp-transport';
import { refreshMCPToken } from './oauth-refresh';

vi.mock('../../utils/safe-outbound-fetch', async (original) => ({
  ...(await original<typeof import('../../utils/safe-outbound-fetch')>()),
  safeOutboundFetch: vi.fn(),
}));

// Public metadata subsets verified by unauthenticated GET, 2026-09-10.
// Codes, client credentials and token responses below are synthetic, not live receipts.
const resource = 'https://mcp.asana.com/v2/mcp';
const metadataUrl = 'https://mcp.asana.com/.well-known/oauth-protected-resource/v2/mcp';
const issuer = 'https://app.asana.com';
const callback = 'https://cell.example.test/mcp-servers/oauth-callback';
const metadata: AuthorizationServerMetadata = {
  issuer,
  authorization_endpoint: `${issuer}/-/oauth_authorize`,
  token_endpoint: `${issuer}/-/oauth_token`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
};

function provider(overrides: Partial<AuthorizationServerMetadata> = {}, statedResource = resource) {
  vi.mocked(safeOutboundFetch).mockImplementation(async (input, options) => {
    const url = String(input);
    if (options?.method === 'POST') {
      expect(url).toBe(metadata.token_endpoint);
      expect(options.redirect).toBe('error');
      return Response.json({
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url === metadataUrl) {
      return Response.json({
        resource: statedResource,
        authorization_servers: [issuer],
        scopes_supported: ['default'],
      });
    }
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({ ...metadata, ...overrides });
    }
    throw new Error('Unexpected fixture request');
  });
}

function start(
  clientId: string | undefined = 'fixture-client',
  clientSecret: string | undefined = 'fixture-secret'
) {
  return startMCPOAuthFlow('', clientId, callback, {
    resourceUri: resource,
    resourceMetadataUrl: metadataUrl,
    compatibilityMode: 'marketplace',
    dcrMode: 'disabled',
    clientSecret,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Asana V2 configured MCP app (mocked provider)', () => {
  it('ships the V2 Streamable HTTP recipe, with no app credentials or DCR', async () => {
    const entry = (await loadCatalog()).find((entry) => entry.name === 'com.asana/mcp');
    expect(entry).toMatchObject({
      remote_url: resource,
      transport: 'streamable-http',
      auth_type: 'oauth',
      oauth: { configured_client: true, dcr_mode: 'disabled' },
    });
    expect(entry?.oauth).not.toHaveProperty('client_id');
  });

  it('discovers the exact V2 resource, exchanges and refreshes with the same configured client', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    provider();
    const discovery = await resolveMCPOAuthDiscovery(null, resource, {
      compatibilityMode: 'marketplace',
    });
    expect(discovery).toEqual({ kind: 'resource-metadata', metadataUrl, source: 'well-known' });
    await expect(
      validateMCPOAuthMetadata(discovery!, resource, { compatibilityMode: 'marketplace' })
    ).resolves.toMatchObject({ issuer });
    const context = await start();
    const authUrl = context.authorizationUrl;
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'fixture-client',
      redirect_uri: callback,
      resource,
      response_type: 'code',
      code_challenge_method: 'S256',
      state: context.state,
      code_challenge: createHash('sha256').update(context.pkceVerifier).digest('base64url'),
    });
    expect(url.searchParams.has('scope')).toBe(false);
    expect(authUrl).not.toContain('fixture-secret');
    expect(context.authorizationResponseIssuerParameterSupported).toBe(false);
    expect(
      vi.mocked(safeOutboundFetch).mock.calls.every(([, options]) => options?.method !== 'POST')
    ).toBe(true);
    await completeMCPOAuthFlow(context, 'fixture-code', context.state, { cacheToken: false });
    const exchange = vi.mocked(safeOutboundFetch).mock.calls.at(-1)![1]!;
    const basic = `Basic ${Buffer.from('fixture-client:fixture-secret').toString('base64')}`;
    expect(exchange.headers).toMatchObject({ Authorization: basic });
    expect(Object.fromEntries(new URLSearchParams(String(exchange.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'fixture-code',
      redirect_uri: callback,
      code_verifier: context.pkceVerifier,
      resource,
    });
    await refreshMCPToken({
      tokenEndpoint: context.tokenEndpoint,
      clientId: context.clientId,
      clientSecret: context.clientSecret,
      refreshToken: 'fixture-refresh',
      resourceUri: context.resourceUri,
    });
    const refresh = vi.mocked(safeOutboundFetch).mock.calls.at(-1)![1]!;
    expect(refresh.headers).toMatchObject({ Authorization: basic });
    expect(Object.fromEntries(new URLSearchParams(String(refresh.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'fixture-refresh',
      resource,
    });
    const logged = JSON.stringify(logs.mock.calls);
    for (const privateValue of [
      'fixture-secret',
      'fixture-code',
      'fixture-access',
      'fixture-refresh',
    ]) {
      expect(logged).not.toContain(privateValue);
    }
  });

  it.each([
    ['issuer', { issuer: `${issuer}/` }],
    ['authorization endpoint', { authorization_endpoint: `${issuer}/other` }],
    ['token endpoint', { token_endpoint: 'https://other.example/token' }],
    ['missing S256', { code_challenge_methods_supported: undefined }],
    ['POST-only client auth', { token_endpoint_auth_methods_supported: ['client_secret_post'] }],
  ] satisfies Array<[string, Partial<AuthorizationServerMetadata>]>)(
    'rejects drift in %s before sending credentials',
    async (_name, changed) => {
      provider(changed);
      await expect(start()).rejects.toThrow();
      expect(
        vi.mocked(safeOutboundFetch).mock.calls.every(([, options]) => options?.method !== 'POST')
      ).toBe(true);
    }
  );

  it.each(['https://mcp.asana.com', 'https://mcp.asana.com/v2', 'https://mcp.asana.com/sse'])(
    'refuses resource alias %s even in marketplace mode',
    async (alias) => {
      provider({}, alias);
      await expect(start()).rejects.toMatchObject({ failureCode: 'metadata_incompatible' });
    }
  );

  it('keeps explicit strict validation and exact callback state/issuer checks', async () => {
    provider();
    await expect(
      startMCPOAuthFlow('', 'fixture-client', callback, {
        resourceUri: resource,
        resourceMetadataUrl: metadataUrl,
        clientSecret: 'fixture-secret',
        compatibilityMode: 'strict',
      })
    ).rejects.toMatchObject({ failureCode: 'metadata_incompatible' });
    const context = await start();
    await expect(
      completeMCPOAuthFlow(context, 'fixture-code', 'wrong-state')
    ).rejects.toMatchObject({ failureCode: 'callback_state_mismatch' });
    await expect(
      completeMCPOAuthFlow(context, 'fixture-code', context.state, { issuer: `${issuer}/` })
    ).rejects.toMatchObject({ failureCode: 'callback_issuer_mismatch' });
    expect(
      vi.mocked(safeOutboundFetch).mock.calls.every(([, options]) => options?.method !== 'POST')
    ).toBe(true);
  });

  it('reports missing configured credentials without attempting registration', async () => {
    provider({ registration_endpoint: `${issuer}/register` });
    await expect(
      startMCPOAuthFlow('', undefined, callback, {
        resourceUri: resource,
        resourceMetadataUrl: metadataUrl,
        compatibilityMode: 'marketplace',
      })
    ).rejects.toMatchObject({ failureCode: 'client_registration_required' });
    await expect(start('fixture-client', '')).rejects.toMatchObject({
      failureCode: 'client_registration_required',
    });
    await expect(start('{{ user.env.CLIENT_ID }}', 'fixture-secret')).rejects.toMatchObject({
      failureCode: 'client_registration_required',
    });
    await expect(start('fixture-client', '{{ user.env.CLIENT_SECRET }}')).rejects.toMatchObject({
      failureCode: 'client_registration_required',
    });
    expect(
      vi.mocked(safeOutboundFetch).mock.calls.every(([, options]) => options?.method !== 'POST')
    ).toBe(true);
  });
});
