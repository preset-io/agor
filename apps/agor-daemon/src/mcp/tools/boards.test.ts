import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerBoardTools } from './boards.js';

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  runWithTenantDatabaseScope: vi.fn((_db, _tenantId, work) => work()),
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

type ToolConfig = {
  inputSchema?: {
    safeParse: (
      value: unknown
    ) =>
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ message: string }> } };
  };
};

function makeMcpContext(ctx: {
  app: unknown;
  userId: string;
  baseServiceParams?: Record<string, unknown>;
}): Parameters<typeof registerBoardTools>[1] {
  return {
    app: ctx.app as Parameters<typeof registerBoardTools>[1]['app'],
    db: {} as Parameters<typeof registerBoardTools>[1]['db'],
    userId: ctx.userId as Parameters<typeof registerBoardTools>[1]['userId'],
    authenticatedUser: { user_id: ctx.userId, role: 'member' } as Parameters<
      typeof registerBoardTools
    >[1]['authenticatedUser'],
    baseServiceParams: (ctx.baseServiceParams ?? {}) as Parameters<
      typeof registerBoardTools
    >[1]['baseServiceParams'],
  };
}

function registerAndCaptureHandler(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    baseServiceParams?: Record<string, unknown>;
  }
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;

  registerBoardTools(fakeServer, makeMcpContext(ctx));

  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function registerAndCaptureConfig(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    baseServiceParams?: Record<string, unknown>;
  }
): ToolConfig {
  let config: ToolConfig | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: ToolConfig, _cb: ToolHandler) => {
      if (name === toolName) config = cfg;
    },
  } as unknown as McpServer;

  registerBoardTools(fakeServer, makeMcpContext(ctx));

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

describe('agor_boards_get', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  const board = {
    board_id: 'board-1',
    name: 'Test Board',
    url: 'http://localhost:5173/ui/b/board-1/',
    created_at: '2026-06-01T00:00:00.000Z',
    last_updated: '2026-06-01T00:00:00.000Z',
    created_by: 'user-1',
    archived: false,
    objects: {
      'zone-review': {
        type: 'zone',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        label: 'Review',
      },
      'note-1': {
        type: 'markdown',
        x: 500,
        y: 0,
        width: 300,
        content: '# Large note',
      },
      'app-1': {
        type: 'app',
        x: 0,
        y: 400,
        width: 600,
        height: 400,
        title: 'Heavy app',
        template: 'react',
        files: { '/src/App.tsx': 'export default function App() { return null; }' },
      },
    },
  };

  function makeApp(options?: {
    boardObjectsFind?: ReturnType<typeof vi.fn>;
    branchesFind?: ReturnType<typeof vi.fn>;
  }) {
    const boardsGet = vi.fn(async () => board);
    const boardObjectsFind =
      options?.boardObjectsFind ??
      vi.fn(async () => ({
        data: [],
        total: 0,
        limit: 100,
        skip: 0,
      }));
    const branchesFind =
      options?.branchesFind ??
      vi.fn(async (params?: { query?: { branch_id?: { $in?: string[] } } }) =>
        (params?.query?.branch_id?.$in ?? []).map((branch_id) => ({ branch_id, archived: false }))
      );

    return {
      boardsGet,
      boardObjectsFind,
      branchesFind,
      app: {
        service(name: string) {
          if (name === 'boards') return { get: boardsGet };
          if (name === 'board-objects') return { find: boardObjectsFind };
          if (name === 'branches') return { find: branchesFind };
          throw new Error(`Unexpected service call: ${name}`);
        },
      },
    };
  }

  it('can return a lean board definition with only zone objects and no entities', async () => {
    const { app, boardObjectsFind } = makeApp();
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({ boardId: 'board-1', objectTypes: ['zone'] });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(Object.keys(parsed.objects)).toEqual(['zone-review']);
    expect(parsed.objects['zone-review'].label).toBe('Review');
    expect(parsed.entities).toBeUndefined();
    expect(boardObjectsFind).not.toHaveBeenCalled();
  });

  it('filters and paginates included positioned entities', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-0',
          board_id: 'board-1',
          branch_id: 'branch-0',
          entity_type: 'branch',
          position: { x: 0, y: 0 },
          zone_id: 'zone-review',
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          zone_id: 'zone-review',
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-2',
          board_id: 'board-1',
          branch_id: 'branch-2',
          entity_type: 'branch',
          position: { x: 30, y: 40 },
          zone_id: 'zone-review',
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 3,
      limit: 100,
      skip: 0,
    }));
    const branchesFind = vi.fn(async () => [
      { branch_id: 'branch-0', archived: false },
      { branch_id: 'branch-1', archived: false },
      { branch_id: 'branch-2', archived: false },
    ]);
    const { app } = makeApp({ boardObjectsFind, branchesFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      entityZoneId: 'zone-review',
      entityType: 'branch',
      entitiesLimit: 1,
      entitiesSkip: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardObjectsFind).toHaveBeenCalledWith({
      query: {
        board_id: 'board-1',
        zone_id: 'zone-review',
        entity_type: 'branch',
      },
      ...baseServiceParams,
    });
    expect(branchesFind).toHaveBeenCalledWith({
      query: {
        branch_id: { $in: ['branch-0', 'branch-1', 'branch-2'] },
        archived: false,
      },
      paginate: false,
      ...baseServiceParams,
    });
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].branch_id).toBe('branch-1');
    expect(parsed.entities_pagination).toEqual({ total: 3, limit: 1, skip: 1 });
  });

  it('excludes archived branch entities by default while preserving card entities', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-2',
          board_id: 'board-1',
          branch_id: 'branch-2',
          entity_type: 'branch',
          position: { x: 30, y: 40 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-card-1',
          board_id: 'board-1',
          card_id: 'card-1',
          entity_type: 'card',
          position: { x: 50, y: 60 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 3,
      limit: 100,
      skip: 0,
    }));
    const branchesFind = vi.fn(async () => [{ branch_id: 'branch-1', archived: false }]);
    const { app } = makeApp({ boardObjectsFind, branchesFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({ boardId: 'board-1', includeEntities: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardObjectsFind).toHaveBeenCalledWith({
      query: { board_id: 'board-1' },
      ...baseServiceParams,
    });
    expect(parsed.entities.map((entity: { object_id: string }) => entity.object_id)).toEqual([
      'obj-branch-1',
      'obj-card-1',
    ]);
    expect(parsed.entities_pagination).toEqual({ total: 2, limit: null, skip: 0 });
  });

  it('includes archived branch entities when includeArchived=true', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 1,
      limit: 100,
      skip: 0,
    }));
    const branchesFind = vi.fn(async () => []);
    const { app } = makeApp({ boardObjectsFind, branchesFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      includeArchived: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(branchesFind).not.toHaveBeenCalled();
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].branch_id).toBe('branch-1');
    expect(parsed.entities_pagination).toEqual({ total: 1, limit: null, skip: 0 });
  });

  it('reports null pagination limit when only entitiesSkip is provided', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-0',
          board_id: 'board-1',
          branch_id: 'branch-0',
          entity_type: 'branch',
          position: { x: 0, y: 0 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 2,
      limit: 100,
      skip: 0,
    }));
    const { app } = makeApp({ boardObjectsFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      entitiesSkip: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].branch_id).toBe('branch-1');
    expect(parsed.entities_pagination).toEqual({ total: 2, limit: null, skip: 1 });
  });

  it('validates entity pagination input constraints in the MCP schema', () => {
    const { app } = makeApp();
    const config = registerAndCaptureConfig('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: 25,
        entitiesSkip: 5,
      }).success
    ).toBe(true);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: -1,
      }).success
    ).toBe(false);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: 1.5,
      }).success
    ).toBe(false);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: 0,
      }).success
    ).toBe(false);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesSkip: 10001,
      }).success
    ).toBe(false);
  });

  it('rejects empty required boardId with a clear field-specific message', () => {
    const { app } = makeApp();
    const config = registerAndCaptureConfig('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = config.inputSchema?.safeParse({ boardId: '' });

    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.issues[0]?.message).toMatch(/boardId cannot be empty/i);
    }
  });
});

describe('agor_boards_create schema', () => {
  it('rejects an empty required board name with a clear message', () => {
    const config = registerAndCaptureConfig('agor_boards_create', {
      app: {},
      userId: 'user-1',
    });

    const result = config.inputSchema?.safeParse({ name: '' });

    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.issues[0]?.message).toMatch(/name cannot be empty/i);
    }
  });
});

describe('agor_boards_update realtime events', () => {
  it('emits custom object mutations with a correctly-shaped HookContext', async () => {
    const params = {
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      user: { user_id: 'user-1', role: 'member' },
    };
    const updatedBoard = { board_id: 'board-1', name: 'Board', objects: {} };
    const emit = vi.fn();
    const batchUpsertBoardObjects = vi.fn(async () => updatedBoard);
    const get = vi.fn(async () => updatedBoard);
    const app = {
      service(name: string) {
        if (name === 'boards') return { batchUpsertBoardObjects, get, emit };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const updateBoard = registerAndCaptureHandler('agor_boards_update', {
      app,
      userId: 'user-1',
      baseServiceParams: params,
    });

    await updateBoard({
      boardId: 'board-1',
      upsertObjects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 100, height: 100 } },
    });

    expect(batchUpsertBoardObjects).toHaveBeenCalledWith('board-1', expect.any(Object), params);
    expect(emit).toHaveBeenCalledWith(
      'patched',
      updatedBoard,
      expect.objectContaining({
        path: 'boards',
        method: 'patch',
        id: 'board-1',
        params: {},
        result: updatedBoard,
      })
    );
  });
});

describe('board icon shortcode handling at MCP boundary', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  it('agor_boards_create returns the repository-normalized icon', async () => {
    const boardsCreate = vi.fn(async (data: Record<string, unknown>) => ({
      board_id: 'board-1',
      name: data.name,
      icon: '🧭',
      created_by: data.created_by,
      created_at: '2026-06-01T00:00:00.000Z',
      last_updated: '2026-06-01T00:00:00.000Z',
      archived: false,
      url: 'http://localhost:5173/ui/b/board-1/',
    }));
    const app = {
      service(name: string) {
        if (name === 'boards') return { create: boardsCreate };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const createBoard = registerAndCaptureHandler('agor_boards_create', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await createBoard({ name: 'Compass Board', icon: ':compass:' });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardsCreate).toHaveBeenCalledWith(
      {
        name: 'Compass Board',
        created_by: 'user-1',
        icon: ':compass:',
      },
      baseServiceParams
    );
    expect(parsed.icon).toBe('🧭');
  });

  it('agor_boards_update returns the repository-normalized icon', async () => {
    const normalizedBoard = {
      board_id: 'board-1',
      name: 'Compass Board',
      icon: '🧭',
      created_by: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
      last_updated: '2026-06-01T00:00:00.000Z',
      archived: false,
      url: 'http://localhost:5173/ui/b/board-1/',
    };
    const boardsPatch = vi.fn(async () => normalizedBoard);
    const boardsGet = vi.fn(async () => normalizedBoard);
    const app = {
      service(name: string) {
        if (name === 'boards') return { patch: boardsPatch, get: boardsGet, emit: vi.fn() };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const updateBoard = registerAndCaptureHandler('agor_boards_update', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await updateBoard({ boardId: 'board-1', icon: ':compass:' });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardsPatch).toHaveBeenCalledWith('board-1', { icon: ':compass:' }, baseServiceParams);
    expect(boardsGet).toHaveBeenCalledWith('board-1', baseServiceParams);
    expect(parsed.board.icon).toBe('🧭');
  });
});
