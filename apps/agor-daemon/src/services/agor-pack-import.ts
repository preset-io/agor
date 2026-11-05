/**
 * `.agorpack` import: stage → dry-run → apply.
 *
 * - The importer owns everything it creates (`created_by`/owner = importer);
 *   the original author survives only as "originally by" metadata.
 * - Every row gets a new id; the per-teammate remap is stored on the
 *   `agor_pack_imports` receipt, keyed by (owner, pack content hash), so
 *   importing the same pack again returns the same result instead of
 *   duplicating anything.
 * - Apply is resumable: one claimed worker (a conditional update on the
 *   receipt, so it holds across processes) runs in the background and saves
 *   each finished step and created row on the receipt. A retry after a
 *   failure or a dead worker skips finished steps and reuses their rows.
 * - Schedules arrive disabled, custom MCP servers disabled and without
 *   credentials, sessions archived as read-only history without SDK resume
 *   state (prompting them is refused), attachments get fresh `upl_` refs
 *   rewritten into the imported messages.
 * - Rows go through the existing services/repositories (createBranch, board
 *   import, Knowledge documents, schedules, MCP servers); the branch's files
 *   are written afterwards by the executor (`branch.pack.materialize`) once
 *   the checkout is ready.
 */

import { randomUUID } from 'node:crypto';
import {
  type AgorPackByteSource,
  AgorPackFormatError,
  AgorPackReader,
  teammatePackPath,
} from '@agor/core/agor-pack';
import { normalizeRepoUrl } from '@agor/core/config';
import {
  AgenticToolPresetRepository,
  AgorPackImportClaimLostError,
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
} from '@agor/core/db';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  type AgorPackApplyRequest,
  type AgorPackApplyStep,
  type AgorPackDryRunTeammate,
  type AgorPackImport,
  type AgorPackManifest,
  type AgorPackSessionFile,
  type AgorPackTeammateFile,
  type AgorPackTeammateProgress,
  type AgorPackTeammateResult,
  type AgorPackTeammateSummary,
  type AgorPackUploadFile,
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
  pluralize,
  type Repo,
  type SessionID,
  type StagedBlobReadInput,
  type TaskID,
  TaskStatus,
  TEAMMATE_FRAMEWORK_DEFAULT_BRANCH,
  TEAMMATE_FRAMEWORK_REPO_SLUG,
  TEAMMATE_FRAMEWORK_REPO_URL,
  type UploadRef,
  type UserID,
  type UUID,
} from '@agor/core/types';
import type { BoardsServiceImpl, ReposServiceImpl } from '../declarations.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { getBlobStagingStore, getUploadStagingStore } from '../utils/upload-staging.js';
import {
  agorPackMaterializeExecutorCommandId,
  runAgorPackExecutorCommand,
} from './agor-pack-executor.js';
import { type AgorPackServiceContext, agorPackBlob } from './agor-pack-export.js';
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
/** A claim not refreshed for this long belongs to a dead worker and can be taken over. */
const CLAIM_STALE_MS = 10 * 60 * 1000;
const INTERRUPTED = 'The import was interrupted; apply it again to resume.';

const staleBefore = () => new Date(Date.now() - CLAIM_STALE_MS);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The staged pack bytes of a receipt (`<scope>:<ref>`), owned by its importer. */
function stagedPackBlob(
  ctx: Pick<AgorPackServiceContext, 'tenantId'>,
  record: Pick<AgorPackImportRecord, 'owner_user_id' | 'staging_ref'>
): StagedBlobReadInput | null {
  const [scope, ref] = (record.staging_ref ?? '').split(':');
  if (!scope || !ref) return null;
  return agorPackBlob(
    { tenantId: ctx.tenantId, user: { user_id: record.owner_user_id as UserID } as never },
    scope,
    ref
  );
}

/** Read a staged pack as a random-access pack source. */
export async function openStagedPack(
  ctx: Pick<AgorPackServiceContext, 'tenantId'>,
  record: Pick<AgorPackImportRecord, 'owner_user_id' | 'staging_ref'>
): Promise<{ source: AgorPackByteSource }> {
  const blob = stagedPackBlob(ctx, record);
  if (!blob) throw new Conflict('The pack file is no longer staged; upload it again');
  const store = getBlobStagingStore();
  const meta = await store.inspect(blob);
  return {
    source: {
      size: meta.size,
      readRange: async (start, end) =>
        (await store.read({ ...blob, offset: start, length: end - start })) as never,
    },
  };
}

function liveClaim(record: AgorPackImportRecord): boolean {
  return (
    record.claim_token !== null &&
    record.claimed_at !== null &&
    Date.parse(record.claimed_at) >= staleBefore().getTime()
  );
}

function publicImport(record: AgorPackImportRecord): AgorPackImport {
  const {
    owner_user_id: _owner,
    staging_ref: _ref,
    progress: _progress,
    claim_token: _token,
    claimed_at: _claimedAt,
    ...rest
  } = record;
  // A worker that died mid-apply leaves `applying` behind; say so.
  return rest.status === 'applying' && !liveClaim(record)
    ? { ...rest, status: 'failed', error: rest.error ?? INTERRUPTED }
    : rest;
}

function emptyProgress(): AgorPackTeammateProgress {
  return {
    steps: [],
    done: [],
    artifacts: {},
    upload_refs: {},
    remap: { artifacts: {}, schedules: [], sessions: {}, uploads: [] },
    warnings: [],
  };
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
    const store = getBlobStagingStore();
    await store.cleanupExpired({ tenantId: this.ctx.tenantId }).catch(() => 0);
    const scope = generateId();
    const staged = await store.stage({
      owner: {
        tenantId: this.ctx.tenantId,
        kind: 'agor-pack',
        scopeId: scope,
        createdBy: this.ctx.user.user_id as UserID,
      },
      name: 'import.agorpack',
      mimeType: 'application/zip',
      body,
      sizeHint: size,
    });
    const pending = { owner_user_id: this.ctx.user.user_id, staging_ref: `${scope}:${staged.ref}` };
    const discard = () => store.delete(stagedPackBlob(this.ctx, pending)!).catch(() => undefined);
    let manifest: AgorPackManifest;
    try {
      const { source } = await openStagedPack(this.ctx, pending);
      const reader = await AgorPackReader.open(source);
      manifest = reader.manifest;
      reader.close();
    } catch (error) {
      await discard();
      throw error;
    }

    const existing = await this.unit(() =>
      this.receipts().findByContent(this.ctx.user.user_id, manifest.content_sha256)
    );
    if (existing && liveClaim(existing)) {
      // A worker is reading the current bytes; keep them.
      await discard();
      return publicImport(existing);
    }
    const dryRun = await this.dryRun(manifest, existing?.results ?? []);
    if (existing) {
      // Keep the freshest bytes so teammates not yet imported can still be applied.
      const previous = stagedPackBlob(this.ctx, existing);
      if (previous) await store.delete(previous).catch(() => undefined);
      const updated = await this.write(() =>
        this.receipts().update(existing.import_id, {
          staging_ref: pending.staging_ref,
          dry_run: dryRun,
        })
      );
      return publicImport(updated);
    }
    const created = await this.write(() =>
      this.receipts().create({
        owner_user_id: this.ctx.user.user_id,
        content_sha256: manifest.content_sha256,
        staging_ref: pending.staging_ref,
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
   * Claim the import for applying the selected teammates. Returns at once
   * with the claimed receipt and `run`, which the caller starts in the
   * background; it settles when every row is in (the files leg runs after,
   * see {@link materializePending}).
   * Already-imported teammates are kept as they are; a teammate that an
   * earlier attempt left part-way resumes from its last finished step.
   */
  async start(
    importId: string,
    request: AgorPackApplyRequest
  ): Promise<{ receipt: AgorPackImport; run: () => Promise<void> }> {
    const record = await this.load(importId);
    const selected = record.manifest.teammates.filter((t) => request.teammates.includes(t.key));
    if (selected.length !== new Set(request.teammates).size) {
      throw new BadRequest('Unknown teammate key in the request');
    }
    if (request.board_id) {
      // Throws unless the importer can see the board.
      await this.ctx.app.service('boards').get(request.board_id, this.params);
    }
    const token = randomUUID();
    const claimed = await this.write(() =>
      this.receipts().claim(importId, this.ctx.user.user_id, token, staleBefore(), {
        status: 'applying',
        error: null,
      })
    );
    if (!claimed) throw new Conflict('This import is already being applied');
    return { receipt: publicImport(claimed), run: () => this.run(claimed, token, request) };
  }

  /** {@link start} and wait for the rows (in-process callers and tests). */
  async apply(importId: string, request: AgorPackApplyRequest): Promise<AgorPackImport> {
    await (await this.start(importId, request)).run();
    return this.get(importId);
  }

  private async run(
    claimed: AgorPackImportRecord,
    token: string,
    request: AgorPackApplyRequest
  ): Promise<void> {
    const importId = claimed.import_id;
    const save = (patch: Parameters<AgorPackImportRepository['updateClaimed']>[2]) =>
      this.write(() => this.receipts().updateClaimed(importId, token, patch));
    let results = [...claimed.results];
    const progress = { ...claimed.progress };
    try {
      const todo = claimed.manifest.teammates.filter(
        (t) => request.teammates.includes(t.key) && !results.some((r) => r.key === t.key)
      );
      if (todo.length > 0) {
        const { source } = await openStagedPack(this.ctx, claimed);
        const reader = await AgorPackReader.open(source);
        try {
          if (reader.manifest.content_sha256 !== claimed.content_sha256) {
            throw new AgorPackFormatError('Staged pack does not match this import');
          }
          for (const teammate of todo) {
            const file = await reader.readJson(
              teammatePackPath(teammate.key, 'teammate.json'),
              agorPackTeammateFileSchema
            );
            // Each step opens its own short tenant units (never one scope for
            // the whole teammate: on PostgreSQL that is one transaction across
            // branch provisioning, Knowledge writes, and attachment staging)
            // and is saved on the receipt before the next one starts.
            const state = progress[teammate.key] ?? emptyProgress();
            const persist = async () => {
              progress[teammate.key] = state;
              await save({ progress });
            };
            const result = await this.applyTeammate(
              reader,
              teammate,
              file,
              request.board_id,
              state,
              persist
            );
            results = [...results, result];
            delete progress[teammate.key];
            await save({ results, progress });
          }
        } finally {
          reader.close();
        }
      }
      // Selected teammates whose files failed earlier go back to pending; the
      // files leg (materializePending) retries them next.
      results = results.map((result) =>
        request.teammates.includes(result.key) && result.filesystem === 'failed'
          ? { ...result, filesystem: 'pending', filesystem_error: undefined }
          : result
      );
      await save({
        results,
        status: 'applied',
        error: null,
        applied_at: claimed.applied_at ? new Date(claimed.applied_at) : new Date(),
        release: true,
      });
    } catch (error) {
      // Lost claim: a newer worker took over and owns the receipt now.
      if (error instanceof AgorPackImportClaimLostError) return;
      await save({ status: 'failed', error: errorText(error), release: true }).catch(
        () => undefined
      );
      throw error;
    }
  }

  private async ensureRepo(
    file: AgorPackTeammateFile,
    heartbeat: () => Promise<unknown>
  ): Promise<Repo> {
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
      await heartbeat();
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

  /**
   * One teammate, as resumable steps. `state` carries finished steps, rows
   * done inside a step, and every id created so far; `persist` saves it on
   * the receipt. Rows are recorded right after they are created, so a retry
   * at most re-creates the single row whose write was interrupted (a
   * part-written session is removed and written again).
   */
  private async applyTeammate(
    reader: AgorPackReader,
    summary: AgorPackTeammateSummary,
    file: AgorPackTeammateFile,
    existingBoardId: string | null,
    state: AgorPackTeammateProgress,
    persist: () => Promise<void>
  ): Promise<AgorPackTeammateResult> {
    const path = (relative: string) => teammatePackPath(summary.key, relative);
    const userId = this.ctx.user.user_id;
    const { remap, warnings } = state;
    const step = async (name: AgorPackApplyStep, work: () => Promise<void>) => {
      if (state.steps.includes(name)) return;
      await work();
      state.steps.push(name);
      await persist();
    };
    const item = async (id: string, work: () => Promise<void>) => {
      if (state.done.includes(id)) return;
      await work();
      state.done.push(id);
      await persist();
    };
    const importedFrom = {
      pack_id: reader.manifest.pack_id,
      source_branch_id: summary.source_branch_id,
      originally_by: file.originally_by,
      imported_at: new Date().toISOString(),
    };

    // 0. Repository: register/clone it (background; the claim stays fresh).
    await step('repo', async () => {
      state.repo_id = (await this.ensureRepo(file, persist)).repo_id;
    });
    const repo = (await this.unit(() =>
      new RepoRepository(this.ctx.db).findById(state.repo_id as string)
    )) as Repo;

    // 1. Board (artifact objects are re-added once the artifacts exist).
    const boardFile = reader.has(path('board.json'))
      ? await reader.readJson(path('board.json'), agorPackBoardFileSchema)
      : null;
    const artifactObjects: Record<string, BoardObject> = {};
    if (!existingBoardId) {
      for (const [id, object] of Object.entries(
        (boardFile?.board as BoardExportBlob | undefined)?.objects ?? {}
      )) {
        if (object.type === 'artifact') artifactObjects[id] = object;
      }
    }
    await step('board', async () => {
      if (existingBoardId) {
        state.board_id = existingBoardId;
        return;
      }
      const blob = (boardFile?.board ?? {
        name: `${file.teammate.displayName}'s Board`,
        icon: file.teammate.emoji,
      }) as unknown as BoardExportBlob & { version?: number };
      const { version: _version, ...boardBlob } = blob;
      const objects = Object.fromEntries(
        Object.entries(boardBlob.objects ?? {}).filter(([id]) => !artifactObjects[id])
      );
      const slugTaken = boardBlob.slug
        ? await this.unit(() =>
            new BoardRepository(this.ctx.db).findBySlug(boardBlob.slug as string)
          )
        : null;
      const boards = this.ctx.app.service('boards') as unknown as BoardsServiceImpl;
      const board = (await this.write(() =>
        boards.fromBlob(
          {
            ...boardBlob,
            ...(slugTaken ? { slug: undefined } : {}),
            objects,
            custom_context: { ...(boardBlob.custom_context ?? {}), imported_from: importedFrom },
          },
          this.params
        )
      )) as Board & { import_skipped?: unknown[] };
      state.board_id = board.board_id;
      if (board.import_skipped?.length) {
        warnings.push(
          `${pluralize(board.import_skipped.length, 'board object')} could not be imported.`
        );
      }
    });
    const boardId = state.board_id as string;

    // 2. Branch (KB namespace and primary-teammate wiring happen in branches.create).
    const createBranch = async () => {
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
            boardId,
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
            custom_context: { teammate: { kind: 'teammate', ...file.teammate } },
          },
          this.params
        )
      );
      state.branch_id = created.branch_id;
      await persist();
      return created.branch_id;
    };
    await step('branch', async () => {
      if (!state.branch_id) state.branch_id = await createBranch();
      // Provenance is server-managed and kept out of template-visible context.
      await this.write(() =>
        new BranchRepository(this.ctx.db).update(state.branch_id as string, {
          agor_pack: { imported_from: importedFrom },
        })
      );
    });
    const branch = (await this.unit(() =>
      new BranchRepository(this.ctx.db).findById(state.branch_id as string)
    )) as Branch;
    const kb = getTeammateConfig(branch)?.kb;

    // 3. Knowledge into the teammate's own namespace (one tenant unit).
    await step('knowledge', async () => {
      if (
        !kb?.primary_namespace_id ||
        !kb.primary_namespace_slug ||
        !reader.has(path('knowledge/manifest.yaml'))
      ) {
        return;
      }
      const files = new Map<string, string>();
      for (const entry of reader.list(path('knowledge/'))) {
        const relative = entry.path.slice(path('knowledge/').length);
        if (relative === 'history.json') continue;
        files.set(relative, await reader.readText(entry.path));
      }
      const history = reader.has(path('knowledge/history.json'))
        ? await reader.readJson(path('knowledge/history.json'), agorPackKnowledgeHistorySchema)
        : null;
      const kbResult = await this.write(() =>
        importKnowledgeRepository({
          db: this.ctx.db,
          app: this.ctx.app,
          params: this.params,
          namespace: { namespace_id: kb.primary_namespace_id, slug: kb.primary_namespace_slug },
          files,
          history,
          importMetadata: { agor_pack: importedFrom },
        })
      );
      if (kbResult.unresolvedLinks) {
        warnings.push(
          `${pluralize(kbResult.unresolvedLinks, 'Knowledge link')} could not be resolved.`
        );
      }
    });

    // 4. Artifacts, then their board objects with the new ids.
    await step('artifacts', async () => {
      const artifacts = new ArtifactRepository(this.ctx.db);
      for (const entry of reader.list(path('artifacts/'))) {
        const sequence = entry.path.slice(path('artifacts/').length).replace(/\.json$/, '');
        await item(`artifact:${sequence}`, async () => {
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
          state.artifacts[sequence] = row.artifact_id;
          if (artifact.had_agor_grants) {
            warnings.push(`Artifact "${artifact.name}" needs its Agor grants re-approved.`);
          }
        });
      }
      const rewired: Record<string, BoardObject> = {};
      for (const [objectId, object] of Object.entries(artifactObjects)) {
        const sequence = boardFile?.artifact_objects[objectId];
        const artifactId = sequence ? state.artifacts[sequence] : undefined;
        if (object.type === 'artifact' && artifactId) {
          rewired[objectId] = { ...object, artifact_id: artifactId as UUID };
          remap.artifacts[objectId] = artifactId;
        }
      }
      if (Object.keys(rewired).length > 0) {
        const board = await this.write(() =>
          new BoardRepository(this.ctx.db).batchUpsertBoardObjects(boardId, rewired)
        );
        emitServiceEvent(this.ctx.app, {
          path: 'boards',
          event: 'patched',
          data: board,
          params: this.params,
          id: board.board_id,
        });
      }
    });

    // 5. Custom MCP servers (disabled, no credentials; matched by name, so a
    // retry reuses them), then schedules (disabled).
    await step('schedules', async () => {
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
      if (!reader.has(path('schedules.json'))) return;
      const { schedules } = await reader.readJson(
        path('schedules.json'),
        agorPackSchedulesFileSchema
      );
      const presets = new AgenticToolPresetRepository(this.ctx.db);
      for (const [index, schedule] of schedules.entries()) {
        await item(`schedule:${index}`, async () => {
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
        });
      }
    });

    // 6. Sessions as archived history (+ tasks, messages). Attachments get
    // fresh refs (refs are global keys; the originals may exist here or in
    // another workspace), rewritten into message text before it is stored.
    // Every new id is fixed and saved first, so parent/fork links resolve in
    // any entry order and a retry writes the same ids.
    const uploadMetas: AgorPackUploadFile[] = [];
    for (const entry of reader.list(path('uploads/'))) {
      if (entry.path.endsWith('.json')) {
        uploadMetas.push(await reader.readJson(entry.path, agorPackUploadFileSchema));
      }
    }
    const sessionEntries: Array<{ path: string; file: AgorPackSessionFile }> = [];
    for (const entry of reader.list(path('sessions/'))) {
      if (!entry.path.endsWith('.json')) continue;
      sessionEntries.push({
        path: entry.path,
        file: await reader.readJson(entry.path, agorPackSessionFileSchema),
      });
    }
    await step('sessions', async () => {
      for (const meta of uploadMetas) state.upload_refs[meta.ref] ??= `upl_${randomUUID()}`;
      for (const { file: sessionFile } of sessionEntries) {
        remap.sessions[sessionFile.session.source_session_id] ??= generateId();
      }
      await persist();
      const rewriteRefs = (text: string) => {
        let out = text;
        for (const [from, to] of Object.entries(state.upload_refs)) {
          if (out.includes(from)) out = out.split(from).join(to);
        }
        return out;
      };
      const childrenOf = new Map<string, SessionID[]>();
      for (const { file: sessionFile } of sessionEntries) {
        const source = sessionFile.session;
        const parentSource =
          source.parent_source_session_id ?? source.forked_from_source_session_id;
        if (!parentSource || !remap.sessions[parentSource]) continue;
        const list = childrenOf.get(parentSource) ?? [];
        list.push(remap.sessions[source.source_session_id] as SessionID);
        childrenOf.set(parentSource, list);
      }

      const sessionsRepo = new SessionRepository(this.ctx.db);
      const tasksRepo = new TaskRepository(this.ctx.db);
      const messagesRepo = new MessagesRepository(this.ctx.db);
      for (const { path: entryPath, file: sessionFile } of sessionEntries) {
        const source = sessionFile.session;
        const sessionId = remap.sessions[source.source_session_id] as SessionID;
        await item(`session:${source.source_session_id}`, async () => {
          // Part-written by an interrupted attempt: drop it (tasks and
          // messages cascade) and write it again.
          if (await this.unit(() => sessionsRepo.findById(sessionId))) {
            await this.write(() => sessionsRepo.delete(sessionId));
          }
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
                children: childrenOf.get(source.source_session_id) ?? [],
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
                full_prompt: rewriteRefs(task.full_prompt),
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
          const messagesPath = entryPath.replace(/\.json$/, '.messages.jsonl');
          if (!reader.has(messagesPath)) return;
          const batch: MessageCreate[] = [];
          const flush = async () => {
            if (!batch.length) return;
            const rows = batch.splice(0, batch.length);
            await this.write(() => messagesRepo.createMany(rows));
          };
          for (const line of (await reader.readText(messagesPath)).split('\n')) {
            if (!line) continue;
            const message = agorPackMessageSchema.parse(JSON.parse(rewriteRefs(line)));
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
        });
      }
    });

    // 7. Attachments under their new refs.
    await step('uploads', async () => {
      const uploadStore = getUploadStagingStore();
      for (const meta of uploadMetas) {
        const sessionId = remap.sessions[meta.source_session_id];
        const ref = state.upload_refs[meta.ref] as UploadRef | undefined;
        if (!sessionId || !ref) continue;
        await item(`upload:${meta.ref}`, async () => {
          const owner = {
            tenantId: this.ctx.tenantId,
            sessionId: sessionId as SessionID,
            branchId: branch.branch_id as BranchID,
          };
          try {
            // A reservation an interrupted attempt left behind.
            await uploadStore.delete({ ...owner, ref }).catch(() => undefined);
            await uploadStore.stage({
              reservedRef: ref,
              owner: { ...owner, createdBy: userId as UUID },
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
        });
      }
    });

    const hasFiles =
      reader.list(path('git/')).length > 0 || reader.list(path('sdk-home/')).length > 0;
    return {
      key: summary.key,
      display_name: summary.display_name,
      branch_id: branch.branch_id,
      board_id: boardId,
      knowledge_namespace_id: kb?.primary_namespace_id ?? null,
      filesystem: hasFiles ? 'pending' : 'skipped',
      remap,
      warnings,
    };
  }

  /**
   * Patch one teammate's result under a short claim, so the files leg never
   * overwrites results an apply worker is writing (it waits for it instead).
   */
  private async updateResult(
    importId: string,
    key: string,
    patch: Partial<AgorPackTeammateResult>
  ): Promise<void> {
    const deadline = Date.now() + CLAIM_STALE_MS;
    for (;;) {
      const token = randomUUID();
      const claimed = await this.write(() =>
        this.receipts().claim(importId, this.ctx.user.user_id, token, staleBefore())
      );
      if (claimed) {
        const results = claimed.results.map((result) =>
          result.key === key ? { ...result, ...patch } : result
        );
        await this.write(() =>
          this.receipts().updateClaimed(importId, token, { results, release: true })
        );
        return;
      }
      if (Date.now() > deadline) throw new Conflict('This import is busy; retry shortly');
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
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
      const slug = await this.teammateSlug(record, key);
      await runAgorPackExecutorCommand(this.ctx, {
        command: 'branch.pack.materialize',
        commandId: agorPackMaterializeExecutorCommandId(importId, key),
        branch,
        params: { importId, teammateKey: key, sourceClaudeProjectSlug: slug },
      });
      await this.updateResult(importId, key, { filesystem: 'ready' });
    } catch (error) {
      console.error(`[agor-pack] materialize ${importId}/${key} failed:`, error);
      await this.updateResult(importId, key, {
        filesystem: 'failed',
        filesystem_error: errorText(error),
      }).catch(() => undefined);
    }
  }

  private async teammateSlug(record: AgorPackImportRecord, key: string): Promise<string | null> {
    const { source } = await openStagedPack(this.ctx, record);
    const reader = await AgorPackReader.open(source);
    try {
      const file = await reader.readJson(
        teammatePackPath(key, 'teammate.json'),
        agorPackTeammateFileSchema
      );
      return file.claude_project_slug;
    } finally {
      reader.close();
    }
  }
}
