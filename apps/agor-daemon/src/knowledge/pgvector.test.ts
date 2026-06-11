import type { Database } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';
import { ensureKnowledgePgvectorStorage, getKnowledgePgvectorCapability } from './pgvector';

function fakePostgresDb(execute: (query: unknown) => unknown | Promise<unknown>): Database {
  return {
    execute,
  } as unknown as Database;
}

describe('Knowledge pgvector capability detection', () => {
  it('treats postgres-js array results as available when extension and storage exist', async () => {
    const db = fakePostgresDb(() => [
      {
        extension_installed: true,
        extension_available: true,
        table_ready: true,
        space_index_ready: true,
        hnsw_index_ready: true,
      },
    ]);

    await expect(getKnowledgePgvectorCapability(db)).resolves.toMatchObject({
      available: true,
      extensionInstalled: true,
      extensionAvailable: true,
      storageReady: true,
      reason: null,
    });
  });

  it('does not throw when CREATE EXTENSION is denied', async () => {
    let calls = 0;
    const execute = vi.fn(() => {
      calls += 1;
      if (calls === 2) throw new Error('permission denied');
      return [
        {
          extension_installed: false,
          extension_available: true,
          table_ready: false,
          space_index_ready: false,
          hnsw_index_ready: false,
        },
      ];
    });
    const db = fakePostgresDb(execute);

    await expect(ensureKnowledgePgvectorStorage(db)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('permission denied'),
      setupHint: expect.stringContaining('CREATE EXTENSION vector'),
    });
  });

  it('does not issue CREATE statements when pgvector storage objects already exist', async () => {
    const execute = vi.fn(() => [
      {
        extension_installed: true,
        extension_available: true,
        table_ready: true,
        space_index_ready: true,
        hnsw_index_ready: true,
      },
    ]);
    const db = fakePostgresDb(execute);

    await expect(ensureKnowledgePgvectorStorage(db)).resolves.toMatchObject({
      available: true,
      storageReady: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
