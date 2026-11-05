import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  BranchRepository,
  createDatabase,
  type Database,
  executeRaw,
  initializeDatabase,
  KnowledgeDocumentRepository,
  MessagesRepository,
  SessionRepository,
  sql,
  UploadRepository,
} from '@agor/core/db';
import type { BranchID, SessionID, TenantID, UploadRef } from '@agor/core/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPackFixture, expectPackRoutesIsolated } from '../../test/agor-pack-fixture';
import type { RegisterHooksContext } from '../register-hooks';
import { getUploadStagingStore, resetUploadStagingStoreForTests } from '../utils/upload-staging';
import { AgorPackImporter } from './agor-pack-import';

vi.mock('../utils/spawn-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn(),
  spawnExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));
vi.mock('./agor-pack-executor', async (importOriginal) =>
  (await import('../../test/agor-pack-executor-mock')).packExecutorMock(importOriginal as never)
);

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const CONFIG = {
  database: { dialect: 'postgresql' },
  execution: { branch_storage: { default_mode: 'clone', allowed_modes: ['clone'] } },
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
} as RegisterHooksContext['config'];

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  '.agorpack import (PostgreSQL/RLS)',
  () => {
    let raw: Database;
    let uploadsRoot = '';
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      const result = await executeRaw(
        raw,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60_000);
    afterAll(async () => {
      await (raw as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });
    beforeEach(async () => {
      uploadsRoot = await mkdtemp(join(tmpdir(), 'agor-pack-pg-'));
    });
    afterEach(async () => {
      resetUploadStagingStoreForTests();
      await rm(uploadsRoot, { recursive: true, force: true });
    });

    it('imports a teammate into another user, resuming after a mid-apply failure', async () => {
      const tenant = 'pack-pg-round-trip' as TenantID;
      const fx = await createPackFixture({ raw, tenant, config: CONFIG, uploadsRoot });
      try {
        const { pack } = await fx.exportPack();
        const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
        const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
        const request = { teammates: ['t01'], board_id: null };

        const create = SessionRepository.prototype.create;
        let calls = 0;
        const spy = vi.spyOn(SessionRepository.prototype, 'create').mockImplementation(function (
          this: SessionRepository,
          ...args
        ) {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('injected failure'));
          return create.apply(this, args);
        });
        try {
          await expect(importer.apply(staged.import_id, request)).rejects.toThrow(/injected/);
        } finally {
          spy.mockRestore();
        }
        expect((await importer.get(staged.import_id)).status).toBe('failed');

        const applied = await importer.apply(staged.import_id, request);
        expect(applied.status).toBe('applied');
        const result = applied.results[0]!;
        await fx.unit(async () => {
          const branches = (await new BranchRepository(fx.db).findAll()).filter(
            (b) => b.created_by === fx.bea.user_id
          );
          expect(branches.map((b) => b.branch_id)).toEqual([result.branch_id]);
          expect(branches[0]?.agor_pack?.imported_from?.originally_by?.email).toBe(
            'ada@example.test'
          );
          const sessions = (await new SessionRepository(fx.db).findAll()).filter(
            (s) => s.branch_id === result.branch_id
          );
          expect(sessions).toHaveLength(2);
          expect(sessions.every((s) => s.archived && s.created_by === fx.bea.user_id)).toBe(true);
          const first = result.remap.sessions[fx.seeded.first.session_id] as SessionID;
          expect(await new MessagesRepository(fx.db).findAll({ sessionId: first })).toHaveLength(1);
          expect(
            await new KnowledgeDocumentRepository(fx.db).findByNamespaceAndPath(
              result.knowledge_namespace_id as never,
              'docs/plan.md'
            )
          ).toBeTruthy();
          const restored = await new UploadRepository(fx.db).findOwned(
            tenant,
            result.remap.uploads[0] as UploadRef
          );
          expect(restored).toMatchObject({ createdBy: fx.bea.user_id, sessionId: first });
        });
        const bytes: Buffer[] = [];
        for await (const chunk of await getUploadStagingStore().read({
          tenantId: tenant,
          sessionId: result.remap.sessions[fx.seeded.first.session_id] as SessionID,
          branchId: result.branch_id as BranchID,
          ref: result.remap.uploads[0] as UploadRef,
        }))
          bytes.push(chunk as Buffer);
        expect(Buffer.concat(bytes).toString()).toBe('png-bytes');

        // Re-importing the same file is a no-op.
        const again = await importer.stage(Readable.from([pack]), pack.byteLength);
        expect(again.import_id).toBe(staged.import_id);
        expect((await importer.apply(again.import_id, request)).results).toEqual(applied.results);
      } finally {
        await fx.close();
      }
    }, 60_000);

    it("pack routes never serve another tenant's or user's export, import, or teammate", async () => {
      const tenant = 'pack-pg-routes-a' as TenantID;
      const other = 'pack-pg-routes-b' as TenantID;
      const fx = await createPackFixture({ raw, tenant, config: CONFIG, uploadsRoot });
      try {
        const cy = await fx.createUser('cy@example.test', other);
        await expectPackRoutesIsolated(fx, expect, [{ user: cy, tenantId: other }]);
      } finally {
        await fx.close();
      }
    }, 60_000);
  }
);
