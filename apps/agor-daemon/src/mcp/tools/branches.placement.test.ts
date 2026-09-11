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
import type { BoardEntityObject, BoardID, UUID } from '@agor/core/types';
import { findFreeZoneSlot } from '@agor/core/utils/board-placement';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { BoardObjectsService } from '../../services/board-objects';
import { registerBranchTools } from './branches';

type Handler = (args: { branchId: string; zoneId: string }) => Promise<unknown>;

async function fixture(db: Database) {
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
    },
  });
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
        if (name === 'boards') return { get: () => boards.findById(board.board_id as BoardID) };
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
  return { destination, board, moving, placement, objects, find, patch, handler };
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
      expect(stored?.position).toEqual({ x: 24, y: 24 });
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
