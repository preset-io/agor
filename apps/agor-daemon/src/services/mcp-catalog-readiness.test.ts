import { readFileSync } from 'node:fs';
import type {
  AuthenticatedParams,
  MCPCatalogEntry,
  MCPCatalogServerCandidate,
  MCPServer,
  UserID,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { MCPCatalogReadinessService } from './mcp-catalog-readiness';

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const PARAMS = { user: { user_id: ALICE } } as AuthenticatedParams;
const ENTRY: MCPCatalogEntry = {
  name: 'com.example/tasks',
  title: 'Example',
  category: 'productivity',
  capabilities: ['tasks'],
  benefit: 'Manage tasks.',
  starter_prompt: 'Show my tasks.',
  permission_disclosure: 'Reads tasks.',
  transport: 'streamable-http',
  remote_url: 'https://mcp.example.com/mcp',
  has_remote: true,
  auth_type: 'oauth',
  oauth: { compatibility_mode: 'strict' },
};

function peer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    mcp_server_id: '00000000-0000-7000-8000-000000000001',
    name: 'example-manual',
    owner_user_id: ALICE,
    transport: 'http',
    url: ENTRY.remote_url,
    scope: 'session',
    source: 'user',
    enabled: true,
    headers: {},
    auth: {
      type: 'oauth',
      oauth_mode: 'per_user',
      oauth_compatibility_mode: 'strict',
      oauth_access_token: '••••••••',
      oauth_token_expires_at: 4_102_444_800_000,
    },
    created_at: new Date(),
    ...overrides,
  } as MCPServer;
}

function build(
  servers: MCPServer[],
  entry: MCPCatalogEntry = ENTRY,
  redirectUri?: (entry: MCPCatalogEntry) => string | undefined
) {
  const catalogGet = vi.fn(async () => entry);
  const listCandidates = vi.fn(
    async (): Promise<MCPCatalogServerCandidate[]> =>
      servers.map((server) => ({
        server: {
          ...server,
          auth:
            server.auth?.type === 'oauth'
              ? {
                  ...server.auth,
                  oauth_access_token: undefined,
                  oauth_token_expires_at: undefined,
                }
              : server.auth,
        },
        has_row_secret: false,
        grant: {
          has_access_token: true,
          expires_at: 4_102_444_800_000,
          refresh_status: 'idle',
          resource_uri: ENTRY.remote_url,
          binding_ready: true,
        },
      }))
  );
  const app = {
    service(path: string) {
      if (path === 'mcp-catalog') return { get: catalogGet };
      throw new Error(`unexpected service ${path}`);
    },
  };
  const isGrantAuthorized = vi.fn(async () => true);
  return {
    service: new MCPCatalogReadinessService(app, {
      redirectUri,
      listCandidates,
      isGrantAuthorized,
    }),
    catalogGet,
    listCandidates,
    isGrantAuthorized,
  };
}

describe('MCPCatalogReadinessService', () => {
  it('production wiring never opens the credential-authority projection', () => {
    const source = readFileSync(new URL('../register-services.ts', import.meta.url), 'utf8');
    const registration = source.slice(
      source.indexOf("'/mcp-catalog/readiness'"),
      source.indexOf("'/mcp-marketplace'", source.indexOf("'/mcp-catalog/readiness'"))
    );
    expect(registration).toContain('candidate.grant?.binding_ready');
    expect(registration).not.toMatch(
      /getCatalogGrantAuthority|getToken|oauth_client_secret|openMCPOAuthSecret/
    );
  });

  it('shows the stable callback for an allowlisted DCR entry, and none for a plain one', async () => {
    const redirectUri = vi.fn(() => 'https://cloud.example/mcp/oauth/callback/abc');
    const allowlisted = { ...ENTRY, oauth: { stable_callback: { issuer: 'https://id.example' } } };
    await expect(
      build([], allowlisted, redirectUri).service.get(ENTRY.name, PARAMS)
    ).resolves.toMatchObject({ redirect_uri: 'https://cloud.example/mcp/oauth/callback/abc' });
    expect(redirectUri).toHaveBeenCalledWith(allowlisted);
    redirectUri.mockClear();
    const plain = await build([], ENTRY, redirectUri).service.get(ENTRY.name, PARAMS);
    expect(plain).not.toHaveProperty('redirect_uri');
    expect(redirectUri).not.toHaveBeenCalled();
  });

  it('reports reusable OAuth without returning peer or grant metadata', async () => {
    const built = build([peer()]);
    const result = await built.service.get(ENTRY.name, PARAMS);
    expect(result).toEqual({ catalog_key: ENTRY.name, state: 'reusable_oauth' });
    expect(Object.keys(result).sort()).toEqual(['catalog_key', 'state']);
    expect(JSON.stringify(result)).not.toMatch(/server_id|resource|issuer|scope|account/i);
  });

  it('distinguishes a current installed grant and performs reads only', async () => {
    const built = build([
      peer({ source: 'catalog', catalog_entry_name: ENTRY.name, name: 'example' }),
    ]);
    await expect(built.service.get(ENTRY.name, PARAMS)).resolves.toEqual({
      catalog_key: ENTRY.name,
      state: 'installed_ready',
    });
    expect(built.catalogGet).toHaveBeenCalledOnce();
    expect(built.listCandidates).toHaveBeenCalledOnce();
    expect(built.isGrantAuthorized).toHaveBeenCalledOnce();
  });

  it('offers shared configuration separately from private readiness, without requiring or exposing a grant', async () => {
    const built = build([
      peer({ owner_user_id: undefined, source: 'catalog', catalog_entry_name: ENTRY.name }),
    ]);
    built.isGrantAuthorized.mockResolvedValue(false);
    await expect(built.service.get(ENTRY.name, PARAMS)).resolves.toEqual({
      catalog_key: ENTRY.name,
      state: 'oauth_required',
      shared_configuration_available: true,
    });
    await expect(
      built.service.get(ENTRY.name, { ...PARAMS, query: { sharing: 'shared' } })
    ).resolves.toEqual({
      catalog_key: ENTRY.name,
      state: 'oauth_required',
      shared_configuration_available: true,
      reusable_configuration: true,
    });
  });

  it.each([
    { enabled: false },
    { scope: 'global' as const },
    { url: 'https://drift.example/mcp' },
    { env: { KEY: 'fixture-env' } },
    { headers: { Authorization: 'fixture-header' } },
  ])('does not offer drifted or embedded shared configuration: %j', async (changes) => {
    const built = build([
      peer({
        owner_user_id: undefined,
        source: 'catalog',
        catalog_entry_name: ENTRY.name,
        ...changes,
      }),
    ]);
    expect(
      (await built.service.get(ENTRY.name, PARAMS)).shared_configuration_available
    ).toBeUndefined();
  });

  it('does not offer a canonical shared candidate with row-level OAuth material', async () => {
    const built = build([
      peer({ owner_user_id: undefined, source: 'catalog', catalog_entry_name: ENTRY.name }),
    ]);
    const [candidate] = await built.listCandidates();
    built.listCandidates.mockResolvedValue([{ ...candidate, has_row_secret: true }]);
    expect(
      (await built.service.get(ENTRY.name, PARAMS)).shared_configuration_available
    ).toBeUndefined();
  });

  it('is advisory across a credential race and never carries state into Connect', async () => {
    const servers = [peer()];
    const built = build(servers);
    await expect(built.service.get(ENTRY.name, PARAMS)).resolves.toMatchObject({
      state: 'reusable_oauth',
    });
    servers.splice(0);
    await expect(built.service.get(ENTRY.name, PARAMS)).resolves.toEqual({
      catalog_key: ENTRY.name,
      state: 'oauth_required',
    });
    expect(built.listCandidates).toHaveBeenCalledTimes(2);
  });

  it('predicts the live manual peer when a stale catalog row also exists', async () => {
    const stale = peer({
      mcp_server_id: '00000000-0000-7000-8000-000000000002',
      source: 'catalog',
      catalog_entry_name: ENTRY.name,
      url: 'https://stale.example/mcp',
    });
    await expect(build([stale, peer()]).service.get(ENTRY.name, PARAMS)).resolves.toEqual({
      catalog_key: ENTRY.name,
      state: 'reusable_oauth',
    });
  });
});
