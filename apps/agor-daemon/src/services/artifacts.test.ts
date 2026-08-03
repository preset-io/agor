/**
 * ArtifactsService Tests
 *
 * Covers updateMetadata (board moves, placement preservation, authz) and
 * land (filesystem materialization, path-traversal defenses).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateId } from '@agor/core';
import { getDaemonBaseUrl } from '@agor/core/config';
import {
  ArtifactRepository,
  artifacts,
  BoardRepository,
  BranchRepository,
  type Database,
  eq,
  RepoRepository,
  SessionRepository,
  shortId,
  UsersRepository,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Artifact, BoardID, BranchID, SessionID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ArtifactsService } from './artifacts';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    getDaemonBaseUrl: vi.fn(async () => 'http://localhost:3030'),
  };
});

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

describe('ArtifactsService.getPayload trust + .env synthesis', () => {
  dbTest(
    'removed grants cannot be persisted or observed through patch/get/list',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifactRepo = new ArtifactRepository(db);
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'canonical-grants',
        template: 'react',
        files: { '/index.js': 'console.log("grants")' },
        public: true,
        created_by: 'user-owner',
      });
      const untypedGrants = {
        agor_api_url: true,
        agor_token: true,
        agor_proxies: ['shortcut'],
      } as unknown as Artifact['agor_grants'];

      const patched = await service.patch(created.artifact_id, {
        agor_grants: untypedGrants,
      });
      expect(patched.agor_grants).toEqual({ agor_api_url: true });

      // Simulate a row written by an older daemon to cover read-time
      // normalization independently from the current write boundary.
      await update(db, artifacts)
        .set({ agor_grants: untypedGrants })
        .where(eq(artifacts.artifact_id, created.artifact_id))
        .run();

      const fetched = await service.get(created.artifact_id);
      expect(fetched.agor_grants).toEqual({ agor_api_url: true });

      const listed = (await service.find({
        query: { board_id: board.board_id },
      })) as { data: Artifact[] };
      expect(listed.data).toHaveLength(1);
      expect(listed.data[0]?.agor_grants).toEqual({ agor_api_url: true });
    }
  );

  dbTest('content changes invalidate an artifact-scoped secret grant', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    await seedUser(db, 'viewer-1');
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'version-bound',
      template: 'react',
      files: { '/index.js': 'export default 1' },
      required_env_vars: ['FAKE_LAUNCH_SECRET'],
      public: true,
      created_by: 'viewer-1',
    });
    await service.grantTrust({
      userId: 'viewer-1',
      artifactId: created.artifact_id,
      scopeType: 'artifact',
    });
    await artifactRepo.update(created.artifact_id, {
      files: { '/index.js': 'document.body.textContent = import.meta.env.VITE_FAKE_LAUNCH_SECRET' },
    });

    const payload = await service.getPayload(created.artifact_id, 'viewer-1' as never);
    expect(payload.trust_state).toBe('untrusted');
    expect(payload.files['/.env']).not.toContain('FAKE_LAUNCH_SECRET=fake-secret-value');
  });

  dbTest(
    'viewer-is-author still renders without secrets until explicitly consented',
    async ({ db }) => {
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
      expect(payload.trust_state).toBe('untrusted');
      expect(payload.trust_scope).toBeUndefined();
      // The safe render contains only an empty placeholder, never a resolved value.
      // `react` template is CRA-backed, so the prefix is `REACT_APP_`.
      expect(payload.files['/.env']).toMatch(/REACT_APP_OPENAI_KEY=/);
    }
  );

  dbTest('injects the daemon origin for the artifact API grant', async ({ db }) => {
    vi.mocked(getDaemonBaseUrl).mockResolvedValueOnce('http://[::1]:3030');
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    await seedUser(db, 'user-owner');
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'daemon-api-grant',
      template: 'react',
      files: { '/index.js': 'console.log("daemon")', '/package.json': '{}' },
      agor_grants: { agor_api_url: true },
      public: true,
      created_by: 'user-owner',
    });

    await service.grantTrust({
      userId: 'user-owner',
      artifactId: created.artifact_id,
      scopeType: 'artifact',
    });
    const payload = await service.getPayload(created.artifact_id, 'user-owner' as never);

    expect(payload.files['/.env']).toContain('REACT_APP_AGOR_API_URL="http://[::1]:3030"');
    expect(getDaemonBaseUrl).toHaveBeenCalledOnce();
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
        agor_grants: { agor_api_url: true },
        public: true,
        created_by: 'user-owner',
      });

      const payload = await service.getPayload(created.artifact_id, 'user-stranger' as never);
      expect(payload.trust_state).toBe('untrusted');
      // Empty values, but keys are present so the artifact can detect the state.
      // `react` template is CRA-backed, so the prefix is `REACT_APP_`.
      expect(payload.files['/.env']).toMatch(/REACT_APP_OPENAI_KEY=/);
      expect(payload.files['/.env']).toMatch(/REACT_APP_STRIPE_KEY=/);
      expect(payload.files['/.env']).toMatch(/REACT_APP_AGOR_API_URL=/);
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

  dbTest(
    'rejects legacy broad trust scopes instead of trusting another artifact',
    async ({ db }) => {
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

      await expect(
        service.grantTrust({
          userId: 'viewer-1',
          artifactId: a.artifact_id,
          scopeType: 'author' as never,
        })
      ).rejects.toThrow(/scoped to this artifact/i);

      // Artifact B (same author) should be trusted via the author grant.
      const payload = await service.getPayload(b.artifact_id, 'viewer-1' as never);
      expect(payload.trust_state).toBe('untrusted');
    }
  );

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

describe('ArtifactsService.getStatus + console isolation', () => {
  dbTest(
    'does not disclose fake secret console output without introspection consent',
    async ({ db }) => {
      const service = new ArtifactsService(db, makeFakeApp());
      const board = await seedBoard(db);
      const artifactRepo = new ArtifactRepository(db);
      const created = await artifactRepo.create({
        artifact_id: generateId(),
        board_id: board.board_id,
        name: 'fake-secret-console',
        template: 'react',
        files: { '/index.js': 'console.log(import.meta.env.VITE_FAKE_SECRET)' },
        required_env_vars: ['FAKE_SECRET'],
        public: true,
        created_by: 'user-owner',
      });
      await service.appendConsoleLogs(created.artifact_id, 'user-owner', [
        { timestamp: 1, level: 'log', message: 'fake-launch-secret-do-not-disclose' },
      ]);

      const status = await service.getStatus(created.artifact_id, 'user-owner' as never);
      expect(JSON.stringify(status)).not.toContain('fake-launch-secret-do-not-disclose');
      expect(status.console_logs).toEqual([]);
    }
  );

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
  dbTest('blocks secret-bearing DOM introspection without separate consent', async ({ db }) => {
    const service = new ArtifactsService(db, makeFakeApp());
    const board = await seedBoard(db);
    await seedUser(db, 'user-owner');
    const artifactRepo = new ArtifactRepository(db);
    const created = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: board.board_id,
      name: 'secret-dom',
      template: 'react',
      files: { '/index.js': 'document.body.textContent = import.meta.env.VITE_FAKE_SECRET' },
      required_env_vars: ['FAKE_SECRET'],
      public: true,
      created_by: 'user-owner',
    });
    await service.grantTrust({
      userId: 'user-owner',
      artifactId: created.artifact_id,
      scopeType: 'artifact',
      allowIntrospection: false,
    });

    await expect(
      service.queryArtifactRuntime({
        artifactId: created.artifact_id,
        userId: 'user-owner',
        kind: 'document_html',
        args: {},
      })
    ).rejects.toThrow(/separate DOM-to-agent consent/i);
  });
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

describe('ArtifactsService.find SQL pushdown', () => {
  async function seedPushdownFixture(db: Database) {
    const boardA = (await seedBoard(db)).board_id as BoardID;
    const boardB = (await seedBoard(db)).board_id as BoardID;
    const branch1 = (await seedRepoAndBranch(db, '/tmp/artifact-branch-1')).branch_id as BranchID;
    const branch2 = (await seedRepoAndBranch(db, '/tmp/artifact-branch-2')).branch_id as BranchID;
    const artifactRepo = new ArtifactRepository(db);
    const files = { '/index.js': 'console.log("hi")' };

    // boardA: branch1, branch2, and an orphan (null branch_id).
    const onBranch1 = await artifactRepo.create({
      artifact_id: generateId(),
      board_id: boardA,
      branch_id: branch1,
      name: 'a-branch1',
      files,
    });
    await artifactRepo.create({
      artifact_id: generateId(),
      board_id: boardA,
      branch_id: branch2,
      name: 'a-branch2',
      files,
    });
    await artifactRepo.create({
      artifact_id: generateId(),
      board_id: boardA,
      branch_id: null,
      name: 'a-orphan',
      files,
    });
    // boardB: branch1 — must be excluded by a boardA-scoped query.
    await artifactRepo.create({
      artifact_id: generateId(),
      board_id: boardB,
      branch_id: branch1,
      name: 'b-branch1',
      files,
    });

    const service = new ArtifactsService(db, makeFakeApp());
    return { service, boardA, boardB, branch1, branch2, onBranch1 };
  }

  dbTest('pushes board_id into the repository read (rbac off)', async ({ db }) => {
    const { service, boardA } = await seedPushdownFixture(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
      'findAll'
    );

    const result = (await service.find({ query: { board_id: boardA } })) as {
      data: Artifact[];
      total: number;
    };

    // SQL-bounded: the board predicate reaches the repository, not a whole-table read.
    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA });
    // boardA has 3 artifacts (branch1, branch2, orphan).
    expect(result.total).toBe(3);
    expect(result.data.every((a) => a.board_id === boardA)).toBe(true);
    // Per-row enrichment ran on the reduced set (rowToArtifact populates files).
    expect(result.data.every((a) => a.files !== undefined)).toBe(true);
  });

  dbTest(
    'pushes board_id + accessible branch_id $in and excludes orphans (rbac on)',
    async ({ db }) => {
      const { service, boardA, branch1, onBranch1 } = await seedPushdownFixture(db);
      const repoFindAll = vi.spyOn(
        (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
        'findAll'
      );

      const result = (await service.find({
        query: { board_id: boardA, branch_id: { $in: [branch1] } },
      })) as { data: Artifact[]; total: number };

      expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA, branchIds: [branch1] });
      // Only the boardA + branch1 artifact survives; branch2 and the orphan are excluded.
      expect(result.total).toBe(1);
      expect(result.data.map((a) => a.artifact_id)).toEqual([onBranch1.artifact_id]);
    }
  );

  dbTest('pushes a scalar branch_id as a single-id set', async ({ db }) => {
    const { service, branch1 } = await seedPushdownFixture(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
      'findAll'
    );

    const result = (await service.find({ query: { branch_id: branch1 } })) as {
      data: Artifact[];
      total: number;
    };

    expect(repoFindAll).toHaveBeenCalledWith({ branchIds: [branch1] });
    // branch1 has artifacts on both boardA and boardB.
    expect(result.total).toBe(2);
  });

  dbTest(
    'returns no rows for an empty accessible set without reading the table',
    async ({ db }) => {
      const { service } = await seedPushdownFixture(db);
      const repoFindAll = vi.spyOn(
        (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
        'findAll'
      );

      const result = (await service.find({ query: { branch_id: { $in: [] } } })) as {
        data: Artifact[];
        total: number;
      };

      expect(repoFindAll).toHaveBeenCalledWith({ branchIds: [] });
      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
    }
  );

  dbTest('pushes the RBAC SQL visibility marker into the repository read', async ({ db }) => {
    const { service, boardA } = await seedPushdownFixture(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
      'findAll'
    );

    await service.find({
      _agorSqlBranchAccessUserId: 'viewer-1' as UUID,
      query: { board_id: boardA },
    });

    expect(repoFindAll).toHaveBeenCalledWith({
      board_id: boardA,
      visibleToUserId: 'viewer-1',
    });
  });

  // branch_id is nullable: a `{ $in }` containing a non-string element must NOT
  // be pushed, because SQL `IN (NULL)` never matches an orphan's null branch_id
  // while the JS `includes` path does. Pushing it would return a SUBSET.
  dbTest('does NOT push a $in containing null — orphans stay visible', async ({ db }) => {
    const { service } = await seedPushdownFixture(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
      'findAll'
    );

    const result = (await service.find({
      query: { branch_id: { $in: [null as unknown as BranchID] } },
    })) as { data: Artifact[]; total: number };

    // Fell through to the whole-table read (no branchIds pushed); filterData
    // applied the $in in JS, which matches the orphan's null branch_id.
    expect(repoFindAll).toHaveBeenCalledWith({});
    expect(result.data.map((a) => a.name)).toEqual(['a-orphan']);
    expect(result.data.every((a) => a.branch_id === null)).toBe(true);
  });

  dbTest('does NOT push a mixed null + string $in — orphans stay visible', async ({ db }) => {
    const { service, branch1 } = await seedPushdownFixture(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { artifactRepo: ArtifactRepository }).artifactRepo,
      'findAll'
    );

    const result = (await service.find({
      query: { branch_id: { $in: [null as unknown as BranchID, branch1] } },
    })) as { data: Artifact[]; total: number };

    // Whole-table fall-through; JS $in matches the orphan AND both branch1 rows.
    expect(repoFindAll).toHaveBeenCalledWith({});
    expect(result.data.map((a) => a.name).sort()).toEqual(['a-branch1', 'a-orphan', 'b-branch1']);
  });
});
