import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgorPackReader, AgorPackWriter, bufferByteSource } from '@agor/core/agor-pack';
import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  MessagesRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  UploadRepository,
  UsersRepository,
} from '@agor/core/db';
import {
  type BranchID,
  getTeammateConfig,
  type SessionID,
  type TenantID,
  UPLOAD_VIRTUAL_URL_PREFIX,
  type UploadRef,
  type User,
  type UUID,
} from '@agor/core/types';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import { LocalUploadStagingStore } from '../host/local/upload-staging-store';
import type { RegisterHooksContext } from '../register-hooks';
import { MetadataUploadStagingStore } from '../utils/metadata-upload-staging-store';
import {
  configureUploadStagingStore,
  getAgorPackStagingStore,
  getUploadStagingStore,
  resetUploadStagingStoreForTests,
} from '../utils/upload-staging';
import { AgorPackExporter, type AgorPackServiceContext } from './agor-pack-export';
import { AgorPackImporter } from './agor-pack-import';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { ReposService } from './repos';
import { createSchedulesService } from './schedules';
import { ensureTeammateKnowledgeNamespace } from './teammate-knowledge';

vi.mock('../utils/spawn-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn(),
  spawnExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));

// The executor leg stages a fragment exactly like `branch.pack.collect` does.
vi.mock('./agor-pack-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agor-pack-executor')>()),
  runAgorPackExecutorCommand: vi.fn(
    async (
      ctx: { tenantId: TenantID; user: { user_id: string } },
      input: { params: { exportId: string }; branch: { branch_id: string } }
    ) => {
      const writer = new AgorPackWriter();
      const chunks: Buffer[] = [];
      writer.output.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise((resolve) => writer.output.on('end', resolve));
      writer.addJson('teammates/t00/git/state.json', {
        version: 1,
        head_sha: 'a'.repeat(40),
        ref: 'ada',
        deleted: [],
      });
      writer.addBuffer('teammates/t00/sdk-home/claude/projects/-src-ada/memory/MEMORY.md', '# me');
      writer.finishFragment();
      await done;
      const staged = await getAgorPackStagingStore().stage({
        owner: {
          tenantId: ctx.tenantId,
          sessionId: input.params.exportId as UUID,
          branchId: input.branch.branch_id as UUID,
          createdBy: ctx.user.user_id as UUID,
        },
        name: 'fragment.zip',
        mimeType: 'application/zip',
        provenance: 'import',
        body: Readable.from([Buffer.concat(chunks)]),
      });
      return {
        fragmentRef: staged.ref,
        git: {
          mode: 'bundle',
          head_sha: 'a'.repeat(40),
          unpushed_commits: 3,
          dirty_files: 0,
          deleted_files: 0,
          bundle: false,
          skipped_files: [],
        },
        claudeMemory: { files: 1, bytes: 4 },
      };
    }
  ),
}));

const TENANT = 'pack-test' as TenantID;
let uploadsRoot = '';

beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), 'agor-pack-uploads-'));
});
afterEach(async () => {
  resetUploadStagingStoreForTests();
  await rm(uploadsRoot, { recursive: true, force: true });
});

dbTest(
  'a teammate round-trips into another user with new ids, importer ownership, and idempotency',
  async ({ db: raw }) => {
    const db = createTenantScopedDatabaseProxy(raw, { label: 'agor-pack-round-trip' });
    const unit = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, TENANT, work);
    configureUploadStagingStore(
      () =>
        new MetadataUploadStagingStore(
          db,
          new LocalUploadStagingStore((tenant) => join(uploadsRoot, tenant), { ttlMs: 0 })
        )
    );
    const config = {
      database: { dialect: 'sqlite' },
      execution: {},
      multi_tenancy: { mode: 'static', static_tenant_id: TENANT },
    } as RegisterHooksContext['config'];
    const server = await boardMetadataTestApp(db, config, false, false, false, async (app) => {
      await app.unuse('repos');
      app.use('repos', new ReposService(db, app), {
        methods: ['find', 'get', 'create', 'patch', 'createBranch', 'cloneRepository'],
      } as never);
      await app.unuse('schedules');
      app.use('schedules', createSchedulesService(db));
      app.use('artifacts', {
        async find() {
          return [];
        },
      });
    });
    Object.assign(server.app, {
      sessionTokenService: { generateCommandToken: vi.fn(async () => 'command-token') },
    });
    try {
      const [ada, bea] = await unit(async () => [
        await new UsersRepository(db).create({
          email: 'ada@example.test',
          name: 'Ada',
          role: 'member',
        }),
        await new UsersRepository(db).create({
          email: 'bea@example.test',
          name: 'Bea',
          role: 'member',
        }),
      ]);
      const params = (user: User) => ({
        user,
        tenant: { tenant_id: TENANT, source: 'explicit' as const },
      });
      const ctx = (user: User): AgorPackServiceContext => ({
        app: server.app,
        db,
        config,
        tenantId: TENANT,
        user,
        agorVersion: '0.0.0-test',
      });

      // ---- Seed Ada's teammate ------------------------------------------------
      const seeded = await unit(async () => {
        const repo = await new RepoRepository(db).create({
          name: 'Example',
          slug: 'example/repo',
          repo_type: 'remote',
          local_path: '/fictional/example',
          default_branch: 'main',
          remote_url: 'https://example.test/repo.git',
          clone_status: 'ready',
        });
        const board = await new BoardRepository(db).create({
          name: "Ada's board",
          created_by: ada.user_id,
          objects: {
            'zone-1': {
              type: 'zone',
              x: 0,
              y: 0,
              width: 800,
              height: 600,
              label: 'Doing',
            } as never,
          },
        });
        const branch = await new BranchRepository(db).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          board_id: board.board_id,
          name: 'ada',
          ref: 'ada',
          path: '/fictional/worktrees/example/repo/ada',
          branch_unique_id: 1,
          created_by: ada.user_id,
          storage_mode: 'clone',
          filesystem_status: 'ready',
          custom_context: { teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🦊' } },
        });
        const { namespace } = await ensureTeammateKnowledgeNamespace(
          db,
          branch.branch_id,
          ada.user_id
        );
        const docs = new KnowledgeDocumentsService(db, server.app);
        await docs.create(
          {
            namespace_id: namespace.namespace_id,
            path: 'docs/plan.md',
            title: 'Plan',
            content_text: '# Plan\n\nv1',
          },
          params(ada)
        );
        const plan = await new KnowledgeDocumentRepository(db).findByNamespaceAndPath(
          namespace.namespace_id,
          'docs/plan.md'
        );
        await docs.patch(plan!.document_id, { content_text: '# Plan\n\nv2' }, params(ada));
        await docs.create(
          {
            namespace_id: namespace.namespace_id,
            path: 'docs/notes.md',
            title: 'Notes',
            content_text: `See [the plan](agor://kb/${namespace.slug}/docs/plan.md).`,
          },
          params(ada)
        );
        await docs.create(
          {
            namespace_id: namespace.namespace_id,
            path: 'docs/ideas.md',
            title: 'Ideas',
            content_text: 'Ideas',
          },
          params(ada)
        );
        const artifact = await new ArtifactRepository(db).create({
          board_id: board.board_id,
          branch_id: branch.branch_id,
          name: 'Dashboard',
          files: { '/App.js': 'export default () => null;' },
          public: false,
          created_by: ada.user_id,
        });
        await new BoardRepository(db).upsertBoardObject(board.board_id, 'artifact-a', {
          type: 'artifact',
          artifact_id: artifact.artifact_id,
          x: 10,
          y: 10,
          width: 400,
          height: 300,
        } as never);
        await new ScheduleRepository(db).create({
          branch_id: branch.branch_id,
          name: 'Daily digest',
          cron_expression: '0 9 * * *',
          timezone_mode: 'utc',
          prompt: 'Summarize',
          agentic_tool_config: { agentic_tool: 'claude-code' },
          enabled: true,
          created_by: ada.user_id,
        } as never);
        const sessions = new SessionRepository(db);
        const first = await sessions.create({
          branch_id: branch.branch_id,
          created_by: ada.user_id,
          agentic_tool: 'claude-code',
          sdk_session_id: 'sdk-resume-state',
          title: 'First',
        });
        const second = await sessions.create({
          branch_id: branch.branch_id,
          created_by: ada.user_id,
          agentic_tool: 'claude-code',
          title: 'Second',
          genealogy: { parent_session_id: first.session_id, children: [] },
        });
        const task = await new TaskRepository(db).create({
          session_id: first.session_id,
          created_by: ada.user_id,
          full_prompt: 'Hello',
          status: 'completed',
        });
        return { repo, board, branch, namespace, artifact, first, second, task };
      });
      const upload = await getUploadStagingStore().stage({
        owner: {
          tenantId: TENANT,
          sessionId: seeded.first.session_id,
          branchId: seeded.branch.branch_id,
          createdBy: ada.user_id as UUID,
        },
        name: 'chart.png',
        mimeType: 'image/png',
        provenance: 'browser',
        body: Readable.from([Buffer.from('png-bytes')]),
      });
      await unit(() =>
        new MessagesRepository(db).create({
          session_id: seeded.first.session_id,
          task_id: seeded.task.task_id,
          type: 'user',
          role: 'user',
          index: 0,
          timestamp: new Date().toISOString(),
          content_preview: 'chart',
          content: `look [chart](${UPLOAD_VIRTUAL_URL_PREFIX}${upload.ref})`,
        } as never)
      );
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

      // ---- Export as Ada --------------------------------------------------------
      const writer = new AgorPackWriter();
      const chunks: Buffer[] = [];
      writer.output.on('data', (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise((resolve) => writer.output.on('end', resolve));
      const manifest = await new AgorPackExporter(ctx(ada)).export(
        {
          branch_ids: [seeded.branch.branch_id],
          sections: [
            'board',
            'knowledge',
            'knowledge_history',
            'artifacts',
            'schedules',
            'claude_memory',
            'uploads',
          ],
          sessions: 'all',
          include_others_sessions: false,
        },
        writer
      );
      await ended;
      const pack = Buffer.concat(chunks);
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
      reader.close();
      const sections = manifest.teammates[0]!.sections;
      expect(sections.knowledge).toEqual({ documents: 3, history_versions: 1 });
      expect(sections.sessions?.count).toBe(2);
      expect(sections.uploads?.count).toBe(1);
      expect(sections.sessions?.redacted_values).toBe(2);

      // ---- Import as Bea ----------------------------------------------------------
      const importer = new AgorPackImporter(ctx(bea), params(bea));
      const staged = await importer.stage(Readable.from([pack]), pack.byteLength);
      expect(staged.dry_run[0]).toMatchObject({ key: 't01', repo_status: 'existing' });
      const applied = await importer.apply(staged.import_id, {
        teammates: ['t01'],
        board_id: null,
      });
      expect(applied.status).toBe('applied');
      const result = applied.results[0]!;

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
        expect(
          (branch?.custom_context?.teammate as { imported_from?: { originally_by?: unknown } })
            ?.imported_from?.originally_by
        ).toEqual({ name: 'Ada', email: 'ada@example.test' });

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
    } finally {
      await server.close();
    }
  }
);
