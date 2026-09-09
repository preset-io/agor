import { loadCatalog } from '@agor/core/mcp-catalog';
import type { MCPCatalogEntry, MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { OAUTH_PROVIDER_FIXTURES } from '../../../../packages/core/src/tools/mcp/oauth-provider.test-fixtures';
import { catalogOAuthSetupRecovery } from './mcp-oauth-provider-setup';

function installed(entry: MCPCatalogEntry): MCPServer {
  return {
    mcp_server_id: '00000000-0000-7000-8000-000000000001',
    source: 'catalog',
    catalog_entry_name: entry.name,
    transport: entry.transport === 'sse' ? 'sse' : 'http',
    url: entry.remote_url,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  } as MCPServer;
}

describe('current provider setup policy', () => {
  it.each(OAUTH_PROVIDER_FIXTURES)(
    '$label stops automatic registrations for existing catalog installs',
    async ({ name }) => {
      const catalog = await loadCatalog();
      const entry = catalog.find((entry) => entry.name === name)!;
      expect(entry.setup_required).toBeDefined();
      expect(Object.isFrozen(entry.setup_required)).toBe(true);
      await expect(catalogOAuthSetupRecovery(installed(entry), catalog)).resolves.toMatchObject({
        category: 'configuration_required',
        action: 'contact_admin',
        message: entry.setup_required!.message,
      });
      // A manually configured client takes the ordinary OAuth checks, not DCR.
      await expect(
        catalogOAuthSetupRecovery(
          {
            ...installed(entry),
            auth: {
              type: 'oauth',
              oauth_client_id: 'configured-client',
            },
          },
          catalog
        )
      ).resolves.toBeUndefined();
    }
  );

  it('does not infer provider identity from a name, hostname suffix, imported stamp or edited endpoint', async () => {
    const catalog = await loadCatalog();
    const entry = catalog.find((entry) => entry.name === 'com.canva/mcp')!;
    for (const overrides of [
      { source: 'user' },
      { catalog_entry_name: 'com.canva/mcp-SENTINEL' },
      { url: 'https://mcp.canva.com.evil.example/mcp' },
      { url: `${entry.remote_url}?token=SENTINEL` },
      { transport: 'sse' },
    ]) {
      await expect(
        catalogOAuthSetupRecovery({ ...installed(entry), ...overrides } as MCPServer, catalog)
      ).resolves.toBeUndefined();
    }
    await expect(catalogOAuthSetupRecovery(installed(entry), [])).resolves.toBeUndefined();
  });
});
