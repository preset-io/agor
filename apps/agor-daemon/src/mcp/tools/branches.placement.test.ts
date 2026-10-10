import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CardRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  RepoRepository,
  runWithTenantContext,
} from '@agor/core/db';
import type {
  BoardEntityObject,
  BoardID,
  BoardLayoutBatch,
  UUID,
  ZoneLayoutPolicy,
} from '@agor/core/types';
import { findFreeZoneSlot } from '@agor/core/utils/board-placement';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { BoardObjectsService } from '../../services/board-objects';
import { registerBranchTools } from './branches';

type Handler = (args: { branchId: string; zoneId: string }) => Promise<unknown>;

async function fixture(db: Database, extraObjects: Record<string, unknown> = {}) {
  const boards = new BoardRepository(db);
  const branches = new BranchRepository(db);
  const objects = new BoardObjectRepository(db);
  const service = new BoardObjectsService(
    createTenantScopedDatabaseProxy(db, { requireScope: false })
  );
  const destination = {
    type: 'zone' as const,
    label: 'Example zone',
    x: 2000,
    y: 1000,
    width: 650,
    height: 500,
  };
  const board = await boards.create({
    board_id: generateId(),
    name: 'Example workflow',
    created_by: 'test-user',
    objects: {
      source: { ...destination, x: 200 },
      destination,
      preview: {
        type: 'artifact',
        x: 2000,
        y: 2000,
        width: 900,
        height: 900,
        artifact_id: generateId(),
      },
      ...extraObjects,
    },
  } as Parameters<BoardRepository['create']>[0]);
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: 'example/project',
    name: 'Example',
    repo_type: 'remote',
    remote_url: 'https://example.test/project.git',
    local_path: '/tmp/example-project',
    default_branch: 'main',
  });
  let nextBranchId = 1;
  async function createBranch(name: string, archived = false) {
    return branches.create({
      branch_unique_id: nextBranchId++,
      repo_id: repo.repo_id,
      board_id: board.board_id as BoardID,
      name,
      ref: `refs/heads/${name}`,
      path: `/tmp/example-project/${name}`,
      primary_owner_user_id: 'test-user' as UUID,
      created_by: 'test-user' as UUID,
      archived,
    });
  }
  const moving = await createBranch('feature');
  const placement = await objects.create({
    board_id: board.board_id as BoardID,
    branch_id: moving.branch_id,
    zone_id: 'source',
    position: { x: 24, y: 100 },
    size: { width: 500, height: 200 },
  });
  for (let index = 0; index < 6; index++) {
    const archived = await createBranch(`archived-${index}`, true);
    await objects.create({
      board_id: board.board_id as BoardID,
      branch_id: archived.branch_id,
      zone_id: 'destination',
      position: { x: 0, y: index * 224 },
      size: { width: 500, height: 200 },
    });
  }
  const find = vi.spyOn(service, 'find');
  const patch = vi.spyOn(service, 'patch');
  function handler(tenantId?: string) {
    let setZone!: Handler;
    const server = {
      registerTool(name: string, _config: unknown, callback: Handler) {
        if (name === 'agor_branches_set_zone') setZone = callback;
      },
    } as unknown as McpServer;
    const app = {
      get: () => ({}),
      service(name: string) {
        if (name === 'boards') {
          return {
            get: () => boards.findById(board.board_id as BoardID),
            patch: (id: string, data: BoardLayoutBatch & { _action: string }) =>
              boards.applyBoardLayout(id, data),
          };
        }
        if (name === 'branches') return { get: () => branches.findById(moving.branch_id) };
        if (name === 'board-objects') return service;
        throw new Error(`Unexpected service ${name}`);
      },
    };
    registerBranchTools(server, {
      db,
      app,
      userId: 'test-user',
      baseServiceParams: { ...(tenantId ? { tenant: { tenant_id: tenantId } } : {}) },
    } as unknown as Parameters<typeof registerBranchTools>[1]);
    return setZone;
  }
  return {
    destination,
    board,
    boards,
    moving,
    placement,
    objects,
    find,
    patch,
    handler,
    createBranch,
  };
}

function contained(placement: BoardEntityObject, zone: { width: number; height: number }) {
  expect(placement.position.x).toBeGreaterThanOrEqual(0);
  expect(placement.position.y).toBeGreaterThanOrEqual(0);
  expect(placement.position.x + 500).toBeLessThanOrEqual(zone.width);
  expect(placement.position.y + 200).toBeLessThanOrEqual(zone.height);
}

dbTest(
  'archived occupancy cannot push a same/cross-zone pin over an unrelated artifact',
  async ({ db }) => {
    const f = await fixture(db);
    // Reproduce the old allocator against actual persisted archived rows.
    const all = await f.objects.findAll({
      board_id: f.board.board_id as BoardID,
      zone_id: 'destination',
    });
    const oldSlot = findFreeZoneSlot(
      f.destination,
      all.map((entity) => ({
        ...entity.position,
        width: 500,
        height: 200,
      }))
    );
    expect(oldSlot.y).toBeGreaterThan(f.destination.height);
    expect(f.destination.y + oldSlot.y).toBeGreaterThan(2000);
    expect(f.destination.y + oldSlot.y).toBeLessThan(2900);

    for (const zoneId of ['destination', 'destination', 'source', 'destination']) {
      await f.handler()({ branchId: f.moving.branch_id, zoneId });
      const stored = await f.objects.findByObjectId(f.placement.object_id);
      expect(stored?.zone_id).toBe(zoneId);
      // Default zone frame: 32px padding below the 80px title reserve.
      expect(stored?.position).toEqual({ x: 32, y: 112 });
      contained(stored!, f.destination);
      // Relative hydration adds the parent once, leaving the preview untouched.
      expect(f.destination.y + stored!.position.y + 200).toBeLessThan(2000);
    }
    expect(f.find).toHaveBeenCalledWith({
      query: {
        board_id: f.board.board_id,
        zone_id: 'destination',
        exclude_archived_branches: true,
      },
    });
  }
);

dbTest(
  'rejects a conflicting tenant before collecting occupancy or mutating placement',
  async ({ db }) => {
    const f = await fixture(db);
    await expect(
      runWithTenantContext('tenant-b', () =>
        f.handler('tenant-a')({
          branchId: f.moving.branch_id,
          zoneId: 'destination',
        })
      )
    ).rejects.toThrow(/tenant/i);
    expect(f.find).not.toHaveBeenCalled();
    expect(f.patch).not.toHaveBeenCalled();
    expect(await f.objects.findByObjectId(f.placement.object_id)).toEqual(f.placement);
  }
);

dbTest(
  'a full destination preserves the previous pin and does not overlap a visible card',
  async ({ db }) => {
    const f = await fixture(db);
    const card = await new CardRepository(db).create({
      board_id: f.board.board_id as BoardID,
      title: 'Occupied',
    });
    await f.objects.create({
      board_id: f.board.board_id as BoardID,
      card_id: card.card_id,
      zone_id: 'destination',
      position: { x: 0, y: 0 },
      size: { width: 650, height: 500 },
    });
    await expect(
      f.handler()({ branchId: f.moving.branch_id, zoneId: 'destination' })
    ).rejects.toThrow(/No free slot/);
    expect(f.patch).not.toHaveBeenCalled();
    expect(await f.objects.findByObjectId(f.placement.object_id)).toEqual(f.placement);
  }
);

dbTest(
  'uses the moving branch measured dimensions, not only nominal card dimensions',
  async ({ db }) => {
    const f = await fixture(db);
    await f.objects.updateSize(f.placement.object_id, { width: 500, height: 600 });
    const before = await f.objects.findByObjectId(f.placement.object_id);
    await expect(
      f.handler()({ branchId: f.moving.branch_id, zoneId: 'destination' })
    ).rejects.toThrow(/too small/);
    expect(f.patch).not.toHaveBeenCalled();
    expect(await f.objects.findByObjectId(f.placement.object_id)).toEqual(before);
  }
);

// Fictional shape of a live report: a manual one-column zone that already
// holds one arranged branch at its frame origin (20,100) and may grow in height.
const implementingLayout: ZoneLayoutPolicy = {
  mode: 'manual',
  preset: 'grid',
  sortBy: 'position',
  sortDirection: 'asc',
  columns: 1,
  padding: 20,
  rowGap: 8,
  resize: 'height',
  autoResizeHeight: true,
  onOverflow: 'reflow_board',
};

async function implementingFixture(
  db: Database,
  options: { height: number; layout?: ZoneLayoutPolicy }
) {
  const implementing = {
    type: 'zone' as const,
    label: 'Implementing',
    x: 5000,
    y: 0,
    width: 812,
    height: options.height,
    layout: options.layout ?? implementingLayout,
  };
  const below = {
    type: 'zone' as const,
    label: 'Below',
    x: 5000,
    y: options.height + 20,
    width: 812,
    height: 300,
  };
  const f = await fixture(db, { implementing, below });
  const resident = await f.createBranch('resident');
  await f.objects.create({
    board_id: f.board.board_id as BoardID,
    branch_id: resident.branch_id,
    zone_id: 'implementing',
    position: { x: 20, y: 100 },
    size: { width: 500, height: 200 },
  });
  // The moving branch is a measured compact card.
  await f.objects.updateSize(f.placement.object_id, { width: 500, height: 220 });
  return { ...f, implementing, below };
}

dbTest(
  'pins into the free band below an arranged occupant instead of rejecting',
  async ({ db }) => {
    const f = await implementingFixture(db, { height: 600 });

    await f.handler()({ branchId: f.moving.branch_id, zoneId: 'implementing' });

    const stored = await f.objects.findByObjectId(f.placement.object_id);
    expect(stored?.zone_id).toBe('implementing');
    expect(stored?.position).toEqual({ x: 20, y: 308 });
    const board = await f.boards.findById(f.board.board_id as BoardID);
    expect(board?.objects?.implementing).toMatchObject({ width: 812, height: 600 });
    expect(board?.objects?.below).toMatchObject({ y: 620 });
  }
);

dbTest(
  'grows a height-resizable zone and reflows its neighbour instead of rejecting',
  async ({ db }) => {
    const f = await implementingFixture(db, { height: 340 });

    const result = (await f.handler()({
      branchId: f.moving.branch_id,
      zoneId: 'implementing',
    })) as { content: Array<{ text: string }> };

    const stored = await f.objects.findByObjectId(f.placement.object_id);
    expect(stored?.zone_id).toBe('implementing');
    expect(stored?.position).toEqual({ x: 20, y: 308 });
    const board = await f.boards.findById(f.board.board_id as BoardID);
    expect(board?.objects?.implementing).toMatchObject({ y: 0, width: 812, height: 560 });
    const below = board?.objects?.below;
    expect(below?.type).toBe('zone');
    expect(below!.y).toBeGreaterThanOrEqual(560);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      zone_resize: { height: 560, moved_zone_ids: ['below'] },
    });
  }
);

dbTest('a full fixed-size zone rejects without resizing or moving the branch', async ({ db }) => {
  const f = await implementingFixture(db, {
    height: 340,
    layout: { ...implementingLayout, resize: 'fixed', autoResizeHeight: false },
  });
  const before = await f.objects.findByObjectId(f.placement.object_id);

  await expect(
    f.handler()({ branchId: f.moving.branch_id, zoneId: 'implementing' })
  ).rejects.toThrow(/No free slot/);

  expect(f.patch).not.toHaveBeenCalled();
  expect(await f.objects.findByObjectId(f.placement.object_id)).toEqual(before);
  const board = await f.boards.findById(f.board.board_id as BoardID);
  expect(board?.objects?.implementing).toMatchObject({ height: 340 });
});
