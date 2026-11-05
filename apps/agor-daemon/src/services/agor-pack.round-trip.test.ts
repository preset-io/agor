import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgorPackReader, bufferByteSource } from '@agor/core/agor-pack';
import {
  AgorPackImportRepository,
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  MessagesRepository,
  ScheduleRepository,
  SessionRepository,
  UploadRepository,
} from '@agor/core/db';
import {
  type BranchID,
  getTeammateConfig,
  type SessionID,
  type TenantID,
  type UploadRef,
} from '@agor/core/types';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  createPackFixture,
  expectPackRoutesIsolated,
  type PackFixture,
} from '../../test/agor-pack-fixture';
import type { RegisterHooksContext } from '../register-hooks';
import {
  getBlobStagingStore,
  getUploadStagingStore,
  resetUploadStagingStoreForTests,
} from '../utils/upload-staging';
import { AgorPackExporter } from './agor-pack-export';
import { AgorPackImporter } from './agor-pack-import';

vi.mock('../utils/spawn-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn(),
  spawnExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));

// The executor leg stages a fragment exactly like `branch.pack.collect` does.
vi.mock('./agor-pack-executor', async (importOriginal) =>
  (await import('../../test/agor-pack-executor-mock')).packExecutorMock(importOriginal as never)
);

const TENANT = 'pack-test' as TenantID;
const CONFIG = {
  database: { dialect: 'sqlite' },
  execution: {},
  multi_tenancy: { mode: 'static', static_tenant_id: TENANT },
} as RegisterHooksContext['config'];
let uploadsRoot = '';

beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), 'agor-pack-uploads-'));
});
afterEach(async () => {
  resetUploadStagingStoreForTests();
  await rm(uploadsRoot, { recursive: true, force: true });
});

async function withFixture(
  raw: Parameters<typeof createPackFixture>[0]['raw'],
  work: (fx: PackFixture) => Promise<void>
) {
  const fx = await createPackFixture({ raw, tenant: TENANT, config: CONFIG, uploadsRoot });
  try {
    await work(fx);
  } finally {
    await fx.close();
  }
}

/** Teammate rows an importer owns on a repo (branches, sessions, schedules, artifacts). */
async function ownedCounts(fx: PackFixture, userId: string) {
  return fx.unit(async () => {
    const branches = (
      await new BranchRepository(fx.db).findAll({ repo_id: fx.seeded.repo.repo_id } as never)
    ).filter((b) => b.created_by === userId && getTeammateConfig(b)?.displayName === 'Ada');
    const ids = new Set(branches.map((b) => b.branch_id));
    const sessions = (await new SessionRepository(fx.db).findAll()).filter((session) =>
      ids.has(session.branch_id)
    );
    const schedules = (
      await Promise.all(
        branches.map((b) => new ScheduleRepository(fx.db).findByBranchId(b.branch_id as never))
      )
    ).flat();
    const artifacts = (await new ArtifactRepository(fx.db).findAll()).filter(
      (a) => a.created_by === userId
    );
    return {
      branches: branches.length,
      sessions: sessions.length,
      schedules: schedules.length,
      artifacts: artifacts.length,
    };
  });
}

dbTest(
  'a teammate round-trips into another user with new ids, importer ownership, and idempotency',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { db, unit, ctx, params, ada, bea, seeded, upload } = fx;
      // Secrets after a newline (JSON-escaped as \n) and a whole private key.
      const token = `ghp_${'a'.repeat(36)}`;
      const keyBody = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ';
      await unit(() =>
        new MessagesRepository(db).create({
          session_id: seeded.first.session_id,
          task_id: seeded.task.task_id,
          type: 'assistant',
          role: 'assistant',
          index: 1,
          timestamp: new Date().toISOString(),
          content_preview: 'creds',
          content: `token:\n${token}\n-----BEGIN OPENSSH PRIVATE KEY-----\n${keyBody}\n-----END OPENSSH PRIVATE KEY-----\n`,
        } as never)
      );

      // ---- Preflight as Ada -----------------------------------------------------
      const [preflight] = await new AgorPackExporter(ctx(ada)).preflight([seeded.branch.branch_id]);
      expect(preflight?.sessions.own).toBe(2);
      expect(preflight?.knowledge_documents).toBe(3);
      expect(preflight?.archived).toEqual({ sessions: 1, knowledge_documents: 1, artifacts: 0 });
      expect(preflight?.knowledge_outside_links).toEqual({ count: 1, namespaces: ['team-wiki'] });

      // ---- Export as Ada --------------------------------------------------------
      const { pack, manifest } = await fx.exportPack();
      const reader = await AgorPackReader.open(bufferByteSource(pack));
      expect(reader.has('teammates/t01/sdk-home/claude/projects/-src-ada/memory/MEMORY.md')).toBe(
        true
      );
      const messagesText = (
        await Promise.all(
          reader
            .list('teammates/t01/sessions/')
            .filter((entry) => entry.path.endsWith('.messages.jsonl'))
            .map((entry) => reader.readText(entry.path))
        )
      ).join('');
      expect(messagesText).toContain('[redacted:github_token]');
      expect(messagesText).not.toContain(token);
      expect(messagesText).not.toContain(keyBody);
      const entryPaths = reader.manifest.entries.map((entry) => entry.path);
      expect(entryPaths.some((path) => path.includes('docs/old'))).toBe(false);
      const sessionTitles = await Promise.all(
        entryPaths
          .filter((path) => /sessions\/[^/]+\.json$/.test(path))
          .map(async (path) => JSON.parse(await reader.readText(path)).session.title)
      );
      expect(sessionTitles.sort()).toEqual(['First', 'Second']);
      reader.close();
      const sections = manifest.teammates[0]!.sections;
      expect(sections.knowledge).toEqual({
        documents: 3,
        history_versions: 1,
        outside_links: { count: 1, namespaces: ['team-wiki'] },
      });
      expect(sections.archived_skipped).toEqual({
        sessions: 1,
        knowledge_documents: 1,
        artifacts: 0,
      });
      expect(sections.sessions?.count).toBe(2);
      expect(sections.uploads?.count).toBe(1);
      expect(sections.sessions?.redacted_values).toBe(2);

      // ---- Import as Bea ----------------------------------------------------------
      const importer = new AgorPackImporter(ctx(bea), params(bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      expect(staged.dry_run[0]).toMatchObject({ key: 't01', repo_status: 'existing' });
      // Every section this release writes is known to its own importer.
      expect(staged.dry_run[0]?.warnings.join(' ')).not.toMatch(/newer Agor/);
      const applied = await importer.apply(staged.import_id, {
        teammates: ['t01'],
        board_id: null,
      });
      expect(applied.status).toBe('applied');
      const result = applied.results[0]!;
      // The outside link was reported at export; it is not "unresolved" here.
      expect(result.warnings.join(' ')).not.toMatch(/could not be resolved/);

      // Receipts are private to their importer.
      const outsider = new AgorPackImporter(ctx(ada), params(ada));
      await expect(outsider.get(staged.import_id)).rejects.toThrow(/Import not found/);
      await expect(
        outsider.apply(staged.import_id, { teammates: ['t01'], board_id: null })
      ).rejects.toThrow(/Import not found/);

      await unit(async () => {
        const branch = await new BranchRepository(db).findById(result.branch_id);
        expect(branch?.branch_id).not.toBe(seeded.branch.branch_id);
        expect(branch?.created_by).toBe(bea.user_id);
        expect(branch?.board_id).toBe(result.board_id);
        expect(result.board_id).not.toBe(seeded.board.board_id);
        const teammate = getTeammateConfig(branch!);
        expect(teammate?.displayName).toBe('Ada');
        // Provenance is server-managed branch data, not template-visible context.
        expect(branch?.agor_pack?.imported_from?.originally_by).toEqual({
          name: 'Ada',
          email: 'ada@example.test',
        });
        expect(JSON.stringify(branch?.custom_context ?? {})).not.toContain('imported_from');

        // Knowledge landed in the new teammate's own namespace with links rewritten.
        expect(result.knowledge_namespace_id).toBe(teammate?.kb?.primary_namespace_id);
        const kbDocs = new KnowledgeDocumentRepository(db);
        const notes = await kbDocs.findByNamespaceAndPath(
          result.knowledge_namespace_id as never,
          'docs/notes.md'
        );
        const notesVersion = await new KnowledgeDocumentVersionRepository(db).findById(
          notes!.current_version_id as string
        );
        expect(notesVersion?.content_text).toContain(
          `agor://kb/${teammate?.kb?.primary_namespace_slug}/docs/plan.md`
        );
        const plan = await kbDocs.findByNamespaceAndPath(
          result.knowledge_namespace_id as never,
          'docs/plan.md'
        );
        const planVersions = await new KnowledgeDocumentVersionRepository(db).findAll({
          document_id: plan!.document_id,
        });
        expect(planVersions.map((v) => v.content_text)).toEqual(['# Plan\n\nv2', '# Plan\n\nv1']);

        // Artifact recreated for Bea and the board object points at it.
        const newArtifactId = result.remap.artifacts['artifact-a'];
        expect(newArtifactId).toBeDefined();
        expect(newArtifactId).not.toBe(seeded.artifact.artifact_id);
        const artifact = await new ArtifactRepository(db).findById(newArtifactId!);
        expect(artifact?.created_by).toBe(bea.user_id);
        const board = await new BoardRepository(db).findById(result.board_id);
        expect(board?.objects?.['artifact-a']).toMatchObject({ artifact_id: newArtifactId });
        expect(board?.objects?.['zone-1']).toBeDefined();

        // Schedules arrive disabled and owned by the importer.
        const schedules = await new ScheduleRepository(db).findByBranchId(
          result.branch_id as never
        );
        expect(schedules).toHaveLength(1);
        expect(schedules[0]).toMatchObject({ enabled: false, created_by: bea.user_id });

        // Sessions are archived history without SDK resume state, genealogy remapped.
        const newFirst = await new SessionRepository(db).findById(
          result.remap.sessions[seeded.first.session_id]!
        );
        const newSecond = await new SessionRepository(db).findById(
          result.remap.sessions[seeded.second.session_id]!
        );
        expect(newFirst).toMatchObject({
          archived: true,
          archived_reason: 'imported',
          created_by: bea.user_id,
        });
        expect(newFirst?.sdk_session_id).toBeUndefined();
        expect(newSecond?.genealogy.parent_session_id).toBe(newFirst?.session_id);
        expect(newFirst?.genealogy.children).toEqual([newSecond?.session_id]);
        const messages = await new MessagesRepository(db).findAll({
          sessionId: newFirst!.session_id as SessionID,
        });
        expect(messages).toHaveLength(2);

        // The attachment gets a fresh ref (refs are global keys) rewritten into
        // the message; the original stays with Ada's session.
        const newRef = result.remap.uploads[0] as UploadRef;
        expect(newRef).toBeDefined();
        expect(newRef).not.toBe(upload.ref);
        const linked = messages.find((m) => String(m.content).includes('chart'));
        expect(String(linked!.content)).toContain(newRef);
        expect(String(linked!.content)).not.toContain(upload.ref);
        const restored = await new UploadRepository(db).findOwned(TENANT, newRef);
        expect(restored).toMatchObject({
          createdBy: bea.user_id,
          sessionId: newFirst?.session_id,
          provenance: 'import',
          expiresAt: null,
        });
        expect(
          await new UploadRepository(db).findOwned(TENANT, upload.ref as UploadRef)
        ).toMatchObject({ sessionId: seeded.first.session_id });
      });
      const bytes: Buffer[] = [];
      for await (const chunk of await getUploadStagingStore().read({
        tenantId: TENANT,
        sessionId: result.remap.sessions[seeded.first.session_id] as SessionID,
        branchId: result.branch_id as BranchID,
        ref: result.remap.uploads[0] as UploadRef,
      }))
        bytes.push(chunk as Buffer);
      expect(Buffer.concat(bytes).toString()).toBe('png-bytes');

      // ---- Re-import is idempotent -------------------------------------------------
      const again = await importer.stage(Readable.from([pack]), pack.byteLength);
      expect(again.import_id).toBe(staged.import_id);
      expect(again.dry_run[0]?.already_imported_branch_id).toBe(result.branch_id);
      const reapplied = await importer.apply(again.import_id, {
        teammates: ['t01'],
        board_id: null,
      });
      expect(reapplied.results).toEqual(applied.results);
      const teammates = await unit(() =>
        new BranchRepository(db).findAll({ repo_id: seeded.repo.repo_id } as never)
      );
      expect(teammates.filter((b) => getTeammateConfig(b)?.displayName === 'Ada')).toHaveLength(2);
      // The progress log is cleared once a teammate's result is recorded.
      const receipt = await unit(() => new AgorPackImportRepository(db).findById(staged.import_id));
      expect(receipt?.progress).toEqual({});
      expect(receipt?.claim_token).toBeNull();
    })
);

dbTest('a failed apply resumes where it stopped: one teammate, the same ids', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { pack } = await fx.exportPack();
    const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
    const staged = await importer.stage(Readable.from([pack]), pack.byteLength);

    // Fail on the second session, after the first one and every earlier step landed.
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
      await expect(
        importer.apply(staged.import_id, { teammates: ['t01'], board_id: null })
      ).rejects.toThrow(/injected failure/);
    } finally {
      spy.mockRestore();
    }

    const failed = await importer.get(staged.import_id);
    // Internal failures reach the importer only as a generic line.
    expect(failed).toMatchObject({ status: 'failed', results: [] });
    expect(failed.error).toMatch(/details are in the server log/);
    const partial = await fx.unit(() =>
      new AgorPackImportRepository(fx.db).findById(staged.import_id)
    );
    const progress = partial!.progress.t01!;
    // Every id was planned (and saved) before the first row was created.
    expect(Object.keys(progress.remap.sessions)).toHaveLength(2);
    expect(Object.keys(progress.schedules)).toHaveLength(1);
    expect(progress.knowledge_done).toBe(true);
    expect(partial!.claim_token).toBeNull();

    const applied = await importer.apply(staged.import_id, { teammates: ['t01'], board_id: null });
    expect(applied.status).toBe('applied');
    const [result] = applied.results;
    expect(result?.branch_id).toBe(progress.branch_id);
    expect(result?.board_id).toBe(progress.board_id);
    expect(result?.remap.sessions).toEqual(progress.remap.sessions);
    expect(result?.remap.schedules).toEqual(Object.values(progress.schedules));
    expect(Object.values(result?.remap.artifacts ?? {})).toEqual(Object.values(progress.artifacts));
    expect(await ownedCounts(fx, fx.bea.user_id)).toEqual({
      branches: 1,
      sessions: 2,
      schedules: 1,
      artifacts: 1,
    });
    const messages = await fx.unit(() =>
      new MessagesRepository(fx.db).findAll({
        sessionId: result!.remap.sessions[fx.seeded.first.session_id] as SessionID,
      })
    );
    expect(messages).toHaveLength(1);
  })
);

dbTest(
  'a crash after a row commits: the retry adopts it under its planned id',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { pack } = await fx.exportPack();
      const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      const request = { teammates: ['t01'], board_id: null };

      // The board and the branch are committed; the process "dies" in the next
      // step, before any later checkpoint is written.
      const spy = vi
        .spyOn(ArtifactRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('crash after the branch committed'));
      try {
        await expect(importer.apply(staged.import_id, request)).rejects.toThrow(/crash/);
      } finally {
        spy.mockRestore();
      }
      const plan = (await fx.unit(() =>
        new AgorPackImportRepository(fx.db).findById(staged.import_id)
      ))!.progress.t01!;
      expect(
        await fx.unit(() => new BranchRepository(fx.db).findById(plan.branch_id))
      ).toBeTruthy();
      expect(await fx.unit(() => new BoardRepository(fx.db).findById(plan.board_id))).toBeTruthy();

      const applied = await importer.apply(staged.import_id, request);
      expect(applied.results[0]).toMatchObject({
        branch_id: plan.branch_id,
        board_id: plan.board_id,
      });
      expect(await ownedCounts(fx, fx.bea.user_id)).toEqual({
        branches: 1,
        sessions: 2,
        schedules: 1,
        artifacts: 1,
      });
      const branch = await fx.unit(() => new BranchRepository(fx.db).findById(plan.branch_id));
      expect(branch?.name).toBe(plan.branch_name);
      expect(
        await fx.unit(() =>
          new KnowledgeDocumentRepository(fx.db).findAll({
            namespace_id: applied.results[0]!.knowledge_namespace_id,
          } as never)
        )
      ).toHaveLength(3);
    })
);

dbTest('a stale worker that kept running after a takeover cannot write', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { pack } = await fx.exportPack();
    const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
    const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
    const request = { teammates: ['t01'], board_id: null };
    const stale = await importer.start(staged.import_id, request);
    let takeover: Awaited<ReturnType<AgorPackImporter['start']>>;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      takeover = await new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea)).start(
        staged.import_id,
        request
      );
    } finally {
      vi.useRealTimers();
    }
    // The old worker wakes up and runs: every write is fenced off.
    await stale.run();
    expect((await ownedCounts(fx, fx.bea.user_id)).branches).toBe(0);
    await takeover.run();
    expect((await importer.get(staged.import_id)).status).toBe('applied');
    expect(await ownedCounts(fx, fx.bea.user_id)).toMatchObject({ branches: 1, sessions: 2 });
  })
);

dbTest('the sweep never removes the pack of an import that is applying', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { pack } = await fx.exportPack();
    const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
    const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
    const { run } = await importer.start(staged.import_id, { teammates: ['t01'], board_id: null });
    const store = getBlobStagingStore();
    const hour = 60 * 60 * 1000; // the fixture's blob TTL
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Past expiry while applying: kept, and claiming again extends it.
      vi.setSystemTime(Date.now() + 2 * hour);
      expect(await store.cleanupExpired({ tenantId: TENANT })).toBe(0);
      await run();
      expect((await importer.get(staged.import_id)).status).toBe('applied');
      expect(await store.cleanupExpired({ tenantId: TENANT })).toBe(0);
      // Expired and no longer in use: swept.
      vi.setSystemTime(Date.now() + 2 * hour);
      expect(await store.cleanupExpired({ tenantId: TENANT })).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  })
);

dbTest('concurrent applies: one claims the import, the other is refused', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { pack } = await fx.exportPack();
    const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
    const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
    const request = { teammates: ['t01'], board_id: null };
    const outcomes = await Promise.allSettled([
      importer.apply(staged.import_id, request),
      new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea)).apply(staged.import_id, request),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(
      String((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason)
    ).toMatch(/already being applied/);
    expect((await ownedCounts(fx, fx.bea.user_id)).branches).toBe(1);

    // A worker that died holding the claim: refused while fresh, then shown
    // as interrupted and taken over once stale.
    await fx.unit(() =>
      new AgorPackImportRepository(fx.db).claim(
        staged.import_id,
        fx.bea.user_id,
        'dead-worker',
        new Date(0),
        { status: 'applying' }
      )
    );
    await expect(importer.apply(staged.import_id, request)).rejects.toThrow(
      /already being applied/
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expect(await importer.get(staged.import_id)).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/interrupted/),
      });
      expect((await importer.apply(staged.import_id, request)).status).toBe('applied');
    } finally {
      vi.useRealTimers();
    }
    expect((await ownedCounts(fx, fx.bea.user_id)).branches).toBe(1);
  })
);

dbTest("pack routes never serve another user's export, import, or teammate", async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    await expectPackRoutesIsolated(fx, expect);
  })
);
