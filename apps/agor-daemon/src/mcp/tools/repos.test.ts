import type { Application } from '@agor/core/feathers';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { ReposService } from '../../services/repos.js';
import type { McpContext } from '../server.js';
import { registerRepoTools } from './repos.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureRepoTools(app: Application, role: 'viewer' | 'member' | 'admin' | 'superadmin') {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: '550e8400-e29b-41d4-a716-446655440004', role },
    tenant: { tenant_id: 'tenant-a', source: 'auth' },
  } as const;

  registerRepoTools(server, {
    app,
    db: {} as never,
    userId: baseServiceParams.user.user_id,
    authenticatedUser: baseServiceParams.user,
    baseServiceParams,
  } as unknown as McpContext);

  return {
    call(name: string, args: Record<string, unknown>) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool ${name} was not registered`);
      return handler(args);
    },
    baseServiceParams,
  };
}

describe('repository MCP authorization', () => {
  it.each(['viewer', 'member'] as const)(
    'denies %s mutation tools before validation or repository service work',
    async (role) => {
      let service: ReposService;
      const app = {
        get: vi.fn(() => ({})),
        service: vi.fn((path: string) => {
          if (path === 'repos') return service;
          throw new Error(`Unexpected service: ${path}`);
        }),
      } as unknown as Application;
      service = new ReposService({} as never, app);
      const get = vi.spyOn(service, 'get');
      const cloneRepository = vi.spyOn(service, 'cloneRepository');
      const tools = captureRepoTools(app, role);

      await expect(
        tools.call('agor_repos_create_remote', {
          url: 'not-a-git-url',
          slug: 'not a valid slug',
        })
      ).rejects.toMatchObject({ name: 'Forbidden' });
      await expect(
        tools.call('agor_repos_create_local', { path: '/host/private/repo' })
      ).rejects.toMatchObject({ name: 'Forbidden' });
      await expect(
        tools.call('agor_repos_update', { repoId: 'foreign-or-missing', name: 'changed' })
      ).rejects.toMatchObject({ name: 'Forbidden' });

      expect(get).not.toHaveBeenCalled();
      expect(cloneRepository).not.toHaveBeenCalled();
    }
  );

  it.each(['admin', 'superadmin'] as const)(
    'passes the current %s identity to repository mutation tools',
    async (role) => {
      const cloneRepository = vi.fn(async () => ({
        status: 'pending',
        slug: 'org/repo',
        repo_id: 'repo-id',
      }));
      const updateMetadata = vi.fn(async () => ({ repo_id: 'repo-id', name: 'changed' }));
      const service = { cloneRepository, updateMetadata };
      const app = { service: () => service } as unknown as Application;
      const tools = captureRepoTools(app, role);

      await tools.call('agor_repos_create_remote', {
        url: 'https://github.com/org/repo.git',
        slug: 'org/repo',
      });
      await tools.call('agor_repos_update', { repoId: 'repo-id', name: 'changed' });

      expect(cloneRepository).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ provider: 'mcp', user: expect.objectContaining({ role }) })
      );
      expect(updateMetadata).toHaveBeenCalledWith(
        'repo-id',
        { name: 'changed' },
        expect.objectContaining({ provider: 'mcp', user: expect.objectContaining({ role }) })
      );
    }
  );

  it('keeps member repository discovery and reads available', async () => {
    const find = vi.fn(async () => ({ total: 0, limit: 10, skip: 0, data: [] }));
    const get = vi.fn(async () => ({ repo_id: 'repo-id', slug: 'org/repo' }));
    const app = { service: () => ({ find, get }) } as unknown as Application;
    const tools = captureRepoTools(app, 'member');

    await expect(tools.call('agor_repos_list', {})).resolves.toBeDefined();
    await expect(tools.call('agor_repos_get', { repoId: 'repo-id' })).resolves.toBeDefined();
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'mcp',
        user: expect.objectContaining({ role: 'member' }),
      })
    );
    expect(get).toHaveBeenCalledWith(
      'repo-id',
      expect.objectContaining({
        provider: 'mcp',
        user: expect.objectContaining({ role: 'member' }),
      })
    );
  });
});
