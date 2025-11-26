/**
 * BoardsService Tests
 *
 * Basic tests to verify custom export/import/clone methods are properly wired up.
 */

import type { Board } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BoardsService } from './boards';

describe('BoardsService - Custom Methods', () => {
  dbTest('toBlob should export board to JSON blob', async ({ db }) => {
    const service = new BoardsService(db);

    // Create a test board
    const board = (await service.create({
      name: 'Test Board',
      slug: 'test-board',
      description: 'Board for testing export',
      icon: '🧪',
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
    });

    const blob = await service.toBlob('slug-export');

    expect(blob.name).toBe('Slug Export Board');
    expect(blob.slug).toBe('slug-export');
  });

  dbTest('fromBlob should import board from JSON blob', async ({ db }) => {
    const service = new BoardsService(db);

    // Create and export a board
    const original = (await service.create({
      name: 'Original Board',
      slug: 'original-board',
      icon: '🔷',
    })) as Board;

    const blob = await service.toBlob(original.board_id);

    // Modify blob and import
    blob.name = 'Imported Board';
    blob.slug = 'imported-board';

    const imported = await service.fromBlob(blob);

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
    })) as Board;

    const yaml = await service.toYaml(board.board_id);

    expect(typeof yaml).toBe('string');
    expect(yaml).toContain('name: YAML Board');
    expect(yaml).toContain('slug: yaml-board');
    expect(yaml).toContain('icon: 📄');
  });

  dbTest('fromYaml should import board from YAML string', async ({ db }) => {
    const service = new BoardsService(db);

    // Create and export to YAML
    const original = (await service.create({
      name: 'Original YAML Board',
      slug: 'original-yaml',
      description: 'Test description',
    })) as Board;

    const yaml = await service.toYaml(original.board_id);

    // Modify YAML and import
    const modifiedYaml = yaml
      .replace('name: Original YAML Board', 'name: Imported YAML Board')
      .replace('slug: original-yaml', 'slug: imported-yaml');

    const imported = await service.fromYaml(modifiedYaml);

    expect(imported.name).toBe('Imported YAML Board');
    expect(imported.slug).toBe('imported-yaml');
    expect(imported.board_id).not.toBe(original.board_id);
    expect(imported.description).toBe('Test description'); // Preserved from YAML
  });

  dbTest('clone should create a copy with new name', async ({ db }) => {
    const service = new BoardsService(db);

    const original = (await service.create({
      name: 'Original Board',
      slug: 'original',
      description: 'To be cloned',
      icon: '🔵',
    })) as Board;

    const cloned = await service.clone(original.board_id, 'Cloned Board');

    expect(cloned.name).toBe('Cloned Board');
    expect(cloned.slug).toBe('cloned-board');
    expect(cloned.board_id).not.toBe(original.board_id);
    expect(cloned.icon).toBe(original.icon);
    expect(cloned.description).toBe(original.description);
  });

  dbTest('clone should accept slug identifiers', async ({ db }) => {
    const service = new BoardsService(db);

    await service.create({
      name: 'Slug Clone Source',
      slug: 'slug-source',
    });

    const cloned = await service.clone('slug-source', 'Slug Clone Target');

    expect(cloned.name).toBe('Slug Clone Target');
    expect(cloned.slug).toBe('slug-clone-target');
  });

  dbTest('should have all custom methods defined', async ({ db }) => {
    const service = new BoardsService(db);

    // Verify methods exist and are functions
    expect(typeof service.toBlob).toBe('function');
    expect(typeof service.fromBlob).toBe('function');
    expect(typeof service.toYaml).toBe('function');
    expect(typeof service.fromYaml).toBe('function');
    expect(typeof service.clone).toBe('function');
  });
});
