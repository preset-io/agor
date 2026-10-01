/** v0.25.2's journal/SQL through 0087 is byte-identical to the current prefix. */
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { checkMigrationStatus, runMigrations } from './migrate';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const folder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  '0.25.2 offline upgrade preserves ownership and tenant data',
  () => {
    let db: Database;
    let client: Sql;
    let oldFolder: string;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url!, pool: { max: 1 } });
      client = (db as Database & { $client: Sql }).$client;
      expect(
        await client`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`
      ).toMatchObject([{ rolsuper: false, rolbypassrls: false }]);
      oldFolder = await mkdtemp(join(tmpdir(), 'agor-0252-upgrade-'));
      await cp(folder, oldFolder, { recursive: true });
      const journalPath = join(oldFolder, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      journal.entries = journal.entries.filter(({ idx }) => idx <= 87);
      expect(journal.entries.at(-1)).toMatchObject({
        tag: '0087_knowledge_teammate_attribution',
        when: 1787184000000,
      });
      // Pin the shipped order, tags, watermarks and exact SQL, not just the last
      // watermark. Derived from v0.25.2 (ca14396c), not today's migration files.
      // If a historical repair changes this prefix, preserve an archived fixture
      // rather than updating the digest and silently testing a different history.
      const history = await Promise.all(
        journal.entries.map(async ({ idx, tag, when }) => [
          idx,
          tag,
          when,
          createHash('sha256')
            .update(await readFile(join(oldFolder, `${tag}.sql`)))
            .digest('hex'),
        ])
      );
      expect(createHash('sha256').update(JSON.stringify(history)).digest('hex')).toBe(
        '92cd3a9a067b411bd45d0d40c2ca2c06a47ec409adb10c102fc8a09c79a02c0e'
      );
      await writeFile(journalPath, JSON.stringify(journal));
      await migratePostgres(db as never, { migrationsFolder: oldFolder });
      // Every fixture write uses its own tenant context, never an RLS bypass.
      for (const tenant of ['a', 'b']) {
        await client`SELECT set_config('agor.tenant_id', ${tenant}, false)`;
        await client`INSERT INTO users (tenant_id,user_id,created_at,email,password,role,data)
          VALUES (${tenant},${`${tenant}-admin-z`},'2020-01-01',${`${tenant}-z@test`},'unused',${tenant === 'a' ? 'admin' : 'viewer'},'{}'),
                 (${tenant},${`${tenant}-admin-a`},'2020-01-01',${`${tenant}-a@test`},'unused',${tenant === 'a' ? 'admin' : 'viewer'},'{}'),
                 (${tenant},${`${tenant}-superadmin`},'2021-01-01',${`${tenant}-s@test`},'unused','superadmin','{}'),
                 (${tenant},${`${tenant}-member`},'2019-01-01',${`${tenant}-m@test`},'unused','member','{}')`;
        await client`INSERT INTO boards (tenant_id,board_id,created_at,created_by,name,slug,data)
          VALUES (${tenant},${`${tenant}-orphan`},now(),'anonymous','Customized board','custom','{"retained":42}'),
                 (${tenant},${`${tenant}-creator`},now(),${`${tenant}-member`},'Creator board','creator','{}'),
                 (${tenant},${`${tenant}-owned`},now(),${`${tenant}-admin-a`},'Owned board','owned','{}')`;
        await client`INSERT INTO board_owners (tenant_id,board_id,user_id,created_at)
          VALUES (${tenant},${`${tenant}-owned`},${`${tenant}-member`},now())`;
        await client`INSERT INTO repos (tenant_id,repo_id,created_at,slug,data) VALUES (${tenant},${`${tenant}-repo`},now(),'test/repo','{}')`;
        await client`INSERT INTO branches (tenant_id,branch_id,created_at,created_by,name,ref,branch_unique_id,board_id,repo_id,data)
          VALUES (${tenant},${`${tenant}-branch`},now(),'missing','Retained branch','main',${tenant === 'a' ? 1 : 2},${`${tenant}-orphan`},${`${tenant}-repo`},'{"retained":"branch"}')`;
      }
      await client`SELECT set_config('agor.tenant_id', 'default', false)`;
      await client`INSERT INTO boards (board_id,created_at,created_by,name,slug,data)
        VALUES ('seed',now(),'anonymous','Main Board','default','{}'),
               ('used',now(),'anonymous','Customized seed','used','{"retained":true}')`;
      await client`INSERT INTO board_comments
        (comment_id,board_id,created_at,created_by,content,content_preview,data)
        VALUES ('comment','used',now(),'anonymous','Keep this content','Keep this content','{}')`;
    });
    afterAll(async () => {
      if (client) await client.end();
      if (oldFolder) await rm(oldFolder, { recursive: true, force: true });
    });

    it('rolls back and identifies zero-user tenants; explicit attribution then permits retry without deleting anything', async () => {
      const ledger = await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
      const boards = await client`SELECT * FROM boards ORDER BY board_id`;
      const comments = await client`SELECT * FROM board_comments`;
      const before = await checkMigrationStatus(db);
      expect(before.pending[0]).toBe('0088_session_recent_index');
      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      // Other tenants have admins, but neither a pristine seed nor a used board
      // in the zero-user default tenant may borrow one or be discarded.
      for (let attempt = 0; attempt < 2; attempt++) {
        let failure: unknown;
        try {
          await runMigrations(db, { allowOfflineCutover: true });
        } catch (error) {
          failure = error;
        }
        const chain: string[] = [];
        while (failure instanceof Error) {
          chain.push(failure.message);
          failure = failure.cause;
        }
        expect(chain.join('\n')).toMatch(/tenant=default.*board:seed/);
        expect(chain.join('\n')).toContain('board:used');
        expect(await client`SELECT * FROM boards ORDER BY board_id`).toEqual(boards);
        expect(await client`SELECT * FROM board_comments`).toEqual(comments);
        expect(await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(
          ledger
        );
        expect(await checkMigrationStatus(db)).toEqual(before);
        expect(
          await client`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='boards' AND column_name='primary_owner_user_id'`
        ).toHaveLength(0);
        expect(
          await client`SELECT relforcerowsecurity FROM pg_class WHERE oid='public.boards'::regclass`
        ).toMatchObject([{ relforcerowsecurity: true }]);
      }
      // A fixture of the explicit operator decision, NOT automatic provisioning.
      await client`INSERT INTO users (user_id,created_at,email,password,role,data)
        VALUES ('accountable-user',now(),'accountable@test','unused','member','{}')`;
      await expect(runMigrations(db, { allowOfflineCutover: true })).rejects.toThrow(
        'Migration failed'
      );
      expect(await client`SELECT * FROM boards ORDER BY board_id`).toEqual(boards);
      await client`INSERT INTO board_owners (board_id,user_id,created_at)
        VALUES ('seed','accountable-user',now()),('used','accountable-user',now())`;
      await runMigrations(db, { allowOfflineCutover: true });
      expect(
        await client`SELECT board_id,created_by,data,primary_owner_user_id FROM boards ORDER BY board_id`
      ).toEqual(
        boards.map(({ board_id, created_by, data }) => ({
          board_id,
          created_by,
          data: {
            ...data,
            access_mode: 'private',
            default_others_can: 'none',
            default_others_fs_access: 'none',
          },
          primary_owner_user_id: 'accountable-user',
        }))
      );
      expect(await client`SELECT * FROM board_comments`).toEqual(comments);
      for (const tenant of ['a', 'b']) {
        await client`SELECT set_config('agor.tenant_id', ${tenant}, false)`;
        expect(
          await client`SELECT board_id,primary_owner_user_id FROM boards ORDER BY board_id`
        ).toEqual([
          { board_id: `${tenant}-creator`, primary_owner_user_id: `${tenant}-member` },
          {
            board_id: `${tenant}-orphan`,
            primary_owner_user_id: tenant === 'a' ? 'a-admin-a' : 'b-superadmin',
          },
          { board_id: `${tenant}-owned`, primary_owner_user_id: `${tenant}-member` },
        ]);
        expect(
          await client`SELECT created_by,data->>'retained' AS retained FROM boards WHERE board_id=${`${tenant}-orphan`}`
        ).toEqual([{ created_by: 'anonymous', retained: '42' }]);
        expect(await client`SELECT created_by,data,primary_owner_user_id FROM branches`).toEqual([
          {
            created_by: 'missing',
            data: { retained: 'branch', dangerously_allow_session_sharing: false },
            primary_owner_user_id: tenant === 'a' ? 'a-admin-a' : 'b-superadmin',
          },
        ]);
        expect(await client`SELECT * FROM boards WHERE tenant_id <> ${tenant}`).toHaveLength(0);
        await expect(client`UPDATE boards SET primary_owner_user_id=${tenant === 'a' ? 'b-superadmin' : 'a-admin-a'}
          WHERE board_id=${`${tenant}-orphan`}`).rejects.toMatchObject({ code: '23503' });
      }
      const applied = await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
      expect(applied.slice(0, ledger.length)).toEqual(ledger);
      await runMigrations(db, { allowOfflineCutover: true });
      expect(await client`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(applied);
      expect(await checkMigrationStatus(db)).toMatchObject({ hasPending: false });
    });
  }
);
