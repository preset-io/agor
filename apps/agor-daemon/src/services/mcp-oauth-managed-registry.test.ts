import { ManagedMCPOAuthProtocolError } from '@agor/core/tools/mcp/managed-oauth-client';
import type { MCPCatalogEntry, MCPServer } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../../../../packages/core/src/tools/mcp/__fixtures__/managed-v1/projection-results.json';
import type { ManagedOAuthDeployment } from '../mcp-egress/managed-deployment.js';
import { managedCatalogOAuthConfig } from './mcp-catalog-install-policy.js';
import { ManagedOAuthRegistry } from './mcp-oauth-managed-registry.js';

const settings = {
  enabled: true,
  new_starts: true,
  exchange: true,
  refresh: true,
  use_authorization_issuance: true,
  environment: 'staging' as const,
  region: 'us-west-2' as const,
};
const entry = {
  name: fixtures.valid.profile.catalog_entry_name,
  transport: 'streamable-http',
  auth_type: 'oauth',
  remote_url: fixtures.valid.profile.exact_resource_uri,
} as MCPCatalogEntry;
let now: number;
let capabilities: typeof fixtures.valid.capabilities;
let request: ReturnType<typeof vi.fn>;
let deployment: ManagedOAuthDeployment;
beforeEach(() => {
  now = 1_000_000;
  capabilities = structuredClone(fixtures.valid.capabilities);
  request = vi.fn(async () => structuredClone(capabilities));
  deployment = {
    clock: { latestUtcMs: () => now },
    sender: { request },
    getEvidence: () => ({ recovery_incarnation: capabilities.recovery_incarnation }),
  } as unknown as ManagedOAuthDeployment;
});
const setup = (overrides = {}) =>
  new ManagedOAuthRegistry({ ...settings, ...overrides }, deployment, [entry]);

describe('authenticated provider-neutral registry admission', () => {
  it('does no network from resolve and requires successful bootstrap', async () => {
    const registry = setup();
    expect(() => registry.resolveEntry(entry)).toThrow();
    await registry.refresh();
    const profile = registry.resolveEntry(entry);
    expect(profile.clientId).toBe(fixtures.valid.profile.client_id);
    expect(profile.metadataEndpoints).toEqual(fixtures.valid.profile.metadata_endpoints);
    expect(request).toHaveBeenCalledTimes(1);
    registry.resolveEntry(entry);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('projects a second public provider and zero metadata without inference', async () => {
    capabilities.profile_versions = [fixtures.valid.public_profile];
    const beta = { ...entry, name: fixtures.valid.public_profile.catalog_entry_name };
    const registry = new ManagedOAuthRegistry(settings, deployment, [beta]);
    await registry.refresh();
    expect(registry.resolveEntry(beta)).toMatchObject({
      clientKind: 'public',
      tokenEndpointAuthMethod: 'none',
      metadataEndpoints: [],
      metadataUri: '',
      scope: 'mcp:read mcp:write',
    });
  });
  it('binds all ordered metadata endpoints without selecting the first', async () => {
    capabilities.profile_versions = [
      { ...fixtures.valid.multiple_metadata_profile, catalog_entry_name: entry.name },
    ];
    const registry = setup();
    await registry.refresh();
    expect(registry.resolveEntry(entry).metadataUri).toBe('');
    expect(registry.resolveEntry(entry).metadataEndpoints).toEqual(
      fixtures.valid.multiple_metadata_profile.metadata_endpoints
    );
  });
  it('does not convert direct rows or substitute edited references', async () => {
    const registry = setup();
    await registry.refresh();
    const profile = registry.resolveEntry(entry);
    const server = {
      catalog_entry_name: entry.name,
      auth: managedCatalogOAuthConfig(profile.reference),
    } as MCPServer;
    expect(registry.resolve(server, 'use').reference).toEqual(profile.reference);
    server.auth!.oauth_managed_profile!.registry_digest = 'f'.repeat(64);
    expect(() => registry.resolve(server, 'use')).toThrow();
    expect(() => registry.resolve({ ...server, auth: { type: 'oauth' } }, 'use')).toThrow();
  });
  it('fails closed after bounded outage and never renews capability age by reading', async () => {
    const registry = setup();
    await registry.refresh();
    request.mockRejectedValue(new Error('private worker detail'));
    await expect(registry.refresh()).rejects.toThrow();
    now += 119_999;
    registry.resolveEntry(entry);
    now += 1;
    expect(() => registry.resolveEntry(entry)).toThrow();
  });
  it.each(['remote_rejection', 'invalid_response'] as const)(
    'invalidates cached admission for %s',
    async (category) => {
      const registry = setup();
      await registry.refresh();
      request.mockRejectedValue(new ManagedMCPOAuthProtocolError(category));
      await expect(registry.refresh()).rejects.toThrow();
      expect(() => registry.resolveEntry(entry)).toThrow();
    }
  );
  it('retains authenticated negative evidence immediately', async () => {
    const registry = setup();
    await registry.refresh();
    capabilities.available = false;
    capabilities.profile_versions = [];
    await expect(registry.refresh()).rejects.toThrow();
    expect(() => registry.resolveEntry(entry)).toThrow();
  });
  it('pausing refresh does not disable existing-use profile validation', async () => {
    const registry = setup({ refresh: false });
    await registry.refresh();
    const profile = registry.resolveEntry(entry);
    const server = {
      catalog_entry_name: entry.name,
      auth: managedCatalogOAuthConfig(profile.reference),
    } as MCPServer;
    expect(registry.resolve(server, 'use')).toEqual(profile);
    expect(() => registry.resolve(server, 'refresh')).toThrow();
  });
  it('does not let consumer mutation change cached authorization', async () => {
    const registry = setup();
    await registry.refresh();
    registry.capabilities().profile_versions.length = 0;
    expect(registry.resolveEntry(entry).clientId).toBe(fixtures.valid.profile.client_id);
  });
});
