import {
  BOARD_GRID_SIZE,
  ceilBoardGridValue,
  snapBoardGridPoint,
} from '@agor/core/layout/rectangle-packing';
import { GENERIC_BOARD_CARD_LAYOUT } from '@agor/core/layout/zone-layout';
import { branchQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import type { McpServer } from '@modelcontextprotocol/server';
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

/**
 * Put a `branches.find` mock behind the same query-validation hook the daemon
 * registers for the branches service (see register-hooks.ts).
 *
 * Every board layout tool asks the branches service which pinned worktrees are
 * still active, and that query — not the service beneath it — is where the
 * branch path used to die. A mock wired straight to `find` cannot observe
 * that, which is how these tools shipped broken for boards holding a branch.
 */
function validatedBranchesFind<T>(
  find: (query: Record<string, unknown>) => T
): ReturnType<typeof vi.fn> {
  return vi.fn(async (params: { query?: Record<string, unknown> }) => {
    const context = { params: { ...params } };
    await typedValidateQuery(branchQueryValidator)(context);
    return find(context.params.query ?? {});
  });
}

describe('agor_boards_list pagination', () => {
  const baseServiceParams = { authenticated: true, provider: 'mcp' };

  it('uses a lean bounded default and reports how to advance pages', async () => {
    const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => ({
      total: 30,
      limit: query.$limit,
      skip: query.$skip,
      data: Array.from({ length: 25 }, (_, i) => ({ board_id: `board-${i}` })),
    }));
    const list = registerAndCaptureHandler('agor_boards_list', {
      app: { service: () => ({ find }) },
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse((await list({})).content[0].text);
    expect(find).toHaveBeenCalledWith({
      query: {
        $limit: 25,
        $skip: 0,
        lean: true,
        archived: false,
        $sort: { created_at: -1, board_id: 1 },
      },
      ...baseServiceParams,
    });
    expect(parsed).toMatchObject({
      total: 30,
      limit: 25,
      offset: 0,
      hasMore: true,
      nextOffset: 25,
    });
  });

  it('supports explicit and empty final pages and caps limits in the schema', async () => {
    const find = vi.fn(async () => ({ total: 4, limit: 2, skip: 4, data: [] }));
    const ctx = {
      app: { service: () => ({ find }) },
      userId: 'user-1',
      baseServiceParams,
    };
    const list = registerAndCaptureHandler('agor_boards_list', ctx);
    const parsed = JSON.parse((await list({ limit: 2, offset: 4 })).content[0].text);
    expect(parsed).toMatchObject({ total: 4, data: [], hasMore: false, nextOffset: null });

    const schema = registerAndCaptureConfig('agor_boards_list', ctx).inputSchema!;
    expect(schema.safeParse({ limit: 100 }).success).toBe(true);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

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
    const permissionsFind = vi.fn(async () => ({
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_access_revision: 1,
      branch_template_revision: 1,
    }));
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
          if (name === 'boards/:id/permissions') return { find: permissionsFind };
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

  it('accepts None as a board branch-permission default', () => {
    const config = registerAndCaptureConfig('agor_boards_create', {
      app: {},
      userId: 'user-1',
    });

    expect(
      config.inputSchema?.safeParse({ name: 'Private fallback', defaultOthersCan: 'none' }).success
    ).toBe(true);
  });
});

function expectBoardGridRect(rect: {
  position: { x: number; y: number };
  size: { width: number; height: number };
}) {
  expect(rect.position.x % BOARD_GRID_SIZE).toBe(0);
  expect(rect.position.y % BOARD_GRID_SIZE).toBe(0);
  expect(rect.size.width % BOARD_GRID_SIZE).toBe(0);
  expect(rect.size.height % BOARD_GRID_SIZE).toBe(0);
  expect(snapBoardGridPoint(rect.position)).toEqual(rect.position);
}

describe('agor_boards_auto_arrange_zone', () => {
  const baseServiceParams = { authenticated: true, provider: 'mcp' };

  it('exposes deck overflow as an explicit opt-in', () => {
    const config = registerAndCaptureConfig('agor_boards_auto_arrange_zone', {
      app: {},
      userId: 'user-1',
    });

    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        zoneId: 'zone-1',
        overflowStrategy: 'deck',
      }).success
    ).toBe(true);
  });

  it('arranges only active cards, never hidden archived cards', async () => {
    const patches = vi.fn(
      async (_id: string, data: { position: { x: number; y: number } }) => data
    );
    const entities = Array.from({ length: 20 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: 0, y: index * 10 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const cardsFind = vi.fn(async () => ({
      data: entities.slice(0, 5).map((entity) => ({ card_id: entity.card_id })),
    }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1200, height: 1800 } },
            })),
          };
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: entities })), patch: patches };
        if (name === 'cards')
          return { find: cardsFind, get: vi.fn(async () => ({ title: 'Card' })) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 1, strictColumns: true }))
        .content[0].text
    );

    expect(cardsFind).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ archived: false }) })
    );
    expect(parsed).toMatchObject({ applied: true, arranged: 5, columns: 1, rows: 5 });
    expect(patches).toHaveBeenCalledTimes(5);
    expect(patches.mock.calls.map(([objectId]) => objectId)).toEqual(
      entities.slice(0, 5).map((entity) => entity.object_id)
    );
  });

  it('uses accessible cascade offsets only when deck overflow is explicit', async () => {
    const patches: Array<{ id: string; position: { x: number; y: number } }> = [];
    const boardObjects = Array.from({ length: 20 }, (_, index) => ({
      object_id: `branch-${index}`,
      board_id: 'board-1',
      branch_id: `branch-${index}`,
      entity_type: 'branch' as const,
      position: { x: 0, y: 0 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const boardObjectsService = {
      find: vi.fn(async () => ({ data: boardObjects })),
      patch: vi.fn(async (id: string, data: { position: { x: number; y: number } }) => {
        patches.push({ id, position: data.position });
        return data;
      }),
    };
    const app = {
      service(name: string) {
        if (name === 'boards') {
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 100, y: 100, width: 1000, height: 1800 },
              },
            })),
          };
        }
        if (name === 'board-objects') return boardObjectsService;
        if (name === 'branches')
          return {
            find: vi.fn(async () => ({
              data: boardObjects.map((object) => ({ branch_id: object.branch_id })),
            })),
            get: vi.fn(async () => ({ name: 'Branch' })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const rejected = JSON.parse(
      (
        await arrange({
          boardId: 'board-1',
          zoneId: 'zone-1',
          columns: 1,
          includeArchived: true,
        })
      ).content[0].text
    );
    expect(rejected).toMatchObject({
      applied: false,
      arranged: 0,
      requestedColumns: 1,
      layoutMode: 'grid',
      updates: [],
    });
    expect(rejected.overflowingObjectIds.length).toBeGreaterThan(0);
    expect(patches).toHaveLength(0);

    const parsed = JSON.parse(
      (
        await arrange({
          boardId: 'board-1',
          zoneId: 'zone-1',
          columns: 1,
          overflowStrategy: 'deck',
          includeArchived: true,
        })
      ).content[0].text
    );

    expect(parsed.arranged).toBe(20);
    expect(parsed.applied).toBe(true);
    expect(parsed.requestedColumns).toBe(1);
    expect(parsed.columns).toBe(1);
    expect(parsed.fitsWithoutOverlap).toBe(false);
    expect(parsed.layoutMode).toBe('deck');
    expect(parsed.deckOffsetX).toBe(20);
    expect(parsed.deckOffsetY).toBe(60);
    expect(parsed.overflowingObjectIds).toEqual([]);
    expect(parsed.warning).toContain('60px header reveals');
    expect(patches).toHaveLength(20);

    const secondLayer = parsed.updates.find(
      (update: { deckDepth: number }) => update.deckDepth === 1
    );
    const stackBase = parsed.updates.find(
      (update: { stackIndex: number; deckDepth: number }) =>
        update.stackIndex === secondLayer?.stackIndex && update.deckDepth === 0
    );
    expect(secondLayer).toBeDefined();
    expect(stackBase).toBeDefined();
    expect(secondLayer.position).toEqual({
      x: stackBase.position.x + 20,
      y: stackBase.position.y + 60,
    });
    expect(parsed.requiredHeight).toBeLessThanOrEqual(1800);
  });

  it('prefers a fully separated row-major grid when rows and columns fit', async () => {
    const patches: Array<{ position: { x: number; y: number } }> = [];
    const entities = Array.from({ length: 4 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: index * 10, y: 0 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1000, height: 500 } },
            })),
          };
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(
              async (
                _id: string,
                data: {
                  position: { x: number; y: number };
                  size: { width: number; height: number };
                }
              ) => {
                patches.push(data);
                return data;
              }
            ),
          };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: entities.map((entity) => ({ card_id: entity.card_id })),
            })),
            get: vi.fn(async () => ({ title: 'Card' })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 2 })).content[0].text
    );

    expect(parsed).toMatchObject({ layoutMode: 'grid', columns: 2, rows: 2 });
    expect(patches.map((update) => update.position)).toEqual([
      { x: 20, y: 100 },
      { x: 424, y: 100 },
      { x: 20, y: 184 },
      { x: 424, y: 184 },
    ]);
  });

  it.each([4, 12, 24])('preserves a requested %ipx boundary gap', async (gap) => {
    const patches: Array<{ position: { x: number; y: number } }> = [];
    const entities = ['left', 'right'].map((id) => ({
      object_id: id,
      board_id: 'board-1',
      card_id: id,
      entity_type: 'card' as const,
      position: { x: 0, y: 0 },
      size: { width: 380, height: 100 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app: {
        service(name: string) {
          if (name === 'boards')
            return {
              get: vi.fn(async () => ({
                board_id: 'board-1',
                objects: {
                  'zone-1': { type: 'zone', x: 0, y: 0, width: 1000, height: 500 },
                },
              })),
            };
          if (name === 'board-objects')
            return {
              find: vi.fn(async () => ({ data: entities })),
              patch: vi.fn(async (_id: string, data: { position: { x: number; y: number } }) => {
                patches.push(data);
                return data;
              }),
            };
          if (name === 'cards')
            return {
              find: vi.fn(async () => ({ data: entities.map(({ card_id }) => ({ card_id })) })),
            };
          throw new Error(`Unexpected service call: ${name}`);
        },
      },
      userId: 'user-1',
      baseServiceParams,
    });

    const result = JSON.parse(
      (
        await arrange({
          boardId: 'board-1',
          zoneId: 'zone-1',
          columns: 2,
          strictColumns: true,
          gapX: gap,
          gapY: gap,
        })
      ).content[0].text
    );

    expect(result).toMatchObject({ applied: true, appliedGapX: gap, appliedGapY: gap });
    expect(patches[1]!.position.x - (patches[0]!.position.x + 380)).toBe(gap);
  });

  it('uses one compact cluster for measured entities and contained canvas objects', async () => {
    const entities = [
      {
        object_id: 'branch-placement',
        board_id: 'board-1',
        branch_id: 'branch-1',
        entity_type: 'branch' as const,
        position: { x: 40, y: 120 },
        size: { width: 520, height: 140 },
        zone_id: 'zone-1',
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        object_id: 'card-placement',
        board_id: 'board-1',
        card_id: 'card-1',
        entity_type: 'card' as const,
        position: { x: 40, y: 300 },
        size: { width: 280, height: 180 },
        zone_id: 'zone-1',
        created_at: '2026-06-02T00:00:00.000Z',
      },
    ];
    const boardPatch = vi.fn(async () => undefined);
    const entityPatch = vi.fn(async () => undefined);
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 100, y: 100, width: 1400, height: 1100 },
                artifact: {
                  type: 'artifact',
                  artifact_id: 'artifact-1',
                  x: 700,
                  y: 300,
                  width: 260,
                  height: 440,
                },
                note: { type: 'markdown', x: 980, y: 300, width: 320, content: 'A note' },
                app: {
                  type: 'app',
                  x: 700,
                  y: 760,
                  width: 360,
                  height: 220,
                  title: 'App',
                  template: 'react',
                  files: {},
                },
                locked: {
                  type: 'artifact',
                  artifact_id: 'locked',
                  x: 1100,
                  y: 760,
                  width: 260,
                  height: 220,
                  locked: true,
                },
              },
            })),
            patch: boardPatch,
          };
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: entities })), patch: entityPatch };
        if (name === 'branches')
          return { find: vi.fn(async () => ({ data: [{ branch_id: 'branch-1' }] })) };
        if (name === 'cards')
          return { find: vi.fn(async () => ({ data: [{ card_id: 'card-1' }] })) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed).toMatchObject({
      applied: true,
      arranged: 5,
      layoutMode: 'cluster',
      fitsWithoutOverlap: true,
      overflowingObjectIds: [],
    });
    expect(entityPatch).toHaveBeenCalledTimes(2);
    expect(boardPatch).toHaveBeenCalledTimes(1);
    expect(boardPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'batchUpsertObjects',
        objects: {
          artifact: expect.objectContaining({ type: 'artifact' }),
          note: expect.objectContaining({ type: 'markdown' }),
          app: expect.objectContaining({ type: 'app' }),
        },
      }),
      baseServiceParams
    );
    expect(parsed.updates.map((update: { objectId: string }) => update.objectId)).not.toContain(
      'locked'
    );
    const relativeUpdates = parsed.updates.map(
      (update: { objectId: string; position: { x: number; y: number } }) => ({
        ...update,
        position:
          update.objectId === 'branch-placement' || update.objectId === 'card-placement'
            ? update.position
            : { x: update.position.x - 100, y: update.position.y - 100 },
      })
    );
    for (const [index, left] of relativeUpdates.entries()) {
      const leftSize =
        left.objectId === 'branch-placement'
          ? { width: 520, height: 140 }
          : left.objectId === 'card-placement'
            ? { width: 280, height: 180 }
            : left.objectId === 'artifact'
              ? { width: 260, height: 440 }
              : left.objectId === 'note'
                ? { width: 320, height: 140 }
                : { width: 360, height: 220 };
      for (const right of relativeUpdates.slice(index + 1)) {
        const rightSize =
          right.objectId === 'branch-placement'
            ? { width: 520, height: 140 }
            : right.objectId === 'card-placement'
              ? { width: 280, height: 180 }
              : right.objectId === 'artifact'
                ? { width: 260, height: 440 }
                : right.objectId === 'note'
                  ? { width: 320, height: 140 }
                  : { width: 360, height: 220 };
        expect(
          left.position.x + leftSize.width + 20 <= right.position.x ||
            right.position.x + rightSize.width + 20 <= left.position.x ||
            left.position.y + leftSize.height + 20 <= right.position.y ||
            right.position.y + rightSize.height + 20 <= left.position.y
        ).toBe(true);
      }
    }
  });

  it('uses persisted rendered sizes instead of guessing from card content', async () => {
    const patches: Array<{ position: { x: number; y: number } }> = [];
    const entities = Array.from({ length: 20 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: 0, y: index * 10 },
      size: { width: 380, height: 56 + (index % 3) * 12 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const cardsGet = vi.fn(async () => ({ description: 'x'.repeat(10_000) }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 2200 } },
            })),
          };
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (_id: string, data: { position: { x: number; y: number } }) => {
              patches.push(data);
              return data;
            }),
          };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: entities.map((entity) => ({ card_id: entity.card_id })),
            })),
            get: cardsGet,
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed).toMatchObject({
      layoutMode: 'cluster',
      columns: 1,
      rows: 20,
      fitsWithoutOverlap: true,
      overflowingObjectIds: [],
      warning: null,
    });
    expect(cardsGet).not.toHaveBeenCalled();
    expect(patches).toHaveLength(20);
    for (const [index, patch] of patches.entries()) {
      const entity = entities[index];
      expect(patch.position.x + (entity?.size.width ?? 0)).toBeLessThanOrEqual(620 - 24);
      expect(patch.position.y + (entity?.size.height ?? 0)).toBeLessThanOrEqual(2200 - 20);
    }
  });

  it('does not move anything when exact columns cannot fit inside the zone', async () => {
    const patch = vi.fn();
    const entities = Array.from({ length: 4 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: index * 10, y: 0 },
      size: { width: 380, height: 80 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 500 } },
            })),
          };
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: entities })), patch };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: entities.map((entity) => ({ card_id: entity.card_id })),
            })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 3, strictColumns: true }))
        .content[0].text
    );

    expect(parsed).toMatchObject({
      applied: false,
      arranged: 0,
      requestedColumns: 3,
      columns: 3,
      updates: [],
    });
    expect(parsed.overflowingObjectIds.length).toBeGreaterThan(0);
    expect(parsed.warning).toContain('No positions were changed');
    expect(patch).not.toHaveBeenCalled();
  });

  it('reports a rendered object that cannot physically fit inside its zone', async () => {
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 400 } },
            })),
          };
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({
              data: [
                {
                  object_id: 'branch-too-wide',
                  board_id: 'board-1',
                  branch_id: 'branch-1',
                  entity_type: 'branch',
                  position: { x: 0, y: 0 },
                  size: { width: 700, height: 200 },
                  zone_id: 'zone-1',
                  created_at: '2026-06-01T00:00:00.000Z',
                },
              ],
            })),
            patch: vi.fn(async (_id: string, data: unknown) => data),
          };
        if (name === 'branches')
          return { find: vi.fn(async () => ({ data: [{ branch_id: 'branch-1' }] })) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed.overflowingObjectIds).toEqual(['branch-too-wide']);
    expect(parsed.warning).toMatch(/larger than the available zone/i);
  });

  it('sorts a compact list without shrinking its grow-only zone frame', async () => {
    const entities = ['older', 'latest', 'middle'].map((id) => ({
      object_id: `placement-${id}`,
      board_id: 'board-1',
      card_id: id,
      entity_type: 'card' as const,
      position: { x: 0, y: 0 },
      zone_id: 'zone-1',
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    const cards = {
      older: { title: 'Older', updated_at: '2026-01-01T00:00:00.000Z' },
      latest: { title: 'Latest', updated_at: '2026-03-01T00:00:00.000Z' },
      middle: { title: 'Middle', updated_at: '2026-02-01T00:00:00.000Z' },
    };
    const entityPatches: Array<{ id: string; data: Record<string, unknown> }> = [];
    const boardPatch = vi.fn(async () => undefined);
    const app = {
      service(name: string) {
        if (name === 'boards') {
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': {
                  type: 'zone',
                  x: 0,
                  y: 0,
                  width: 620,
                  height: 900,
                  layout: {
                    mode: 'auto',
                    preset: 'compact_list',
                    sortBy: 'updated',
                    sortDirection: 'desc',
                    autoResizeHeight: true,
                  },
                },
              },
            })),
            patch: boardPatch,
          };
        }
        if (name === 'board-objects') {
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
              entityPatches.push({ id, data });
              return data;
            }),
          };
        }
        if (name === 'cards') {
          return {
            find: vi.fn(async () => ({ data: entities.map(({ card_id }) => ({ card_id })) })),
            get: vi.fn(async (id: keyof typeof cards) => cards[id]),
          };
        }
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed).toMatchObject({
      applied: true,
      preset: 'compact_list',
      sortBy: 'updated',
      sortDirection: 'desc',
      columns: 1,
      rows: 3,
      autoResizeHeight: true,
    });
    expect(parsed.zone.height).toBe(900);
    expect(entityPatches.filter(({ data }) => 'position' in data).map(({ id }) => id)).toEqual([
      'placement-latest',
      'placement-middle',
      'placement-older',
    ]);
    expect(entityPatches.filter(({ data }) => data.compact === true)).toHaveLength(0);
    expect(boardPatch).not.toHaveBeenCalled();
  });
});

describe('agor_boards_set_zone_layout', () => {
  it('persists an explicit zone policy without crossing the caller service scope', async () => {
    const baseServiceParams = { authenticated: true, provider: 'mcp' };
    const patch = vi.fn(async () => undefined);
    const setLayout = registerAndCaptureHandler('agor_boards_set_zone_layout', {
      app: {
        service: (name: string) => {
          if (name !== 'boards') throw new Error(`Unexpected service call: ${name}`);
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 900, label: 'Work' },
              },
            })),
            patch,
          };
        },
      },
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (
        await setLayout({
          boardId: 'board-1',
          zoneId: 'zone-1',
          mode: 'auto',
          preset: 'grid',
          sortBy: 'priority',
          sortDirection: 'asc',
          columns: 2,
          gap: 16,
          autoResizeHeight: true,
        })
      ).content[0].text
    );

    expect(parsed.layout).toEqual({
      mode: 'auto',
      preset: 'grid',
      sortBy: 'priority',
      sortDirection: 'asc',
      columns: 2,
      gap: 16,
      // The legacy boolean normalizes into `resize` and is echoed back beside
      // it, so a policy written by an older client reads correctly to both.
      resize: 'height',
      onOverflow: 'report',
      autoResizeHeight: true,
    });
    expect(patch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: 'zone-1',
        objectData: expect.objectContaining({
          layout: parsed.layout,
          layout_binding: 'override',
        }),
      }),
      baseServiceParams
    );
  });

  it('uses the shared Auto Zone transition and skips an already-matching durable policy', async () => {
    const patch = vi.fn(async () => undefined);
    let zoneLayout: Record<string, unknown> | undefined = { mode: 'manual', sortBy: 'position' };
    const setLayout = registerAndCaptureHandler('agor_boards_set_zone_layout', {
      app: {
        service: () => ({
          get: vi.fn(async () => ({
            board_id: 'board-1',
            objects: {
              'zone-1': {
                type: 'zone',
                x: 0,
                y: 0,
                width: 620,
                height: 900,
                label: 'Work',
                layout: zoneLayout,
              },
            },
          })),
          patch,
        }),
      },
      userId: 'user-1',
      baseServiceParams: { authenticated: true, provider: 'mcp' },
    });

    const enabled = JSON.parse(
      (await setLayout({ boardId: 'board-1', zoneId: 'zone-1', mode: 'auto' })).content[0].text
    );
    expect(enabled.layout).toMatchObject({
      mode: 'auto',
      sortBy: 'updated',
      sortDirection: 'desc',
    });
    expect(patch).toHaveBeenCalledTimes(1);

    zoneLayout = enabled.layout;
    patch.mockClear();
    const unchanged = JSON.parse(
      (await setLayout({ boardId: 'board-1', zoneId: 'zone-1', mode: 'auto' })).content[0].text
    );
    expect(unchanged.note).toBe('Zone layout policy already matched.');
    expect(patch).not.toHaveBeenCalled();
  });

  it('resets an override to board defaults and then performs a true no-op', async () => {
    const patch = vi.fn(async () => undefined);
    const defaults = { mode: 'manual', preset: 'grid', gap: 4 };
    let zone = {
      type: 'zone' as const,
      x: 0,
      y: 0,
      width: 620,
      height: 900,
      label: 'Work',
      layout: { mode: 'auto' as const, preset: 'grid' as const, gap: 40 },
    };
    const setLayout = registerAndCaptureHandler('agor_boards_set_zone_layout', {
      app: {
        service: () => ({
          get: vi.fn(async () => ({
            board_id: 'board-1',
            zone_layout_defaults: defaults,
            objects: { 'zone-1': zone },
          })),
          patch,
        }),
      },
      userId: 'user-1',
    });

    const reset = JSON.parse(
      (await setLayout({ boardId: 'board-1', zoneId: 'zone-1', useBoardDefaults: true })).content[0]
        .text
    );
    expect(reset).toMatchObject({ layoutBinding: 'inherit', layout: { gap: 4 } });
    expect(patch).toHaveBeenCalledOnce();

    zone = patch.mock.calls[0]![1].objectData;
    patch.mockClear();
    const unchanged = JSON.parse(
      (await setLayout({ boardId: 'board-1', zoneId: 'zone-1', useBoardDefaults: true })).content[0]
        .text
    );
    expect(unchanged.note).toBe('Zone layout policy already matched.');
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('agor_boards_set_zone_defaults', () => {
  it('uses the shared atomic action and preserves overrides unless apply is explicit', async () => {
    const baseServiceParams = { authenticated: true, provider: 'mcp' };
    const patch = vi.fn(async (_id, data) => ({
      board: { board_id: 'board-1' },
      changed: true,
      changed_zone_ids: data.applyToExisting ? ['override', 'follower'] : ['follower'],
    }));
    const setDefaults = registerAndCaptureHandler('agor_boards_set_zone_defaults', {
      app: {
        service: () => ({
          get: vi.fn(async () => ({
            board_id: 'board-1',
            zone_layout_defaults: { mode: 'manual', preset: 'grid', gap: 24 },
            objects: {
              override: {
                type: 'zone',
                layout: { mode: 'manual', preset: 'grid', gap: 40 },
              },
              follower: {
                type: 'zone',
                layout_binding: 'inherit',
                layout: { mode: 'manual', preset: 'grid', gap: 24 },
              },
            },
          })),
          patch,
        }),
      },
      userId: 'user-1',
      baseServiceParams,
    });

    const preserved = JSON.parse(
      (await setDefaults({ boardId: 'board-1', gap: 8 })).content[0].text
    );
    expect(preserved).toMatchObject({ changed: true, changedZoneIds: ['follower'] });
    expect(patch).toHaveBeenLastCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'setZoneLayoutDefaults',
        defaults: expect.objectContaining({ gap: 8 }),
        applyToExisting: false,
        expected: expect.objectContaining({
          zones: {
            override: expect.objectContaining({ binding: 'override' }),
            follower: expect.objectContaining({ binding: 'inherit' }),
          },
        }),
      }),
      baseServiceParams
    );

    const applied = JSON.parse(
      (await setDefaults({ boardId: 'board-1', gap: 8, applyToExisting: true })).content[0].text
    );
    expect(applied.changedZoneIds).toEqual(['override', 'follower']);
  });
});

describe('agor_boards_auto_arrange', () => {
  it('uses measured row heights and column widths for mixed worktrees and cards', async () => {
    const patches: Array<{
      position: { x: number; y: number };
      size: { width: number; height: number };
    }> = [];
    const entities = [
      {
        object_id: 'branch-1',
        board_id: 'board-1',
        branch_id: 'branch-1',
        entity_type: 'branch' as const,
        position: { x: 0, y: 0 },
        size: { width: 499, height: 199 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        object_id: 'card-1',
        board_id: 'board-1',
        card_id: 'card-1',
        entity_type: 'card' as const,
        position: { x: 600, y: 0 },
        size: { width: 379, height: 57 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        object_id: 'card-2',
        board_id: 'board-1',
        card_id: 'card-2',
        entity_type: 'card' as const,
        position: { x: 0, y: 300 },
        size: { width: 371, height: 51 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (_id: string, data: { position: { x: number; y: number } }) => {
              patches.push(data);
              return data;
            }),
          };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({ data: [{ card_id: 'card-1' }, { card_id: 'card-2' }] })),
            get: vi.fn(async () => ({ title: 'Card' })),
          };
        if (name === 'branches')
          return { find: vi.fn(async () => ({ data: [{ branch_id: 'branch-1' }] })) };
        // Read unconditionally so the grid can be placed clear of any zone.
        if (name === 'boards')
          return { get: vi.fn(async () => ({ board_id: 'board-1', objects: {} })), patch: vi.fn() };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    const parsed = JSON.parse(
      (
        await arrange({
          boardId: 'board-1',
          columns: 2,
          startX: 83,
          startY: 87,
          gapX: 33,
          gapY: 33,
        })
      ).content[0].text
    );

    expect(parsed).toMatchObject({ columns: 2, rows: 2 });
    expect(patches.map((update) => update.position)).toEqual([
      { x: 80, y: 80 },
      { x: 620, y: 80 },
      { x: 80, y: 320 },
    ]);
    for (const patch of patches) expectBoardGridRect(patch);
  });

  it('includes artifacts by default and falls back for unmeasured rectangles', async () => {
    const entityPatches: Array<{
      position: { x: number; y: number };
      size: { width: number; height: number };
    }> = [];
    const boardPatches: Array<Record<string, unknown>> = [];
    const entities = [
      {
        object_id: 'branch-1',
        board_id: 'board-1',
        branch_id: 'branch-1',
        entity_type: 'branch' as const,
        position: { x: 0, y: 0 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (_id: string, data: (typeof entityPatches)[number]) => {
              entityPatches.push(data);
              return data;
            }),
          };
        if (name === 'branches')
          return { find: vi.fn(async () => ({ data: [{ branch_id: 'branch-1' }] })) };
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'artifact-1': {
                  type: 'artifact',
                  artifact_id: 'artifact-1',
                  x: 300,
                  y: 0,
                  // Imported and MCP-created objects can predate measurement.
                  width: undefined,
                  height: 0,
                },
              },
            })),
            patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
              boardPatches.push(data);
              return data;
            }),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    const result = await arrange({ boardId: 'board-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      arranged: 2,
      arrangedEntities: 1,
      arrangedCanvasObjects: 1,
      layoutMode: 'cluster',
    });
    expect(entityPatches).toEqual([
      { position: { x: 80, y: 80 }, size: { width: 500, height: 200 } },
    ]);
    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'batchUpsertObjects',
      objects: {
        'artifact-1': { x: 80, y: 320, width: 600, height: 400 },
      },
    });
  });

  it('lays out an artifact from its persisted measured rectangle', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: [] })), patch: vi.fn() };
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'artifact-1': {
                  type: 'artifact',
                  artifact_id: 'artifact-1',
                  x: 0,
                  y: 0,
                  width: 723,
                  height: 411,
                },
              },
            })),
            patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
              boardPatches.push(data);
              return data;
            }),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
    });

    await arrange({ boardId: 'board-1' });

    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'batchUpsertObjects',
      objects: { 'artifact-1': { width: 740, height: 420 } },
    });
  });

  it('can include canvas annotations, leaving zones fixed and uncovered', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: [] })), patch: vi.fn() };
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 0, y: 0, width: 1000, height: 800 },
                'text-1': { type: 'text', x: 20, y: 20, width: 200, height: 100, content: 'Hi' },
                'note-1': { type: 'markdown', x: 300, y: 20, width: 300, content: '# Note' },
              },
            })),
            patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
              boardPatches.push(data);
              return data;
            }),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', columns: 2, includeCanvasObjects: true })).content[0]
        .text
    );

    expect(parsed).toMatchObject({
      arranged: 2,
      arrangedEntities: 0,
      arrangedCanvasObjects: 2,
      // zone-1 occupies y 0..800, so the default y=80 grid origin moved below it
      // rather than laying the annotations over a zone it is not arranging.
      avoidedZoneIds: ['zone-1'],
      appliedStartY: 840,
    });
    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'batchUpsertObjects',
      objects: {
        'text-1': expect.objectContaining({ x: 80, y: 840 }),
        'note-1': expect.objectContaining({ x: 320, y: 840 }),
      },
    });
  });

  it('can arrange zones as containers without requiring other canvas objects', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: [] })), patch: vi.fn() };
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 900, y: 0, width: 400, height: 300, label: 'One' },
                'zone-2': { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Two' },
              },
            })),
            patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
              boardPatches.push(data);
              return data;
            }),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', columns: 2, includeZones: true })).content[0].text
    );

    expect(parsed).toMatchObject({ arranged: 2, arrangedEntities: 0, arrangedCanvasObjects: 2 });
    expect(boardPatches).toEqual([
      expect.objectContaining({
        _action: 'batchUpsertObjects',
        objects: expect.objectContaining({
          'zone-2': expect.any(Object),
          'zone-1': expect.any(Object),
        }),
      }),
    ]);
  });
});

/**
 * Assert real geometry, not flags.
 *
 * The layout regressions on this feature have all been "every test green, the
 * screenshot shows cards on top of each other" — because the tests asserted
 * `applied: true` and compact flags rather than where anything landed. These
 * helpers reconstruct the placed rectangles and check them.
 */
function assertNoOverlap(rects: Array<{ id: string; x: number; y: number; w: number; h: number }>) {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlaps) {
        throw new Error(
          `${a.id} (${a.x},${a.y} ${a.w}x${a.h}) overlaps ${b.id} (${b.x},${b.y} ${b.w}x${b.h})`
        );
      }
    }
  }
}

function assertInsideZone(
  rects: Array<{ id: string; x: number; y: number; w: number; h: number }>,
  zone: { width: number; height: number }
) {
  for (const rect of rects) {
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > zone.width || rect.y + rect.h > zone.height) {
      throw new Error(
        `${rect.id} (${rect.x},${rect.y} ${rect.w}x${rect.h}) escapes the ${zone.width}x${zone.height} zone`
      );
    }
  }
}

describe('board layout tools with branch entities present', () => {
  const baseServiceParams = { authenticated: true, provider: 'mcp' };
  const branchId = '019e8e10';
  const cardId = '019e8e11';

  function branchEntity(overrides: Record<string, unknown> = {}) {
    return {
      object_id: 'obj-branch',
      board_id: 'board-1',
      branch_id: branchId,
      entity_type: 'branch' as const,
      position: { x: 0, y: 0 },
      created_at: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function cardEntity(overrides: Record<string, unknown> = {}) {
    return {
      object_id: 'obj-card',
      board_id: 'board-1',
      card_id: cardId,
      entity_type: 'card' as const,
      position: { x: 900, y: 0 },
      created_at: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeApp(options: {
    entities: Array<Record<string, unknown>>;
    objects?: Record<string, unknown>;
    card?: { description?: string; note?: string };
    entityPatches?: Array<{ objectId: string; data: Record<string, unknown> }>;
    boardPatches?: Array<Record<string, unknown>>;
  }) {
    const boardObjects = { ...(options.objects ?? {}) };
    const entityState = options.entities.map((entity) => ({ ...entity }));
    const branchesFind = validatedBranchesFind((query) => ({
      data: (((query.branch_id as { $in?: string[] } | undefined)?.$in ?? []) as string[]).map(
        (id) => ({ branch_id: id, archived: false })
      ),
    }));
    const boardObjectsFind = vi.fn(async () => ({
      data: entityState,
      total: entityState.length,
      limit: 100,
      skip: 0,
    }));

    return {
      branchesFind,
      boardObjectsFind,
      app: {
        service(name: string) {
          if (name === 'boards')
            return {
              get: vi.fn(async () => ({
                board_id: 'board-1',
                name: 'Board',
                objects: boardObjects,
              })),
              patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
                options.boardPatches?.push(data);
                if (data._action === 'applyLayout') {
                  Object.assign(boardObjects, data.objects as Record<string, unknown>);
                  for (const [objectId, placement] of Object.entries(
                    (data.placements ?? {}) as Record<
                      string,
                      { position: unknown; size?: unknown; compact?: boolean }
                    >
                  )) {
                    const entity = entityState.find(
                      (candidate) => candidate.object_id === objectId
                    );
                    if (entity) Object.assign(entity, placement);
                  }
                }
                return data;
              }),
            };
          if (name === 'boards/:id/permissions')
            return { find: vi.fn(async () => ({ board_access_revision: 1 })) };
          if (name === 'board-objects')
            return {
              find: boardObjectsFind,
              patch: vi.fn(async (objectId: string, data: Record<string, unknown>) => {
                options.entityPatches?.push({ objectId, data });
                return data;
              }),
            };
          if (name === 'cards')
            return {
              // Echo back whatever card ids were asked for, so adding a card to
              // a fixture doesn't silently make it look archived.
              find: vi.fn(async (params?: { query?: { card_id?: { $in?: string[] } } }) => ({
                data: (params?.query?.card_id?.$in ?? []).map((card_id) => ({ card_id })),
              })),
              get: vi.fn(async (id: string) => ({
                card_id: id,
                title: 'Card',
                ...options.card,
              })),
            };
          if (name === 'branches')
            return {
              find: branchesFind,
              get: vi.fn(async (id: string) => ({ branch_id: id, name: 'feature-branch' })),
            };
          throw new Error(`Unexpected service call: ${name}`);
        },
      },
    };
  }

  it.each([
    ['mixed with a card', [branchEntity({ zone_id: 'zone-1' }), cardEntity({ zone_id: 'zone-1' })]],
    ['branch only', [branchEntity({ zone_id: 'zone-1' })]],
  ])('agor_boards_get returns positioned branch entities (%s)', async (_label, entities) => {
    const { app, branchesFind } = makeApp({ entities });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({ boardId: 'board-1', includeEntities: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(branchesFind).toHaveBeenCalled();
    expect(parsed.entities).toHaveLength(entities.length);
    expect(parsed.entities).toContainEqual(expect.objectContaining({ branch_id: branchId }));
  });

  it('agor_boards_get returns branch entities under entityType="branch"', async () => {
    const { app, boardObjectsFind } = makeApp({ entities: [branchEntity()] });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      entityType: 'branch',
    });

    expect(result.isError).toBeFalsy();
    expect(boardObjectsFind).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ entity_type: 'branch' }) })
    );
    expect(JSON.parse(result.content[0].text).entities).toEqual([
      expect.objectContaining({ branch_id: branchId }),
    ]);
  });

  it.each([
    ['mixed with a card', [branchEntity(), cardEntity()], 2],
    ['branch only', [branchEntity()], 1],
  ])('agor_boards_auto_arrange moves branch entities (%s)', async (_label, entities, arranged) => {
    const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
    const { app } = makeApp({ entities, entityPatches });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await arrange({ boardId: 'board-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({ arranged, arrangedEntities: arranged });
    expect(entityPatches.map(({ objectId }) => objectId)).toContain('obj-branch');
    expect(parsed.updates).toContainEqual(
      expect.objectContaining({ objectId: 'obj-branch', entityType: 'branch' })
    );
  });

  it('agor_boards_auto_arrange moves branch entities under entityType="branch"', async () => {
    const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
    const { app, boardObjectsFind } = makeApp({ entities: [branchEntity()], entityPatches });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await arrange({ boardId: 'board-1', entityType: 'branch' });

    expect(result.isError).toBeFalsy();
    expect(boardObjectsFind).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ entity_type: 'branch' }) })
    );
    expect(entityPatches).toEqual([
      {
        objectId: 'obj-branch',
        data: { position: { x: 80, y: 80 }, size: { width: 500, height: 200 } },
      },
    ]);
  });

  it.each([
    ['mixed with a card', [branchEntity({ zone_id: 'zone-1' }), cardEntity({ zone_id: 'zone-1' })]],
    ['branch only', [branchEntity({ zone_id: 'zone-1' })]],
  ])(
    'agor_boards_auto_arrange_zone arranges a zone holding a branch (%s)',
    async (_l, entities) => {
      const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
      const { app, branchesFind } = makeApp({
        entities,
        entityPatches,
        objects: { 'zone-1': { type: 'zone', x: 40, y: 40, width: 1200, height: 900 } },
      });
      const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
        app,
        userId: 'user-1',
        baseServiceParams,
      });

      const result = await arrange({ boardId: 'board-1', zoneId: 'zone-1' });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(branchesFind).toHaveBeenCalled();
      expect(parsed).toMatchObject({ applied: true, arranged: entities.length });
      expect(parsed.updates).toContainEqual(
        expect.objectContaining({ objectId: 'obj-branch', entityType: 'branch' })
      );
    }
  );

  it('lays out a mixed card+branch zone in one call without overlap', async () => {
    // The case that bit in production: one zone, cards and worktrees together,
    // one default-entityType call. Each item must be sized by its own kind —
    // a 500x200 worktree beside 380-wide cards — and none may overlap.
    const zone = { type: 'zone', x: 40, y: 40, width: 1200, height: 1400 };
    const entities = [
      branchEntity({ object_id: 'obj-branch', zone_id: 'zone-1' }),
      branchEntity({ object_id: 'obj-branch-2', branch_id: '019e8e12', zone_id: 'zone-1' }),
      cardEntity({ object_id: 'obj-card', zone_id: 'zone-1' }),
      cardEntity({ object_id: 'obj-card-2', card_id: '019e8e13', zone_id: 'zone-1' }),
    ];
    const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
    const { app } = makeApp({ entities, entityPatches, objects: { 'zone-1': zone } });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await arrange({ boardId: 'board-1', zoneId: 'zone-1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({ applied: true, arranged: 4, fitsWithoutOverlap: true });
    expect(parsed.layoutMode).not.toBe('deck');
    expect(parsed.overflowingObjectIds).toEqual([]);

    // Reconstruct what was actually written, at each item's own kind size.
    const sizeOf = (objectId: string) =>
      objectId.startsWith('obj-branch') ? { w: 500, h: 200 } : { w: 380, h: 56 };
    const placed = parsed.updates.map(
      (update: { objectId: string; position: { x: number; y: number } }) => ({
        id: update.objectId,
        x: update.position.x,
        y: update.position.y,
        ...sizeOf(update.objectId),
      })
    );
    expect(placed).toHaveLength(4);
    assertNoOverlap(placed);
    assertInsideZone(placed, zone);
    expect(entityPatches.map(({ objectId }) => objectId).sort()).toEqual(
      ['obj-branch', 'obj-branch-2', 'obj-card', 'obj-card-2'].sort()
    );
  });

  it('falls back to nominal size for an entity the browser never measured', async () => {
    // A worktree created over MCP has never rendered, so it carries no `size`.
    // It must lay out at the nominal size for its kind, not fail the arrange.
    const { app } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1' }), cardEntity({ zone_id: 'zone-1' })],
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1200, height: 900 } },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed).toMatchObject({ applied: true, arranged: 2, unusableSizeObjectIds: [] });
    // 500-wide branch + 380-wide card cannot both sit in one 1200 column pair
    // unless each was sized by kind; requiredWidth proves the branch was not
    // silently laid out at card width.
    expect(parsed.requiredWidth).toBeGreaterThanOrEqual(500);
  });

  it('bounds an unmeasured long generic card with the shared rendered-body contract', async () => {
    const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
    const { app } = makeApp({
      entities: [cardEntity({ zone_id: 'zone-1' })],
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 900 } },
      entityPatches,
      card: {
        description: 'Fictional description. '.repeat(1_000),
        note: 'Fictional status.\n'.repeat(1_000),
      },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await arrange({ boardId: 'board-1', zoneId: 'zone-1' });

    expect(result.isError).toBeFalsy();
    expect(entityPatches).toHaveLength(1);
    expect(entityPatches[0].data.size).toEqual({
      width: GENERIC_BOARD_CARD_LAYOUT.width,
      height: ceilBoardGridValue(
        GENERIC_BOARD_CARD_LAYOUT.headerEstimatedHeight + GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight
      ),
    });
  });

  it.each([
    ['zero', { width: 0, height: 0 }],
    ['negative', { width: -10, height: 200 }],
    ['non-finite', { width: Number.NaN, height: 200 }],
  ])(
    'does not fail the whole arrange over one %s persisted size, and names it',
    async (_label, size) => {
      const { app } = makeApp({
        entities: [branchEntity({ zone_id: 'zone-1', size }), cardEntity({ zone_id: 'zone-1' })],
        objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1200, height: 900 } },
      });
      const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
        app,
        userId: 'user-1',
        baseServiceParams,
      });

      const result = await arrange({ boardId: 'board-1', zoneId: 'zone-1' });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(parsed).toMatchObject({
        applied: true,
        arranged: 2,
        unusableSizeObjectIds: ['obj-branch'],
      });
      expect(parsed.warning).toContain('obj-branch');
    }
  );

  it('agor_boards_auto_arrange_zone arranges a branch-only zone under entityType="branch"', async () => {
    const { app, boardObjectsFind } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1' })],
      objects: { 'zone-1': { type: 'zone', x: 40, y: 40, width: 1200, height: 900 } },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await arrange({ boardId: 'board-1', zoneId: 'zone-1', entityType: 'branch' });

    expect(result.isError).toBeFalsy();
    expect(boardObjectsFind).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ entity_type: 'branch' }) })
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({ applied: true, arranged: 1 });
  });

  it('reports the zones an autoResizeHeight grow now covers', async () => {
    // zone-1 is short enough that fitting a 500x200 worktree must grow it past
    // y=250, where zone-below starts. Growing in silence is how a tidy zone
    // ends up swallowing its neighbour on a real board.
    const { app } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1', size: { width: 500, height: 200 } })],
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 120,
          layout: { mode: 'auto', preset: 'grid', autoResizeHeight: true },
        },
        'zone-below': { type: 'zone', x: 0, y: 250, width: 620, height: 300 },
        'zone-clear': { type: 'zone', x: 5000, y: 5000, width: 200, height: 200 },
      },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed.zone.height).toBeGreaterThan(250);
    // Only the zone actually underneath, never the zone itself or a distant one.
    expect(parsed.resizedOverZoneIds).toEqual(['zone-below']);
    expect(parsed.warning).toContain('zone-below');
    expect(parsed.warning).toContain('agor_boards_arrange_zones');
  });

  it('minimally reflows newly covered zones and their canvas contents in one board patch', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const { app } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1', size: { width: 500, height: 200 } })],
      boardPatches,
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 120,
          layout: {
            mode: 'auto',
            preset: 'grid',
            autoResizeHeight: true,
            onOverflow: 'reflow_board',
          },
        },
        'zone-below': { type: 'zone', x: 0, y: 250, width: 620, height: 300 },
        note: { type: 'markdown', x: 40, y: 300, width: 200, height: 100, content: 'Fictional' },
        'zone-clear': { type: 'zone', x: 5000, y: 5000, width: 200, height: 200 },
      },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );
    const objects = boardPatches[0]?.objects as Record<
      string,
      { x: number; y: number; width: number; height: number }
    >;

    expect(boardPatches).toHaveLength(1);
    expect(parsed).toMatchObject({
      reflowedBoard: true,
      resizedOverZoneIds: ['zone-below'],
      movedZoneIds: ['zone-below'],
    });
    expect(objects['zone-below'].x).toBe(0);
    expect(objects['zone-below'].y).toBeGreaterThanOrEqual(
      objects['zone-1'].height + BOARD_GRID_SIZE
    );
    expect(objects.note.y - 300).toBe(objects['zone-below'].y - 250);
    expect(objects['zone-clear']).toBeUndefined();
  });

  it('reports no covered zones when the grow stays clear of them', async () => {
    const { app } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1', size: { width: 500, height: 200 } })],
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 120,
          layout: { mode: 'auto', preset: 'grid', autoResizeHeight: true },
        },
        'zone-far': { type: 'zone', x: 5000, y: 5000, width: 200, height: 200 },
      },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed.resizedOverZoneIds).toEqual([]);
    expect(parsed.warning ?? '').not.toContain('zone-far');
  });

  it('refuses a zone narrower than its contents while resize is fixed', async () => {
    // Height cannot rescue a too-narrow zone: the 500px worktree overflows a
    // 300px zone at any height, so the arrange has nothing safe to do.
    const { app } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1', size: { width: 500, height: 200 } })],
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 300, height: 900 } },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed.applied).toBe(false);
    expect(parsed.requiredWidth).toBeGreaterThan(300);
  });

  it('sizes a zone from the order the arrange will actually use', async () => {
    // The packer fills row-major, so order decides which items share a row and
    // therefore how tall the zone must be. Sorted by position these interleave:
    // the tall worktree lands beside short cards in row 0 and the second tall
    // one starts row 1, which is materially taller than grouping them. Sizing
    // the zone from an arbitrary order writes a height the follow-up arrange
    // then refuses to place anything into.
    // Ids must satisfy the shortid pattern the branch query validator enforces.
    const tall = (suffix: string, y: number) =>
      branchEntity({
        object_id: `obj-b-${suffix}`,
        branch_id: `019e8e${suffix}`,
        zone_id: 'zone-1',
        position: { x: 0, y },
        size: { width: 500, height: 240 },
      });
    const short = (suffix: string, y: number) =>
      cardEntity({
        object_id: `obj-c-${suffix}`,
        card_id: `019e8f${suffix}`,
        zone_id: 'zone-1',
        position: { x: 0, y },
        size: { width: 380, height: 40 },
      });

    // Supplied grouped (both tall first) but positioned interleaved, so the
    // stored order and the sorted order pack to genuinely different heights.
    // Grouped at two columns the talls share row 0; sorted they straddle rows
    // 0 and 2, which is ~200px taller. A zone sized from the stored order is
    // therefore too short for the layout the arrange will actually produce.
    const { app } = makeApp({
      entities: [tall('11', 0), tall('12', 40), short('21', 10), short('22', 20), short('23', 30)],
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 400, height: 400 } },
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrangeZones({ boardId: 'board-1', targetWidth: 1600, dryRun: true })).content[0].text
    );

    const placed = parsed.updates[0];
    // The two 240px items end up in different rows once sorted, so the zone
    // must be tall enough for both. Sizing from the stored order puts them in
    // one row and yields a zone ~200px shorter than the contents need.
    expect(placed.size.height).toBeGreaterThanOrEqual(240 * 2);
  });

  it('places and sizes zones on the manual board grid', async () => {
    const { app } = makeApp({
      entities: [],
      objects: {
        'zone-1': { type: 'zone', x: 13, y: 17, width: 333, height: 257 },
        'zone-2': { type: 'zone', x: 451, y: 19, width: 377, height: 283 },
      },
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (
        await arrangeZones({
          boardId: 'board-1',
          targetWidth: 913,
          gap: 31,
          startX: 83,
          startY: 87,
          dryRun: true,
        })
      ).content[0].text
    );

    expect(parsed.updates).toHaveLength(2);
    for (const update of parsed.updates) expectBoardGridRect(update);
  });

  it('persists one container batch and re-packs each visible child in the same call', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
    const { app } = makeApp({
      entities: [
        branchEntity({
          object_id: 'branch-placement',
          zone_id: 'zone-a',
          position: { x: 220, y: 300 },
          size: { width: 500, height: 200 },
        }),
        cardEntity({
          object_id: 'card-placement',
          zone_id: 'zone-b',
          position: { x: 200, y: 260 },
          size: { width: 380, height: 100 },
        }),
      ],
      objects: {
        'zone-b': { type: 'zone', x: 800, y: 0, width: 620, height: 600, label: 'B' },
        'zone-a': { type: 'zone', x: 0, y: 0, width: 620, height: 600, label: 'A' },
      },
      boardPatches,
      entityPatches,
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });
    const parsed = JSON.parse((await arrangeZones({ boardId: 'board-1' })).content[0].text);

    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'applyLayout',
      objects: {
        'zone-a': expect.objectContaining({ type: 'zone' }),
        'zone-b': expect.objectContaining({ type: 'zone' }),
      },
      placements: {
        'branch-placement': {
          position: expect.any(Object),
          size: { width: 500, height: 200 },
        },
        'card-placement': {
          position: expect.any(Object),
          size: { width: 380, height: 100 },
        },
      },
    });
    expect(entityPatches).toHaveLength(0);
    expect(parsed.updates.map((update: { objectId: string }) => update.objectId)).toEqual([
      'zone-b',
      'zone-a',
    ]);
    expect(parsed.updates.map((update: { arrangedItems: number }) => update.arrangedItems)).toEqual(
      [1, 1]
    );
  });

  it('defaults Pack zone contents on, repairs anchored protrusion, compacts waste, and is idempotent', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const { app } = makeApp({
      entities: [],
      objects: {
        tiny: { type: 'zone', x: 80, y: 80, width: 300, height: 220, label: 'Tiny' },
        protruding: {
          type: 'artifact',
          artifact_id: 'artifact-protruding',
          x: 100,
          y: 120,
          width: 860,
          height: 660,
        },
        empty: { type: 'zone', x: 1800, y: 80, width: 1600, height: 900, label: 'Empty' },
      },
      boardPatches,
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const first = JSON.parse((await arrangeZones({ boardId: 'board-1' })).content[0].text);
    const tiny = first.updates.find((update: { objectId: string }) => update.objectId === 'tiny');
    const empty = first.updates.find((update: { objectId: string }) => update.objectId === 'empty');
    expect(first.packZoneContents).toBe(true);
    expect(tiny.arrangedItems).toBe(1);
    expect(tiny.size.width).toBeGreaterThanOrEqual(900);
    expect(empty.size).toEqual({ width: 600, height: tiny.size.height });
    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'applyLayout',
      objects: {
        tiny: expect.objectContaining({ width: tiny.size.width, height: tiny.size.height }),
        protruding: expect.any(Object),
        empty: expect.objectContaining({ width: 600, height: tiny.size.height }),
      },
      placements: {},
    });

    await arrangeZones({ boardId: 'board-1' });
    expect(boardPatches).toHaveLength(1);
  });

  it('preserves zone frames and child-relative geometry when Pack zone contents is off', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const { app } = makeApp({
      entities: [
        branchEntity({
          object_id: 'contained-worktree',
          zone_id: 'manual',
          position: { x: 20, y: 120 },
          size: { width: 500, height: 200 },
        }),
      ],
      objects: {
        manual: { type: 'zone', x: 900, y: 700, width: 300, height: 220, label: 'Manual' },
        protruding: {
          type: 'artifact',
          artifact_id: 'artifact-protruding',
          x: 920,
          y: 820,
          width: 860,
          height: 660,
        },
      },
      boardPatches,
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrangeZones({ boardId: 'board-1', packZoneContents: false })).content[0].text
    );
    expect(parsed.packZoneContents).toBe(false);
    expect(parsed.updates[0]).toMatchObject({
      objectId: 'manual',
      size: { width: 300, height: 220 },
      arrangedItems: 2,
    });
    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'applyLayout',
      objects: {
        manual: expect.objectContaining({ width: 300, height: 220 }),
      },
      placements: {},
    });
    const objects = boardPatches[0]?.objects as Record<
      string,
      { x: number; y: number; width: number; height: number }
    >;
    expect(objects.protruding.x - objects.manual.x).toBe(20);
    expect(objects.protruding.y - objects.manual.y).toBe(120);
  });

  it('includes free worktrees and heterogeneous canvas objects in the same board cluster', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const entityPatches: Array<{ objectId: string; data: Record<string, unknown> }> = [];
    const { app } = makeApp({
      entities: [
        branchEntity({
          object_id: 'pinned-worktree',
          zone_id: 'zone-a',
          position: { x: 20, y: 100 },
          size: { width: 500, height: 200 },
        }),
        branchEntity({
          object_id: 'free-worktree',
          zone_id: undefined,
          position: { x: 900, y: 700 },
          size: { width: 500, height: 200 },
        }),
      ],
      objects: {
        'zone-a': { type: 'zone', x: 0, y: 0, width: 620, height: 600, label: 'A' },
        artifact: {
          type: 'artifact',
          artifact_id: 'artifact-1',
          x: 0,
          y: 800,
          width: 720,
          height: 420,
        },
        note: { type: 'markdown', x: 760, y: 800, width: 300, content: '# Note' },
        app: {
          type: 'app',
          x: 1100,
          y: 800,
          width: 600,
          height: 400,
          title: 'Demo',
          template: 'react',
          files: {},
        },
        locked: {
          type: 'artifact',
          artifact_id: 'artifact-locked',
          x: 1800,
          y: 800,
          width: 600,
          height: 400,
          locked: true,
        },
      },
      boardPatches,
      entityPatches,
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse((await arrangeZones({ boardId: 'board-1' })).content[0].text);

    expect(parsed).toMatchObject({ arranged: 5, arrangedLooseItems: 4 });
    expect(parsed.looseUpdates.map((update: { objectId: string }) => update.objectId)).toEqual([
      'free-worktree',
      'artifact',
      'note',
      'app',
    ]);
    expect(boardPatches).toHaveLength(1);
    expect(boardPatches[0]).toMatchObject({
      _action: 'applyLayout',
      objects: {
        'zone-a': expect.any(Object),
        artifact: expect.any(Object),
        note: expect.any(Object),
        app: expect.any(Object),
      },
      placements: {
        'free-worktree': expect.any(Object),
      },
    });
    expect(
      (boardPatches[0]?.objects as Record<string, unknown> | undefined)?.locked
    ).toBeUndefined();
    expect(entityPatches).toHaveLength(0);

    const topLevel = [
      ...parsed.updates.map((update: { objectId: string; position: object; size: object }) => ({
        id: update.objectId,
        ...update.position,
        ...update.size,
      })),
      ...parsed.looseUpdates.map(
        (update: { objectId: string; position: object; size: object }) => ({
          id: update.objectId,
          ...update.position,
          ...update.size,
        })
      ),
    ] as Array<{ id: string; x: number; y: number; width: number; height: number }>;
    for (const [index, left] of topLevel.entries()) {
      for (const right of topLevel.slice(index + 1)) {
        expect(
          left.x + left.width <= right.x ||
            right.x + right.width <= left.x ||
            left.y + left.height <= right.y ||
            right.y + right.height <= left.y,
          `${left.id} overlaps ${right.id}`
        ).toBe(true);
      }
    }
  });

  it('never offers a compact_list zone a multi-column shape', async () => {
    // compact_list is one column by definition; a landscape shape would promise
    // a layout the zone arrange will never produce.
    const { app } = makeApp({
      entities: [
        branchEntity({ zone_id: 'zone-1', size: { width: 500, height: 88 } }),
        cardEntity({ zone_id: 'zone-1', size: { width: 380, height: 56 } }),
      ],
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 400,
          height: 400,
          layout: { mode: 'auto', preset: 'compact_list' },
        },
      },
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrangeZones({ boardId: 'board-1', targetWidth: 1600, dryRun: true })).content[0].text
    );

    expect(parsed.updates[0].contentColumns).toBe(1);
  });

  it("uses density geometry for branches while retaining a generic card's natural frame", async () => {
    const compactLayout = { mode: 'auto', preset: 'compact_list', gap: 8 };
    const { app } = makeApp({
      entities: [
        cardEntity({ zone_id: 'cards-zone', compact: true, size: { width: 380, height: 180 } }),
        branchEntity({
          zone_id: 'branches-zone',
          compact: true,
          size: { width: 500, height: 220 },
        }),
      ],
      objects: {
        'cards-zone': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 400,
          layout: compactLayout,
        },
        'branches-zone': {
          type: 'zone',
          x: 700,
          y: 0,
          width: 620,
          height: 400,
          layout: compactLayout,
        },
      },
    });
    const arrangeZones = registerAndCaptureHandler('agor_boards_arrange_zones', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (
        await arrangeZones({
          boardId: 'board-1',
          targetWidth: 1280,
          dryRun: true,
        })
      ).content[0].text
    );

    expect(parsed.updates).toHaveLength(2);
    expect(parsed.updates.map((update: { size: { width: number } }) => update.size.width)).toEqual([
      420, 540,
    ]);
    expect(
      parsed.updates.map((update: { contentColumns: number }) => update.contentColumns)
    ).toEqual([1, 1]);
  });

  it('widens a too-narrow zone when resize is both', async () => {
    const { app } = makeApp({
      entities: [branchEntity({ zone_id: 'zone-1', size: { width: 500, height: 200 } })],
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 300, height: 900 } },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', resize: 'both' })).content[0].text
    );

    expect(parsed.applied).toBe(true);
    expect(parsed.resize).toBe('both');
    expect(parsed.zone.width).toBeGreaterThanOrEqual(500);
    expect(parsed.overflowingObjectIds).toEqual([]);
  });
});

describe('agor_boards_auto_arrange zone avoidance', () => {
  const baseServiceParams = { authenticated: true, provider: 'mcp' };

  function makeApp(objects: Record<string, unknown>) {
    const patches: Array<{ objectId: string; position: { x: number; y: number } }> = [];
    const entities = ['card-a', 'card-b'].map((objectId, index) => ({
      object_id: objectId,
      board_id: 'board-1',
      card_id: objectId,
      entity_type: 'card' as const,
      position: { x: 1400, y: index * 200 },
      created_at: '2026-06-01T00:00:00.000Z',
    }));

    return {
      patches,
      app: {
        service(name: string) {
          if (name === 'boards')
            return {
              get: vi.fn(async () => ({ board_id: 'board-1', objects })),
              patch: vi.fn(async (_id: string, data: Record<string, unknown>) => data),
            };
          if (name === 'board-objects')
            return {
              find: vi.fn(async () => ({ data: entities })),
              patch: vi.fn(
                async (objectId: string, data: { position: { x: number; y: number } }) => {
                  patches.push({ objectId, position: data.position });
                  return data;
                }
              ),
            };
          if (name === 'cards')
            return {
              find: vi.fn(async () => ({ data: entities.map(({ card_id }) => ({ card_id })) })),
              get: vi.fn(async () => ({ title: 'Card' })),
            };
          throw new Error(`Unexpected service call: ${name}`);
        },
      },
    };
  }

  const zoneBoard = { 'zone-1': { type: 'zone', x: 40, y: 40, width: 640, height: 420 } };

  it('drops the default grid below every zone instead of stacking cards on one', async () => {
    const { app, patches } = makeApp(zoneBoard);
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse((await arrange({ boardId: 'board-1', columns: 1 })).content[0].text);

    // Zone spans y 40..460, so the default y=80 origin was inside it.
    expect(parsed).toMatchObject({
      appliedStartX: 80,
      appliedStartY: 500,
      avoidedZoneIds: ['zone-1'],
    });
    expect(patches.every(({ position }) => position.y >= 460)).toBe(true);
  });

  it('settles on the first clear row instead of below a distant zone', async () => {
    const { app, patches } = makeApp({
      'zone-1': { type: 'zone', x: 40, y: 40, width: 640, height: 420 },
      'zone-2': { type: 'zone', x: 40, y: 480, width: 640, height: 200 },
      'zone-parked': { type: 'zone', x: 40, y: 40000, width: 640, height: 420 },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse((await arrange({ boardId: 'board-1', columns: 1 })).content[0].text);

    // Clears zone-1 (ends 460) then zone-2 (ends 680) and stops — the zone
    // parked at y=40000 never blocked, so it must not drag the grid down.
    expect(parsed).toMatchObject({
      appliedStartY: 720,
      avoidedZoneIds: ['zone-1', 'zone-2'],
    });
    expect(patches[0].position).toEqual({ x: 80, y: 720 });
  });

  it('leaves the default origin alone when no zone is in the way', async () => {
    const { app, patches } = makeApp({
      'zone-far': { type: 'zone', x: 2000, y: 2000, width: 640, height: 420 },
    });
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse((await arrange({ boardId: 'board-1', columns: 1 })).content[0].text);

    expect(parsed).toMatchObject({ appliedStartY: 80, avoidedZoneIds: [] });
    expect(patches[0].position).toEqual({ x: 80, y: 80 });
  });

  it('honors an explicit startY even when it lands on a zone', async () => {
    const { app, patches } = makeApp(zoneBoard);
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', columns: 1, startY: 100 })).content[0].text
    );

    expect(parsed).toMatchObject({ appliedStartY: 100, avoidedZoneIds: [] });
    expect(patches[0].position).toEqual({ x: 80, y: 100 });
  });

  it('does not dodge zones it is arranging as containers', async () => {
    const { app } = makeApp(zoneBoard);
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', includeZones: true })).content[0].text
    );

    expect(parsed).toMatchObject({ appliedStartY: 80, avoidedZoneIds: [] });
  });
});

describe('agor_boards_set_compact', () => {
  it('updates only explicitly targeted branch placements on the requested board', async () => {
    const patch = vi.fn(async (objectId: string, data: { compact: boolean }) => ({
      object_id: objectId,
      board_id: 'board-1',
      entity_type: objectId === 'branch-1' ? 'branch' : 'card',
      compact: data.compact,
    }));
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({
              data: [
                { object_id: 'branch-1', board_id: 'board-1', entity_type: 'branch' },
                { object_id: 'card-1', board_id: 'board-1', entity_type: 'card' },
              ],
            })),
            patch,
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const setCompact = registerAndCaptureHandler('agor_boards_set_compact', {
      app,
      userId: 'user-1',
      baseServiceParams: { authenticated: true, provider: 'mcp' },
    });

    const parsed = JSON.parse(
      (await setCompact({ boardId: 'board-1', objectIds: ['branch-1'], compact: true })).content[0]
        .text
    );

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      'branch-1',
      { compact: true },
      expect.objectContaining({ provider: 'mcp' })
    );
    expect(parsed).toMatchObject({ boardId: 'board-1', compact: true, updated: 1 });
  });

  it('updates an explicit generic card target when it has collapsible body content', async () => {
    const patch = vi.fn(async (objectId: string, data: { compact: boolean }) => ({
      object_id: objectId,
      board_id: 'board-1',
      card_id: 'card-record-1',
      entity_type: 'card',
      compact: data.compact,
    }));
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({
              data: [
                {
                  object_id: 'card-1',
                  board_id: 'board-1',
                  card_id: 'card-record-1',
                  entity_type: 'card',
                },
              ],
            })),
            patch,
          };
        if (name === 'cards')
          return {
            get: vi.fn(async () => ({
              card_id: 'card-record-1',
              board_id: 'board-1',
              title: 'Fictional tracking card',
              note: 'Needs a reviewer',
            })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const setCompact = registerAndCaptureHandler('agor_boards_set_compact', {
      app,
      userId: 'user-1',
      baseServiceParams: { authenticated: true, provider: 'mcp' },
    });

    const parsed = JSON.parse(
      (await setCompact({ boardId: 'board-1', objectIds: ['card-1'], compact: true })).content[0]
        .text
    );

    expect(parsed).toMatchObject({ updated: 1 });
    expect(patch).toHaveBeenCalledWith(
      'card-1',
      { compact: true },
      expect.objectContaining({ provider: 'mcp' })
    );
  });

  it('rejects an explicit header-only card and skips repeated same-state writes', async () => {
    const patch = vi.fn();
    let withBody = false;
    const placement = {
      object_id: 'card-1',
      board_id: 'board-1',
      card_id: 'card-record-1',
      entity_type: 'card',
      compact: true,
    };
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: [placement] })), patch };
        if (name === 'cards')
          return {
            get: vi.fn(async () => ({
              card_id: 'card-record-1',
              board_id: 'board-1',
              title: 'Header only',
              ...(withBody ? { description: 'Now has body content' } : {}),
            })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const setCompact = registerAndCaptureHandler('agor_boards_set_compact', {
      app,
      userId: 'user-1',
      baseServiceParams: { authenticated: true, provider: 'mcp' },
    });

    await expect(
      setCompact({ boardId: 'board-1', objectIds: ['card-1'], compact: true })
    ).rejects.toThrow('worktrees and generic cards with body content');
    expect(patch).not.toHaveBeenCalled();

    withBody = true;
    const repeated = JSON.parse(
      (await setCompact({ boardId: 'board-1', objectIds: ['card-1'], compact: true })).content[0]
        .text
    );
    expect(repeated).toMatchObject({ updated: 0, updates: [] });
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('agor_boards_update realtime events', () => {
  it('replaces the normalized board access and branch-default package', async () => {
    const permissions = {
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_access_revision: 1,
      branch_template_revision: 1,
      board_access: {
        schema_version: 1,
        policy_kind: 'board_access',
        sharing_mode: 'private',
        entries: [],
        others: { preset: 'none', capabilities: [], fs_access: 'none' },
      },
      branch_template: {
        access: {
          schema_version: 1,
          policy_kind: 'branch_access',
          sharing_mode: 'private',
          entries: [],
          others: { preset: 'none', capabilities: [], fs_access: 'none' },
        },
        allow_shared_session_prompts: false,
      },
    };
    const patch = vi.fn(async (_id, data) => data);
    const app = {
      service(name: string) {
        if (name === 'boards/:id/permissions') return { patch };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const updateBoard = registerAndCaptureHandler('agor_boards_permissions_update', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    await updateBoard({ boardId: 'board-1', permissions });
    expect(patch).toHaveBeenCalledWith(null, permissions, {
      route: { id: 'board-1' },
    });
  });

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
