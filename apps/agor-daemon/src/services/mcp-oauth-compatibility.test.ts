import { loadCatalog } from '@agor/core/mcp-catalog';
import type { MCPCatalogEntry, MCPCatalogServerCandidate, MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { compatibleCatalogOAuthPeers } from './mcp-catalog-credential-match.js';
import {
  presentMCPOAuthCompatibilityPolicy,
  presentMCPOAuthEffectivePolicy,
  resolveMCPOAuthCompatibilityPolicy,
} from './mcp-oauth-compatibility.js';

const entry = {
  name: 'com.example/provider',
  title: 'Provider',
  description: 'Provider',
  remote_url: 'https://provider.example/mcp',
  transport: 'streamable-http',
  has_remote: true,
  category: 'dev-tools',
  capabilities: [],
  benefit: 'Test',
  starter_prompt: 'Test',
  permission_disclosure: 'Test',
  auth_type: 'oauth',
} as MCPCatalogEntry;

function catalogServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    mcp_server_id: '01900000-0000-7000-8000-000000000001' as MCPServer['mcp_server_id'],
    name: 'provider',
    transport: 'http',
    scope: 'global',
    enabled: true,
    source: 'catalog',
    catalog_entry_name: entry.name,
    url: entry.remote_url,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  };
}

describe('resolveMCPOAuthCompatibilityPolicy', () => {
  it('fails closed for saved Datadog endpoints and grants predating the v1 catalog URL', async () => {
    const datadog = (await loadCatalog()).find((entry) => entry.name === 'com.datadoghq/mcp')!;
    const oldUrl = 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp';
    const saved = catalogServer({ catalog_entry_name: datadog.name, url: oldUrl });
    const before = structuredClone(saved);
    await expect(resolveMCPOAuthCompatibilityPolicy(saved)).resolves.toMatchObject({
      mode: 'strict',
      reason: 'catalog_configuration_drift',
    });
    const current = { ...saved, url: datadog.remote_url };
    await expect(resolveMCPOAuthCompatibilityPolicy(current)).resolves.toMatchObject({
      mode: 'marketplace',
      reason: 'current_catalog_marketplace',
    });
    const candidate: MCPCatalogServerCandidate = {
      server: saved,
      has_row_secret: false,
      grant: {
        has_access_token: true,
        refresh_status: 'idle',
        binding_ready: true,
        resource_uri: oldUrl,
      },
    };
    const definition = { ...datadog, remote_url: datadog.remote_url! };
    // Neither the old row nor a changed URL carrying an old-resource grant is reusable.
    expect(
      await compatibleCatalogOAuthPeers(definition, [candidate, { ...candidate, server: current }])
    ).toEqual([]);
    expect(saved).toEqual(before);
  });

  it('derives marketplace only from a canonical install of a current OAuth entry', async () => {
    await expect(resolveMCPOAuthCompatibilityPolicy(catalogServer(), [entry])).resolves.toEqual({
      mode: 'marketplace',
      reason: 'current_catalog_marketplace',
      catalogEntryName: entry.name,
    });
  });

  it('preserves saved canonical policy and drift checks when a definition is hidden', async () => {
    const server = catalogServer();
    const before = structuredClone(server);
    const hidden = { ...entry, hidden: true };
    expect(await resolveMCPOAuthCompatibilityPolicy(server, [hidden])).toEqual(
      await resolveMCPOAuthCompatibilityPolicy(server, [entry])
    );
    await expect(
      resolveMCPOAuthCompatibilityPolicy(catalogServer({ url: 'https://different.example/mcp' }), [
        hidden,
      ])
    ).resolves.toMatchObject({ mode: 'strict', reason: 'catalog_configuration_drift' });
    expect(server).toEqual(before);
  });

  it('reconciles an existing install with a newly explicit current strict policy', async () => {
    const strictEntry = { ...entry, oauth: { compatibility_mode: 'strict' as const } };
    await expect(
      resolveMCPOAuthCompatibilityPolicy(catalogServer(), [strictEntry])
    ).resolves.toMatchObject({ mode: 'strict', reason: 'current_catalog_strict' });
  });

  it('projects current catalog policy as managed without making marketplace persisted input', () => {
    expect(
      presentMCPOAuthCompatibilityPolicy({
        mode: 'marketplace',
        reason: 'current_catalog_marketplace',
      })
    ).toEqual({
      effective_mode: 'marketplace',
      managed_by_catalog: true,
      effective_dcr_mode: 'advertised',
      dcr_mode_source: 'default',
    });
    expect(
      presentMCPOAuthCompatibilityPolicy({ mode: 'strict', reason: 'explicit_strict' })
    ).toEqual({
      effective_mode: 'strict',
      managed_by_catalog: false,
      effective_dcr_mode: 'advertised',
      dcr_mode_source: 'default',
    });
  });

  it.each([undefined, 'disabled', 'advertised', 'fallback'] as const)(
    'projects DCR %s without changing the saved choice or catalog provenance',
    async (dcrMode) => {
      const server = catalogServer({
        auth: {
          type: 'oauth',
          oauth_mode: 'per_user',
          ...(dcrMode ? { oauth_dcr_mode: dcrMode } : {}),
        },
      });
      const before = structuredClone(server);
      const policy = await resolveMCPOAuthCompatibilityPolicy(server, [entry]);
      expect(presentMCPOAuthCompatibilityPolicy(policy, dcrMode)).toMatchObject({
        effective_mode: dcrMode ? 'strict' : 'marketplace',
        effective_dcr_mode: dcrMode ?? 'advertised',
        dcr_mode_source: dcrMode ? 'explicit' : 'default',
      });
      expect(presentMCPOAuthEffectivePolicy('legacy', dcrMode).effective_dcr_mode).toBe(
        dcrMode ?? 'advertised'
      );
      expect(server).toEqual(before);
    }
  );

  it('retains explicit public strict and legacy opt-ins', async () => {
    await expect(
      resolveMCPOAuthCompatibilityPolicy(
        catalogServer({
          auth: { type: 'oauth', oauth_mode: 'per_user', oauth_compatibility_mode: 'strict' },
        }),
        [entry]
      )
    ).resolves.toMatchObject({ mode: 'strict', reason: 'explicit_strict' });
    await expect(
      resolveMCPOAuthCompatibilityPolicy(
        catalogServer({
          auth: { type: 'oauth', oauth_mode: 'per_user', oauth_compatibility_mode: 'legacy' },
        }),
        [entry]
      )
    ).resolves.toMatchObject({ mode: 'legacy', reason: 'explicit_legacy' });
  });

  it.each([
    ['user provenance', { source: 'user' as const }, [entry], 'general_default_strict'],
    ['imported provenance', { source: 'imported' as const }, [entry], 'general_default_strict'],
    [
      'missing protected stamp',
      { catalog_entry_name: undefined },
      [entry],
      'general_default_strict',
    ],
    ['removed entry', {}, [], 'catalog_entry_removed'],
    [
      'edited endpoint',
      { url: 'https://attacker.example/mcp' },
      [entry],
      'catalog_configuration_drift',
    ],
    ['edited transport', { transport: 'sse' as const }, [entry], 'catalog_configuration_drift'],
    [
      'edited auth routing',
      {
        auth: {
          type: 'oauth' as const,
          oauth_mode: 'per_user' as const,
          oauth_token_url: 'https://attacker.example/token',
        },
      },
      [entry],
      'catalog_configuration_drift',
    ],
    [
      'custom header',
      { headers: { 'X-Route': 'elsewhere' } },
      [entry],
      'catalog_configuration_drift',
    ],
  ] as const)('fails closed for %s', async (_label, overrides, entries, reason) => {
    await expect(
      resolveMCPOAuthCompatibilityPolicy(catalogServer(overrides as Partial<MCPServer>), entries)
    ).resolves.toMatchObject({ mode: 'strict', reason });
  });

  it.each(['marketplace', 'unknown'])('rejects public/persisted mode %s', async (mode) => {
    const server = catalogServer({
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_compatibility_mode: mode,
      } as never,
    });
    await expect(resolveMCPOAuthCompatibilityPolicy(server, [entry])).rejects.toThrow(
      /must be either strict or legacy/
    );
  });
});

it('resolves actual hidden saved installs through the full runtime catalog, without mutation', async () => {
  const definitions = (await loadCatalog()).filter((entry) => entry.hidden);
  expect(definitions).toHaveLength(7);
  for (const definition of definitions) {
    const server = catalogServer({
      catalog_entry_name: definition.name,
      url: definition.remote_url,
    });
    const before = structuredClone(server);
    expect(await resolveMCPOAuthCompatibilityPolicy(server)).toEqual(
      await resolveMCPOAuthCompatibilityPolicy(server, [{ ...definition, hidden: false }])
    );
    expect(await resolveMCPOAuthCompatibilityPolicy(server)).toMatchObject({ mode: 'marketplace' });
    expect(server).toEqual(before);
  }
});
