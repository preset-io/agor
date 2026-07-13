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
      'agor_links_move',
      'agor_links_save',
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

  it('saves a visible link to the current session branch without overwriting an existing copy', async () => {
    const source = {
      link_id: 'link-1',
      kind: 'url',
      url: 'https://example.com/runbook',
      title: 'Runbook',
    };
    const create = vi.fn(async (payload) => ({ link_id: 'branch-link', ...payload }));
    const handlers = registerTools(
      {
        sessions: {
          get: vi.fn(async () => ({ session_id: 'session-full', branch_id: 'branch-1' })),
        },
        links: { get: vi.fn(async () => source), create },
      },
      'session-short'
    );

    await handlers.get('agor_links_save')?.({ linkId: 'link-1', destination: 'branch' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        branch_id: 'branch-1',
        session_id: null,
        source: 'manual',
        url: source.url,
        title: source.title,
      }),
      { authenticated: true, _agorPreserveExistingOnCreate: true }
    );
  });

  it('moves a link to a resolved session owner through the guarded move route', async () => {
    const move = vi.fn(async (payload) => ({ link: payload, merged: false }));
    const handlers = registerTools({
      sessions: { get: vi.fn(async () => ({ session_id: 'session-full' })) },
      '/links/:linkId/move': { create: move },
      links: {},
    });

    await handlers.get('agor_links_move')?.({
      linkId: 'link-1',
      destination: 'session',
      sessionId: 'session-full',
    });

    expect(move).toHaveBeenCalledWith(
      { target: 'session', session_id: 'session-full' },
      {
        authenticated: true,
        route: { linkId: 'link-1' },
      }
    );
  });

  it('uses the guarded promotion service when saving to a teammate', async () => {
    const promote = vi.fn(async () => ({ link_id: 'teammate-link' }));
    const handlers = registerTools({
      branches: {
        get: vi.fn(async () => ({ branch_id: 'teammate-full' })),
      },
      '/links/:sourceLinkId/promote': { create: promote },
      links: {},
    });

    await handlers.get('agor_links_save')?.({
      linkId: 'link-1',
      destination: 'teammate',
      branchId: 'teammate-full',
    });

    expect(promote).toHaveBeenCalledWith(
      { target: 'teammate', teammate_branch_id: 'teammate-full' },
      {
        authenticated: true,
        route: { sourceLinkId: 'link-1' },
      }
    );
  });
});
