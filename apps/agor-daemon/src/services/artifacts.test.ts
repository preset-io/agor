/**
 * ArtifactsService Tests
 *
 * Covers updateMetadata (board moves, placement preservation, authz) and
 * land (filesystem materialization, path-traversal defenses).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateId } from '@agor/core';
import { ArtifactRepository, BoardRepository, type Database } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Artifact, BoardID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ArtifactsService } from './artifacts';

/**
 * Build a fake Feathers app whose services all no-op on emit. The service
 * under test only calls `app.service(name).emit(event, payload)` for
 * WebSocket broadcasts, which we don't care about in unit tests.
 */
function makeFakeApp(): Application {
  const service = () => ({ emit: () => {} });
  return { service } as unknown as Application;
}

/** Create a board directly via the repository, since the artifacts service
 * doesn't own boards. */
async function seedBoard(db: Database) {
  const repo = new BoardRepository(db);
  return repo.create({
    board_id: generateId() as BoardID,
    name: 'Test Board',
    created_by: 'user-owner',
  });
}

/** Seed an artifact with a known file map and a board placement. */
async function seedArtifact(
  db: Database,
  boardId: BoardID,
  options?: {
    userId?: string;
    isPublic?: boolean;
    files?: Record<string, string>;
    placement?: { x: number; y: number; width: number; height: number };
  }
): Promise<Artifact> {
  const artifactRepo = new ArtifactRepository(db);
  const boardRepo = new BoardRepository(db);
  const artifactId = generateId();
  const files = options?.files ?? {
    '/index.js': 'console.log("hello")',
    '/styles.css': 'body { color: red; }',
  };

  const created = await artifactRepo.create({
    artifact_id: artifactId,
    board_id: boardId,
    name: 'Seeded Artifact',
    template: 'react',
    files,
    content_hash: 'hash-seed',
    public: options?.isPublic ?? true,
    created_by: options?.userId ?? 'user-owner',
  });

  const placement = options?.placement ?? { x: 100, y: 200, width: 600, height: 400 };
  await boardRepo.upsertBoardObject(boardId, `artifact-${artifactId}`, {
    type: 'artifact',
    artifact_id: created.artifact_id,
    ...placement,
  });

  return created;
}

describe('ArtifactsService.updateMetadata', () => {
  dbTest('moves artifact to a new board and preserves placement', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const boardRepo = new BoardRepository(db);
    const boardA = await seedBoard(db);
    const boardB = await seedBoard(db);
    const artifact = await seedArtifact(db, boardA.board_id, {
      userId: 'user-owner',
      placement: { x: 42, y: 99, width: 800, height: 500 },
    });

    const updated = await service.updateMetadata(
      artifact.artifact_id,
      { board_id: boardB.board_id },
      'user-owner'
    );

    expect(updated.board_id).toBe(boardB.board_id);

    const refreshedA = await boardRepo.findById(boardA.board_id);
    const refreshedB = await boardRepo.findById(boardB.board_id);
    const objectKey = `artifact-${artifact.artifact_id}`;

    expect(refreshedA?.objects?.[objectKey]).toBeUndefined();
    const placed = refreshedB?.objects?.[objectKey];
    expect(placed).toBeDefined();
    expect(placed && placed.type === 'artifact' && placed.x).toBe(42);
    expect(placed && placed.type === 'artifact' && placed.y).toBe(99);
    expect(placed && placed.type === 'artifact' && placed.width).toBe(800);
    expect(placed && placed.type === 'artifact' && placed.height).toBe(500);
  });

  dbTest('overrides placement when coordinates are passed with move', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const boardRepo = new BoardRepository(db);
    const boardA = await seedBoard(db);
    const boardB = await seedBoard(db);
    const artifact = await seedArtifact(db, boardA.board_id, { userId: 'user-owner' });

    await service.updateMetadata(
      artifact.artifact_id,
      { board_id: boardB.board_id, x: 10, y: 20 },
      'user-owner'
    );

    const refreshed = await boardRepo.findById(boardB.board_id);
    const placed = refreshed?.objects?.[`artifact-${artifact.artifact_id}`];
    expect(placed && placed.type === 'artifact' && placed.x).toBe(10);
    expect(placed && placed.type === 'artifact' && placed.y).toBe(20);
    // Unset dimensions fall back to the existing placement.
    expect(placed && placed.type === 'artifact' && placed.width).toBe(600);
  });

  dbTest('rejects callers who do not own the artifact', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, { userId: 'user-owner' });

    await expect(
      service.updateMetadata(artifact.artifact_id, { name: 'Hijacked' }, 'user-stranger')
    ).rejects.toThrow(/not the owner/i);
  });

  dbTest('rejects move to a nonexistent board without mutating the row', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const artifactRepo = new ArtifactRepository(db);
    const boardRepo = new BoardRepository(db);
    const boardA = await seedBoard(db);
    const artifact = await seedArtifact(db, boardA.board_id, { userId: 'user-owner' });
    const bogusBoardId = generateId() as BoardID;

    await expect(
      service.updateMetadata(
        artifact.artifact_id,
        { board_id: bogusBoardId, name: 'Should-not-apply' },
        'user-owner'
      )
    ).rejects.toThrow(/destination board.*not found/i);

    // Row is untouched: no orphaned board_id, no renamed metadata.
    const after = await artifactRepo.findById(artifact.artifact_id);
    expect(after?.board_id).toBe(boardA.board_id);
    expect(after?.name).toBe('Seeded Artifact');

    // board_objects on source board is still there.
    const refreshedA = await boardRepo.findById(boardA.board_id);
    expect(refreshedA?.objects?.[`artifact-${artifact.artifact_id}`]).toBeDefined();
  });

  dbTest('preserves old board_object when destination upsert fails mid-move', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const artifactRepo = new ArtifactRepository(db);
    const boardRepo = new BoardRepository(db);
    const boardA = await seedBoard(db);
    const boardB = await seedBoard(db);
    const artifact = await seedArtifact(db, boardA.board_id, {
      userId: 'user-owner',
      placement: { x: 55, y: 66, width: 700, height: 500 },
    });

    // Simulate a storage failure on the destination upsert. The service must
    // leave the artifact row on boardA AND leave boardA's board_object intact
    // — otherwise the artifact would be orphaned (row says boardA, but no
    // board_object there).
    const repo = (service as unknown as { boardRepo: BoardRepository }).boardRepo;
    const originalUpsert = repo.upsertBoardObject.bind(repo);
    repo.upsertBoardObject = async (boardId: BoardID, objectId: string, obj: unknown) => {
      if (boardId === boardB.board_id) {
        throw new Error('simulated storage failure');
      }
      return originalUpsert(boardId, objectId, obj as Parameters<typeof originalUpsert>[2]);
    };

    try {
      await expect(
        service.updateMetadata(artifact.artifact_id, { board_id: boardB.board_id }, 'user-owner')
      ).rejects.toThrow(/simulated storage failure/i);
    } finally {
      repo.upsertBoardObject = originalUpsert;
    }

    // Row was rolled back to the original board.
    const after = await artifactRepo.findById(artifact.artifact_id);
    expect(after?.board_id).toBe(boardA.board_id);

    // Critically: the original board_object on boardA is still there —
    // upsert happens BEFORE removal, so a failed upsert never reaches the
    // remove step.
    const key = `artifact-${artifact.artifact_id}`;
    const refreshedA = await boardRepo.findById(boardA.board_id);
    const placed = refreshedA?.objects?.[key];
    expect(placed).toBeDefined();
    expect(placed && placed.type === 'artifact' && placed.x).toBe(55);
    expect(placed && placed.type === 'artifact' && placed.width).toBe(700);

    // Destination board has nothing.
    const refreshedB = await boardRepo.findById(boardB.board_id);
    expect(refreshedB?.objects?.[key]).toBeUndefined();
  });

  dbTest('updates name and public flag without touching placement', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const boardRepo = new BoardRepository(db);
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, {
      userId: 'user-owner',
      placement: { x: 111, y: 222, width: 333, height: 444 },
    });

    const updated = await service.updateMetadata(
      artifact.artifact_id,
      { name: 'Renamed', public: false },
      'user-owner'
    );

    expect(updated.name).toBe('Renamed');
    expect(updated.public).toBe(false);

    const refreshed = await boardRepo.findById(board.board_id);
    const placed = refreshed?.objects?.[`artifact-${artifact.artifact_id}`];
    expect(placed && placed.type === 'artifact' && placed.x).toBe(111);
    expect(placed && placed.type === 'artifact' && placed.width).toBe(333);
  });
});

describe('ArtifactsService.patch (board move routing)', () => {
  dbTest('board_id patch moves the board_objects entry to the new board', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const boardRepo = new BoardRepository(db);
    const boardA = await seedBoard(db);
    const boardB = await seedBoard(db);
    const artifact = await seedArtifact(db, boardA.board_id, {
      placement: { x: 70, y: 80, width: 500, height: 300 },
    });

    const patched = await service.patch(artifact.artifact_id, {
      board_id: boardB.board_id,
    });
    expect((patched as Artifact).board_id).toBe(boardB.board_id);

    const key = `artifact-${artifact.artifact_id}`;
    const refreshedA = await boardRepo.findById(boardA.board_id);
    const refreshedB = await boardRepo.findById(boardB.board_id);
    expect(refreshedA?.objects?.[key]).toBeUndefined();
    const placed = refreshedB?.objects?.[key];
    expect(placed && placed.type === 'artifact' && placed.x).toBe(70);
    expect(placed && placed.type === 'artifact' && placed.width).toBe(500);
  });

  dbTest('metadata-only patch does not touch board_objects', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const boardRepo = new BoardRepository(db);
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, {
      placement: { x: 11, y: 22, width: 333, height: 444 },
    });

    await service.patch(artifact.artifact_id, { name: 'Renamed via patch' });

    const key = `artifact-${artifact.artifact_id}`;
    const refreshed = await boardRepo.findById(board.board_id);
    const placed = refreshed?.objects?.[key];
    // Placement is untouched.
    expect(placed && placed.type === 'artifact' && placed.x).toBe(11);
    expect(placed && placed.type === 'artifact' && placed.width).toBe(333);
  });
});

describe('ArtifactsService.land', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'agor-land-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  dbTest('writes all files plus sandpack.json to default subpath', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, {
      files: { '/app.js': 'export const x = 1', '/nested/deep.js': 'export const y = 2' },
    });

    const result = await service.land(artifact.artifact_id, tmpRoot);

    const expectedDest = path.join(tmpRoot, '.agor', 'artifacts', artifact.artifact_id);
    expect(result.destinationPath).toBe(expectedDest);
    expect(result.fileCount).toBe(3); // 2 source files + sandpack.json
    expect(readFileSync(path.join(expectedDest, 'app.js'), 'utf-8')).toBe('export const x = 1');
    expect(readFileSync(path.join(expectedDest, 'nested', 'deep.js'), 'utf-8')).toBe(
      'export const y = 2'
    );

    const manifest = JSON.parse(readFileSync(path.join(expectedDest, 'sandpack.json'), 'utf-8'));
    expect(manifest.template).toBe('react');
  });

  dbTest('writes to a custom subpath inside the worktree', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    const result = await service.land(artifact.artifact_id, tmpRoot, {
      subpath: 'apps/frontend/demo',
    });

    expect(result.destinationPath).toBe(path.join(tmpRoot, 'apps', 'frontend', 'demo'));
  });

  dbTest('rejects subpath that escapes the worktree via ".."', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(
      service.land(artifact.artifact_id, tmpRoot, { subpath: '../escape' })
    ).rejects.toThrow(/escapes worktree root/i);
  });

  dbTest('rejects absolute subpath', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(
      service.land(artifact.artifact_id, tmpRoot, { subpath: '/etc/passwd' })
    ).rejects.toThrow(/must be relative/i);
  });

  dbTest('rejects subpath that resolves to the worktree root', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(service.land(artifact.artifact_id, tmpRoot, { subpath: '.' })).rejects.toThrow(
      /worktree root/i
    );
  });

  dbTest('rejects when worktree path does not exist', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(
      service.land(artifact.artifact_id, path.join(tmpRoot, 'does-not-exist'))
    ).rejects.toThrow(/does not exist/i);
  });

  dbTest('rejects artifact whose file map contains a traversal key', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, {
      files: {
        '/good.js': 'ok',
        '/../../../bin/evil': 'pwn',
      },
    });

    await expect(service.land(artifact.artifact_id, tmpRoot)).rejects.toThrow(
      /escapes destination/i
    );
  });

  dbTest('errors when destination exists and overwrite is false', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    // Pre-create the default destination with a file inside.
    const dest = path.join(tmpRoot, '.agor', 'artifacts', artifact.artifact_id);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dest, { recursive: true });
    writeFileSync(path.join(dest, 'pre-existing.txt'), 'preexisting');

    await expect(service.land(artifact.artifact_id, tmpRoot)).rejects.toThrow(/already exists/i);
  });

  dbTest('with overwrite=true replaces existing destination', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, {
      files: { '/only.js': 'fresh' },
    });

    const dest = path.join(tmpRoot, '.agor', 'artifacts', artifact.artifact_id);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dest, { recursive: true });
    writeFileSync(path.join(dest, 'stale.txt'), 'stale');

    const result = await service.land(artifact.artifact_id, tmpRoot, { overwrite: true });

    expect(result.fileCount).toBe(2); // /only.js + sandpack.json
    expect(readFileSync(path.join(dest, 'only.js'), 'utf-8')).toBe('fresh');
    // Stale file is gone.
    const fsSync = await import('node:fs');
    expect(fsSync.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
  });

  dbTest(
    'rejects subpath that escapes through a symlinked directory inside the worktree',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifact = await seedArtifact(db, board.board_id);

      // Attack shape: the worktree contains a symlink `.agor` -> `/tmp/...`
      // that points outside the worktree. The default subpath uses `.agor/...`,
      // so without realpath canonicalization, a lexical containment check
      // would let the write escape into the symlink target.
      const outside = mkdtempSync(path.join(tmpdir(), 'agor-land-outside-'));
      try {
        symlinkSync(outside, path.join(tmpRoot, '.agor'), 'dir');

        await expect(service.land(artifact.artifact_id, tmpRoot)).rejects.toThrow(
          /escapes worktree root/i
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  dbTest('canonicalizes a symlinked worktree path before containment check', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    // The worktree.path column may be a symlink (common when cloning the
    // repo under /home vs. /var/home). Landing must still write inside the
    // real (canonicalized) worktree — it should not throw and not land
    // somewhere else.
    const realWorktree = path.join(tmpRoot, 'real-worktree');
    mkdirSync(realWorktree, { recursive: true });
    const symlinkedWorktree = path.join(tmpRoot, 'linked-worktree');
    symlinkSync(realWorktree, symlinkedWorktree, 'dir');

    const result = await service.land(artifact.artifact_id, symlinkedWorktree);

    // Destination path is reported under the real root (post-canonicalize).
    expect(result.destinationPath.startsWith(realWorktree)).toBe(true);
    expect(readFileSync(path.join(result.destinationPath, 'index.js'), 'utf-8')).toBe(
      'console.log("hello")'
    );
  });

  dbTest('errors when artifact has no stored files', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'Empty',
      template: 'react',
      files: undefined,
      public: true,
      created_by: 'user-owner',
    });

    await expect(service.land(created.artifact_id, tmpRoot)).rejects.toThrow(/no stored files/i);
  });
});
