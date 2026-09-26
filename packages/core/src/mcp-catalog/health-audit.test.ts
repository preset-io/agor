import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { MCPExternalError, sanitizeMCPExternalError } from '../tools/mcp/external-error';
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
  it.each([undefined, false])(
    'skips hidden endpoints but still reports visible auth drift (hidden=%s)',
    async (hidden) => {
      const probe = vi.fn().mockResolvedValue({ authType: 'none' });
      const oauthMetadataReady = vi.fn();
      const hiddenEntry = { ...entry('oauth'), name: 'example/hidden', hidden: true };
      const visibleEntry = { ...entry('oauth'), hidden };
      const results = await auditCatalogHealth([hiddenEntry, visibleEntry], {
        probe,
        oauthMetadataReady,
      });

      expect(results).toEqual([
        {
          name: hiddenEntry.name,
          status: 'skipped-hidden',
          expectedAuth: 'oauth',
          observedAuth: 'unknown',
          reason: 'catalog_entry_hidden',
        },
        {
          name: visibleEntry.name,
          status: 'auth-drift',
          expectedAuth: 'oauth',
          observedAuth: 'none',
          reason: 'auth_mismatch',
        },
      ]);
      expect(probe).toHaveBeenCalledExactlyOnceWith(visibleEntry.remote_url);
      expect(oauthMetadataReady).not.toHaveBeenCalled();
    }
  );

  it('skips hidden OAuth discovery without suppressing visible metadata failures', async () => {
    const hidden = { ...entry('oauth'), hidden: true };
    const visible = { ...entry('oauth'), name: 'example/visible' };
    const probe = vi.fn().mockResolvedValue({ authType: 'oauth' });
    const oauthMetadataReady = vi
      .fn()
      .mockRejectedValue(new OAuthConfigurationError('pkce_required', 'S256 required'));

    const results = await auditCatalogHealth([hidden, visible], { probe, oauthMetadataReady });

    expect(results.map(({ status }) => status)).toEqual([
      'skipped-hidden',
      'oauth-metadata-not-ready',
    ]);
    expect(probe).toHaveBeenCalledExactlyOnceWith(visible.remote_url);
    expect(oauthMetadataReady).toHaveBeenCalledExactlyOnceWith(visible, undefined);
    expect(results[1].reason).toBe('pkce_required');
  });

  it('retains the closed storage-policy reason without provider prose', async () => {
    const [result] = await auditCatalogHealth([entry('oauth')], {
      probe: async () => ({ authType: 'oauth' }),
      oauthMetadataReady: async () => {
        throw new MCPExternalError(
          sanitizeMCPExternalError(new Error('SENTINEL_PROVIDER_SECRET'), {
            stage: 'oauth_metadata',
            category: 'storage_policy_rejected',
          })
        );
      },
    });
    expect(result).toMatchObject({
      status: 'oauth-metadata-not-ready',
      reason: 'external_storage_policy_rejected',
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

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

  it('expects Datadog to audit as OAuth-ready without requiring a challenge header', async () => {
    const datadog = entry('oauth');
    datadog.name = 'com.datadoghq/mcp';
    datadog.remote_url = 'https://mcp.datadoghq.com/v1/mcp';
    const oauthMetadataReady = vi.fn().mockResolvedValue(undefined);

    const [result] = await auditCatalogHealth([datadog], {
      probe: async () => ({ authType: 'oauth' }),
      oauthMetadataReady,
    });

    expect(result).toEqual({
      name: 'com.datadoghq/mcp',
      status: 'ready',
      expectedAuth: 'oauth',
      observedAuth: 'oauth',
    });
    expect(oauthMetadataReady).toHaveBeenCalledWith(datadog, undefined);
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
