/**
 * BoardsService Tests
 *
 * Basic tests to verify custom export/import/clone methods are properly wired up.
 */

import {
  BoardObjectRepository,
  BranchRepository,
  type Database,
  generateId,
  RepoRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Board, BranchID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BoardsService } from './boards';

const TEST_USER = 'test-user' as UUID;
const TEST_PARAMS = { user: { user_id: TEST_USER } } as never;

async function ensureTestUser(db: Database) {
  const users = new UsersRepository(db);
  await users.create({
    user_id: TEST_USER,
    email: 'test-user@example.com',
    name: 'Test User',
    role: 'member',
  });
}

function createRepoData(overrides?: { repo_id?: UUID; slug?: string }) {
  const slug = overrides?.slug ?? `test-repo-${generateId()}`;
  return {
    repo_id: overrides?.repo_id ?? generateId(),
    slug,
    name: slug,
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/home/user/.agor/repos/${slug}`,
    default_branch: 'main',
  };
}

function createBranchData(overrides?: { branch_id?: BranchID; repo_id?: UUID; name?: string }) {
  const name = overrides?.name ?? `feature-${generateId()}`;
  return {
    branch_id: overrides?.branch_id ?? (generateId() as BranchID),
    repo_id: overrides?.repo_id ?? (generateId() as UUID),
    name,
    ref: `refs/heads/${name}`,
    branch_unique_id: 1,
    path: `/home/user/.agor/repos/test-repo/${name}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: TEST_USER,
  };
}

describe('BoardsService - Custom Methods', () => {
  dbTest('toBlob should export board to JSON blob', async ({ db }) => {
    const service = new BoardsService(db);

    // Create a test board
    const board = (await service.create({
      name: 'Test Board',
      slug: 'test-board',
      description: 'Board for testing export',
      icon: '🧪',
      created_by: TEST_USER,
    })) as Board;

    // Export to blob
    const blob = await service.toBlob(board.board_id);

    expect(blob).toHaveProperty('name');
    expect(blob.name).toBe('Test Board');
    expect(blob.slug).toBe('test-board');
    expect(blob.icon).toBe('🧪');
  });

  dbTest('toBlob should accept slug identifiers', async ({ db }) => {
    const service = new BoardsService(db);

    await service.create({
      name: 'Slug Export Board',
      slug: 'slug-export',
      created_by: TEST_USER,
    });

    const blob = await service.toBlob('slug-export');

    expect(blob.name).toBe('Slug Export Board');
    expect(blob.slug).toBe('slug-export');
  });

  dbTest('fromBlob should import board from JSON blob', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    // Create and export a board
    const original = (await service.create({
      name: 'Original Board',
      slug: 'original-board',
      icon: '🔷',
      created_by: TEST_USER,
    })) as Board;

    const blob = await service.toBlob(original.board_id);

    // Modify blob and import
    blob.name = 'Imported Board';
    blob.slug = 'imported-board';

    const imported = await service.fromBlob(blob, TEST_PARAMS);

    expect(imported.name).toBe('Imported Board');
    expect(imported.slug).toBe('imported-board');
    expect(imported.board_id).not.toBe(original.board_id);
    expect(imported.icon).toBe('🔷'); // Icon should be preserved
  });

  dbTest('toYaml should export board to YAML string', async ({ db }) => {
    const service = new BoardsService(db);

    const board = (await service.create({
      name: 'YAML Board',
      slug: 'yaml-board',
      icon: '📄',
      created_by: TEST_USER,
    })) as Board;

    const yaml = await service.toYaml(board.board_id);

    expect(typeof yaml).toBe('string');
    expect(yaml).toContain('name: YAML Board');
    expect(yaml).toContain('slug: yaml-board');
    expect(yaml).toContain('icon: 📄');
  });

  dbTest('fromYaml should import board from YAML string', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    // Create and export to YAML
    const original = (await service.create({
      name: 'Original YAML Board',
      slug: 'original-yaml',
      description: 'Test description',
      created_by: TEST_USER,
    })) as Board;

    const yaml = await service.toYaml(original.board_id);

    // Modify YAML and import
    const modifiedYaml = yaml
      .replace('name: Original YAML Board', 'name: Imported YAML Board')
      .replace('slug: original-yaml', 'slug: imported-yaml');

    const imported = await service.fromYaml(modifiedYaml, TEST_PARAMS);

    expect(imported.name).toBe('Imported YAML Board');
    expect(imported.slug).toBe('imported-yaml');
    expect(imported.board_id).not.toBe(original.board_id);
    expect(imported.description).toBe('Test description'); // Preserved from YAML
  });

  dbTest('clone should create a copy with new name', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    const original = (await service.create({
      name: 'Original Board',
      slug: 'original',
      description: 'To be cloned',
      icon: '🔵',
      created_by: TEST_USER,
    })) as Board;

    const cloned = await service.clone(original.board_id, 'Cloned Board', TEST_PARAMS);

    expect(cloned.name).toBe('Cloned Board');
    expect(cloned.slug).toBe('cloned-board');
    expect(cloned.board_id).not.toBe(original.board_id);
    expect(cloned.icon).toBe(original.icon);
    expect(cloned.description).toBe(original.description);
  });

  dbTest('clone should accept slug identifiers', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    await service.create({
      name: 'Slug Clone Source',
      slug: 'slug-source',
      created_by: TEST_USER,
    });

    const cloned = await service.clone('slug-source', 'Slug Clone Target', TEST_PARAMS);

    expect(cloned.name).toBe('Slug Clone Target');
    expect(cloned.slug).toBe('slug-clone-target');
  });

  dbTest(
    'removeBoardObject clears zone-pinned entities with absolute positions',
    async ({ db }) => {
      const emitBoardObjectPatched = vi.fn();
      const service = new BoardsService(db, emitBoardObjectPatched);
      const repoRepo = new RepoRepository(db);
      const branchRepo = new BranchRepository(db);
      const boardObjectRepo = new BoardObjectRepository(db);

      const repo = await repoRepo.create(createRepoData());
      const branch = await branchRepo.create(createBranchData({ repo_id: repo.repo_id }));
      const board = (await service.create({
        name: 'Zone Cleanup Board',
        slug: `zone-cleanup-${generateId()}`,
        created_by: TEST_USER,
        objects: {
          'zone-review': {
            type: 'zone',
            x: 100,
            y: 200,
            width: 400,
            height: 300,
            label: 'Review',
          },
        },
      })) as Board;

      const boardObject = await boardObjectRepo.create({
        board_id: board.board_id,
        branch_id: branch.branch_id,
        position: { x: 10, y: 20 },
        zone_id: 'zone-review',
      });

      await service.removeBoardObject(board.board_id, 'zone-review');

      const updatedBoardObject = await boardObjectRepo.findByObjectId(boardObject.object_id);
      expect(updatedBoardObject?.zone_id).toBeUndefined();
      expect(updatedBoardObject?.position).toEqual({ x: 110, y: 220 });
      expect(emitBoardObjectPatched).toHaveBeenCalledWith(
        expect.objectContaining({
          object_id: boardObject.object_id,
          position: { x: 110, y: 220 },
          zone_id: null,
        })
      );
    }
  );

  dbTest(
    'ensureAssistantWelcomeNote creates rendered static markdown server-side',
    async ({ db }) => {
      const service = new BoardsService(db);
      const board = (await service.create({
        name: 'Assistant Board',
        slug: `assistant-board-${generateId()}`,
        created_by: TEST_USER,
      })) as Board;

      const params = {};
      const updated = await service.ensureAssistantWelcomeNote(
        {
          boardId: board.board_id,
          assistantName: '<img src=x onerror=alert(1)>',
          assistantEmoji: '🤖',
        },
        params
      );

      const note = updated.objects?.['welcome-note'];
      expect(params).toEqual({ assistantWelcomeNoteMutated: true });
      expect(note?.type).toBe('markdown');
      expect(note?.content).not.toContain('{{assistant.name}}');
      expect(note?.content).not.toContain('<img src=x onerror=alert(1)>');
      expect(note?.content).toContain('&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;');
      expect(note?.content).toContain('🤖');
    }
  );

  dbTest(
    'ensureAssistantWelcomeNote is a no-op when welcome note already exists',
    async ({ db }) => {
      const service = new BoardsService(db);
      const board = (await service.create({
        name: 'Assistant Board Existing Note',
        slug: `assistant-board-existing-${generateId()}`,
        created_by: TEST_USER,
        objects: {
          'welcome-note': {
            type: 'markdown',
            x: 12,
            y: 34,
            width: 456,
            content: '# Welcome to {{assistant.name}}',
          },
        },
      })) as Board;

      const params = {};
      const updated = await service.ensureAssistantWelcomeNote(
        {
          boardId: board.board_id,
          assistantName: 'Ignored Bot',
          assistantEmoji: '🛠️',
        },
        params
      );

      expect(params).toEqual({});
      expect(updated.objects?.['welcome-note']).toEqual(board.objects?.['welcome-note']);
    }
  );

  dbTest('ensureAssistantWelcomeNote preserves custom existing welcome notes', async ({ db }) => {
    const service = new BoardsService(db);
    const board = (await service.create({
      name: 'Assistant Board Custom',
      slug: `assistant-board-custom-${generateId()}`,
      created_by: TEST_USER,
      objects: {
        'welcome-note': {
          type: 'markdown',
          x: 1,
          y: 2,
          width: 300,
          content: 'My custom welcome note',
        },
      },
    })) as Board;

    const params = {};
    const updated = await service.ensureAssistantWelcomeNote(
      {
        boardId: board.board_id,
        assistantName: 'Ignored Bot',
      },
      params
    );

    expect(params).toEqual({});
    expect(updated.objects?.['welcome-note']).toEqual(board.objects?.['welcome-note']);
  });

  dbTest('should have all custom methods defined', async ({ db }) => {
    const service = new BoardsService(db);

    // Verify methods exist and are functions
    expect(typeof service.toBlob).toBe('function');
    expect(typeof service.fromBlob).toBe('function');
    expect(typeof service.toYaml).toBe('function');
    expect(typeof service.fromYaml).toBe('function');
    expect(typeof service.clone).toBe('function');
    expect(typeof service.ensureAssistantWelcomeNote).toBe('function');
  });
});
