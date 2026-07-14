import { LINK_PROMOTION_TARGET } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerLinkTools } from './links.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function registerTools(services: Record<string, unknown>, sessionId?: string) {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerLinkTools(server, {
    app: {
      service: (name: string) => {
        const service = services[name];
        if (!service) throw new Error(`Unexpected service: ${name}`);
        return service;
      },
    } as any,
    db: {} as any,
    userId: 'user-1' as any,
    sessionId: sessionId as any,
    authenticatedUser: { user_id: 'user-1', email: 'user@example.com', role: 'member' } as any,
    baseServiceParams: { authenticated: true },
  });
  return handlers;
}

describe('link MCP tools', () => {
  it('registers a complete CRUD surface', () => {
    const handlers = registerTools({ links: {} });
    expect([...handlers.keys()]).toEqual([
      'agor_links_list',
      'agor_links_get',
      'agor_links_create',
      'agor_links_update',
      'agor_links_promote',
      'agor_links_remove_from',
      'agor_links_delete',
    ]);
  });

  it('creates a manual link on the current session by default', async () => {
    const create = vi.fn(async (payload) => ({ link_id: 'link-1', ...payload }));
    const handlers = registerTools(
      {
        sessions: {
          get: vi.fn(async () => ({ session_id: 'session-full', branch_id: 'branch-1' })),
        },
        links: { create },
      },
      'session-short'
    );

    await handlers.get('agor_links_create')?.({
      url: 'https://github.com/preset-io/agor/issues/154',
      title: 'Follow-up',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-full',
        branch_id: null,
        kind: 'issue',
        source: 'manual',
        title: 'Follow-up',
      }),
      { authenticated: true }
    );
  });

  it('does not classify non-GitHub issue-shaped URLs as GitHub issues', async () => {
    const create = vi.fn(async (payload) => ({ link_id: 'link-1', ...payload }));
    const handlers = registerTools({
      branches: { get: vi.fn(async () => ({ branch_id: 'branch-full' })) },
      links: { create },
    });

    await handlers.get('agor_links_create')?.({
      branchId: 'branch-full',
      url: 'https://example.com/team/project/issues/154',
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'url' }), {
      authenticated: true,
    });
  });

  it('rejects target edits on parsed links while allowing label edits', async () => {
    const patch = vi.fn(async (_id, changes) => changes);
    const get = vi.fn(async () => ({ link_id: 'link-1', source: 'parsed' }));
    const handlers = registerTools({ links: { get, patch } });
    const update = handlers.get('agor_links_update');

    await expect(
      update?.({ linkId: 'link-1', url: 'https://example.com/replacement' })
    ).rejects.toThrow('Only manual links can change target');

    await update?.({ linkId: 'link-1', title: 'Readable label' });
    expect(patch).toHaveBeenCalledWith(
      'link-1',
      { title: 'Readable label' },
      { authenticated: true }
    );
  });

  it('infers kind when a manual target changes', async () => {
    const patch = vi.fn(async (_id, changes) => changes);
    const get = vi.fn(async () => ({ link_id: 'link-1', source: 'manual' }));
    const handlers = registerTools({ links: { get, patch } });

    await handlers.get('agor_links_update')?.({
      linkId: 'link-1',
      url: 'https://github.com/openai/codex/pull/42',
    });

    expect(patch).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({ kind: 'pr', url: 'https://github.com/openai/codex/pull/42' }),
      { authenticated: true }
    );
  });

  it('promotes a visible link to the current session branch through the guarded service', async () => {
    const promote = vi.fn(async () => ({ link_id: 'branch-link' }));
    const handlers = registerTools(
      {
        sessions: {
          get: vi.fn(async () => ({ session_id: 'session-full', branch_id: 'branch-1' })),
        },
        '/links/:sourceLinkId/placements': { create: promote },
        links: {},
      },
      'session-short'
    );

    await handlers.get('agor_links_promote')?.({
      linkId: 'link-1',
      destination: LINK_PROMOTION_TARGET.branch,
    });

    expect(promote).toHaveBeenCalledWith(
      { target: LINK_PROMOTION_TARGET.branch, branch_id: 'branch-1' },
      {
        authenticated: true,
        route: { sourceLinkId: 'link-1' },
      }
    );
  });

  it('promotes a visible link to a resolved teammate through the guarded service', async () => {
    const promote = vi.fn(async () => ({ link_id: 'teammate-link' }));
    const handlers = registerTools({
      branches: {
        get: vi.fn(async () => ({ branch_id: 'teammate-full' })),
      },
      '/links/:sourceLinkId/placements': { create: promote },
      links: {},
    });

    await handlers.get('agor_links_promote')?.({
      linkId: 'link-1',
      destination: LINK_PROMOTION_TARGET.teammate,
      branchId: 'teammate-full',
    });

    expect(promote).toHaveBeenCalledWith(
      { target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: 'teammate-full' },
      {
        authenticated: true,
        route: { sourceLinkId: 'link-1' },
      }
    );
  });

  it('removes only the resolved teammate placement', async () => {
    const remove = vi.fn(async () => ({ link_id: 'teammate-link' }));
    const handlers = registerTools({
      branches: {
        get: vi.fn(async () => ({ branch_id: 'teammate-full' })),
      },
      '/links/:sourceLinkId/placements': { remove },
      links: {},
    });

    await handlers.get('agor_links_remove_from')?.({
      linkId: 'link-1',
      destination: LINK_PROMOTION_TARGET.teammate,
      branchId: 'teammate-full',
    });

    const request = {
      target: LINK_PROMOTION_TARGET.teammate,
      teammate_branch_id: 'teammate-full',
    };
    expect(remove).toHaveBeenCalledWith(null, {
      authenticated: true,
      route: { sourceLinkId: 'link-1' },
      query: request,
    });
  });
});
