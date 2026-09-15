import type { MCPManagedOAuthResolvedProfile, MCPServer, MCPServerID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { managedCatalogOAuthConfig } from './mcp-catalog-install-policy.js';
import { fingerprintManagedMCPOAuthGrantConfiguration } from './mcp-oauth-grant-binding.js';

const profile: MCPManagedOAuthResolvedProfile = {
  reference: {
    profile_id: 'fake_alpha',
    semantic_version: '1',
    environment: 'staging',
    region: 'us-west-2',
    registry_digest: 'a'.repeat(64),
  },
  catalogEntryName: 'test.example/fake-alpha',
  mcpUrl: 'https://alpha.example.test/mcp',
  transport: 'http',
  metadataEndpoints: [],
  metadataUri: 'https://alpha.example.test/.well-known/oauth-protected-resource',
  resourceUri: 'https://alpha.example.test/mcp',
  issuer: 'https://alpha.example.test/',
  authorizationEndpoint: 'https://alpha.example.test/authorize',
  tokenEndpoint: 'https://alpha.example.test/token',
  redirectUri: 'https://broker.example.test/v1/callback/alpha',
  clientId: 'fake-client',
  scope: 'read',
  tokenEndpointAuthMethod: 'client_secret_basic',
  clientKind: 'confidential',
  registrationProvenanceDigest: 'b'.repeat(64),
};
const server = {
  mcp_server_id: 'server_alpha' as MCPServerID,
  enabled: true,
  source: 'catalog',
  catalog_entry_name: profile.catalogEntryName,
  transport: 'http',
  url: profile.mcpUrl,
  headers: {},
  auth: managedCatalogOAuthConfig(profile.reference),
} satisfies Pick<
  MCPServer,
  | 'mcp_server_id'
  | 'enabled'
  | 'source'
  | 'catalog_entry_name'
  | 'transport'
  | 'url'
  | 'headers'
  | 'auth'
>;
const subject = {
  tenantId: 'workspace_alpha',
  userId: 'user_alpha',
  cloudSubject: 'cloud_alpha',
  grantGeneration: '2',
};
const fingerprint = () =>
  fingerprintManagedMCPOAuthGrantConfiguration(
    'disposable-master-secret',
    server,
    profile,
    subject
  );
describe('managed v5 grant binding', () => {
  it('binds canonical local subject and registry metadata, never direct policy', () =>
    expect(fingerprint()).toMatch(/^[a-f0-9]{64}$/));
  for (const field of ['tenantId', 'userId', 'cloudSubject', 'grantGeneration'] as const)
    it(`fences changed ${field}`, () =>
      expect(
        fingerprintManagedMCPOAuthGrantConfiguration('disposable-master-secret', server, profile, {
          ...subject,
          [field]: field === 'grantGeneration' ? '3' : 'changed',
        })
      ).not.toBe(fingerprint()));
  for (const field of [
    'metadataUri',
    'resourceUri',
    'issuer',
    'authorizationEndpoint',
    'tokenEndpoint',
    'redirectUri',
    'clientId',
    'scope',
    'tokenEndpointAuthMethod',
    'clientKind',
    'registrationProvenanceDigest',
  ] as const)
    it(`binds immutable ${field}`, () =>
      expect(
        fingerprintManagedMCPOAuthGrantConfiguration(
          'disposable-master-secret',
          server,
          { ...profile, [field]: `${profile[field]}changed` },
          subject
        )
      ).not.toBe(fingerprint()));
  it('has no operational secret version in semantic identity', () =>
    expect(
      fingerprintManagedMCPOAuthGrantConfiguration(
        'disposable-master-secret',
        server,
        { ...profile, secretVersion: 'rotated' } as MCPManagedOAuthResolvedProfile,
        subject
      )
    ).toBe(fingerprint()));
  for (const mutation of [
    { source: 'user' },
    { url: 'https://other.example.test/mcp' },
    { headers: { authorization: 'secret' } },
    { auth: { ...server.auth, oauth_client_id: 'override' } },
    { auth: { ...server.auth, oauth_access_token: 'leak' } },
    { auth: { ...server.auth, oauth_client_mode: 'direct' } },
    { enabled: false },
  ] as const)
    it(`refuses drift ${Object.keys(mutation)[0]}`, () =>
      expect(() =>
        fingerprintManagedMCPOAuthGrantConfiguration(
          'disposable-master-secret',
          { ...server, ...mutation } as MCPServer,
          profile,
          subject
        )
      ).toThrow());
  it('rejects empty HMAC key and malformed generation', () => {
    expect(() =>
      fingerprintManagedMCPOAuthGrantConfiguration('', server, profile, subject)
    ).toThrow();
    expect(() =>
      fingerprintManagedMCPOAuthGrantConfiguration('key', server, profile, {
        ...subject,
        grantGeneration: '01',
      })
    ).toThrow();
  });
});
