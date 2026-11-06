import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgorPackReader, AgorPackWriter, bufferByteSource } from '@agor/core/agor-pack';
import {
  AgorPackImportRepository,
  ArtifactRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  eq,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  kbDocuments,
  MessagesRepository,
  ScheduleRepository,
  SessionRepository,
  StagedBlobRepository,
  UploadRepository,
  UsersRepository,
  update,
  uploads,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import {
  AGOR_PACK,
  AGOR_PACK_SECTIONS,
  agorPackExportRequestSchema,
  type BranchID,
  getTeammateConfig,
  type Message,
  type Paginated,
  type SessionID,
  type Task,
  TaskStatus,
  type TenantID,
  type UploadRef,
} from '@agor/core/types';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  createPackFixture,
  expectChunkedUploadWorks,
  expectPackRoutesIsolated,
  type PackFixture,
} from '../../test/agor-pack-fixture';
import type { ReposServiceImpl } from '../declarations';
import { LocalUploadStagingStore } from '../host/local/upload-staging-store';
import type { RegisterHooksContext } from '../register-hooks';
import { MetadataUploadStagingStore } from '../utils/metadata-upload-staging-store';
import { spawnExecutorFireAndForget } from '../utils/spawn-executor';
import { configureUploadLimits } from '../utils/upload';
import {
  configureUploadStagingStore,
  getBlobStagingStore,
  getUploadStagingStore,
  localPackBytes,
  resetUploadStagingStoreForTests,
} from '../utils/upload-staging';
import { runAgorPackExecutorCommand } from './agor-pack-executor';
import { AgorPackExporter } from './agor-pack-export';
import { AgorPackImporter } from './agor-pack-import';
import { BranchesService } from './branches';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { MessagesService } from './messages';
import { createTasksService } from './tasks';

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
      expect(preflight?.archived).toEqual({
        sessions: 1,
        knowledge_documents: 1,
        artifacts: 0,
        private_knowledge_documents: 0,
      });
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
        // The session view reads the Session's Tasks (queued excluded), then
        // each Task's Messages, through these services: the imported
        // transcript must come back the same way.
        const rows = <T>(result: T[] | Paginated<T>) =>
          Array.isArray(result) ? result : result.data;
        const shownTasks = rows(
          (await createTasksService(db, feathers()).find({
            query: {
              session_id: newFirst!.session_id,
              status: { $ne: TaskStatus.QUEUED },
              $sort: { created_at: 1, task_id: 1 },
              $limit: 100,
            },
          })) as Task[] | Paginated<Task>
        );
        expect(shownTasks).toHaveLength(1);
        const shownMessages = rows(
          (await new MessagesService(db).find({
            query: { task_id: shownTasks[0]!.task_id, $sort: { index: 1 }, $limit: 100 },
          })) as Message[] | Paginated<Message>
        );
        expect(shownMessages.map((m) => m.index)).toEqual([0, 1]);
        expect(shownMessages.every((m) => m.session_id === newFirst!.session_id)).toBe(true);

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

dbTest(
  'sessions that may contain passwords: the preflight lists them, the export or the import leaves them out',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { db, unit, ctx, params, ada, bea, seeded } = fx;
      await unit(() =>
        new MessagesRepository(db).create({
          session_id: seeded.first.session_id,
          task_id: seeded.task.task_id,
          type: 'assistant',
          role: 'assistant',
          index: 1,
          timestamp: new Date().toISOString(),
          content_preview: 'creds',
          content: `token ghp_${'a'.repeat(36)}`,
        } as never)
      );
      const [preflight] = await new AgorPackExporter(ctx(ada)).preflight([seeded.branch.branch_id]);
      expect(preflight?.flagged_sessions).toEqual([
        { session_id: seeded.first.session_id, title: 'First', own: true, recent: true },
      ]);
      expect(preflight?.session_bytes.own).toBeGreaterThan(0);
      expect(preflight?.session_bytes.recent_own).toBe(preflight?.session_bytes.own);

      const exportWith = async (exclude: string[]) => {
        const writer = new AgorPackWriter();
        const chunks: Buffer[] = [];
        writer.output.on('data', (chunk: Buffer) => chunks.push(chunk));
        const ended = new Promise((resolve) => writer.output.on('end', resolve));
        const manifest = await new AgorPackExporter(ctx(ada)).export(
          agorPackExportRequestSchema.parse({
            branch_ids: [seeded.branch.branch_id],
            sessions: 'all',
            exclude_session_ids: exclude,
          }),
          writer
        );
        await ended;
        return { pack: Buffer.concat(chunks), manifest };
      };
      // Left out at export ("Leave these out"): everything else is the default.
      const without = await exportWith([seeded.first.session_id]);
      expect(without.manifest.options.sections).toEqual([...AGOR_PACK_SECTIONS].sort());
      expect(without.manifest.teammates[0]?.sections.sessions).toMatchObject({
        count: 1,
        flagged: 0,
      });

      // Kept at export, left out at import.
      const { pack, manifest } = await exportWith([]);
      expect(manifest.teammates[0]?.sections.sessions).toMatchObject({ count: 2, flagged: 1 });
      const importer = new AgorPackImporter(ctx(bea), params(bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      const applied = await importer.apply(staged.import_id, {
        teammates: ['t01'],
        board_id: null,
        skip_flagged_sessions: true,
      });
      const result = applied.results[0]!;
      expect(Object.keys(result.remap.sessions)).toEqual([seeded.second.session_id]);
      // The attachment lived in the skipped session.
      expect(result.remap.uploads).toEqual([]);
      await unit(async () => {
        const second = await new SessionRepository(db).findById(
          result.remap.sessions[seeded.second.session_id]!
        );
        expect(second?.genealogy.parent_session_id ?? null).toBeNull();
      });
    })
);

dbTest(
  'attachments over the interactive upload cap are restored from a pack, or named with the reason',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { pack } = await fx.exportPack();
      // A workspace whose interactive per-file cap (4 bytes) is below the
      // 9-byte attachment; `restore` is the pack-limit adapter the daemon wires.
      const configure = (restore: boolean) => {
        configureUploadLimits(4);
        configureUploadStagingStore(() => {
          const root = (tenant: string) => join(uploadsRoot, tenant);
          return new MetadataUploadStagingStore(
            fx.db,
            new LocalUploadStagingStore(root, { ttlMs: 0, maxBytes: 4 }),
            { bytes: localPackBytes((t) => join(root(t), 'agor-packs')), ttlMs: 60 * 60 * 1000 },
            restore
              ? {
                  bytes: new LocalUploadStagingStore(root, {
                    ttlMs: 0,
                    maxBytes: AGOR_PACK.maxEntryBytes,
                  }),
                  maxBytes: AGOR_PACK.maxEntryBytes,
                }
              : undefined
          );
        });
      };
      const importAs = async (email: string) => {
        const user = await fx.createUser(email);
        const importer = new AgorPackImporter(fx.ctx(user), fx.params(user));
        expect(user.onboarding_completed).toBeFalsy();
        const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
        const applied = await importer.apply(staged.import_id, { teammates: ['t01'] });
        // Having imported a teammate, first-run onboarding is done for them.
        const after = await fx.unit(() => new UsersRepository(fx.db).findById(user.user_id));
        expect(after?.onboarding_completed).toBe(true);
        return { staged, applied };
      };

      configure(false);
      const refused = await importAs('cap@example.test');
      expect(refused.staged.dry_run[0]?.warnings).toContain(
        'Attachment "chart.png" (1 MB) is larger than this workspace accepts (1 MB) and won\'t be restored.'
      );
      expect(refused.applied.results[0]?.remap.uploads).toEqual([]);
      expect(refused.applied.results[0]?.warnings.join(' ')).toMatch(
        /Attachment "chart\.png" could not be restored: it is larger than this workspace accepts/
      );

      configure(true);
      const restored = await importAs('restore@example.test');
      expect(restored.staged.dry_run[0]?.warnings.join(' ')).not.toMatch(/chart\.png/);
      expect(restored.applied.results[0]?.remap.uploads).toHaveLength(1);
    })
);

dbTest(
  'an attachment over the pack entry limit is left out and reported, not fatal',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { db, unit, ctx, ada, seeded, upload } = fx;
      // The recorded size decides; the bytes are never read.
      await unit(() =>
        update(db, uploads)
          .set({ size_bytes: AGOR_PACK.maxEntryBytes + 1 })
          .where(eq(uploads.upload_ref, upload.ref))
          .run()
      );
      const [preflight] = await new AgorPackExporter(ctx(ada)).preflight([seeded.branch.branch_id]);
      expect(preflight?.large_attachments).toEqual([
        { name: 'chart.png', size: AGOR_PACK.maxEntryBytes + 1, own: true, recent: true },
      ]);
      const { manifest } = await fx.exportPack();
      const teammate = manifest.teammates[0]!;
      expect(teammate.sections.uploads).toEqual({ count: 0, bytes: 0, too_large: 1 });
      expect(teammate.warnings).toContain(
        '1 attachment is too large to move (over 256 MB) and was left out.'
      );
    })
);

dbTest("the export leaves out Knowledge docs the exporter can't read", async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { db, unit, ada, bea, seeded } = fx;
    // Another user's private doc (with history) in the teammate's namespace.
    await unit(async () => {
      const docs = new KnowledgeDocumentsService(db, fx.server.app);
      const doc = (await docs.create(
        {
          namespace_id: seeded.namespace.namespace_id,
          path: 'docs/bea.md',
          title: 'Bea',
          visibility: 'private',
          content_text: 'bea-private-v1',
        },
        fx.params(ada)
      )) as { document_id: string };
      await docs.patch(doc.document_id, { content_text: 'bea-private-v2' }, fx.params(ada));
      await update(db, kbDocuments)
        .set({ created_by: bea.user_id })
        .where(eq(kbDocuments.document_id, doc.document_id))
        .run();
    });
    const [preflight] = await new AgorPackExporter(fx.ctx(ada)).preflight([
      seeded.branch.branch_id,
    ]);
    expect(preflight?.knowledge_documents).toBe(3);
    expect(preflight?.archived.private_knowledge_documents).toBe(1);

    const { pack, manifest } = await fx.exportPack();
    const sections = manifest.teammates[0]!.sections;
    expect(sections.knowledge?.documents).toBe(3);
    expect(sections.archived_skipped?.private_knowledge_documents).toBe(1);
    const reader = await AgorPackReader.open(bufferByteSource(pack));
    const knowledge = (
      await Promise.all(
        reader.list('teammates/t01/knowledge/').map((entry) => reader.readText(entry.path))
      )
    ).join('\n');
    reader.close();
    expect(knowledge).toContain('# Plan');
    expect(knowledge).not.toMatch(/bea-private|docs\/bea/);
  })
);

dbTest("the export leaves out a board the exporter can't view", async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const spy = vi.spyOn(BoardRepository.prototype, 'canViewResolved').mockResolvedValue(false);
    try {
      const [preflight] = await new AgorPackExporter(fx.ctx(fx.ada)).preflight([
        fx.seeded.branch.branch_id,
      ]);
      expect(preflight?.artifacts).toBe(0);
      expect(preflight?.warnings.join(' ')).toMatch(/can't view this teammate's board/);

      const { pack, manifest } = await fx.exportPack();
      const teammate = manifest.teammates[0]!;
      expect(teammate.sections.board).toBeNull();
      expect(teammate.sections.artifacts).toBe(0);
      expect(teammate.warnings.join(' ')).toMatch(/can't view this teammate's board/);
      const reader = await AgorPackReader.open(bufferByteSource(pack));
      expect(reader.has('teammates/t01/board.json')).toBe(false);
      reader.close();
    } finally {
      spy.mockRestore();
    }
  })
);

dbTest('a text attachment too large to scan for secrets stays behind', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const limits = AGOR_PACK as { maxTextEntryBytes: number };
    const limit = limits.maxTextEntryBytes;
    // The fixture's attachment ("png-bytes") has no NUL byte: it reads as text.
    limits.maxTextEntryBytes = 4;
    let manifest: Awaited<ReturnType<typeof fx.exportPack>>['manifest'];
    try {
      ({ manifest } = await fx.exportPack());
    } finally {
      limits.maxTextEntryBytes = limit;
    }
    const teammate = manifest.teammates[0]!;
    expect(teammate.sections.uploads).toEqual({ count: 0, bytes: 0 });
    expect(teammate.warnings.join(' ')).toMatch(/too large to check for secrets/);
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

dbTest(
  'a crash right after the branch row commits: the resume finishes the branch',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { pack } = await fx.exportPack();
      const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      const request = { teammates: ['t01'], board_id: null };
      // branches.create committed the row, then the process died: no Knowledge
      // namespace, board placement, primary teammate, or provisioning dispatch.
      const spy = vi
        .spyOn(
          BranchesService.prototype as unknown as {
            maybeEnsureTeammateKnowledgeNamespace: () => Promise<unknown>;
          },
          'maybeEnsureTeammateKnowledgeNamespace'
        )
        .mockRejectedValueOnce(new Error('crash after the branch row committed'));
      try {
        await expect(importer.apply(staged.import_id, request)).rejects.toThrow(/crash/);
      } finally {
        spy.mockRestore();
      }
      const plan = (await fx.unit(() =>
        new AgorPackImportRepository(fx.db).findById(staged.import_id)
      ))!.progress.t01!;
      const branches = new BranchRepository(fx.db);
      const half = await fx.unit(() => branches.findById(plan.branch_id));
      expect(getTeammateConfig(half!)?.kb).toBeUndefined();
      expect(half?.filesystem_status).toBe('creating');
      // The restart's startup watchdog marks the interrupted checkout failed.
      const repos = fx.server.app.service('repos') as unknown as ReposServiceImpl;
      await fx.unit(() => repos.reconcileStuckCreatingBranches(fx.params(fx.bea)));
      const spawn = vi.mocked(spawnExecutorFireAndForget);
      spawn.mockClear();

      const applied = await importer.apply(staged.import_id, request);
      expect(applied.status).toBe('applied');
      const result = applied.results[0]!;
      expect(result.branch_id).toBe(plan.branch_id);
      await fx.unit(async () => {
        const branch = await branches.findById(plan.branch_id);
        const kb = getTeammateConfig(branch!)?.kb;
        expect(kb?.primary_namespace_id).toBe(result.knowledge_namespace_id);
        expect(
          await new KnowledgeDocumentRepository(fx.db).findAll({
            namespace_id: kb?.primary_namespace_id,
          } as never)
        ).toHaveLength(3);
        expect(
          await new BoardObjectRepository(fx.db).findByBranchId(plan.branch_id as BranchID)
        ).toMatchObject({ board_id: plan.board_id });
        expect(
          (await new BoardRepository(fx.db).findById(plan.board_id))?.primary_teammate_id
        ).toBe(plan.branch_id);
        // Provisioning went through the normal retry path again.
        expect(branch?.filesystem_status).toBe('creating');
      });
      expect(spawn.mock.calls.map(([payload]) => payload.command)).toContain('git.branch.add');
    })
);

dbTest(
  'a crash mid-Knowledge replay leaves no partial document; the resume writes each version once',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { pack } = await fx.exportPack();
      const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      const request = { teammates: ['t01'], board_id: null };
      // plan.md replays v1 (create) then v2 (patch); the process dies between them.
      const patch = KnowledgeDocumentsService.prototype.patch;
      let crashed = false;
      const spy = vi
        .spyOn(KnowledgeDocumentsService.prototype, 'patch')
        .mockImplementation(function (this: KnowledgeDocumentsService, ...args) {
          const data = args[1] as { content_text?: string };
          if (!crashed && data.content_text === '# Plan\n\nv2') {
            crashed = true;
            return Promise.reject(new Error('crash mid-replay'));
          }
          return patch.apply(this, args);
        });
      try {
        await expect(importer.apply(staged.import_id, request)).rejects.toThrow(/crash/);
      } finally {
        spy.mockRestore();
      }
      const [result] = (await importer.apply(staged.import_id, request)).results;
      await fx.unit(async () => {
        const plan = await new KnowledgeDocumentRepository(fx.db).findByNamespaceAndPath(
          result!.knowledge_namespace_id as never,
          'docs/plan.md'
        );
        const versions = await new KnowledgeDocumentVersionRepository(fx.db).findAll({
          document_id: plan!.document_id,
        });
        expect(versions.map((v) => v.content_text)).toEqual(['# Plan\n\nv2', '# Plan\n\nv1']);
      });
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

dbTest(
  "the heartbeat keeps a live import's pack past its TTL; afterwards the sweep takes it",
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { pack } = await fx.exportPack();
      const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      const store = getBlobStagingStore();
      const receipt = await fx.unit(() =>
        new AgorPackImportRepository(fx.db).findById(staged.import_id)
      );
      const ref = receipt!.staging_ref!.split(':')[1] as UploadRef;
      const expiresAt = async () =>
        Date.parse(
          (await fx.unit(() => new StagedBlobRepository(fx.db).find(TENANT, ref)))!.expiresAt
        );
      const hour = 60 * 60 * 1000; // the fixture's blob TTL
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      try {
        const { run } = await importer.start(staged.import_id, {
          teammates: ['t01'],
          board_id: null,
        });
        const claimedUntil = await expiresAt();
        const create = ArtifactRepository.prototype.create;
        const spy = vi
          .spyOn(ArtifactRepository.prototype, 'create')
          .mockImplementation(async function (this: ArtifactRepository, ...args) {
            // A long step: the heartbeat fires while it runs...
            vi.setSystemTime(claimedUntil - 60_000);
            vi.advanceTimersByTime(60_000);
            for (let i = 0; i < 1000 && (await expiresAt()) <= claimedUntil; i++) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            // ...so past the TTL it got when claimed, the sweep keeps the pack.
            vi.setSystemTime(claimedUntil + 30 * 60_000);
            expect(await store.cleanupExpired({ tenantId: TENANT })).toBe(0);
            return create.apply(this, args);
          });
        try {
          await run();
        } finally {
          spy.mockRestore();
        }
        expect((await importer.get(staged.import_id)).status).toBe('applied');
        // Nothing refreshes it any more: a TTL later it is swept.
        vi.setSystemTime(Date.now() + 2 * hour);
        expect(await store.cleanupExpired({ tenantId: TENANT })).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    })
);

dbTest('the files leg re-checks the claim after waiting for the checkout', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { pack } = await fx.exportPack();
    const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
    const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
    const request = { teammates: ['t01'], board_id: null };
    const [result] = (await importer.apply(staged.import_id, request)).results;
    expect(result?.filesystem).toBe('pending');
    const executor = vi.mocked(runAgorPackExecutorCommand);
    executor.mockClear();

    // The files leg waits for the checkout; meanwhile another worker takes over.
    const done = (await importer.start(staged.import_id, request)).run({ files: true });
    await fx.unit(() =>
      new AgorPackImportRepository(fx.db).claim(
        staged.import_id,
        fx.bea.user_id,
        'other-worker',
        new Date(Date.now() + 60_000)
      )
    );
    await fx.unit(() =>
      new BranchRepository(fx.db).update(result!.branch_id, { filesystem_status: 'ready' })
    );
    await done;
    expect(executor.mock.calls.map(([, input]) => input.command)).not.toContain(
      'branch.pack.materialize'
    );
    const receipt = await fx.unit(() =>
      new AgorPackImportRepository(fx.db).findById(staged.import_id)
    );
    expect(receipt?.claim_token).toBe('other-worker');
  })
);

dbTest('a lost attachment attempt deletes only its own upload', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const store = getUploadStagingStore() as MetadataUploadStagingStore;
    const owner = {
      tenantId: TENANT,
      sessionId: fx.seeded.first.session_id,
      branchId: fx.seeded.branch.branch_id,
    };
    const planned = `upl_${randomUUID()}` as UploadRef;
    const attempt = async (text: string) =>
      (
        await store.stage({
          owner: { ...owner, createdBy: fx.ada.user_id as never },
          name: 'note.txt',
          mimeType: 'text/plain',
          provenance: 'import',
          body: Readable.from([Buffer.from(text)]),
          ttlMs: 0,
        })
      ).ref;
    const winner = await attempt('winner');
    await fx.unit(() => store.publishAs({ ...owner, ref: winner }, planned));
    // A second attempt for the same planned ref loses: its publish refuses to
    // replace the published upload, and it deletes only its own.
    const loser = await attempt('loser');
    await expect(fx.unit(() => store.publishAs({ ...owner, ref: loser }, planned))).rejects.toThrow(
      /already published/
    );
    await store.delete({ ...owner, ref: loser });
    const bytes: Buffer[] = [];
    for await (const chunk of await store.read({ ...owner, ref: planned }))
      bytes.push(chunk as Buffer);
    expect(Buffer.concat(bytes).toString()).toBe('winner');
    const uploads = new UploadRepository(fx.db);
    expect(await fx.unit(() => uploads.findOwned(TENANT, loser))).toBeNull();
    expect(await fx.unit(() => uploads.findOwned(TENANT, planned))).toMatchObject({
      status: 'active',
    });
  })
);

dbTest('a claim fails cleanly once the sweep removed the pack', async ({ db: raw }) =>
  withFixture(raw, async (fx) => {
    const { pack } = await fx.exportPack();
    const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
    const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      expect(await getBlobStagingStore().cleanupExpired({ tenantId: TENANT })).toBe(1);
      await expect(
        importer.start(staged.import_id, { teammates: ['t01'], board_id: null })
      ).rejects.toThrow(/upload it again/);
    } finally {
      vi.useRealTimers();
    }
    // The claim rolled back with it: nothing is left "applying".
    const receipt = await fx.unit(() =>
      new AgorPackImportRepository(fx.db).findById(staged.import_id)
    );
    expect(receipt).toMatchObject({ status: 'staged', claim_token: null });
  })
);

dbTest(
  'an import abandoned while applying is marked failed and its pack reclaimed',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      const { pack } = await fx.exportPack();
      const importer = new AgorPackImporter(fx.ctx(fx.bea), fx.params(fx.bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      // Claimed, then the worker dies before doing anything.
      await importer.start(staged.import_id, { teammates: ['t01'], board_id: null });
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
        expect(await importer.get(staged.import_id)).toMatchObject({ status: 'failed' });
        const receipt = await fx.unit(() =>
          new AgorPackImportRepository(fx.db).findById(staged.import_id)
        );
        expect(receipt?.status).toBe('failed');
        expect(await getBlobStagingStore().cleanupExpired({ tenantId: TENANT })).toBe(1);
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

dbTest(
  'a chunked upload resumes, checks its sha256, and stays with its uploader',
  async ({ db: raw }) =>
    withFixture(raw, async (fx) => {
      await expectChunkedUploadWorks(fx, expect);
    })
);
