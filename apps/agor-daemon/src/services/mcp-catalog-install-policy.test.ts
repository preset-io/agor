import type {
  MCPCatalogEntry,
  MCPManagedOAuthProfileReference,
  MCPServer,
  UserID,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  isCurrentManagedCatalogInstall,
  managedCatalogOAuthConfig,
} from './mcp-catalog-install-policy.js';

const userId = 'caller' as UserID;
const profile: MCPManagedOAuthProfileReference = {
  profile_id: 'fake_alpha',
  semantic_version: '1',
  environment: 'staging',
  region: 'us-west-2',
  registry_digest: 'a'.repeat(64),
};
const entry = {
  name: 'test.provider/mcp',
  remote_url: 'https://provider.example.test/mcp',
  transport: 'streamable-http',
  auth_type: 'oauth',
} as MCPCatalogEntry & { remote_url: string };
const server = {
  source: 'catalog',
  catalog_entry_name: entry.name,
  transport: 'http',
  url: entry.remote_url,
  auth: managedCatalogOAuthConfig(profile),
  headers: {},
  owner_user_id: userId,
} as MCPServer;

describe('managed catalog prescription does not adopt direct or other-owner rows', () => {
  it('requires exact current profile, endpoint, transport, origin and owner', () => {
    expect(isCurrentManagedCatalogInstall(server, entry, profile, userId)).toBe(true);
    for (const patch of [
      { source: 'imported' },
      { source: 'user' },
      { owner_user_id: 'other' },
      { owner_user_id: null },
      { url: `${entry.remote_url}/` },
      { catalog_entry_name: 'other/mcp' },
      { transport: 'sse' },
      { headers: { 'X-Route': 'other' } },
      { auth: { type: 'oauth', oauth_mode: 'per_user' } },
      { auth: { ...server.auth, oauth_client_mode: 'future' } },
      {
        auth: {
          ...server.auth,
          oauth_managed_profile: { ...profile, registry_digest: 'b'.repeat(64) },
        },
      },
      { auth: { ...server.auth, oauth_managed_profile: { ...profile, semantic_version: '2' } } },
    ])
      expect(
        isCurrentManagedCatalogInstall({ ...server, ...patch } as MCPServer, entry, profile, userId)
      ).toBe(false);
  });
  it('does not ignore runtime-hydrated or redacted secret fields for managed canonical identity', () => {
    for (const key of [
      'oauth_access_token',
      'oauth_refresh_token',
      'oauth_client_secret',
      'oauth_client_id',
      'oauth_token_url',
      'oauth_dcr_mode',
    ]) {
      expect(
        isCurrentManagedCatalogInstall(
          { ...server, auth: { ...server.auth!, [key]: 'synthetic' } },
          entry,
          profile,
          userId
        )
      ).toBe(false);
    }
  });
});
