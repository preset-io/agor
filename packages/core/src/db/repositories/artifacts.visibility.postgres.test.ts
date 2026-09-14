import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId, shortId } from '../../lib/ids';
import type { UUID } from '../../types';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import * as schema from '../schema.postgres';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from '../tenant-scope';
import { ArtifactRepository } from './artifacts';
import { BoardRepository } from './boards';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'board artifact visibility projection (PostgreSQL RLS)',
  () => {
    let db: Database;
    let client: ReturnType<typeof postgres>;
    let capture = false;
    let failQueryNumber: number | undefined;
    const queries: string[] = [];
    beforeAll(async () => {
      const raw = createDatabase({ dialect: 'postgresql', url: url! });
      client = (raw as unknown as { $client: ReturnType<typeof postgres> }).$client;
      db = drizzle(client, {
        schema,
        logger: {
          logQuery(query) {
            if (capture) {
              queries.push(query);
              // A client-side failure before dispatch leaves the PostgreSQL
              // transaction usable. Server transaction aborts are not recovery
              // promises of this projection; later chunks then fail closed too.
              if (queries.length === failQueryNumber) throw new Error('middle chunk unavailable');
            }
          },
        },
      });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await client?.end();
    });

    it('keeps full/prefix/public/creator reads tenant-bound and resolves ambiguity before visibility', async () => {
      const tenantA = `artifact-a-${generateId()}`;
      const tenantB = `artifact-b-${generateId()}`;
      const ownerAId = generateId();
      const ownerBId = generateId();
      const uniqueId = generateId();
      // A foreign same-prefix row must not make A's unique prefix ambiguous.

      const foreignCollision = uniqueId.replace(/.$/, uniqueId.endsWith('0') ? '1' : '0') as UUID;
      const foreignId = generateId();
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          user_id: ownerBId,
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const board = await new BoardRepository(scoped).create({
          name: 'foreign',
          created_by: owner.user_id,
        });
        const repo = new ArtifactRepository(scoped);
        for (const artifact_id of [foreignId, foreignCollision]) {
          await repo.create({
            artifact_id,
            board_id: board.board_id,
            public: true,
            created_by: owner.user_id,
          });
        }
      });
      const guarded = createTenantScopedDatabaseProxy(db);
      const repo = new ArtifactRepository(guarded);
      await expect(repo.findBoardReferenceVisibleIds([foreignId])).rejects.toThrow();
      await runWithTenantDatabaseScope(guarded, tenantA, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          user_id: ownerAId,
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const board = await new BoardRepository(scoped).create({
          name: 'local',
          created_by: owner.user_id,
        });
        const publicId = generateId();

        const privateId = publicId.replace(/.$/, publicId.endsWith('0') ? '1' : '0') as UUID;
        await repo.create({ artifact_id: uniqueId, board_id: board.board_id, public: true });
        await repo.create({ artifact_id: publicId, board_id: board.board_id, public: true });
        await repo.create({
          artifact_id: privateId,
          board_id: board.board_id,
          public: false,
          created_by: owner.user_id,
        });
        const uniquePrefix = shortId(uniqueId);
        const ambiguous = shortId(publicId);
        const refs = [
          uniqueId,
          uniquePrefix,
          publicId,
          privateId,
          ambiguous,
          foreignId,
          shortId(foreignId),
          foreignCollision,
        ];
        capture = true;
        try {
          expect(await repo.findBoardReferenceVisibleIds(refs, owner.user_id)).toEqual(
            new Set([uniqueId, uniquePrefix, publicId, privateId])
          );
        } finally {
          capture = false;
        }
        expect(queries).toHaveLength(2);
        expect(queries.join('\n')).not.toMatch(
          /\b(files|agor_runtime|sandpack_config|dependencies|required_env_vars|agor_grants)\b/
        );
        expect(await repo.findBoardReferenceVisibleIds(refs, generateId())).toEqual(
          new Set([uniqueId, uniquePrefix, publicId])
        );
      });
    });

    it('retains successful chunks around a recoverable client-side read failure', async () => {
      await runWithTenantDatabaseScope(db, `artifact-chunks-${generateId()}`, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          user_id: generateId(),
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const board = await new BoardRepository(scoped).create({
          name: 'chunks',
          created_by: owner.user_id,
        });
        const repo = new ArtifactRepository(scoped);
        const ids = Array.from({ length: 401 }, () => generateId());
        for (const artifact_id of [ids[0], ids[200], ids[400]]) {
          await repo.create({ artifact_id, board_id: board.board_id, public: true });
        }
        queries.length = 0;
        failQueryNumber = 2;
        capture = true;
        try {
          expect(await repo.findBoardReferenceVisibleIds(ids, owner.user_id)).toEqual(
            new Set([ids[0], ids[400]])
          );
          expect(queries).toHaveLength(3);
        } finally {
          capture = false;
          failQueryNumber = undefined;
        }
      });
    });
  }
);
