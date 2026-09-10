import type {
  AuthenticatedParams,
  Branch,
  MCPCatalogEntry,
  MCPServer,
  Session,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createMCPCatalogStartSessionService } from './mcp-catalog-start-session.js';

const USER_ID = '00000000-0000-7000-8000-00000000a11c';
const TEAMMATE_ID = '00000000-0000-7000-8000-00000000b123';
const params = {
  provider: 'rest',
  user: { user_id: USER_ID, role: 'member' },
  tenant: { tenant_id: 'tenant-a' },
} as unknown as AuthenticatedParams;
const entry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  starter_prompt: 'Explain this repository.',
} as MCPCatalogEntry;
const server = {
  mcp_server_id: 'server-1',
  source: 'catalog',
  catalog_entry_name: entry.name,
  owner_user_id: USER_ID,
  url: entry.remote_url,
  transport: 'http',
} as MCPServer;
const teammate = {
  branch_id: TEAMMATE_ID,
  name: 'ada-branch',
  custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
} as unknown as Branch;
const request = {
  catalog_key: entry.name,
  mcp_server_id: server.mcp_server_id,
  teammate_branch_id: teammate.branch_id,
  agentic_tool: 'codex' as const,
};

function buildApp({ candidates = [teammate], savedServer = server } = {}) {
  const createdSession = {
    session_id: 'session-1',
    branch_id: teammate.branch_id,
    created_by: USER_ID,
  } as Session;
  const sessionsCreate = vi.fn(async () => createdSession);
  const sessionsRemove = vi.fn(async () => createdSession);
  const attach = vi.fn(async () => ({ session_id: createdSession.session_id }));
  const getCandidates = vi.fn(async () => candidates);
  const services: Record<string, unknown> = {
    'mcp-catalog': { get: vi.fn(async () => entry) },
    'mcp-servers': { get: vi.fn(async () => savedServer) },
    users: { getPrimaryTeammateCandidates: getCandidates },
    sessions: { create: sessionsCreate, remove: sessionsRemove },
    '/sessions/:id/mcp-servers': { create: attach },
  };
  return {
    app: { service: (path: string) => services[path] },
    sessionsCreate,
    sessionsRemove,
    attach,
    getCandidates,
    services,
  };
}

describe('mcp-catalog/start-session', () => {
  it('creates a caller-owned session on an eligible teammate and attaches the install', async () => {
    const built = buildApp();

    await expect(
      createMCPCatalogStartSessionService(built.app).create(request, params)
    ).resolves.toEqual({
      session: expect.objectContaining({ session_id: 'session-1' }),
      starter_prompt: entry.starter_prompt,
    });
    expect(built.getCandidates).toHaveBeenCalledWith(undefined, params);
    expect(built.sessionsCreate).toHaveBeenCalledWith(
      {
        branch_id: TEAMMATE_ID,
        agentic_tool: 'codex',
        status: 'idle',
        title: 'DeepWiki',
        mcpServerIds: ['server-1'],
      },
      params
    );
    expect(built.attach).not.toHaveBeenCalled();
  });

  it('rejects a teammate omitted by tenant/permission filtering before session creation', async () => {
    const built = buildApp({ candidates: [] });

    await expect(
      createMCPCatalogStartSessionService(built.app).create(request, params)
    ).rejects.toThrow(/active teammate/);
    expect(built.sessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects another user’s catalog install before session creation', async () => {
    const built = buildApp({
      savedServer: { ...server, owner_user_id: '00000000-0000-7000-8000-00000000b0b0' },
    });

    await expect(
      createMCPCatalogStartSessionService(built.app).create(request, params)
    ).rejects.toThrow(/not the selected MCP Catalog connection/);
    expect(built.getCandidates).not.toHaveBeenCalled();
    expect(built.sessionsCreate).not.toHaveBeenCalled();
  });

  it('propagates atomic session/attachment refusal without a second write', async () => {
    const built = buildApp();
    built.sessionsCreate.mockRejectedValue(new Error('private to another user'));

    await expect(
      createMCPCatalogStartSessionService(built.app).create(request, params)
    ).rejects.toThrow(/private to another user/);
    expect(built.sessionsRemove).not.toHaveBeenCalled();
    expect(built.attach).not.toHaveBeenCalled();
  });
});

it.each(['catalog_entry_name', 'url', 'transport'] as const)(
  'rejects mismatched install %s',
  async (field) => {
    const built = buildApp({ savedServer: { ...server, [field]: 'different' } });
    await expect(
      createMCPCatalogStartSessionService(built.app).create(request, params)
    ).rejects.toThrow(/not the selected/);
    expect(built.sessionsCreate).not.toHaveBeenCalled();
  }
);

it('does not cross a tenant boundary when the owning server service refuses its row', async () => {
  const built = buildApp();
  const get = vi.fn(async () => {
    throw new Error('Server not found in this tenant');
  });
  built.services['mcp-servers'] = { get };
  await expect(
    createMCPCatalogStartSessionService(built.app).create(request, params)
  ).rejects.toThrow(/not found in this tenant/);
  expect(get).toHaveBeenCalledWith(request.mcp_server_id, params);
  expect(built.getCandidates).not.toHaveBeenCalled();
  expect(built.sessionsCreate).not.toHaveBeenCalled();
});

it('fails before reads or writes without authenticated caller identity', async () => {
  const built = buildApp();
  await expect(
    createMCPCatalogStartSessionService(built.app).create(request, {} as AuthenticatedParams)
  ).rejects.toThrow(/Authentication required/);
  expect(built.getCandidates).not.toHaveBeenCalled();
  expect(built.sessionsCreate).not.toHaveBeenCalled();
});

it.each([
  'https://other.example/mcp/',
  'http://mcp.deepwiki.com/mcp/',
  'https://mcp.deepwiki.com/other/',
  'https://mcp.deepwiki.com/mcp/?account=other',
])('still rejects a different endpoint %s', async (url) => {
  const built = buildApp({ savedServer: { ...server, url } });
  await expect(
    createMCPCatalogStartSessionService(built.app).create(request, params)
  ).rejects.toThrow(/not the selected/);
  expect(built.sessionsCreate).not.toHaveBeenCalled();
});
