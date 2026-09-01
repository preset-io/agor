import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { OAuthConfigurationError } from '../tools/mcp/oauth-mcp-transport';
import { auditCatalogHealth } from './health-audit';

const oauthMocks = vi.hoisted(() => ({
  resolveMCPOAuthDiscovery: vi.fn(),
  validateMCPOAuthMetadata: vi.fn(),
}));

vi.mock('../tools/mcp/oauth-mcp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/mcp/oauth-mcp-transport')>()),
  resolveMCPOAuthDiscovery: oauthMocks.resolveMCPOAuthDiscovery,
  validateMCPOAuthMetadata: oauthMocks.validateMCPOAuthMetadata,
}));

function entry(auth_type: MCPCatalogEntry['auth_type']): MCPCatalogEntry {
  return {
    name: `example/${auth_type}`,
    category: 'dev-tools',
    capabilities: ['docs'],
    benefit: 'Benefit',
    starter_prompt: 'Prompt',
    permission_disclosure: 'Disclosure',
    remote_url: 'https://mcp.example.com/mcp',
    has_remote: true,
    auth_type,
  };
}

describe('auditCatalogHealth', () => {
  it('classifies reachability and auth drift without public network access', async () => {
    const results = await auditCatalogHealth([entry('none'), entry('oauth')], {
      probe: vi
        .fn()
        .mockResolvedValueOnce({ authType: 'unreachable' })
        .mockResolvedValueOnce({ authType: 'none' }),
    });
    expect(results.map(({ status }) => status)).toEqual(['unreachable', 'auth-drift']);
  });

  it('audits OAuth metadata and preserves the production failure category and error', async () => {
    const result = await auditCatalogHealth([entry('oauth')], {
      probe: async () => ({ authType: 'oauth', wwwAuthenticate: 'Bearer resource_metadata="x"' }),
      oauthMetadataReady: async () => {
        throw new OAuthConfigurationError(
          'client_registration_required',
          'No reviewed registration path'
        );
      },
    });
    expect(result[0]).toMatchObject({
      status: 'oauth-metadata-not-ready',
      reason: 'client_registration_required',
      error: 'No reviewed registration path',
    });
  });

  it('does not call a public credential challenge fully verified without a credential', async () => {
    const [result] = await auditCatalogHealth([entry('credentials')], {
      probe: async () => ({ authType: 'credentials' }),
    });
    expect(result).toMatchObject({
      status: 'credential-required',
      reason: 'credential_not_verified',
    });
  });

  it('keeps a reviewed OAuth-challenge bearer route credential-unverified when OAuth is unusable', async () => {
    const github = entry('credentials');
    github.credentials = {
      scheme: 'bearer',
      acquisition_url: 'https://example.com/token',
      oauth_challenge_compatible: true,
    };
    const [result] = await auditCatalogHealth([github], {
      probe: async () => ({ authType: 'oauth' }),
      oauthMetadataReady: async () => {
        throw new Error('DCR remains unavailable');
      },
    });
    expect(result).toMatchObject({
      status: 'credential-required',
      reason: 'unexpected_error',
      error: 'Error: DCR remains unavailable',
    });
  });

  it('signals when an OAuth-challenge bearer exception can retire', async () => {
    const github = entry('credentials');
    github.credentials = {
      scheme: 'bearer',
      acquisition_url: 'https://example.com/token',
      oauth_challenge_compatible: true,
    };
    const oauthMetadataReady = vi.fn().mockResolvedValue(undefined);
    const [result] = await auditCatalogHealth([github], {
      probe: async () => ({ authType: 'oauth' }),
      oauthMetadataReady,
    });
    expect(oauthMetadataReady).toHaveBeenCalledOnce();
    expect(result.status).toBe('oauth-now-available');
  });

  it.each([
    ['malformed', 'not a URL'],
    ['non-HTTPS', 'http://registration.example.com/register'],
    ['private-host', 'https://127.0.0.1/register'],
  ])('does not retire a bearer exception for a %s DCR endpoint', async (_label, endpoint) => {
    const github = entry('credentials');
    github.credentials = {
      scheme: 'bearer',
      acquisition_url: 'https://example.com/token',
      oauth_challenge_compatible: true,
    };
    oauthMocks.resolveMCPOAuthDiscovery.mockResolvedValueOnce({ kind: 'authorization-server' });
    oauthMocks.validateMCPOAuthMetadata.mockResolvedValueOnce({
      registrationEndpoint: endpoint,
    });

    const [result] = await auditCatalogHealth([github], {
      probe: async () => ({ authType: 'oauth' }),
    });

    expect(result).toMatchObject({
      status: 'credential-required',
      reason: 'metadata_incompatible',
      error: 'OAuth metadata advertises an unsafe Dynamic Client Registration endpoint',
    });
  });

  it('contains an unexpected per-entry failure and keeps the rest of the audit', async () => {
    const results = await auditCatalogHealth([entry('none'), entry('none')], {
      probe: vi
        .fn()
        .mockRejectedValueOnce(new Error('one endpoint exploded'))
        .mockResolvedValueOnce({ authType: 'none' }),
    });
    expect(results).toEqual([
      expect.objectContaining({
        status: 'indeterminate',
        reason: 'unexpected_error',
        error: 'Error: one endpoint exploded',
      }),
      expect.objectContaining({ status: 'ready' }),
    ]);
  });
});
