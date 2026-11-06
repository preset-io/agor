/**
 * Shared `.agor` test fixture: a real REST app with the pack routes, a
 * seeded teammate (board, Knowledge, artifact, schedule, sessions, attachment)
 * owned by Ada, and its exported pack. Used by the SQLite and PostgreSQL
 * round-trip tests.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type AgorPackUploadSend, AgorPackWriter, uploadPackChunked } from '@agor/core/agor-pack';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  KnowledgeDocumentRepository,
  MessagesRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { authenticate } from '@agor/core/feathers';
import {
  AGOR_PACK,
  type AgorPackChunkedUpload,
  type AgorPackImport,
  type AgorPackManifest,
  type BranchID,
  type HookContext,
  type TenantID,
  UPLOAD_VIRTUAL_URL_PREFIX,
  type User,
  type UUID,
} from '@agor/core/types';
import { LocalUploadStagingStore } from '../src/host/local/upload-staging-store.js';
import type { RegisterHooksContext } from '../src/register-hooks.js';
import { createUploadAuthMiddleware } from '../src/register-routes.js';
import { registerAgorPackRoutes } from '../src/routes/agor-pack.js';
import { setAgorPackChunkBytesForTests } from '../src/services/agor-pack-chunked-upload.js';
import { AgorPackExporter, type AgorPackServiceContext } from '../src/services/agor-pack-export.js';
import { KnowledgeDocumentsService } from '../src/services/knowledge-documents.js';
import { ReposService } from '../src/services/repos.js';
import { createSchedulesService } from '../src/services/schedules.js';
import { ensureTeammateKnowledgeNamespace } from '../src/services/teammate-knowledge.js';
import { registerAuthenticatedRoute } from '../src/utils/authorization.js';
import { MetadataUploadStagingStore } from '../src/utils/metadata-upload-staging-store.js';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteAdmissionAroundHook,
} from '../src/utils/tenant-db-scope.js';
import {
  configureUploadStagingStore,
  getUploadStagingStore,
  localPackBytes,
} from '../src/utils/upload-staging.js';
import { BOARD_METADATA_TEST_JWT_SECRET, boardMetadataTestApp } from './board-metadata-app.js';

export type PackFixture = Awaited<ReturnType<typeof createPackFixture>>;

export async function createPackFixture(input: {
  raw: Database;
  tenant: TenantID;
  config: RegisterHooksContext['config'];
  uploadsRoot: string;
}) {
  const { tenant, config } = input;
  const db = createTenantScopedDatabaseProxy(input.raw, { label: 'agor-pack-fixture' });
  const unit = <T>(work: () => Promise<T>, tenantId: TenantID = tenant) =>
    runWithTenantDatabaseScope(db, tenantId, work);
  configureUploadStagingStore(
    () =>
      new MetadataUploadStagingStore(
        db,
        new LocalUploadStagingStore((t) => join(input.uploadsRoot, t), { ttlMs: 0 }),
        {
          bytes: localPackBytes((t) => join(input.uploadsRoot, t, 'agor-packs')),
          ttlMs: 60 * 60 * 1000,
        }
      )
  );
  const server = await boardMetadataTestApp(db, config, false, false, false, async (app) => {
    await app.unuse('repos');
    app.use('repos', new ReposService(db, app), {
      methods: ['find', 'get', 'create', 'patch', 'createBranch', 'cloneRepository'],
    } as never);
    await app.unuse('schedules');
    app.use('schedules', createSchedulesService(db));
    for (const path of ['artifacts', 'gateway-channels']) {
      app.use(path, {
        async find() {
          return [];
        },
      });
    }
    registerAgorPackRoutes({
      app,
      db,
      config,
      agorVersion: '0.0.0-test',
      // The daemon's long-route registrar: tenant identity + write gate, no transaction.
      registerLongAuthenticatedRoute: (
        routeApp,
        path,
        service,
        authConfig,
        requireAuth,
        options = {}
      ) =>
        registerAuthenticatedRoute(routeApp, path, service, authConfig, requireAuth, {
          ...options,
          around: [
            createTenantDatabaseScopeAroundHook({
              db,
              config,
              jwtSecret: BOARD_METADATA_TEST_JWT_SECRET,
              transaction: false,
            }),
            createTenantWriteAdmissionAroundHook(db),
          ],
        }),
      requireAuth: authenticate({ strategies: ['jwt'] }) as (
        context: HookContext
      ) => Promise<HookContext>,
      streamAuth: createUploadAuthMiddleware({
        authentication: app.service('authentication') as never,
        multiTenancy: resolveMultiTenancyConfig(config),
      }),
    });
  });
  Object.assign(server.app, {
    sessionTokenService: { generateCommandToken: async () => 'command-token' },
  });

  const createUser = (email: string, tenantId: TenantID = tenant) =>
    unit(
      () =>
        new UsersRepository(db).create({
          email,
          name: email.charAt(0).toUpperCase() + email.slice(1).split('@')[0],
          role: 'member',
        }),
      tenantId
    );
  const params = (user: User, tenantId: TenantID = tenant) => ({
    user,
    tenant: { tenant_id: tenantId, source: 'explicit' as const },
  });
  const ctx = (user: User, tenantId: TenantID = tenant): AgorPackServiceContext => ({
    app: server.app,
    db,
    config,
    tenantId,
    user,
    agorVersion: '0.0.0-test',
  });

  const ada = await createUser('ada@example.test');
  const bea = await createUser('bea@example.test');

  // ---- Seed Ada's teammate --------------------------------------------------
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
    const { namespace } = await ensureTeammateKnowledgeNamespace(db, branch.branch_id, ada.user_id);
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
        content_text: 'Ideas, see [the wiki](agor://kb/team-wiki/home.md).',
      },
      params(ada)
    );
    // Archived Knowledge stays behind.
    const old = (await docs.create(
      {
        namespace_id: namespace.namespace_id,
        path: 'docs/old.md',
        title: 'Old',
        content_text: 'Old notes',
      },
      params(ada)
    )) as { document_id: string };
    await docs.remove(old.document_id, params(ada));
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
    // Archived sessions stay behind too.
    await sessions.create({
      branch_id: branch.branch_id,
      created_by: ada.user_id,
      agentic_tool: 'claude-code',
      title: 'Archived chat',
      archived: true,
      archived_reason: 'manual',
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
      tenantId: tenant,
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

  /** Export Ada's teammate (all sections) as a pack buffer. */
  const exportPack = async (): Promise<{ pack: Buffer; manifest: AgorPackManifest }> => {
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
    return { pack: Buffer.concat(chunks), manifest };
  };

  return {
    db,
    unit,
    server,
    ctx,
    params,
    createUser,
    ada,
    bea,
    seeded,
    upload,
    exportPack,
    close: () => server.close(),
  };
}

/**
 * Over HTTP: nobody but the creator downloads an export, nobody but the
 * importer reads or applies an import, and switch-over needs write access to
 * the source teammate. `foreign` adds callers from other tenants.
 */
export async function expectPackRoutesIsolated(
  fx: PackFixture,
  expect: typeof import('vitest').expect,
  foreign: Array<{ user: User; tenantId: TenantID }> = []
) {
  const { server, ada, bea, seeded } = fx;
  const tenantOf = (tenantId: TenantID) =>
    resolveMultiTenancyConfig(server.app.get('config')).mode === 'static' ? undefined : tenantId;
  const home = fx.ctx(ada).tenantId;
  const as = (user: User, tenantId: TenantID = home) =>
    server.headers(user.user_id as never, tenantOf(tenantId));

  const exported = await fetch(`${server.url}/agor-pack/exports`, {
    method: 'POST',
    headers: as(ada),
    body: JSON.stringify({
      branch_ids: [seeded.branch.branch_id],
      sections: ['board', 'schedules'],
      sessions: 'none',
      include_others_sessions: false,
    }),
  });
  expect(exported.ok, await exported.clone().text()).toBe(true);
  const { export_id, ref } = (await exported.json()) as { export_id: string; ref: string };
  const download = `${server.url}/agor-pack/downloads/${export_id}/${ref}`;
  const own = await fetch(download, { headers: as(ada) });
  expect(own.status).toBe(200);
  const pack = Buffer.from(await own.arrayBuffer());

  const uploaded = await fetch(`${server.url}/agor-pack/uploads`, {
    method: 'POST',
    headers: { ...as(bea), 'content-type': 'application/zip' },
    body: pack,
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const { import_id } = (await uploaded.json()) as { import_id: string };
  expect(
    (await fetch(`${server.url}/agor-pack/imports/${import_id}`, { headers: as(bea) })).status
  ).toBe(200);

  const strangers = [{ user: bea, tenantId: home }, ...foreign];
  for (const { user, tenantId } of [{ user: ada, tenantId: home }, ...foreign]) {
    const headers = as(user, tenantId);
    expect((await fetch(`${server.url}/agor-pack/imports/${import_id}`, { headers })).status).toBe(
      404
    );
    const apply = await fetch(`${server.url}/agor-pack/imports/${import_id}/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ teammates: ['t01'], board_id: null }),
    });
    expect(apply.status).toBe(404);
  }
  for (const { user, tenantId } of strangers) {
    const headers = as(user, tenantId);
    expect((await fetch(download, { headers })).status).toBe(404);
    const switched = await fetch(`${server.url}/agor-pack/switch-over/${seeded.branch.branch_id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ undo: false }),
    });
    expect(switched.status).toBeGreaterThanOrEqual(400);
    expect(switched.status).toBeLessThan(500);
  }
  // The owner can; the state is server-managed branch data, not custom_context.
  const switchOver = (undo: boolean) =>
    fetch(`${server.url}/agor-pack/switch-over/${seeded.branch.branch_id}`, {
      method: 'POST',
      headers: as(ada),
      body: JSON.stringify({ undo }),
    });
  const switched = await switchOver(false);
  expect(switched.ok, await switched.clone().text()).toBe(true);
  await fx.unit(async () => {
    const [schedule] = await new ScheduleRepository(fx.db).findByBranchId(
      seeded.branch.branch_id as never
    );
    expect(schedule?.enabled).toBe(false);
    const branch = await new BranchRepository(fx.db).findById(seeded.branch.branch_id);
    expect(branch?.agor_pack?.switch_over?.disabled_schedule_ids).toEqual([schedule?.schedule_id]);
    expect(branch?.custom_context).not.toHaveProperty('move_to_cloud');
  });
  expect((await switchOver(true)).ok).toBe(true);
  await fx.unit(async () => {
    const [schedule] = await new ScheduleRepository(fx.db).findByBranchId(
      seeded.branch.branch_id as never
    );
    expect(schedule?.enabled).toBe(true);
    const branch = await new BranchRepository(fx.db).findById(seeded.branch.branch_id);
    expect(branch?.agor_pack?.switch_over ?? null).toBeNull();
  });
}

/**
 * Resumable upload over HTTP: out-of-order and repeated chunks, resume after
 * a dropped connection, a repeated `complete`, a wrong checksum, the size
 * caps, and isolation (another user or tenant can't see, extend, or finish
 * someone's upload; the same file uploaded by two users stays two uploads).
 */
export async function expectChunkedUploadWorks(
  fx: PackFixture,
  expect: typeof import('vitest').expect,
  foreign: Array<{ user: User; tenantId: TenantID }> = []
) {
  const { server, ada, bea } = fx;
  const tenantOf = (tenantId: TenantID) =>
    resolveMultiTenancyConfig(server.app.get('config')).mode === 'static' ? undefined : tenantId;
  const home = fx.ctx(ada).tenantId;
  const as = (user: User, tenantId: TenantID = home) =>
    server.headers(user.user_id as never, tenantOf(tenantId));
  const base = `${server.url}/agor-pack/uploads/chunked`;
  const send =
    (user: User, tenantId: TenantID = home): AgorPackUploadSend =>
    (path, init) => {
      const headers = new Headers(as(user, tenantId));
      for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
      return fetch(`${server.url}${path}`, {
        method: init.method,
        headers,
        body: init.body as never,
      });
    };
  const { pack } = await fx.exportPack();
  const sha256 = createHash('sha256').update(pack).digest('hex');
  setAgorPackChunkBytesForTests(1024);
  try {
    const init = async (user: User, body: unknown, tenantId: TenantID = home) =>
      fetch(base, {
        method: 'POST',
        headers: { ...as(user, tenantId), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const put = (user: User, id: string, index: number, bytes: Buffer, tenantId = home) =>
      fetch(`${base}/${id}/${index}`, {
        method: 'PUT',
        headers: { ...as(user, tenantId), 'content-type': 'application/octet-stream' },
        body: bytes,
      });
    const chunk = (index: number) => pack.subarray(index * 1024, (index + 1) * 1024);

    // Caps and shape.
    expect((await init(bea, { size: AGOR_PACK.maxBytes + 1, sha256 })).status).toBe(413);
    expect((await init(bea, { size: pack.byteLength })).status).toBe(400);
    const started = await init(bea, { size: pack.byteLength, sha256 });
    expect(started.status, await started.clone().text()).toBe(200);
    const state = (await started.json()) as AgorPackChunkedUpload;
    expect(state).toMatchObject({ chunk_size: 1024, received: [], import_id: null });
    expect(state.chunks).toBeGreaterThan(2);
    const last = state.chunks - 1;
    expect((await put(bea, state.upload_id, state.chunks, chunk(0))).status).toBe(400);
    expect((await put(bea, state.upload_id, 0, chunk(0).subarray(1))).status).toBe(400);
    expect((await put(bea, state.upload_id, 0, Buffer.alloc(1025))).status).toBe(413);

    // Out of order and repeated; then the connection "drops".
    expect((await put(bea, state.upload_id, last, chunk(last))).status).toBe(200);
    expect((await put(bea, state.upload_id, 1, chunk(1))).status).toBe(200);
    const again = await put(bea, state.upload_id, 1, chunk(1));
    expect(((await again.json()) as AgorPackChunkedUpload).received).toEqual([1, last]);

    // Nobody else sees, extends, or finishes it.
    for (const { user, tenantId } of [{ user: ada, tenantId: home }, ...foreign]) {
      expect(
        (await fetch(`${base}/${state.upload_id}`, { headers: as(user, tenantId) })).status
      ).toBe(404);
      expect((await put(user, state.upload_id, 0, chunk(0), tenantId)).status).toBe(404);
      const complete = await fetch(`${base}/${state.upload_id}/complete`, {
        method: 'POST',
        headers: as(user, tenantId),
      });
      expect(complete.status).toBe(404);
      // The same file from someone else is their own upload.
      const theirs = (await (
        await init(user, { size: pack.byteLength, sha256 }, tenantId)
      ).json()) as AgorPackChunkedUpload;
      expect(theirs.received).toEqual([]);
    }

    // Incomplete: refused; resuming sends only what's missing.
    const early = await fetch(`${base}/${state.upload_id}/complete`, {
      method: 'POST',
      headers: as(bea),
    });
    expect(early.status).toBe(409);
    const sent: number[] = [];
    const receipt = await uploadPackChunked({
      size: pack.byteLength,
      sha256,
      readChunk: async (start, end) => pack.subarray(start, end),
      send: (path, request) => {
        const index = /\/(\d+)$/.exec(path)?.[1];
        if (request.method === 'PUT' && index) sent.push(Number(index));
        return send(bea)(path, request);
      },
      retryDelayMs: 0,
    });
    expect(sent).not.toContain(1);
    expect(sent).not.toContain(last);
    expect(sent).toHaveLength(state.chunks - 2);
    expect(receipt.manifest.teammates[0]?.display_name).toBe('Ada');

    // Repeating `complete` (a lost response) or the whole upload returns the receipt.
    const repeated = await fetch(`${base}/${state.upload_id}/complete`, {
      method: 'POST',
      headers: as(bea),
    });
    expect(((await repeated.json()) as AgorPackImport).import_id).toBe(receipt.import_id);
    const resent: number[] = [];
    const second = await uploadPackChunked({
      size: pack.byteLength,
      sha256,
      readChunk: async (start, end) => pack.subarray(start, end),
      send: (path, request) => {
        if (request.method === 'PUT') resent.push(1);
        return send(bea)(path, request);
      },
      retryDelayMs: 0,
    });
    expect(second.import_id).toBe(receipt.import_id);
    expect(resent).toEqual([]);

    // A wrong checksum is refused and the chunks are dropped.
    const wrong = createHash('sha256').update('something else').digest('hex');
    await expect(
      uploadPackChunked({
        size: pack.byteLength,
        sha256: wrong,
        readChunk: async (start, end) => pack.subarray(start, end),
        send: send(bea),
        retryDelayMs: 0,
      })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/checksum/) });
    const dropped = (await (
      await init(bea, { size: pack.byteLength, sha256: wrong })
    ).json()) as AgorPackChunkedUpload;
    expect(dropped.received).toEqual([]);

    // A transient failure mid-upload is retried, not fatal.
    let failures = 1;
    const flaky = await uploadPackChunked({
      size: pack.byteLength,
      sha256,
      readChunk: async (start, end) => pack.subarray(start, end),
      send: async (path, request) => {
        if (request.method === 'POST' && failures-- > 0) throw new TypeError('fetch failed');
        return send(bea)(path, request);
      },
      retryDelayMs: 0,
    });
    expect(flaky.import_id).toBe(receipt.import_id);
  } finally {
    setAgorPackChunkBytesForTests();
  }
}
