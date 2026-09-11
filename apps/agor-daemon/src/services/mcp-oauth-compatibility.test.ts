import type { MCPCatalogEntry, MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { selectCatalogCandidate } from './mcp-catalog-credential-match.js';
import { catalogOAuthConfig } from './mcp-catalog-install-policy.js';
import {
  presentMCPOAuthCompatibilityPolicy,
  resolveMCPOAuthCompatibilityPolicy,
} from './mcp-oauth-compatibility.js';

const entry = {
  name: 'com.example/provider',
  title: 'Provider',
  description: 'Provider',
  remote_url: 'https://provider.example/mcp',
  transport: 'streamable-http',
  has_remote: true,
  category: 'developer-tools',
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

describe('reviewed configured-client catalog policy', () => {
  const asana: MCPCatalogEntry & { remote_url: string } = {
    ...entry,
    name: 'com.asana/mcp',
    remote_url: 'https://mcp.asana.com/v2/mcp',
    oauth: { configured_client: true, dcr_mode: 'disabled' },
  };
  const server = () =>
    catalogServer({
      catalog_entry_name: asana.name,
      url: asana.remote_url,
      owner_user_id: '01900000-0000-7000-8000-000000000002' as MCPServer['owner_user_id'],
      auth: {
        ...catalogOAuthConfig(asana),
        oauth_client_id: 'fixture-client',
        oauth_client_secret: 'fixture-secret',
      },
    });

  it('keeps normal catalog sign-in after saving the app, without relaxing general strict', async () => {
    await expect(resolveMCPOAuthCompatibilityPolicy(server(), [asana])).resolves.toMatchObject({
      mode: 'marketplace',
    });
    for (const changed of [
      { source: 'user' as const },
      { source: 'imported' as const },
      { url: 'https://mcp.asana.com/sse' },
      { url: `${asana.remote_url}/` },
      { transport: 'sse' as const },
      { headers: { 'X-Custom': 'value' } },
      { auth: { ...server().auth!, oauth_token_url: 'https://other.example/token' } },
      { auth: { ...server().auth!, oauth_scope: 'other-scope' } },
      { auth: { ...server().auth!, oauth_dcr_mode: 'advertised' as const } },
      { auth: { ...server().auth!, oauth_mode: 'shared' as const } },
      { auth: { ...server().auth!, oauth_compatibility_mode: 'strict' as const } },
    ]) {
      await expect(
        resolveMCPOAuthCompatibilityPolicy({ ...server(), ...changed }, [asana])
      ).resolves.toMatchObject({ mode: 'strict' });
    }
    await expect(
      resolveMCPOAuthCompatibilityPolicy(server(), [{ ...asana, oauth: undefined }])
    ).resolves.toMatchObject({ mode: 'strict' });
    await expect(resolveMCPOAuthCompatibilityPolicy(server(), [])).resolves.toMatchObject({
      mode: 'strict',
    });
  });

  it('does not lend a row client secret to another catalog caller', async () => {
    const candidate = { server: server(), has_row_secret: true };
    const deps = { isGrantAuthorized: async () => false };
    const own = await selectCatalogCandidate(
      asana,
      catalogOAuthConfig(asana),
      [candidate],
      candidate.server.owner_user_id!,
      Date.now(),
      deps
    );
    expect(own.currentCatalog).toBe(candidate);
    const other = await selectCatalogCandidate(
      asana,
      catalogOAuthConfig(asana),
      [candidate],
      'other-user',
      Date.now(),
      deps
    );
    expect(other.currentCatalog).toBeUndefined();
    expect(other.ownedCatalog).toBeUndefined();
    expect(other.live).toBeUndefined();
    expect(other.compatibleOAuth).toEqual([]);
  });
});

describe('resolveMCPOAuthCompatibilityPolicy', () => {
  it('derives marketplace only from a canonical install of a current OAuth entry', async () => {
    await expect(resolveMCPOAuthCompatibilityPolicy(catalogServer(), [entry])).resolves.toEqual({
      mode: 'marketplace',
      reason: 'current_catalog_marketplace',
      catalogEntryName: entry.name,
    });
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
    ).toEqual({ effective_mode: 'marketplace', managed_by_catalog: true });
    expect(
      presentMCPOAuthCompatibilityPolicy({ mode: 'strict', reason: 'explicit_strict' })
    ).toEqual({ effective_mode: 'strict', managed_by_catalog: false });
  });

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
