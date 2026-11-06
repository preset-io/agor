import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ArtifactRepository,
  acquireTenantWriteGate,
  BranchRepository,
  createDatabase,
  type Database,
  executeRaw,
  initializeDatabase,
  KnowledgeDocumentRepository,
  MessagesRepository,
  releaseTenantWriteGate,
  SessionRepository,
  select,
  sql,
  stagedBlobs,
  UploadRepository,
} from '@agor/core/db';
import type { BranchID, SessionID, TenantID, UploadRef } from '@agor/core/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPackFixture,
  expectChunkedUploadWorks,
  expectPackRoutesIsolated,
} from '../../test/agor-pack-fixture';
import type { RegisterHooksContext } from '../register-hooks';
import {
  getBlobStagingStore,
  getUploadStagingStore,
  resetUploadStagingStoreForTests,
} from '../utils/upload-staging';
import { AgorPackChunkedUploads } from './agor-pack-chunked-upload';
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
  '.agor import (PostgreSQL/RLS)',
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

    it('each apply step keeps the pack for another TTL; afterwards the sweep takes it', async () => {
      const tenant = 'pack-pg-sweep' as TenantID;
      const fx = await createPackFixture({ raw, tenant, config: CONFIG, uploadsRoot });
      try {
        const { pack } = await fx.exportPack();
        const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
        const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
        const { run } = await importer.start(staged.import_id, {
          teammates: ['t01'],
          board_id: null,
        });
        const hour = 60 * 60 * 1000;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          // Mid-run, past the TTL the pack got when claimed; the next step's
          // claim check extends it again.
          const create = ArtifactRepository.prototype.create;
          const spy = vi.spyOn(ArtifactRepository.prototype, 'create').mockImplementation(function (
            this: ArtifactRepository,
            ...args
          ) {
            vi.setSystemTime(Date.now() + 2 * hour);
            return create.apply(this, args);
          });
          try {
            await run();
          } finally {
            spy.mockRestore();
          }
          expect(await getBlobStagingStore().cleanupExpired({ tenantId: tenant })).toBe(0);
          vi.setSystemTime(Date.now() + 2 * hour);
          expect(await getBlobStagingStore().cleanupExpired({ tenantId: tenant })).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      } finally {
        await fx.close();
      }
    }, 60_000);

    it('a pack upload is refused, and nothing staged, while the tenant write gate is held', async () => {
      const tenant = 'pack-pg-gated' as TenantID;
      const fx = await createPackFixture({ raw, tenant, config: CONFIG, uploadsRoot });
      try {
        const { pack } = await fx.exportPack();
        const blobs = () => fx.unit(() => select(fx.db).from(stagedBlobs).all());
        const before = (await blobs()).length;
        const { generation } = await acquireTenantWriteGate(raw, tenant);
        try {
          await expect(
            new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea)).stage(
              Readable.from([pack]),
              pack.byteLength
            )
          ).rejects.toThrow(/write/i);
        } finally {
          await releaseTenantWriteGate(raw, tenant, { generation });
        }
        expect(await blobs()).toHaveLength(before);
      } finally {
        await fx.close();
      }
    }, 60_000);

    it('a write-gated tenant cannot complete a chunked upload; it completes after the gate', async () => {
      const tenant = 'pack-pg-chunk-gate' as TenantID;
      const fx = await createPackFixture({ raw, tenant, config: CONFIG, uploadsRoot });
      try {
        const { pack } = await fx.exportPack();
        const sha256 = createHash('sha256').update(pack).digest('hex');
        const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
        const uploads = new AgorPackChunkedUploads(fx.ctx(fx.bea));
        const state = await uploads.init({ size: pack.byteLength, sha256 }, importer);
        for (let index = 0; index < state.chunks; index++) {
          const chunk = pack.subarray(index * state.chunk_size, (index + 1) * state.chunk_size);
          await uploads.putChunk(state.upload_id, index, Readable.from([chunk]), chunk.byteLength);
        }
        const { generation } = await acquireTenantWriteGate(raw, tenant);
        try {
          await expect(uploads.complete(state.upload_id, importer)).rejects.toThrow(/write/i);
        } finally {
          await releaseTenantWriteGate(raw, tenant, { generation });
        }
        // Nothing was consumed: the chunks are all there and nothing completed.
        const after = await uploads.status(state.upload_id);
        expect(after.received).toHaveLength(after.chunks);
        expect(after.import_id).toBeNull();
        const receipt = await uploads.complete(state.upload_id, importer);
        expect(receipt.manifest.teammates[0]?.display_name).toBe('Ada');
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

    it('a chunked upload resumes, checks its sha256, and never crosses users or tenants', async () => {
      const tenant = 'pack-pg-chunks-a' as TenantID;
      const other = 'pack-pg-chunks-b' as TenantID;
      const fx = await createPackFixture({ raw, tenant, config: CONFIG, uploadsRoot });
      try {
        const cy = await fx.createUser('cy@example.test', other);
        await expectChunkedUploadWorks(fx, expect, [{ user: cy, tenantId: other }]);
      } finally {
        await fx.close();
      }
    }, 60_000);
  }
);
