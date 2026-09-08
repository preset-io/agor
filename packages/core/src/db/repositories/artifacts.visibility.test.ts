import type { Logger } from 'drizzle-orm/logger';
import { describe, expect, vi } from 'vitest';
import { generateId, shortId } from '../../lib/ids';
import type { UUID } from '../../types';
import { insert } from '../database-wrapper';
import { artifacts } from '../schema';
import { createTenantScopedDatabaseProxy } from '../tenant-scope';
import { ownedDbTest as dbTest } from '../test-helpers';
import { ArtifactRepository } from './artifacts';
import { BoardRepository } from './boards';

describe('ArtifactRepository board visibility projection', () => {
  dbTest('replaces 84 artifact SELECTs with two bounded minimal queries', async ({ db }) => {
    const board = await new BoardRepository(db).create({
      name: 'visibility',
      created_by: 'test-user',
    });
    const ids = Array.from({ length: 72 }, () => generateId());
    await insert(db, artifacts)
      .values(
        ids.map((artifact_id) => ({
          artifact_id,
          board_id: board.board_id,
          name: 'payload',
          public: true,
          files: { '/index.ts': 'source must not be selected' },
          created_at: new Date(),
          updated_at: new Date(),
        }))
      )
      .run();
    const refs = [...ids, ...ids.slice(0, 6).map(shortId)];
    const logger = (db as unknown as { session: { logger: Logger } }).session.logger;
    const queries = vi.spyOn(logger, 'logQuery');
    const repo = new ArtifactRepository(db);

    // Record the old caller path as an executable before/after comparison.
    for (const ref of refs) await repo.findById(ref);
    expect(queries).toHaveBeenCalledTimes(84); // 72 exact + 6 (resolve + full read)
    queries.mockClear();
    const visible = await repo.findBoardReferenceVisibleIds([...refs, ...refs], 'test-user');
    expect(visible).toEqual(new Set(refs));
    expect(queries).toHaveBeenCalledTimes(2);
    for (const [query] of queries.mock.calls) {
      expect(query).not.toMatch(
        /\b(files|agor_runtime|sandpack_config|dependencies|required_env_vars|agor_grants)\b/
      );
      expect(query).not.toMatch(/select\s+\*/i);
      expect(query).not.toMatch(/\b(name|description|board_id|branch_id|created_at|updated_at)\b/);
    }
    queries.mockClear();
    expect(await repo.findBoardReferenceVisibleIds([], 'test-user')).toEqual(new Set());
    expect(queries).not.toHaveBeenCalled();
  });

  dbTest(
    'fails closed for missing/invalid/ambiguous references before applying visibility',
    async ({ db }) => {
      const board = await new BoardRepository(db).create({
        name: 'visibility',
        created_by: 'test-user',
      });
      const repo = new ArtifactRepository(db);
      const publicId = generateId();
      // Deliberately retain one shared prefix; neither visibility nor ownership
      // may turn this two-row reference into an unambiguous result.

      const privateId = publicId.replace(/.$/, publicId.endsWith('0') ? '1' : '0') as UUID;
      await repo.create({ artifact_id: publicId, board_id: board.board_id, public: true });
      await repo.create({
        artifact_id: privateId,
        board_id: board.board_id,
        public: false,
        created_by: 'test-user' as UUID,
      });
      const ownPrefix = privateId.replace(/-/g, '');
      const ambiguous = shortId(publicId);
      const refs = [publicId, privateId, ownPrefix, ambiguous, generateId(), 'missing', '%', '_'];
      expect(await repo.findBoardReferenceVisibleIds(refs, 'test-user')).toEqual(
        new Set([publicId, privateId, ownPrefix])
      );
      expect(await repo.findBoardReferenceVisibleIds(refs, 'another-user')).toEqual(
        new Set([publicId])
      );
      expect(await repo.findBoardReferenceVisibleIds(refs)).toEqual(new Set([publicId]));
      expect(
        await repo.findBoardReferenceVisibleIds([ownPrefix.toUpperCase()], 'test-user')
      ).toEqual(new Set([ownPrefix.toUpperCase()]));
      // Preserve the old DTO comparison for internal callers with no user;
      // normal authenticated callers cannot see an ownerless private artifact.
      const ownerless = await repo.create({ board_id: board.board_id, public: false });
      expect(await repo.findBoardReferenceVisibleIds([ownerless.artifact_id], 'test-user')).toEqual(
        new Set()
      );
      expect(await repo.findBoardReferenceVisibleIds([ownerless.artifact_id])).toEqual(
        new Set([ownerless.artifact_id])
      );
    }
  );

  dbTest('chunks identifiers and denies failed chunks', async ({ db }) => {
    const logger = (db as unknown as { session: { logger: Logger } }).session.logger;
    const queries = vi.spyOn(logger, 'logQuery');
    const repo = new ArtifactRepository(db);
    expect(
      await repo.findBoardReferenceVisibleIds(Array.from({ length: 401 }, () => generateId()))
    ).toEqual(new Set());
    expect(queries).toHaveBeenCalledTimes(3);
    queries.mockClear();
    const prefixes = Array.from({ length: 101 }, () => shortId(generateId()));
    expect(await repo.findBoardReferenceVisibleIds([...prefixes, ...prefixes])).toEqual(new Set());
    expect(queries).toHaveBeenCalledTimes(2);
    expect(queries.mock.calls.every(([query]) => query.includes('LIMIT 2'))).toBe(true);
    queries.mockImplementationOnce(() => {
      throw new Error('read unavailable');
    });
    expect(await repo.findBoardReferenceVisibleIds([generateId()])).toEqual(new Set());
    const guarded = new ArtifactRepository(createTenantScopedDatabaseProxy(db));
    for (const id of [generateId(), shortId(generateId())]) {
      await expect(guarded.findBoardReferenceVisibleIds([id])).rejects.toThrow(
        'Missing tenant database scope'
      );
    }
  });

  for (const kind of ['exact', 'prefix'] as const) {
    dbTest(
      `retains successful ${kind} chunks before and after a failed chunk without retries`,
      async ({ db }) => {
        const board = await new BoardRepository(db).create({
          name: 'chunk failure',
          created_by: 'test-user',
        });
        const chunkSize = kind === 'exact' ? 200 : 100;
        const ids = Array.from({ length: chunkSize * 2 + 1 }, () => generateId());
        const presentIds = [ids[0], ids[chunkSize], ids[chunkSize * 2]];
        await insert(db, artifacts)
          .values(
            presentIds.map((artifact_id) => ({
              artifact_id,
              board_id: board.board_id,
              name: 'public',
              public: true,
              created_at: new Date(),
              updated_at: new Date(),
            }))
          )
          .run();
        const refs = kind === 'exact' ? ids : ids.map(shortId);
        const logger = (db as unknown as { session: { logger: Logger } }).session.logger;
        const queries = vi
          .spyOn(logger, 'logQuery')
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error('middle chunk unavailable');
          })
          .mockImplementationOnce(() => undefined);
        expect(
          await new ArtifactRepository(db).findBoardReferenceVisibleIds(refs, 'test-user')
        ).toEqual(new Set([refs[0], refs[chunkSize * 2]]));
        expect(queries).toHaveBeenCalledTimes(3);
      }
    );
  }
});
