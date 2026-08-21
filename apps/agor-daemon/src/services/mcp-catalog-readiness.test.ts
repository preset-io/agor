import type { AuthenticatedParams, MCPCatalogEntry, MCPServer, UserID } from '@agor/core/types';
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

function build(servers: MCPServer[]) {
  const catalogGet = vi.fn(async () => ENTRY);
  const serverFind = vi.fn(async () => servers);
  const app = {
    service(path: string) {
      if (path === 'mcp-catalog') return { get: catalogGet, find: vi.fn() };
      if (path === 'mcp-servers') return { get: vi.fn(), find: serverFind };
      throw new Error(`unexpected service ${path}`);
    },
  };
  const readGrantResourceUri = vi.fn(async () => ENTRY.remote_url);
  return {
    service: new MCPCatalogReadinessService(app, { readGrantResourceUri }),
    catalogGet,
    serverFind,
    readGrantResourceUri,
  };
}

describe('MCPCatalogReadinessService', () => {
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
    expect(built.serverFind).toHaveBeenCalledOnce();
    expect(built.readGrantResourceUri).toHaveBeenCalledOnce();
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
    expect(built.serverFind).toHaveBeenCalledTimes(2);
  });
});
