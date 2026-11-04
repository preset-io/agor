/**
 * `.agorpack` import: stage → dry-run → apply.
 *
 * - The importer owns everything it creates (`created_by`/owner = importer);
 *   the original author survives only as "originally by" metadata.
 * - Every row gets a new id; the per-teammate remap is stored on the
 *   `agor_pack_imports` receipt, keyed by (owner, pack content hash), so
 *   importing the same pack again returns the same result instead of
 *   duplicating anything.
 * - Schedules arrive disabled, custom MCP servers disabled and without
 *   credentials, sessions archived as read-only history without SDK resume
 *   state, attachments keep their `upl_` refs.
 * - Rows go through the existing services/repositories (createBranch, board
 *   import, Knowledge documents, schedules, MCP servers); the branch's files
 *   are written afterwards by the executor (`branch.pack.materialize`) once
 *   the checkout is ready.
 */

import {
  type AgorPackByteSource,
  AgorPackFormatError,
  AgorPackReader,
  teammatePackPath,
} from '@agor/core/agor-pack';
import { normalizeRepoUrl } from '@agor/core/config';
import {
  AgenticToolPresetRepository,
  type AgorPackImportRecord,
  AgorPackImportRepository,
  ArtifactRepository,
  assertTenantWritable,
  BoardRepository,
  BranchRepository,
  MessagesRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UploadRepository,
} from '@agor/core/db';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  type AgorPackApplyRequest,
  type AgorPackDryRunTeammate,
  type AgorPackImport,
  type AgorPackManifest,
  type AgorPackTeammateFile,
  type AgorPackTeammateResult,
  type AgorPackTeammateSummary,
  type AuthenticatedParams,
  agorPackArtifactFileSchema,
  agorPackBoardFileSchema,
  agorPackKnowledgeHistorySchema,
  agorPackMessageSchema,
  agorPackSchedulesFileSchema,
  agorPackSessionFileSchema,
  agorPackTeammateFileSchema,
  agorPackUploadFileSchema,
  type Board,
  type BoardExportBlob,
  type BoardObject,
  type Branch,
  type BranchID,
  getTeammateConfig,
  type MessageCreate,
  type MessageID,
  type Repo,
  type SessionID,
  type TaskID,
  TaskStatus,
  TEAMMATE_FRAMEWORK_DEFAULT_BRANCH,
  TEAMMATE_FRAMEWORK_REPO_SLUG,
  TEAMMATE_FRAMEWORK_REPO_URL,
  type UploadRef,
  type UUID,
} from '@agor/core/types';
import type { BoardsServiceImpl, ReposServiceImpl } from '../declarations.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { getAgorPackStagingStore, getUploadStagingStore } from '../utils/upload-staging.js';
import {
  agorPackMaterializeExecutorCommandId,
  runAgorPackExecutorCommand,
} from './agor-pack-executor.js';
import { type AgorPackServiceContext, pluralize } from './agor-pack-export.js';
import { importKnowledgeRepository } from './knowledge-transfers.js';

const KNOWN_SECTIONS = new Set([
  'board',
  'knowledge',
  'artifacts',
  'schedules',
  'claude_memory',
  'uploads',
  'sessions',
  'git',
]);
const TERMINAL_TASK_STATUSES = new Set<string>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);
const READY_POLL_MS = 2_000;
const READY_TIMEOUT_MS = 15 * 60 * 1000;

/** One apply at a time per import on this daemon (double-click guard). */
const applying = new Set<string>();
/** Serializes receipt result updates from background materialization. */
const resultLocks = new Map<string, Promise<unknown>>();

function stagingOwner(
  ctx: AgorPackServiceContext,
  record: Pick<AgorPackImportRecord, 'owner_user_id' | 'staging_ref'>
) {
  const [key, ref] = (record.staging_ref ?? '').split(':');
  if (!key || !ref) return null;
  return {
    tenantId: ctx.tenantId,
    sessionId: key as UUID,
    branchId: record.owner_user_id as UUID,
    ref: ref as UploadRef,
  };
}

/** Read a staged pack (bytes only) as a random-access pack source. */
export async function openStagedPack(
  ctx: Pick<AgorPackServiceContext, 'tenantId'>,
  record: Pick<AgorPackImportRecord, 'owner_user_id' | 'staging_ref'>
): Promise<{ source: AgorPackByteSource; owner: NonNullable<ReturnType<typeof stagingOwner>> }> {
  const owner = stagingOwner(ctx as AgorPackServiceContext, record);
  if (!owner) throw new Conflict('The pack file is no longer staged; upload it again');
  const store = getAgorPackStagingStore();
  const meta = await store.inspect(owner);
  return {
    owner,
    source: {
      size: meta.size,
      readRange: async (start, end) =>
        (await store.read({ ...owner, offset: start, length: end - start })) as never,
    },
  };
}

function publicImport(record: AgorPackImportRecord): AgorPackImport {
  const { owner_user_id: _owner, staging_ref: _ref, ...rest } = record;
  return rest;
}

export class AgorPackImporter {
  constructor(
    private readonly ctx: AgorPackServiceContext,
    private readonly params: AuthenticatedParams
  ) {}

  private unit<T>(work: () => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.ctx.db, this.ctx.tenantId, work);
  }

  /** Short mutating unit that honors the tenant write gate (like MCP writes). */
  private write<T>(work: () => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.ctx.db, this.ctx.tenantId, async () => {
      await assertTenantWritable(this.ctx.db, this.ctx.tenantId);
      return work();
    });
  }

  private receipts(): AgorPackImportRepository {
    return new AgorPackImportRepository(this.ctx.db);
  }

  private async load(importId: string): Promise<AgorPackImportRecord> {
    const record = await this.unit(() => this.receipts().findById(importId));
    if (!record || record.owner_user_id !== this.ctx.user.user_id) {
      throw new NotFound('Import not found');
    }
    return record;
  }

  async get(importId: string): Promise<AgorPackImport> {
    return publicImport(await this.load(importId));
  }

  /**
   * Stage an uploaded pack, validate it, and return the dry-run. Re-uploading
   * a pack this user already imported returns the existing receipt.
   */
  async stage(body: NodeJS.ReadableStream, size: number): Promise<AgorPackImport> {
    const store = getAgorPackStagingStore();
    await store.cleanupExpired({ tenantId: this.ctx.tenantId }).catch(() => 0);
    const stagingKey = generateId();
    const staged = await store.stage({
      owner: {
        tenantId: this.ctx.tenantId,
        sessionId: stagingKey as UUID,
        branchId: this.ctx.user.user_id as UUID,
        createdBy: this.ctx.user.user_id as UUID,
      },
      name: `import.agorpack`,
      mimeType: 'application/zip',
      provenance: 'import',
      body,
      sizeHint: size,
    });
    const stagingRef = `${stagingKey}:${staged.ref}`;
    const pending = { owner_user_id: this.ctx.user.user_id, staging_ref: stagingRef };
    let manifest: AgorPackManifest;
    try {
      const { source } = await openStagedPack(this.ctx, pending);
      const reader = await AgorPackReader.open(source);
      manifest = reader.manifest;
      reader.close();
    } catch (error) {
      await store.delete(stagingOwner(this.ctx, pending)!).catch(() => undefined);
      throw error;
    }

    const existing = await this.unit(() =>
      this.receipts().findByContent(this.ctx.user.user_id, manifest.content_sha256)
    );
    const dryRun = await this.dryRun(manifest, existing?.results ?? []);
    if (existing) {
      // Keep the freshest bytes so teammates not yet imported can still be applied.
      const previous = stagingOwner(this.ctx, existing);
      if (previous) await store.delete(previous).catch(() => undefined);
      const updated = await this.write(() =>
        this.receipts().update(existing.import_id, { staging_ref: stagingRef, dry_run: dryRun })
      );
      return publicImport(updated);
    }
    const created = await this.write(() =>
      this.receipts().create({
        owner_user_id: this.ctx.user.user_id,
        content_sha256: manifest.content_sha256,
        staging_ref: stagingRef,
        manifest,
        dry_run: dryRun,
      })
    );
    return publicImport(created);
  }

  private async findRepoByRemote(remoteUrl: string): Promise<Repo | null> {
    const wanted = normalizeRepoUrl(remoteUrl);
    const repos = await this.unit(() => new RepoRepository(this.ctx.db).findAll());
    return (
      repos.find((repo) => repo.remote_url && normalizeRepoUrl(repo.remote_url) === wanted) ?? null
    );
  }

  private async dryRun(
    manifest: AgorPackManifest,
    results: AgorPackTeammateResult[]
  ): Promise<AgorPackDryRunTeammate[]> {
    const out: AgorPackDryRunTeammate[] = [];
    for (const teammate of manifest.teammates) {
      const warnings = [...teammate.warnings];
      const repoStatus: AgorPackDryRunTeammate['repo_status'] = teammate.repo.local_home
        ? 'framework'
        : teammate.repo.remote_url && (await this.findRepoByRemote(teammate.repo.remote_url))
          ? 'existing'
          : 'clone';
      if (!teammate.repo.local_home && !teammate.repo.remote_url) {
        warnings.push('This teammate has no git remote; its files cannot be restored here.');
      }
      for (const variant of teammate.environment.variants) {
        if (variant.status === 'wont_run_in_cloud') {
          warnings.push(
            `Environment "${variant.name}" uses ${variant.match}; it won't run in Agor Cloud.`
          );
        } else if (variant.status === 'needs_webhook') {
          warnings.push(
            `Environment "${variant.name}" points at ${variant.match}; use a webhook in Agor Cloud.`
          );
        }
      }
      const unknown = Object.keys(teammate.sections).filter((key) => !KNOWN_SECTIONS.has(key));
      if (unknown.length) {
        warnings.push(`Skipped sections from a newer Agor: ${unknown.join(', ')}.`);
      }
      if (teammate.sections.sessions?.others_included) {
        warnings.push("Includes other people's sessions; you will own the imported copies.");
      }
      out.push({
        key: teammate.key,
        display_name: teammate.display_name,
        repo_status: repoStatus,
        already_imported_branch_id:
          results.find((result) => result.key === teammate.key)?.branch_id ?? null,
        warnings,
      });
    }
    return out;
  }

  /**
   * Import the selected teammates. Already-imported teammates are returned as
   * they are (their filesystem leg is retried if it failed).
   */
  async apply(importId: string, request: AgorPackApplyRequest): Promise<AgorPackImport> {
    if (applying.has(importId)) throw new Conflict('This import is already being applied');
    applying.add(importId);
    try {
      const record = await this.load(importId);
      const selected = record.manifest.teammates.filter((t) => request.teammates.includes(t.key));
      if (selected.length !== new Set(request.teammates).size) {
        throw new BadRequest('Unknown teammate key in the request');
      }
      if (request.board_id) {
        // Throws unless the importer can see the board.
        await this.ctx.app.service('boards').get(request.board_id, this.params);
      }
      let results = [...record.results];
      const todo = selected.filter((t) => !results.some((r) => r.key === t.key));
      if (todo.length > 0) {
        await this.write(() =>
          this.receipts().update(importId, { status: 'applying', error: null })
        );
        const { source } = await openStagedPack(this.ctx, record);
        const reader = await AgorPackReader.open(source);
        try {
          if (reader.manifest.content_sha256 !== record.content_sha256) {
            throw new AgorPackFormatError('Staged pack does not match this import');
          }
          for (const teammate of todo) {
            const file = await reader.readJson(
              teammatePackPath(teammate.key, 'teammate.json'),
              agorPackTeammateFileSchema
            );
            // Registering/cloning a repository commits on its own; the teammate's
            // rows then land in one tenant transaction (all or nothing).
            const repo = await this.ensureRepo(file);
            const result = await this.write(() =>
              this.applyTeammate(reader, teammate, file, repo, request.board_id)
            );
            results = [...results, result];
            await this.write(() => this.receipts().update(importId, { results }));
          }
        } catch (error) {
          await this.write(() =>
            this.receipts().update(importId, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
          );
          throw error;
        } finally {
          reader.close();
        }
      }
      const updated = await this.write(() =>
        this.receipts().update(importId, {
          status: 'applied',
          error: null,
          applied_at: record.applied_at ? new Date(record.applied_at) : new Date(),
          results,
        })
      );
      return publicImport(updated);
    } finally {
      applying.delete(importId);
    }
  }

  private async ensureRepo(file: AgorPackTeammateFile): Promise<Repo> {
    const url = file.repo.local_home ? TEAMMATE_FRAMEWORK_REPO_URL : file.repo.remote_url;
    if (!url)
      throw new BadRequest(`${file.teammate.displayName} has no git remote to restore from`);
    let repo = await this.findRepoByRemote(url);
    if (!repo) {
      const repos = this.ctx.app.service('repos') as unknown as ReposServiceImpl;
      const cloned = await repos.cloneRepository(
        file.repo.local_home
          ? {
              url,
              slug: TEAMMATE_FRAMEWORK_REPO_SLUG,
              default_branch: TEAMMATE_FRAMEWORK_DEFAULT_BRANCH,
            }
          : {
              url,
              slug: file.repo.slug,
              ...(file.repo.default_branch ? { default_branch: file.repo.default_branch } : {}),
            },
        this.params
      );
      repo = await this.unit(() => new RepoRepository(this.ctx.db).findBySlug(cloned.slug));
    }
    if (!repo) throw new BadRequest('Repository registration failed');
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (repo.clone_status === 'cloning' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      repo =
        (await this.unit(() => new RepoRepository(this.ctx.db).findById(repo!.repo_id))) ?? repo;
    }
    if (repo.clone_status === 'failed') {
      throw new BadRequest(`Could not clone ${repo.slug}; check repository access and retry`);
    }
    if (repo.clone_status === 'cloning')
      throw new BadRequest(`${repo.slug} is still cloning; retry shortly`);
    // Environment configuration travels; set it only on a repo that has none.
    if (!repo.environment && file.repo.environment && !file.repo.local_home) {
      await this.ctx.app
        .service('repos')
        .patch(repo.repo_id, { environment: file.repo.environment as never }, this.params)
        .catch(() => undefined);
    }
    return repo;
  }

  private async uniqueBranchName(repoId: string, wanted: string): Promise<string> {
    const branches = new BranchRepository(this.ctx.db);
    for (let n = 1; n < 100; n += 1) {
      const name = n === 1 ? wanted : `${wanted}-${n}`;
      if (!(await this.unit(() => branches.findByRepoAndName(repoId as UUID, name)))) return name;
    }
    throw new Conflict(`No free branch name for ${wanted}`);
  }

  private async applyTeammate(
    reader: AgorPackReader,
    summary: AgorPackTeammateSummary,
    file: AgorPackTeammateFile,
    repo: Repo,
    existingBoardId: string | null
  ): Promise<AgorPackTeammateResult> {
    const path = (relative: string) => teammatePackPath(summary.key, relative);
    const warnings: string[] = [];
    const userId = this.ctx.user.user_id;
    const importedFrom = {
      pack_id: reader.manifest.pack_id,
      source_branch_id: summary.source_branch_id,
      originally_by: file.originally_by,
      imported_at: new Date().toISOString(),
    };

    // 1. Board (artifact objects are re-added once the artifacts exist).
    const boardFile = reader.has(path('board.json'))
      ? await reader.readJson(path('board.json'), agorPackBoardFileSchema)
      : null;
    let boardId = existingBoardId;
    let artifactObjects: Record<string, BoardObject> = {};
    if (!boardId) {
      const blob = (boardFile?.board ?? {
        name: `${file.teammate.displayName}'s Board`,
        icon: file.teammate.emoji,
      }) as unknown as BoardExportBlob & { version?: number };
      const { version: _version, ...boardBlob } = blob;
      const objects: Record<string, BoardObject> = {};
      for (const [id, object] of Object.entries(boardBlob.objects ?? {})) {
        if (object.type === 'artifact') artifactObjects[id] = object;
        else objects[id] = object;
      }
      const slugTaken = boardBlob.slug
        ? await this.unit(() =>
            new BoardRepository(this.ctx.db).findBySlug(boardBlob.slug as string)
          )
        : null;
      const boards = this.ctx.app.service('boards') as unknown as BoardsServiceImpl;
      const board = (await boards.fromBlob(
        {
          ...boardBlob,
          ...(slugTaken ? { slug: undefined } : {}),
          objects,
          custom_context: { ...(boardBlob.custom_context ?? {}), imported_from: importedFrom },
        },
        this.params
      )) as Board & { import_skipped?: unknown[] };
      boardId = board.board_id;
      if (board.import_skipped?.length) {
        warnings.push(
          `${pluralize(board.import_skipped.length, 'board object')} could not be imported.`
        );
      }
    } else {
      artifactObjects = {};
    }

    // 2. Branch (KB namespace and primary-teammate wiring happen in branches.create).
    const name = await this.uniqueBranchName(repo.repo_id, file.branch.name);
    const repos = this.ctx.app.service('repos') as unknown as ReposServiceImpl;
    const created = await this.write(() =>
      repos.createBranch(
        repo.repo_id,
        {
          name,
          ref: name,
          createBranch: true,
          sourceBranch: file.repo.local_home
            ? TEAMMATE_FRAMEWORK_DEFAULT_BRANCH
            : (repo.default_branch ?? file.repo.default_branch ?? 'main'),
          boardId: boardId as string,
          ...(existingBoardId || !boardFile?.placement
            ? {}
            : {
                position: boardFile.placement.position,
                ...(boardFile.placement.zone_object_id
                  ? { zoneId: boardFile.placement.zone_object_id }
                  : {}),
              }),
          ...(file.branch.environment_variant
            ? { environment_variant: file.branch.environment_variant }
            : {}),
          ...(file.branch.notes ? { notes: file.branch.notes } : {}),
          custom_context: {
            teammate: { kind: 'teammate', ...file.teammate, imported_from: importedFrom },
          },
        },
        this.params
      )
    );
    const branch = (await this.unit(() =>
      new BranchRepository(this.ctx.db).findById(created.branch_id)
    )) as Branch;
    const kb = getTeammateConfig(branch)?.kb;
    const remap: AgorPackTeammateResult['remap'] = {
      artifacts: {},
      schedules: [],
      sessions: {},
      uploads: [],
    };

    // 3. Knowledge into the teammate's own namespace.
    if (
      kb?.primary_namespace_id &&
      kb.primary_namespace_slug &&
      reader.has(path('knowledge/manifest.yaml'))
    ) {
      const files = new Map<string, string>();
      for (const entry of reader.list(path('knowledge/'))) {
        const relative = entry.path.slice(path('knowledge/').length);
        if (relative === 'history.json') continue;
        files.set(relative, await reader.readText(entry.path));
      }
      const history = reader.has(path('knowledge/history.json'))
        ? await reader.readJson(path('knowledge/history.json'), agorPackKnowledgeHistorySchema)
        : null;
      const kbResult = await importKnowledgeRepository({
        db: this.ctx.db,
        app: this.ctx.app,
        params: this.params,
        namespace: { namespace_id: kb.primary_namespace_id, slug: kb.primary_namespace_slug },
        files,
        history,
        importMetadata: { agor_pack: importedFrom },
      });
      if (kbResult.unresolvedLinks) {
        warnings.push(
          `${pluralize(kbResult.unresolvedLinks, 'Knowledge link')} could not be resolved.`
        );
      }
    }

    // 4. Artifacts, then their board objects with the new ids.
    const artifactIdBySequence = new Map<string, string>();
    const artifacts = new ArtifactRepository(this.ctx.db);
    for (const entry of reader.list(path('artifacts/'))) {
      const sequence = entry.path.slice(path('artifacts/').length).replace(/\.json$/, '');
      const artifact = await reader.readJson(entry.path, agorPackArtifactFileSchema);
      const row = await this.write(() =>
        artifacts.create({
          board_id: boardId as never,
          branch_id: branch.branch_id,
          name: artifact.name,
          description: artifact.description ?? undefined,
          template: artifact.template as never,
          build_status: 'unknown',
          files: artifact.files ?? undefined,
          dependencies: artifact.dependencies ?? undefined,
          entry: artifact.entry ?? undefined,
          sandpack_config: (artifact.sandpack_config ?? undefined) as never,
          required_env_vars: artifact.required_env_vars ?? undefined,
          agor_runtime: (artifact.agor_runtime ?? undefined) as never,
          public: false,
          created_by: userId,
        })
      );
      emitServiceEvent(this.ctx.app, {
        path: 'artifacts',
        event: 'created',
        data: row,
        params: this.params,
        id: row.artifact_id,
      });
      artifactIdBySequence.set(sequence, row.artifact_id);
      if (artifact.had_agor_grants) {
        warnings.push(`Artifact "${artifact.name}" needs its Agor grants re-approved.`);
      }
    }
    const rewired: Record<string, BoardObject> = {};
    for (const [objectId, object] of Object.entries(artifactObjects)) {
      const sequence = boardFile?.artifact_objects[objectId];
      const artifactId = sequence ? artifactIdBySequence.get(sequence) : undefined;
      if (object.type === 'artifact' && artifactId) {
        rewired[objectId] = { ...object, artifact_id: artifactId as UUID };
        remap.artifacts[objectId] = artifactId;
      }
    }
    if (Object.keys(rewired).length > 0) {
      const board = await this.write(() =>
        new BoardRepository(this.ctx.db).batchUpsertBoardObjects(boardId as string, rewired)
      );
      emitServiceEvent(this.ctx.app, {
        path: 'boards',
        event: 'patched',
        data: board,
        params: this.params,
        id: board.board_id,
      });
    }

    // 5. Custom MCP servers (disabled, no credentials), then schedules (disabled).
    const serverIdByName = new Map<string, string>();
    type ServerRef = { mcp_server_id: string; name: string };
    let mcpServers: ReturnType<typeof this.ctx.app.service> | null = null;
    try {
      mcpServers = this.ctx.app.service('mcp-servers');
    } catch {
      mcpServers = null; // MCP disabled on this deployment
    }
    const usable = (mcpServers
      ? await mcpServers.find({ ...this.params, query: { $limit: 1000 } }).catch(() => [])
      : []) as unknown as { data: ServerRef[] } | ServerRef[];
    for (const server of Array.isArray(usable) ? usable : usable.data) {
      serverIdByName.set(server.name, server.mcp_server_id);
    }
    for (const server of file.mcp_servers) {
      if (serverIdByName.has(server.name)) continue;
      try {
        if (!mcpServers) throw new Error('MCP servers are not available here');
        const createdServer = (await mcpServers.create(
          {
            name: server.name,
            ...(server.display_name ? { display_name: server.display_name } : {}),
            ...(server.description ? { description: server.description } : {}),
            transport: server.transport,
            ...(server.url ? { url: server.url } : {}),
            ...(server.command ? { command: server.command } : {}),
            ...(server.args ? { args: server.args } : {}),
            scope: 'global',
            enabled: false,
          },
          this.params
        )) as { mcp_server_id: string };
        serverIdByName.set(server.name, createdServer.mcp_server_id);
        if (server.env_names.length || server.header_names.length) {
          warnings.push(
            `MCP server "${server.name}" was added disabled; set ${[...server.env_names, ...server.header_names].join(', ')} and enable it.`
          );
        }
      } catch (error) {
        warnings.push(
          `MCP server "${server.name}" could not be added (${error instanceof Error ? error.message : 'error'}).`
        );
      }
    }
    if (reader.has(path('schedules.json'))) {
      const { schedules } = await reader.readJson(
        path('schedules.json'),
        agorPackSchedulesFileSchema
      );
      const presets = new AgenticToolPresetRepository(this.ctx.db);
      for (const schedule of schedules) {
        const config = { ...schedule.agentic_tool_config } as Record<string, unknown>;
        if (schedule.preset_name) {
          const match = (
            await this.unit(() => presets.find(config.agentic_tool as never)).catch(() => [])
          ).find((preset) => preset.name === schedule.preset_name);
          if (match) {
            for (const key of [
              'permission_mode',
              'model_config',
              'codex_sandbox_mode',
              'codex_approval_policy',
              'codex_network_access',
              'codex_include_plugins',
            ])
              delete config[key];
            config.preset_id = match.preset_id;
          } else {
            warnings.push(
              `Schedule "${schedule.name}": preset "${schedule.preset_name}" not found; using defaults.`
            );
          }
        }
        const missing = schedule.mcp_server_names.filter((n) => !serverIdByName.has(n));
        if (missing.length) {
          warnings.push(
            `Schedule "${schedule.name}": connect ${missing.join(', ')} before enabling it.`
          );
        }
        const data = {
          branch_id: branch.branch_id,
          name: schedule.name,
          ...(schedule.description ? { description: schedule.description } : {}),
          cron_expression: schedule.cron_expression,
          timezone_mode: schedule.timezone_mode,
          ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
          prompt: schedule.prompt,
          agentic_tool_config: config,
          mcp_server_ids: schedule.mcp_server_names.flatMap((n) => {
            const id = serverIdByName.get(n);
            return id ? [id] : [];
          }),
          enabled: false,
          allow_concurrent_runs: schedule.allow_concurrent_runs,
          retention: schedule.retention,
        };
        try {
          const createdSchedule = (await this.ctx.app
            .service('schedules')
            .create(data as never, this.params)) as { schedule_id: string };
          remap.schedules.push(createdSchedule.schedule_id);
        } catch (error) {
          warnings.push(
            `Schedule "${schedule.name}" could not be imported (${error instanceof Error ? error.message : 'error'}).`
          );
        }
      }
    }

    // 6. Sessions as archived history (+ tasks, messages).
    const sessionsRepo = new SessionRepository(this.ctx.db);
    const tasksRepo = new TaskRepository(this.ctx.db);
    const messagesRepo = new MessagesRepository(this.ctx.db);
    for (const entry of reader.list(path('sessions/'))) {
      if (!entry.path.endsWith('.json')) continue;
      const sessionFile = await reader.readJson(entry.path, agorPackSessionFileSchema);
      const source = sessionFile.session;
      const sessionId = generateId() as SessionID;
      remap.sessions[source.source_session_id] = sessionId;
      const taskIds = new Map(
        sessionFile.tasks.map((task) => [task.source_task_id, generateId() as TaskID])
      );
      const parent = source.parent_source_session_id
        ? remap.sessions[source.parent_source_session_id]
        : undefined;
      const forked = source.forked_from_source_session_id
        ? remap.sessions[source.forked_from_source_session_id]
        : undefined;
      await this.write(() =>
        sessionsRepo.create({
          session_id: sessionId,
          branch_id: branch.branch_id,
          created_by: userId,
          agentic_tool: source.agentic_tool as never,
          title: source.title ?? undefined,
          description: source.description ?? undefined,
          model_config: (source.model_config ?? undefined) as never,
          created_at: source.created_at,
          last_updated: source.last_updated,
          genealogy: {
            ...(parent ? { parent_session_id: parent as SessionID } : {}),
            ...(forked ? { forked_from_session_id: forked as SessionID } : {}),
            children: [],
          },
          tasks: [...taskIds.values()],
          archived: true,
          archived_reason: 'imported',
          custom_context: {
            import: {
              ...importedFrom,
              source_session_id: source.source_session_id,
              originally_by: source.originally_by,
            },
          },
        })
      );
      for (const task of sessionFile.tasks) {
        await this.write(() =>
          tasksRepo.create({
            task_id: taskIds.get(task.source_task_id) as TaskID,
            session_id: sessionId,
            created_by: userId,
            full_prompt: task.full_prompt,
            status: (TERMINAL_TASK_STATUSES.has(task.status)
              ? task.status
              : TaskStatus.STOPPED) as never,
            ...(task.model ? { model: task.model } : {}),
            ...(task.completed_at ? { completed_at: task.completed_at } : {}),
            ...(task.duration_ms !== null ? { duration_ms: task.duration_ms } : {}),
            ...(task.message_range ? { message_range: task.message_range as never } : {}),
          })
        );
      }
      const messagesPath = entry.path.replace(/\.json$/, '.messages.jsonl');
      if (reader.has(messagesPath)) {
        const batch: MessageCreate[] = [];
        const flush = async () => {
          if (!batch.length) return;
          const rows = batch.splice(0, batch.length);
          await this.write(() => messagesRepo.createMany(rows));
        };
        for (const line of (await reader.readText(messagesPath)).split('\n')) {
          if (!line) continue;
          const message = agorPackMessageSchema.parse(JSON.parse(line));
          batch.push({
            message_id: generateId() as MessageID,
            session_id: sessionId,
            ...(message.source_task_id && taskIds.has(message.source_task_id)
              ? { task_id: taskIds.get(message.source_task_id) as TaskID }
              : {}),
            type: message.type as never,
            role: message.role as never,
            index: message.index,
            timestamp: message.timestamp,
            content_preview: message.content_preview,
            content: message.content as never,
            ...(message.tool_uses ? { tool_uses: message.tool_uses as never } : {}),
            parent_tool_use_id: message.parent_tool_use_id,
            ...(message.metadata ? { metadata: message.metadata as never } : {}),
          });
          if (batch.length >= 500) await flush();
        }
        await flush();
      }
    }

    // 7. Attachments under their original refs (message text needs no rewrite).
    const uploads = new UploadRepository(this.ctx.db);
    const uploadStore = getUploadStagingStore();
    for (const entry of reader.list(path('uploads/'))) {
      if (!entry.path.endsWith('.json')) continue;
      const meta = await reader.readJson(entry.path, agorPackUploadFileSchema);
      const sessionId = remap.sessions[meta.source_session_id];
      if (!sessionId) continue;
      const ref = meta.ref as UploadRef;
      if (await this.unit(() => uploads.findOwned(this.ctx.tenantId, ref))) continue;
      try {
        await uploadStore.stage({
          reservedRef: ref,
          owner: {
            tenantId: this.ctx.tenantId,
            sessionId: sessionId as SessionID,
            branchId: branch.branch_id as BranchID,
            createdBy: userId as UUID,
          },
          name: meta.name,
          mimeType: meta.mime_type,
          provenance: 'import',
          body: await reader.openStream(path(`uploads/${meta.ref}.data`)),
          sizeHint: meta.size,
          ttlMs: 0,
        });
        remap.uploads.push(ref);
      } catch {
        warnings.push(`Attachment "${meta.name}" could not be restored.`);
      }
    }

    const hasFiles =
      reader.list(path('git/')).length > 0 || reader.list(path('sdk-home/')).length > 0;
    return {
      key: summary.key,
      display_name: summary.display_name,
      branch_id: branch.branch_id,
      board_id: boardId as string,
      knowledge_namespace_id: kb?.primary_namespace_id ?? null,
      filesystem: hasFiles ? 'pending' : 'skipped',
      remap,
      warnings,
    };
  }

  private async updateResult(
    importId: string,
    key: string,
    patch: Partial<AgorPackTeammateResult>
  ): Promise<void> {
    const previous = resultLocks.get(importId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const record = await this.load(importId);
        const results = record.results.map((result) =>
          result.key === key ? { ...result, ...patch } : result
        );
        await this.write(() => this.receipts().update(importId, { results }));
      });
    resultLocks.set(importId, next);
    await next;
  }

  /**
   * Run the filesystem leg for the selected teammates that still need it
   * (pending, or failed on an earlier attempt), one at a time.
   */
  async materializePending(importId: string, keys: string[]): Promise<void> {
    const record = await this.load(importId);
    for (const result of record.results) {
      if (!keys.includes(result.key)) continue;
      if (result.filesystem === 'pending' || result.filesystem === 'failed') {
        await this.materialize(importId, result.key);
      }
    }
  }

  /**
   * Filesystem leg: wait for the branch checkout, then let the executor write
   * the teammate's git history, files, and Claude memory into it.
   */
  async materialize(importId: string, key: string): Promise<void> {
    try {
      const record = await this.load(importId);
      const result = record.results.find((r) => r.key === key);
      const summary = record.manifest.teammates.find((t) => t.key === key);
      if (!result || !summary) return;
      await this.updateResult(importId, key, {
        filesystem: 'pending',
        filesystem_error: undefined,
      });
      const branches = new BranchRepository(this.ctx.db);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let branch = await this.unit(() => branches.findById(result.branch_id));
      while (branch?.filesystem_status === 'creating' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
        branch = await this.unit(() => branches.findById(result.branch_id));
      }
      if (branch?.filesystem_status !== 'ready') {
        throw new Error(
          branch?.filesystem_status === 'failed'
            ? 'The branch checkout failed; retry provisioning, then apply the import again'
            : 'The branch checkout did not become ready in time'
        );
      }
      const { reader, slug } = await this.teammateSlug(record, key);
      await runAgorPackExecutorCommand(this.ctx, {
        command: 'branch.pack.materialize',
        commandId: agorPackMaterializeExecutorCommandId(importId, key),
        branch,
        params: { importId, teammateKey: key, sourceClaudeProjectSlug: slug },
      });
      reader?.close();
      await this.updateResult(importId, key, { filesystem: 'ready' });
    } catch (error) {
      console.error(`[agor-pack] materialize ${importId}/${key} failed:`, error);
      await this.updateResult(importId, key, {
        filesystem: 'failed',
        filesystem_error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }

  private async teammateSlug(
    record: AgorPackImportRecord,
    key: string
  ): Promise<{ reader: AgorPackReader | null; slug: string | null }> {
    const { source } = await openStagedPack(this.ctx, record);
    const reader = await AgorPackReader.open(source);
    const file = await reader.readJson(
      teammatePackPath(key, 'teammate.json'),
      agorPackTeammateFileSchema
    );
    return { reader, slug: file.claude_project_slug };
  }
}
