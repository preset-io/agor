import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { auditCatalogHealth } from './health-audit';

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

  it('audits OAuth metadata and reports a missing DCR path', async () => {
    const result = await auditCatalogHealth([entry('oauth')], {
      probe: async () => ({ authType: 'oauth', wwwAuthenticate: 'Bearer resource_metadata="x"' }),
      oauthMetadataReady: async () => {
        throw new Error('dcr_missing');
      },
    });
    expect(result[0]).toMatchObject({ status: 'oauth-metadata-not-ready', reason: 'dcr_missing' });
  });

  it('treats only a reviewed OAuth-challenge bearer route as ready', async () => {
    const github = entry('credentials');
    github.credentials = {
      scheme: 'bearer',
      acquisition_url: 'https://example.com/token',
      oauth_challenge_compatible: true,
    };
    const [result] = await auditCatalogHealth([github], {
      probe: async () => ({ authType: 'oauth' }),
    });
    expect(result.status).toBe('ready');
  });
});
