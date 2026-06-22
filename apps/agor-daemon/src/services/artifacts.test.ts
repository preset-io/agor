/**
 * ArtifactsService Tests
 *
 * Covers updateMetadata (board moves, placement preservation, authz) and
 * land (filesystem materialization, path-traversal defenses).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateId } from '@agor/core';
import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  type Database,
  RepoRepository,
  SessionRepository,
  shortId,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Artifact, BoardID, BranchID, SessionID, UUID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ArtifactsService } from './artifacts';

/**
 * Build a fake Feathers app whose services all no-op on emit. The service
 * under test only calls `app.service(name).emit(event, payload)` for
 * WebSocket broadcasts, which we don't care about in unit tests.
 */
function makeFakeApp(): Application {
  const service = () => ({ emit: () => {} });
  return {
    service,
    get: (key: string) =>
      key === 'authentication' ? { secret: 'artifact-test-secret' } : undefined,
  } as unknown as Application;
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

async function seedRepoAndBranch(db: Database, branchPath: string) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `artifact-test-${generateId()}`,
    name: 'Artifact Test Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: path.dirname(branchPath),
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `artifact-branch-${generateId()}`,
    ref: 'refs/heads/artifact-branch',
    branch_unique_id: 1,
    path: branchPath,
    created_by: 'user-owner' as UUID,
    others_can: 'session',
  });
}

async function seedSession(db: Database, branchId: BranchID, userId = 'user-owner') {
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branchId,
    created_by: userId as UUID,
    tasks: [],
    genealogy: { children: [] },
  });
}

/**
 * Insert a row into `users` so FK-bearing tables (like
 * `artifact_trust_grants.user_id`) accept a grant for this user. The CI
 * SQLite has `PRAGMA foreign_keys = ON`; tests that skip seeding hit
 * SQLITE_CONSTRAINT_FOREIGNKEY.
 */
async function seedUser(db: Database, userId: string): Promise<void> {
  const repo = new UsersRepository(db);
  await repo.create({
    user_id: userId as never,
    email: `${userId}@test.local`,
    display_name: userId,
  });
}

/**
 * Compute the same default land subpath that `defaultLandFolderName` in
 * the service does. Tests that pre-create the default destination must
 * stay in sync — duplicating the logic here is the lesser evil vs
 * exporting an internal helper just for tests.
 */
function defaultLandDestForArtifact(
  tmpRoot: string,
  artifact: { name: string; artifact_id: string }
): string {
  const slug = artifact.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const idShort = shortId(artifact.artifact_id);
  const folder = slug.length > 0 ? `${slug}-${idShort}` : artifact.artifact_id;
  return path.join(realpathSync(tmpRoot), '.agor', 'artifacts', folder);
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

describe('ArtifactRepository URL fields', () => {
  dbTest('returns both board url and fullscreen_url from repository reads', async ({ db }) => {
    const previousBaseUrl = process.env.AGOR_BASE_URL;
    process.env.AGOR_BASE_URL = 'https://agor.example.com/ui';
    try {
      const artifactRepo = new ArtifactRepository(db);
      const board = await seedBoard(db);
      const artifact = await seedArtifact(db, board.board_id, { userId: 'user-owner' });
      const artifactShortId = shortId(artifact.artifact_id);

      expect(artifact.url).toBe(`https://agor.example.com/ui/a/${artifactShortId}/`);
      expect(artifact.fullscreen_url).toBe(
        `https://agor.example.com/ui/a/${artifactShortId}/fullscreen`
      );

      const fetched = await artifactRepo.findById(artifact.artifact_id);
      expect(fetched?.url).toBe(artifact.url);
      expect(fetched?.fullscreen_url).toBe(artifact.fullscreen_url);

      const listed = await artifactRepo.findAll();
      expect(listed[0]?.url).toBe(artifact.url);
      expect(listed[0]?.fullscreen_url).toBe(artifact.fullscreen_url);
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.AGOR_BASE_URL;
      } else {
        process.env.AGOR_BASE_URL = previousBaseUrl;
      }
    }
  });
});

describe('ArtifactRepository source session provenance', () => {
  dbTest('persists and returns source_session_id', async ({ db }) => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'artifact-source-session-'));
    try {
      const board = await seedBoard(db);
      const branch = await seedRepoAndBranch(db, tmpRoot);
      const session = await seedSession(db, branch.branch_id);
      const artifactRepo = new ArtifactRepository(db);

      const created = await artifactRepo.create({
        board_id: board.board_id,
        name: 'Session-linked artifact',
        template: 'react',
        files: { '/index.js': 'console.log("hi")' },
        source_session_id: session.session_id,
        created_by: 'user-owner',
      });

      expect(created.source_session_id).toBe(session.session_id);
      const fetched = await artifactRepo.findById(created.artifact_id);
      expect(fetched?.source_session_id).toBe(session.session_id);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('ArtifactsService source session provenance', () => {
  dbTest('ignores source_session_id in generic metadata patch', async ({ db }) => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'artifact-source-session-patch-'));
    try {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const branch = await seedRepoAndBranch(db, tmpRoot);
      const originalSession = await seedSession(db, branch.branch_id);
      const spoofedSession = await seedSession(db, branch.branch_id);
      const artifactRepo = new ArtifactRepository(db);

      const artifact = await artifactRepo.create({
        board_id: board.board_id,
        name: 'Original',
        template: 'react',
        files: { '/index.js': 'console.log("hi")' },
        source_session_id: originalSession.session_id,
        created_by: 'user-owner',
      });

      const patched = await service.patch(artifact.artifact_id, {
        name: 'Renamed',
        source_session_id: spoofedSession.session_id,
      });

      expect(patched.name).toBe('Renamed');
      expect(patched.source_session_id).toBe(originalSession.session_id);

      const updated = await service.update(artifact.artifact_id, {
        description: 'Updated metadata',
        source_session_id: spoofedSession.session_id,
      });

      expect(updated.description).toBe('Updated metadata');
      expect(updated.source_session_id).toBe(originalSession.session_id);
      const fetched = await artifactRepo.findById(artifact.artifact_id);
      expect(fetched?.source_session_id).toBe(originalSession.session_id);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

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
    ).rejects.toThrow(/Forbidden/i);
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

  dbTest('writes all files plus agor.artifact.json to default subpath', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id, {
      files: { '/app.js': 'export const x = 1', '/nested/deep.js': 'export const y = 2' },
    });

    const result = await service.land(artifact.artifact_id, tmpRoot);

    const expectedDest = defaultLandDestForArtifact(tmpRoot, artifact);
    expect(result.destinationPath).toBe(expectedDest);
    expect(result.fileCount).toBe(3); // 2 source files + agor.artifact.json sidecar
    expect(readFileSync(path.join(expectedDest, 'app.js'), 'utf-8')).toBe('export const x = 1');
    expect(readFileSync(path.join(expectedDest, 'nested', 'deep.js'), 'utf-8')).toBe(
      'export const y = 2'
    );

    const manifest = JSON.parse(
      readFileSync(path.join(expectedDest, 'agor.artifact.json'), 'utf-8')
    );
    expect(manifest.template).toBe('react');
  });

  dbTest('writes to a custom subpath inside the branch', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    const result = await service.land(artifact.artifact_id, tmpRoot, {
      subpath: 'apps/frontend/demo',
    });

    expect(result.destinationPath).toBe(
      path.join(realpathSync(tmpRoot), 'apps', 'frontend', 'demo')
    );
  });

  dbTest('rejects subpath that escapes the branch via ".."', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(
      service.land(artifact.artifact_id, tmpRoot, { subpath: '../escape' })
    ).rejects.toThrow(/escapes branch root/i);
  });

  dbTest('rejects absolute subpath', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(
      service.land(artifact.artifact_id, tmpRoot, { subpath: '/etc/passwd' })
    ).rejects.toThrow(/must be relative/i);
  });

  dbTest('rejects subpath that resolves to the branch root', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    await expect(service.land(artifact.artifact_id, tmpRoot, { subpath: '.' })).rejects.toThrow(
      /branch root/i
    );
  });

  dbTest('rejects when branch path does not exist', async ({ db }) => {
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
    const dest = defaultLandDestForArtifact(tmpRoot, artifact);
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

    const dest = defaultLandDestForArtifact(tmpRoot, artifact);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dest, { recursive: true });
    writeFileSync(path.join(dest, 'stale.txt'), 'stale');

    const result = await service.land(artifact.artifact_id, tmpRoot, { overwrite: true });

    expect(result.fileCount).toBe(2); // /only.js + agor.artifact.json sidecar
    expect(readFileSync(path.join(dest, 'only.js'), 'utf-8')).toBe('fresh');
    // Stale file is gone.
    const fsSync = await import('node:fs');
    expect(fsSync.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
  });

  dbTest(
    'rejects subpath that escapes through a symlinked directory inside the branch',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifact = await seedArtifact(db, board.board_id);

      // Attack shape: the branch contains a symlink `.agor` -> `/tmp/...`
      // that points outside the branch. The default subpath uses `.agor/...`,
      // so without realpath canonicalization, a lexical containment check
      // would let the write escape into the symlink target.
      const outside = mkdtempSync(path.join(tmpdir(), 'agor-land-outside-'));
      try {
        symlinkSync(outside, path.join(tmpRoot, '.agor'), 'dir');

        await expect(service.land(artifact.artifact_id, tmpRoot)).rejects.toThrow(
          /escapes branch root/i
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  dbTest('canonicalizes a symlinked branch path before containment check', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifact = await seedArtifact(db, board.board_id);

    // The branch.path column may be a symlink (common when cloning the
    // repo under /home vs. /var/home). Landing must still write inside the
    // real (canonicalized) branch — it should not throw and not land
    // somewhere else.
    const realBranch = path.join(tmpRoot, 'real-branch');
    mkdirSync(realBranch, { recursive: true });
    const symlinkedBranch = path.join(tmpRoot, 'linked-branch');
    symlinkSync(realBranch, symlinkedBranch, 'dir');

    const result = await service.land(artifact.artifact_id, symlinkedBranch);

    // Destination path is reported under the real root (post-canonicalize).
    expect(result.destinationPath.startsWith(realpathSync(realBranch))).toBe(true);
    expect(readFileSync(path.join(result.destinationPath, 'index.js'), 'utf-8')).toBe(
      'console.log("hello")'
    );
  });

  dbTest(
    'rejects branch-relative publish source that is a symlink to outside the branch',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const branch = await seedRepoAndBranch(db, tmpRoot);
      const outside = mkdtempSync(path.join(tmpdir(), 'agor-publish-outside-'));
      try {
        writeFileSync(path.join(outside, 'index.js'), 'console.log("outside")');
        symlinkSync(outside, path.join(tmpRoot, 'app'), 'dir');

        await expect(
          service.checkBuildFromFolder(
            { branch_id: branch.branch_id, subpath: 'app' },
            'user-reviewer',
            'member'
          )
        ).rejects.toThrow(/escapes branch root/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  dbTest(
    'treats registered branches under temp roots as branches before temp-dir allowance',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const branch = await seedRepoAndBranch(db, tmpRoot);
      const appDir = path.join(tmpRoot, 'app');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(path.join(appDir, 'index.js'), 'console.log("branch")');

      await expect(
        service.checkBuildFromFolder({ folderPath: appDir }, undefined, 'member')
      ).rejects.toThrow(/Authentication required/i);

      await expect(
        service.checkBuildFromFolder({ folderPath: appDir }, 'user-reviewer', 'member')
      ).resolves.toMatchObject({ status: 'success' });

      expect(branch.path).toBe(tmpRoot);
    }
  );

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

describe('ArtifactsService.getPayload trust + .env synthesis', () => {
  // Seed an artifact whose `created_by` is the author. The payload's trust
  // resolution should treat the author as 'self' and skip consent.
  dbTest('viewer-is-author → trust_state=self, .env injected', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'self-render',
      template: 'react',
      files: { '/index.js': 'console.log("self")', '/package.json': '{}' },
      required_env_vars: ['OPENAI_KEY'],
      public: true,
      created_by: 'user-owner',
    });

    const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);
    expect(payload.trust_state).toBe('self');
    expect(payload.trust_scope).toBe('self');
    // .env is synthesized even though the user has no env var stored — value is empty.
    // `react` template is CRA-backed, so the prefix is `REACT_APP_`.
    expect(payload.files['/.env']).toMatch(/REACT_APP_OPENAI_KEY=/);
  });

  dbTest('agor_token renders as artifact-runtime scoped token for author', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'scoped-token-render',
      template: 'react',
      files: { '/index.js': 'console.log("token")' },
      agor_grants: { agor_token: true, agor_proxies: ['shortcut'] },
      public: true,
      created_by: 'user-owner',
    });

    const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);
    const env = payload.files['/.env'];
    const token = String(env)
      .match(/REACT_APP_AGOR_TOKEN=(.+)/)?.[1]
      ?.replace(/^"|"$/g, '');
    expect(token).toBeTruthy();
    const decoded = jwt.verify(token!, 'artifact-test-secret', {
      issuer: 'agor',
      audience: 'agor:artifact-runtime',
    }) as jwt.JwtPayload;
    expect(decoded.type).toBe('artifact');
    expect(decoded.purpose).toBe('artifact-runtime');
    expect(decoded.artifact_id).toBe(created.artifact_id);
    expect(decoded.proxies).toEqual(['shortcut']);
  });

  dbTest(
    'untrusted viewer → trust_state=untrusted, .env keys present with empty values',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifactRepo = new ArtifactRepository(db);
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'untrusted-render',
        template: 'react',
        files: { '/index.js': 'console.log("x")' },
        required_env_vars: ['OPENAI_KEY', 'STRIPE_KEY'],
        agor_grants: { agor_token: true },
        public: true,
        created_by: 'user-owner',
      });

      const payload = await service.getPayload(created.artifact_id, 'user-stranger' as never);
      expect(payload.trust_state).toBe('untrusted');
      // Empty values, but keys are present so the artifact can detect the state.
      // `react` template is CRA-backed, so the prefix is `REACT_APP_`.
      expect(payload.files['/.env']).toMatch(/REACT_APP_OPENAI_KEY=/);
      expect(payload.files['/.env']).toMatch(/REACT_APP_STRIPE_KEY=/);
      expect(payload.files['/.env']).toMatch(/REACT_APP_AGOR_TOKEN=/);
    }
  );

  dbTest('vanilla template skips .env synthesis entirely', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'vanilla',
      template: 'vanilla',
      files: { '/index.html': '<h1>hi</h1>' },
      required_env_vars: ['SOMETHING'],
      public: true,
      created_by: 'user-owner',
    });

    const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);
    expect(payload.files['/.env']).toBeUndefined();
  });
});

describe('ArtifactsService.grantTrust', () => {
  dbTest('session-scope grant is in-memory only and authorizes the next render', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'session-trust',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      required_env_vars: ['OPENAI_KEY'],
      public: true,
      created_by: 'user-owner',
    });

    // First render — untrusted.
    const before = await service.getPayload(created.artifact_id, 'user-stranger' as never);
    expect(before.trust_state).toBe('untrusted');

    // Grant session-scope trust. Server derives env vars + grants from the
    // artifact's current request — caller only nominates the scope.
    const result = await service.grantTrust({
      userId: 'user-stranger',
      artifactId: created.artifact_id,
      scopeType: 'session',
    });
    expect(result.persisted).toBe(false);

    const after = await service.getPayload(created.artifact_id, 'user-stranger' as never);
    expect(after.trust_state).toBe('trusted');
    expect(after.trust_scope).toBe('session');
  });

  dbTest('artifact-scope grant persists and authorizes future renders', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    await seedUser(db, 'user-stranger');
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'artifact-trust',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      required_env_vars: ['OPENAI_KEY'],
      public: true,
      created_by: 'user-owner',
    });

    await service.grantTrust({
      userId: 'user-stranger',
      artifactId: created.artifact_id,
      scopeType: 'artifact',
    });

    const payload = await service.getPayload(created.artifact_id, 'user-stranger' as never);
    expect(payload.trust_state).toBe('trusted');
    expect(payload.trust_scope).toBe('artifact');
  });

  dbTest(
    'strict subset: a grant predating an expansion of required_env_vars no longer covers',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      await seedUser(db, 'user-stranger');
      const artifactRepo = new ArtifactRepository(db);
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'expanding-needs',
        template: 'react',
        files: { '/index.js': 'console.log("x")' },
        required_env_vars: ['OPENAI_KEY'],
        public: true,
        created_by: 'user-owner',
      });

      // Grant covers the artifact at this point in time (just OPENAI_KEY).
      await service.grantTrust({
        userId: 'user-stranger',
        artifactId: created.artifact_id,
        scopeType: 'artifact',
      });

      // Author later expands the artifact's requested env vars. The grant is
      // now strictly narrower than the request, so the user should be
      // re-prompted on the next render.
      await artifactRepo.update(created.artifact_id, {
        required_env_vars: ['OPENAI_KEY', 'STRIPE_KEY'],
      });

      const payload = await service.getPayload(created.artifact_id, 'user-stranger' as never);
      expect(payload.trust_state).toBe('untrusted');
    }
  );

  dbTest('agor_token at author scope is rejected (artifact scope only)', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'token-author',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      agor_grants: { agor_token: true },
      public: true,
      created_by: 'user-owner',
    });

    await expect(
      service.grantTrust({
        userId: 'user-stranger',
        artifactId: created.artifact_id,
        scopeType: 'author',
      })
    ).rejects.toThrow(/agor_token/);
  });

  dbTest('author-scope grant covers a different artifact by the same author', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    await seedUser(db, 'viewer-1');
    const artifactRepo = new ArtifactRepository(db);
    const a = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'a',
      template: 'react',
      files: { '/index.js': 'a' },
      required_env_vars: ['OPENAI_KEY'],
      public: true,
      created_by: 'author-1',
    });
    const b = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'b',
      template: 'react',
      files: { '/index.js': 'b' },
      required_env_vars: ['OPENAI_KEY'],
      public: true,
      created_by: 'author-1',
    });

    // Grant on artifact A at author scope.
    await service.grantTrust({
      userId: 'viewer-1',
      artifactId: a.artifact_id,
      scopeType: 'author',
    });

    // Artifact B (same author) should be trusted via the author grant.
    const payload = await service.getPayload(b.artifact_id, 'viewer-1' as never);
    expect(payload.trust_state).toBe('trusted');
    expect(payload.trust_scope).toBe('author');
  });

  dbTest('grantTrust rejects when artifact is not visible to caller', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'private',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      required_env_vars: ['OPENAI_KEY'],
      public: false,
      created_by: 'user-owner',
    });

    await expect(
      service.grantTrust({
        userId: 'user-stranger',
        artifactId: created.artifact_id,
        scopeType: 'artifact',
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe('ArtifactsService.checkBuildFromFolder validation diagnostics', () => {
  dbTest('reports missing local imports and malformed package.json', async ({ db }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'agor-artifact-validate-'));
    try {
      writeFileSync(path.join(root, 'index.js'), "import './missing';\nconsole.log('hello');\n");
      writeFileSync(path.join(root, 'package.json'), '{ invalid json');

      const service = new ArtifactsService(db, makeFakeApp());
      const result = await service.checkBuildFromFolder({ folderPath: root });

      expect(result.status).toBe('error');
      expect(result.diagnostics.map((d) => d.code)).toContain('missing_local_import');
      expect(result.diagnostics.map((d) => d.code)).toContain('malformed_package_json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  dbTest('warns about declared env vars on templates without dotenv injection', async ({ db }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'agor-artifact-validate-'));
    try {
      writeFileSync(path.join(root, 'index.js'), "console.log('hello');\n");
      writeFileSync(
        path.join(root, 'agor.artifact.json'),
        JSON.stringify({ template: 'vanilla', required_env_vars: ['API_KEY'] })
      );

      const service = new ArtifactsService(db, makeFakeApp());
      const result = await service.checkBuildFromFolder({ folderPath: root });

      expect(result.status).toBe('success');
      expect(result.diagnostics.map((d) => d.code)).toContain('env_vars_not_injected_for_template');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ArtifactsService.getStatus + console isolation', () => {
  dbTest('console logs and sandpack errors are scoped per viewer', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'console-isolation',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      public: true,
      created_by: 'user-owner',
    });

    // Two different viewers post console output. Viewer A's output may
    // contain values derived from their own injected secrets — those must
    // never leak into viewer B's status read.
    await service.appendConsoleLogs(created.artifact_id, 'viewer-A', [
      { timestamp: 1, level: 'log', message: 'A_SECRET=alpha' },
    ]);
    await service.appendConsoleLogs(created.artifact_id, 'viewer-B', [
      { timestamp: 2, level: 'log', message: 'B_SECRET=bravo' },
    ]);
    await service.setSandpackError(
      created.artifact_id,
      'viewer-A',
      { message: 'A-only error' },
      'idle'
    );

    const statusA = await service.getStatus(created.artifact_id, 'viewer-A' as never);
    expect(statusA.console_logs.map((l) => l.message)).toEqual(['A_SECRET=alpha']);
    expect(statusA.sandpack_error?.message).toBe('A-only error');

    const statusB = await service.getStatus(created.artifact_id, 'viewer-B' as never);
    expect(statusB.console_logs.map((l) => l.message)).toEqual(['B_SECRET=bravo']);
    expect(statusB.sandpack_error).toBeNull();
  });

  dbTest('waitForRuntimeStatus resolves with browser-reported Sandpack failure', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'wait-failure',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      public: true,
      created_by: 'user-owner',
    });

    const waitPromise = service.waitForRuntimeStatus(created.artifact_id, 'viewer-A' as never, {
      timeoutMs: 5000,
      settleMs: 0,
    });
    await service.setSandpackError(
      created.artifact_id,
      'viewer-A',
      { message: 'Cannot find module ./missing' },
      'idle'
    );

    const result = await waitPromise;
    expect(result.ok).toBe(false);
    expect(result.observed).toBe(true);
    expect(result.build_status).toBe('error');
    expect(result.build_errors?.join('\n')).toMatch(/Cannot find module/);
  });

  dbTest(
    'waitForRuntimeStatus ignores stale content-hash reports and times out',
    async ({ db }) => {
      vi.useFakeTimers();
      try {
        const service = new ArtifactsService(db, makeFakeApp());
        const board = await seedBoard(db);
        const artifactRepo = new ArtifactRepository(db);
        const created = await artifactRepo.create({
          artifact_id: generateId(),
          board_id: board.board_id,
          name: 'wait-stale',
          template: 'react',
          files: { '/index.js': 'console.log("x")' },
          content_hash: 'current',
          public: true,
          created_by: 'user-owner',
        });

        const waitPromise = service.waitForRuntimeStatus(created.artifact_id, 'viewer-A' as never, {
          timeoutMs: 500,
          settleMs: 0,
        });
        await service.setSandpackError(created.artifact_id, 'viewer-A', null, 'idle', 'old');
        await vi.advanceTimersByTimeAsync(600);

        const result = await waitPromise;
        expect(result.ok).toBe(false);
        expect(result.observed).toBe(false);
        expect(result.timed_out).toBe(true);
        expect(result.sandpack_status).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  dbTest(
    'waitForRuntimeStatus ignores stale reports after metadata-only render changes',
    async ({ db }) => {
      vi.useFakeTimers();
      try {
        const service = new ArtifactsService(db, makeFakeApp());
        const board = await seedBoard(db);
        const artifactRepo = new ArtifactRepository(db);
        const created = await artifactRepo.create({
          artifact_id: generateId(),
          board_id: board.board_id,
          name: 'wait-stale-metadata',
          template: 'react',
          files: { '/index.js': 'console.log("x")' },
          content_hash: 'same-file-hash',
          public: true,
          created_by: 'user-owner',
        });
        const beforePayload = await service.getPayload(created.artifact_id, 'viewer-A' as never);

        const updated = await service.updateMetadata(
          created.artifact_id,
          { sandpack_config: { options: { showNavigator: true } } },
          'user-owner',
          'admin'
        );
        expect(updated.content_hash).toBe('same-file-hash');

        const waitPromise = service.waitForRuntimeStatus(created.artifact_id, 'viewer-A' as never, {
          timeoutMs: 500,
          settleMs: 0,
        });
        await service.setSandpackError(
          created.artifact_id,
          'viewer-A',
          null,
          'idle',
          beforePayload.runtime_report_hash
        );
        await vi.advanceTimersByTimeAsync(600);

        const result = await waitPromise;
        expect(result.ok).toBe(false);
        expect(result.observed).toBe(false);
        expect(result.timed_out).toBe(true);
        expect(result.sandpack_status).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  dbTest('getStatus rejects when artifact is not visible to caller', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'private',
      template: 'react',
      files: { '/index.js': 'console.log("x")' },
      public: false,
      created_by: 'user-owner',
    });

    await expect(service.getStatus(created.artifact_id, 'user-stranger' as never)).rejects.toThrow(
      /not found/i
    );
  });
});

describe('ArtifactsService.deleteArtifact authorization', () => {
  dbTest('owner can delete; returned artifact carries the deleted row', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    const deleted = await service.deleteArtifact(created.artifact_id, 'user-owner', 'member');
    expect(deleted.artifact_id).toBe(created.artifact_id);
  });

  dbTest('non-owner non-admin is rejected', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    await expect(
      service.deleteArtifact(created.artifact_id, 'user-stranger', 'member')
    ).rejects.toThrow(/Forbidden/i);
  });

  dbTest("admin can delete someone else's artifact", async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    await expect(
      service.deleteArtifact(created.artifact_id, 'admin-user', 'admin')
    ).resolves.toMatchObject({ artifact_id: created.artifact_id });
  });

  // REST DELETE /artifacts/:id arrives via service.remove(id, params); regression
  // guard that it threads params.user through to the auth-checked deleteArtifact.
  dbTest('service.remove() threads params.user → owner deletes successfully', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    const removed = await service.remove(created.artifact_id, {
      user: { user_id: 'user-owner', role: 'member' },
    });
    expect(removed.artifact_id).toBe(created.artifact_id);
  });

  dbTest('service.remove() rejects when params.user is missing or wrong', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    await expect(service.remove(created.artifact_id)).rejects.toThrow(/Forbidden/i);
    await expect(
      service.remove(created.artifact_id, {
        user: { user_id: 'user-stranger', role: 'member' },
      })
    ).rejects.toThrow(/Forbidden/i);
  });
});

describe('ArtifactsService.updateMetadata authorization', () => {
  dbTest('admin can update someone else’s artifact', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    const updated = await service.updateMetadata(
      created.artifact_id,
      { name: 'admin-renamed' },
      'admin-user',
      'admin'
    );
    expect(updated.name).toBe('admin-renamed');
  });

  dbTest('non-owner non-admin is rejected', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'owned',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    await expect(
      service.updateMetadata(
        created.artifact_id,
        { name: 'stranger-renamed' },
        'user-stranger',
        'member'
      )
    ).rejects.toThrow(/Forbidden/i);
  });
});

describe('ArtifactsService.getPayload agor-runtime injection', () => {
  dbTest(
    'default-on: adds runtime data URL to sandpack_config.options.externalResources without touching files',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifactRepo = new ArtifactRepository(db);
      // Hello-world-shape: /App.js only. The previous file-map injection
      // approach silently dropped the runtime here (no /src/index.*
      // entry to attach to). Under externalResources we don't need
      // any user file at all — the runtime ships as an iframe-level
      // <script src="..."> tag.
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'runtime-default',
        template: 'react',
        files: { '/App.js': 'export default function App() { return null; }' },
        public: true,
        created_by: 'user-owner',
      });

      const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);

      // User files are served verbatim — no import prepended, no synthesized
      // runtime file in the map.
      expect(payload.files['/App.js']).toBe('export default function App() { return null; }');
      expect(payload.files['/agor-runtime.js']).toBeUndefined();

      const resources = (payload.sandpack_config?.options as Record<string, unknown> | undefined)
        ?.externalResources;
      expect(Array.isArray(resources)).toBe(true);
      const arr = resources as string[];
      expect(arr.length).toBeGreaterThan(0);
      expect(arr[0]).toMatch(/^data:text\/javascript;base64,/);
      // Critical: must end in `.js` so Sandpack's static client (which
      // sniffs MIME via `/\.([^.]*)$/` on the URL) accepts it. A bare
      // base64 data URL ends in base64 chars and gets silently rejected
      // — see SandpackStatic.injectExternalResources.
      expect(arr[0]).toMatch(/\.js$/);
      const sandpackExtensionSniff = /\.([^.]*)$/;
      expect(arr[0].match(sandpackExtensionSniff)?.[1]).toBe('js');
      // The body before the `#` fragment is the actual base64 payload.
      const body = arr[0].slice('data:text/javascript;base64,'.length).split('#', 1)[0];
      const decoded = Buffer.from(body, 'base64').toString('utf-8');
      expect(decoded).toContain('agor:query');
    }
  );

  dbTest(
    'externalResources is daemon-owned: author-supplied entries are not preserved',
    async ({ db }) => {
      // sanitizeSandpackConfig strips externalResources on write, but a
      // legacy/manually-edited row could still carry them. Render-time
      // injection must NOT re-emit them — that would re-enable a prop
      // the sanitizer explicitly blocked (XSS into the iframe).
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifactRepo = new ArtifactRepository(db);
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'author-resources',
        template: 'react',
        files: { '/App.js': 'export default () => null;' },
        // Cast through `any` to simulate a row that escaped the
        // sanitizer (legacy / manual edit). `SandpackConfig.options`
        // doesn't expose `externalResources` because authors aren't
        // allowed to set it; we want to prove the daemon doesn't honor
        // it even when it slips into the persisted row anyway.
        sandpack_config: {
          options: { externalResources: ['https://attacker.example/xss.js'] },
        } as any,
        public: true,
        created_by: 'user-owner',
      });

      const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);
      const resources = (payload.sandpack_config?.options as Record<string, unknown> | undefined)
        ?.externalResources;
      expect(Array.isArray(resources)).toBe(true);
      const arr = resources as string[];
      // Exactly one entry: the daemon's runtime URL. The attacker entry
      // is dropped.
      expect(arr.length).toBe(1);
      expect(arr[0]).toMatch(/^data:text\/javascript;base64,/);
      expect(arr.some((r) => r.includes('attacker.example'))).toBe(false);
    }
  );

  dbTest('opt-out: enabled=false skips externalResources injection entirely', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'runtime-disabled',
      template: 'react',
      files: { '/src/index.js': 'console.log("user code")' },
      agor_runtime: { enabled: false },
      public: true,
      created_by: 'user-owner',
    });

    const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);
    expect(payload.files['/agor-runtime.js']).toBeUndefined();
    expect(payload.files['/src/index.js']).toBe('console.log("user code")');
    const resources = (payload.sandpack_config?.options as Record<string, unknown> | undefined)
      ?.externalResources;
    // Either no externalResources at all, or an array that doesn't carry
    // the runtime data URL. Both are acceptable opt-out shapes.
    if (Array.isArray(resources)) {
      expect((resources as string[]).every((r) => !r.startsWith('data:text/javascript'))).toBe(
        true
      );
    } else {
      expect(resources).toBeUndefined();
    }
  });

  dbTest(
    'persistence: published sandpack_config does not carry the runtime data URL',
    async ({ db }) => {
      const board = await seedBoard(db);
      const artifactRepo = new ArtifactRepository(db);
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'runtime-persistence',
        template: 'react',
        files: { '/src/index.js': 'console.log("user code")' },
        public: true,
        created_by: 'user-owner',
      });

      // The persisted row should never carry the runtime injection — it's
      // a render-time-only synthesis. Read directly from the repo to
      // bypass any getPayload-level rewriting.
      const stored = await artifactRepo.findById(created.artifact_id);
      expect(stored?.files?.['/agor-runtime.js']).toBeUndefined();
      expect(stored?.files?.['/src/index.js']).toBe('console.log("user code")');
      const persistedResources = (
        stored?.sandpack_config?.options as Record<string, unknown> | undefined
      )?.externalResources;
      // sanitizeSandpackConfig strips externalResources on write, so
      // either nothing was persisted at all or any persisted array is
      // empty / runtime-free.
      if (Array.isArray(persistedResources)) {
        expect(
          (persistedResources as string[]).every((r) => !r.startsWith('data:text/javascript'))
        ).toBe(true);
      } else {
        expect(persistedResources).toBeUndefined();
      }
    }
  );
});

describe('ArtifactsService.queryArtifactRuntime', () => {
  dbTest('rejects when agor_runtime.enabled is false', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'runtime-disabled',
      template: 'react',
      files: { '/index.js': 'x' },
      agor_runtime: { enabled: false },
      public: true,
      created_by: 'user-owner',
    });

    await expect(
      service.queryArtifactRuntime({
        artifactId: created.artifact_id,
        userId: 'user-owner',
        kind: 'query_dom',
        args: { selector: 'h1' },
        timeoutMs: 500,
      })
    ).rejects.toThrow(/disabled/i);
  });

  dbTest('rejects when artifact is not visible to caller', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'private',
      template: 'react',
      files: { '/index.js': 'x' },
      public: false,
      created_by: 'user-owner',
    });

    await expect(
      service.queryArtifactRuntime({
        artifactId: created.artifact_id,
        userId: 'user-stranger',
        kind: 'query_dom',
        args: { selector: 'h1' },
        timeoutMs: 500,
      })
    ).rejects.toThrow(/not found/i);
  });

  dbTest('times out cleanly when no browser answers', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'no-browser',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    // Floor-clamped to 500ms by queryArtifactRuntime; that's enough to
    // verify the timeout path without dragging the test suite.
    const start = Date.now();
    await expect(
      service.queryArtifactRuntime({
        artifactId: created.artifact_id,
        userId: 'user-owner',
        kind: 'query_dom',
        args: { selector: 'h1' },
        timeoutMs: 500,
      })
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeGreaterThanOrEqual(450);
  });

  dbTest('resolveRuntimeQuery delivers the iframe response', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'happy-path',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    let capturedRequestId: string | null = null;
    // Mock the service.emit so we can grab the request_id and resolve the
    // query before it times out. (Real production has an iframe round-trip
    // do this; we short-circuit it here.)
    const realApp = service as unknown as {
      app: { service: (name: string) => { emit: (event: string, data: unknown) => void } };
    };
    const originalApp = realApp.app;
    realApp.app = {
      service: () => ({
        emit: (event: string, data: unknown) => {
          if (event === 'agor-query') {
            capturedRequestId = (data as { request_id: string }).request_id;
          }
        },
      }),
    } as never;

    const queryPromise = service.queryArtifactRuntime({
      artifactId: created.artifact_id,
      userId: 'user-owner',
      kind: 'query_dom',
      args: { selector: 'h1' },
      timeoutMs: 5000,
    });
    // Flush the microtask queue so emit lands.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedRequestId).not.toBeNull();
    service.resolveRuntimeQuery({
      requestId: capturedRequestId as string,
      responderUserId: 'user-owner',
      ok: true,
      result: { matched: 1, nodes: [{ tag: 'h1', textContent: 'Hi' }] },
    });

    const result = await queryPromise;
    expect(result).toEqual({ matched: 1, nodes: [{ tag: 'h1', textContent: 'Hi' }] });

    realApp.app = originalApp;
  });

  dbTest('resolveRuntimeQuery silently ignores wrong-user responses', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'cross-user-block',
      template: 'react',
      files: { '/index.js': 'x' },
      public: true,
      created_by: 'user-owner',
    });

    let capturedRequestId: string | null = null;
    const realApp = service as unknown as {
      app: { service: (name: string) => { emit: (event: string, data: unknown) => void } };
    };
    const originalApp = realApp.app;
    realApp.app = {
      service: () => ({
        emit: (event: string, data: unknown) => {
          if (event === 'agor-query') {
            capturedRequestId = (data as { request_id: string }).request_id;
          }
        },
      }),
    } as never;

    const queryPromise = service.queryArtifactRuntime({
      artifactId: created.artifact_id,
      userId: 'user-owner',
      kind: 'query_dom',
      args: { selector: 'h1' },
      timeoutMs: 600,
    });
    await new Promise((r) => setTimeout(r, 10));
    // Different user (responder) tries to answer — should be silently
    // dropped, query should still time out.
    service.resolveRuntimeQuery({
      requestId: capturedRequestId as string,
      responderUserId: 'someone-else',
      ok: true,
      result: { i: 'should not be visible' },
    });
    await expect(queryPromise).rejects.toThrow(/timed out/i);

    realApp.app = originalApp;
  });
});
