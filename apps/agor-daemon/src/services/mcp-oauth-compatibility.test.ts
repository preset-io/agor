import type { MCPCatalogEntry, MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
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
