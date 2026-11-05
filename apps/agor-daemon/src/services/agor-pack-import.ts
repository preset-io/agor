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
 *   receipt, so it holds across processes) runs in the background. Every id
 *   a teammate's rows get is planned once and saved on the receipt before any
 *   row exists; each step re-checks the claim, then creates with its planned
 *   id or adopts an existing row (receipt writes are claim-conditional). A
 *   retry after a failure, a crash, or a takeover converges on exactly one
 *   copy.
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
  AgorPackSecretError,
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
  runWithTenantDatabaseTransaction,
  ScheduleRepository,
  SessionRepository,
  StagedBlobRepository,
  TaskRepository,
  UploadRepository,
} from '@agor/core/db';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  AGOR_PACK_CLAIM_STALE_MS,
  type AgorPackApplyRequest,
  type AgorPackDryRunTeammate,
  type AgorPackImport,
  type AgorPackManifest,
  type AgorPackSessionFile,
  type AgorPackTeammateFile,
  type AgorPackTeammateProgress,
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
  agorPackTeammateSectionsSchema,
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
import { withImportedRowId } from '../utils/imported-row-id.js';
import { MetadataUploadStagingStore } from '../utils/metadata-upload-staging-store.js';
import { getBlobStagingStore, getUploadStagingStore } from '../utils/upload-staging.js';
import {
  agorPackMaterializeExecutorCommandId,
  runAgorPackExecutorCommand,
} from './agor-pack-executor.js';
import { type AgorPackServiceContext, agorPackBlob } from './agor-pack-export.js';
import { importKnowledgeRepository } from './knowledge-transfers.js';

/** Sections this release reads; anything else came from a newer Agor. */
const KNOWN_SECTIONS = new Set(Object.keys(agorPackTeammateSectionsSchema.shape));
const TERMINAL_TASK_STATUSES = new Set<string>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);
const READY_POLL_MS = 2_000;
const READY_TIMEOUT_MS = 15 * 60 * 1000;

const CLAIM_HEARTBEAT_MS = 60 * 1000;
const INTERRUPTED = 'The import was interrupted; apply it again to resume.';

const staleBefore = () => new Date(Date.now() - AGOR_PACK_CLAIM_STALE_MS);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the importer sees when apply stops: request and pack errors as they
 * are; anything else (a database or I/O failure carries query text and row
 * values) only as a generic line, with the details in the server log.
 */
function receiptError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (
    error instanceof AgorPackFormatError ||
    error instanceof AgorPackSecretError ||
    (typeof code === 'number' && code >= 400 && code < 500)
  ) {
    return errorText(error);
  }
  console.error('[agor-pack] apply failed:', error);
  return 'Something went wrong while importing; details are in the server log';
}

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
  const meta = await store.inspect(blob).catch((error: unknown) => {
    if (
      (error as { status?: number }).status === 404 ||
      (error as { status?: number }).status === 410
    ) {
      throw new Conflict('The pack file is no longer staged; upload it again');
    }
    throw error;
  });
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
  if (record.claim_token === null || liveClaim(record)) return rest;
  // A worker that died leaves `applying` or pending files behind; say so.
  return {
    ...rest,
    ...(rest.status === 'applying' ? { status: 'failed', error: rest.error ?? INTERRUPTED } : {}),
    results: rest.results.map((result) =>
      result.filesystem === 'pending'
        ? { ...result, filesystem: 'failed', filesystem_error: INTERRUPTED }
        : result
    ),
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
    const record = await this.load(importId);
    if (record.status === 'applying' && !liveClaim(record)) {
      // A dead worker's import: record it as failed (resumable), so it stops
      // counting as in use and its pack is eventually reclaimed.
      await this.write(() => this.receipts().failStale(staleBefore(), INTERRUPTED));
      return publicImport(await this.load(importId));
    }
    return publicImport(record);
  }

  /**
   * Stage an uploaded pack, validate it, and return the dry-run. Re-uploading
   * a pack this user already imported returns the existing receipt.
   */
  async stage(body: NodeJS.ReadableStream, size: number): Promise<AgorPackImport> {
    const store = getBlobStagingStore();
    // Also the write admission check: nothing is staged while the tenant is gated.
    await this.write(() => this.receipts().failStale(staleBefore(), INTERRUPTED));
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
    // Same content: keep the bytes already staged (a worker may be reading
    // them); only swap in the new upload when they are gone.
    if (existing && (liveClaim(existing) || (await this.isStaged(existing)))) {
      await discard();
      if (liveClaim(existing)) return publicImport(existing);
      const dryRun = await this.dryRun(manifest, existing.results);
      return publicImport(
        await this.write(() => this.receipts().update(existing.import_id, { dry_run: dryRun }))
      );
    }
    const dryRun = await this.dryRun(manifest, existing?.results ?? []);
    if (existing) {
      const updated = await this.write(() =>
        this.receipts().update(existing.import_id, {
          staging_ref: pending.staging_ref,
          dry_run: dryRun,
        })
      );
      return publicImport(updated);
    }
    let created: AgorPackImportRecord;
    try {
      created = await this.write(() =>
        this.receipts().create({
          owner_user_id: this.ctx.user.user_id,
          content_sha256: manifest.content_sha256,
          staging_ref: pending.staging_ref,
          manifest,
          dry_run: dryRun,
        })
      );
    } catch (error) {
      // The same file uploaded twice at once: the other upload's receipt wins.
      await discard();
      const winner = await this.unit(() =>
        this.receipts().findByContent(this.ctx.user.user_id, manifest.content_sha256)
      );
      if (!winner) throw error;
      return publicImport(winner);
    }
    return publicImport(created);
  }

  private async isStaged(record: AgorPackImportRecord): Promise<boolean> {
    const blob = stagedPackBlob(this.ctx, record);
    if (!blob) return false;
    return getBlobStagingStore()
      .inspect(blob)
      .then(
        () => true,
        () => false
      );
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
   * background. One claim covers the whole run: the rows, then (with
   * `files`) each selected teammate's files leg, so no second worker, upload,
   * or retry can interleave with it.
   * Already-imported teammates are kept as they are; a teammate that an
   * earlier attempt left part-way continues from its saved plan.
   */
  async start(
    importId: string,
    request: AgorPackApplyRequest
  ): Promise<{ receipt: AgorPackImport; run: (options?: { files?: boolean }) => Promise<void> }> {
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
    // Keep the staged pack for another TTL first: once extended it is no
    // longer expired, so the sweep's conditional delete cannot remove it; if
    // the sweep already removed it, this fails and nothing is claimed.
    const blob = stagedPackBlob(this.ctx, record);
    const kept =
      blob &&
      (await this.write(() =>
        new StagedBlobRepository(this.ctx.db).extend(
          blob.ref,
          new Date(Date.now() + getBlobStagingStore().ttlMs)
        )
      ));
    if (!kept) throw new Conflict('The pack file is no longer staged; upload it again');
    const claimed = await this.write(() =>
      this.receipts().claim(importId, this.ctx.user.user_id, token, staleBefore(), {
        status: 'applying',
        error: null,
      })
    );
    if (!claimed) throw new Conflict('This import is already being applied');
    return {
      receipt: publicImport(claimed),
      run: (options) => this.run(claimed, token, request, options?.files === true),
    };
  }

  /** {@link start} and wait for the rows (in-process callers and tests; no files leg). */
  async apply(importId: string, request: AgorPackApplyRequest): Promise<AgorPackImport> {
    await (await this.start(importId, request)).run();
    return this.get(importId);
  }

  private async run(
    claimed: AgorPackImportRecord,
    token: string,
    request: AgorPackApplyRequest,
    files: boolean
  ): Promise<void> {
    const importId = claimed.import_id;
    const blob = stagedPackBlob(this.ctx, claimed);
    // Before each step: refresh the claim (throws once another worker took
    // over) and keep the staged pack for another TTL. Run on a timer too, it
    // is the heartbeat; a dead worker's pack expires one TTL after its last.
    // Creates are idempotent by planned id and receipt writes are
    // token-conditional (`save`), so steps need no transaction of their own.
    const check = () =>
      this.write(async () => {
        if (!(await this.receipts().touchClaim(importId, token))) {
          throw new AgorPackImportClaimLostError();
        }
        if (blob) {
          await new StagedBlobRepository(this.ctx.db).extend(
            blob.ref,
            new Date(Date.now() + getBlobStagingStore().ttlMs)
          );
        }
      });
    // Pure repository writes that must land whole (a session with its tasks
    // and messages, an attachment's publish) re-check the claim in their
    // transaction, so a stale worker cannot write them.
    const fenced = <T>(work: () => Promise<T>): Promise<T> =>
      runWithTenantDatabaseTransaction(this.ctx.db, this.ctx.tenantId, async () => {
        await assertTenantWritable(this.ctx.db, this.ctx.tenantId);
        if (!(await this.receipts().touchClaim(importId, token))) {
          throw new AgorPackImportClaimLostError();
        }
        return work();
      });
    const save = (patch: Parameters<AgorPackImportRepository['updateClaimed']>[2]) =>
      this.write(() => this.receipts().updateClaimed(importId, token, patch));
    const heartbeat = setInterval(() => {
      void check().catch(() => undefined);
    }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();
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
            const repo = await this.ensureRepo(file, check);
            let plan = progress[teammate.key];
            if (!plan) {
              plan = await this.plan(reader, teammate, file, repo, request.board_id);
              progress[teammate.key] = plan;
              await save({ progress });
            }
            const state = plan;
            const persist = async () => {
              progress[teammate.key] = state;
              await this.write(() => this.receipts().updateClaimed(importId, token, { progress }));
            };
            const result = await this.applyTeammate(
              reader,
              teammate,
              file,
              repo,
              request.board_id,
              state,
              { check, fenced },
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
      // Selected teammates whose files failed earlier are retried below; show
      // them as pending meanwhile.
      if (files) {
        results = results.map((result) =>
          request.teammates.includes(result.key) && result.filesystem === 'failed'
            ? { ...result, filesystem: 'pending', filesystem_error: undefined }
            : result
        );
      }
      await save({
        results,
        status: 'applied',
        error: null,
        applied_at: claimed.applied_at ? new Date(claimed.applied_at) : new Date(),
      });
      if (files) {
        for (const result of results) {
          if (!request.teammates.includes(result.key)) continue;
          if (result.filesystem !== 'pending') continue;
          const patch = await this.materialize(claimed, result, token, check);
          results = results.map((r) => (r.key === result.key ? { ...r, ...patch } : r));
          await save({ results });
        }
      }
      await save({ release: true });
    } catch (error) {
      // Lost claim: a newer worker took over and owns the receipt now.
      if (error instanceof AgorPackImportClaimLostError) return;
      await save({ status: 'failed', error: receiptError(error), release: true }).catch(
        () => undefined
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Allocate every id (and the branch name) for one teammate, once. */
  private async plan(
    reader: AgorPackReader,
    summary: AgorPackTeammateSummary,
    file: AgorPackTeammateFile,
    repo: Repo,
    existingBoardId: string | null
  ): Promise<AgorPackTeammateProgress> {
    const path = (relative: string) => teammatePackPath(summary.key, relative);
    const artifacts: Record<string, string> = {};
    for (const entry of reader.list(path('artifacts/'))) {
      artifacts[entry.path.slice(path('artifacts/').length).replace(/\.json$/, '')] = generateId();
    }
    const schedules: Record<string, string> = {};
    if (reader.has(path('schedules.json'))) {
      const parsed = await reader.readJson(path('schedules.json'), agorPackSchedulesFileSchema);
      parsed.schedules.forEach((_schedule, index) => {
        schedules[String(index)] = generateId();
      });
    }
    const sessions: Record<string, string> = {};
    for (const entry of reader.list(path('sessions/'))) {
      if (!entry.path.endsWith('.json')) continue;
      const sessionFile = await reader.readJson(entry.path, agorPackSessionFileSchema);
      sessions[sessionFile.session.source_session_id] = generateId();
    }
    const uploadRefs: Record<string, string> = {};
    for (const entry of reader.list(path('uploads/'))) {
      if (!entry.path.endsWith('.json')) continue;
      const meta = await reader.readJson(entry.path, agorPackUploadFileSchema);
      uploadRefs[meta.ref] = `upl_${randomUUID()}`;
    }
    return {
      repo_id: repo.repo_id,
      board_id: existingBoardId ?? generateId(),
      branch_id: generateId(),
      branch_name: await this.uniqueBranchName(repo.repo_id, file.branch.name),
      artifacts,
      schedules,
      upload_refs: uploadRefs,
      knowledge_done: false,
      remap: { artifacts: {}, schedules: [], sessions, uploads: [] },
      warnings: [],
    };
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
   * One teammate from its plan. Every step re-checks the claim, then creates
   * its row with the planned id unless it already exists (then it is
   * adopted), so steps are idempotent: a retry after any crash converges on
   * exactly one teammate with the planned ids.
   */
  private async applyTeammate(
    reader: AgorPackReader,
    summary: AgorPackTeammateSummary,
    file: AgorPackTeammateFile,
    repo: Repo,
    existingBoardId: string | null,
    state: AgorPackTeammateProgress,
    {
      check,
      fenced,
    }: { check: () => Promise<void>; fenced: <T>(work: () => Promise<T>) => Promise<T> },
    persist: () => Promise<void>
  ): Promise<AgorPackTeammateResult> {
    const path = (relative: string) => teammatePackPath(summary.key, relative);
    const userId = this.ctx.user.user_id;
    const { remap, warnings } = state;
    const warn = (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
    };
    const boards = new BoardRepository(this.ctx.db);
    const branchRepo = new BranchRepository(this.ctx.db);
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
    const artifactObjects: Record<string, BoardObject> = {};
    if (!existingBoardId) {
      for (const [id, object] of Object.entries(
        (boardFile?.board as BoardExportBlob | undefined)?.objects ?? {}
      )) {
        if (object.type === 'artifact') artifactObjects[id] = object;
      }
      await check();
      if (!(await this.unit(() => boards.findById(state.board_id)))) {
        const blob = (boardFile?.board ?? {
          name: `${file.teammate.displayName}'s Board`,
          icon: file.teammate.emoji,
        }) as unknown as BoardExportBlob & { version?: number };
        const { version: _version, ...boardBlob } = blob;
        const objects = Object.fromEntries(
          Object.entries(boardBlob.objects ?? {}).filter(([id]) => !artifactObjects[id])
        );
        const slugTaken = boardBlob.slug
          ? await this.unit(() => boards.findBySlug(boardBlob.slug as string))
          : null;
        const service = this.ctx.app.service('boards') as unknown as BoardsServiceImpl;
        const board = (await this.unit(() =>
          service.fromBlob(
            { ...boardBlob, ...(slugTaken ? { slug: undefined } : {}), objects },
            withImportedRowId(this.params, state.board_id)
          )
        )) as Board & { import_skipped?: unknown[] };
        if (board.import_skipped?.length) {
          warn(`${pluralize(board.import_skipped.length, 'board object')} could not be imported.`);
        }
      }
    }
    const boardId = state.board_id;

    // 2. Branch (KB namespace and primary-teammate wiring happen in branches.create).
    await check();
    if (!(await this.unit(() => branchRepo.findById(state.branch_id)))) {
      // A branch created now has a fresh Knowledge namespace to fill.
      state.knowledge_done = false;
      if (
        await this.unit(() => branchRepo.findByRepoAndName(repo.repo_id as UUID, state.branch_name))
      ) {
        // Taken since planning by someone else; ours does not exist, so re-picking is safe.
        state.branch_name = await this.uniqueBranchName(repo.repo_id, file.branch.name);
      }
      const repos = this.ctx.app.service('repos') as unknown as ReposServiceImpl;
      await this.unit(() =>
        repos.createBranch(
          repo.repo_id,
          {
            name: state.branch_name,
            ref: state.branch_name,
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
          withImportedRowId(this.params, state.branch_id)
        )
      );
    }
    let branch = (await this.unit(() => branchRepo.findById(state.branch_id))) as Branch;
    if (!branch.agor_pack?.imported_from) {
      // Provenance is server-managed and kept out of template-visible context
      // (also set when an earlier attempt stopped right after the create).
      branch = await this.write(() =>
        branchRepo.update(state.branch_id, { agor_pack: { imported_from: importedFrom } })
      );
    }
    await persist();
    const kb = getTeammateConfig(branch)?.kb;

    // 3. Knowledge into the teammate's own namespace (documents that already
    // hold their content are skipped on a resume), then its done-flag.
    if (
      !state.knowledge_done &&
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
      await check();
      const kbResult = await this.unit(() =>
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
        warn(`${pluralize(kbResult.unresolvedLinks, 'Knowledge link')} could not be resolved.`);
      }
      state.knowledge_done = true;
      await persist();
    }

    // 4. Artifacts with their planned ids, then their board objects.
    const artifacts = new ArtifactRepository(this.ctx.db);
    for (const entry of reader.list(path('artifacts/'))) {
      const sequence = entry.path.slice(path('artifacts/').length).replace(/\.json$/, '');
      const artifactId = state.artifacts[sequence];
      if (!artifactId) continue;
      const artifact = await reader.readJson(entry.path, agorPackArtifactFileSchema);
      await check();
      const row = await this.write(async () => {
        if (await artifacts.findById(artifactId)) return null;
        return artifacts.create({
          artifact_id: artifactId as UUID,
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
        });
      });
      if (row) {
        emitServiceEvent(this.ctx.app, {
          path: 'artifacts',
          event: 'created',
          data: row,
          params: this.params,
          id: row.artifact_id,
        });
      }
      if (artifact.had_agor_grants) {
        warn(`Artifact "${artifact.name}" needs its Agor grants re-approved.`);
      }
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
      await check();
      const board = await this.write(() => boards.batchUpsertBoardObjects(boardId, rewired));
      emitServiceEvent(this.ctx.app, {
        path: 'boards',
        event: 'patched',
        data: board,
        params: this.params,
        id: board.board_id,
      });
    }

    // 5. Custom MCP servers (disabled, no credentials; matched by name, so a
    // retry reuses them), then schedules (disabled) with their planned ids.
    const serverIdByName = new Map<string, string>();
    type ServerRef = { mcp_server_id: string; name: string };
    let mcpServers: ReturnType<typeof this.ctx.app.service> | null = null;
    try {
      mcpServers = this.ctx.app.service('mcp-servers');
    } catch {
      mcpServers = null; // MCP disabled on this deployment
    }
    const usable = (mcpServers
      ? // Not swallowed: a failed lookup on a retry would create the servers twice.
        await mcpServers.find({ ...this.params, query: { $limit: 1000 } })
      : []) as unknown as { data: ServerRef[] } | ServerRef[];
    for (const server of Array.isArray(usable) ? usable : usable.data) {
      serverIdByName.set(server.name, server.mcp_server_id);
    }
    for (const server of file.mcp_servers) {
      if (serverIdByName.has(server.name)) continue;
      try {
        const service = mcpServers;
        if (!service) throw new Error('MCP servers are not available here');
        await check();
        const createdServer = (await this.unit(() =>
          service.create(
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
          )
        )) as { mcp_server_id: string };
        serverIdByName.set(server.name, createdServer.mcp_server_id);
        if (server.env_names.length || server.header_names.length) {
          warn(
            `MCP server "${server.name}" was added disabled; set ${[...server.env_names, ...server.header_names].join(', ')} and enable it.`
          );
        }
      } catch (error) {
        if (error instanceof AgorPackImportClaimLostError) throw error;
        warn(
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
      const scheduleRepo = new ScheduleRepository(this.ctx.db);
      for (const [index, schedule] of schedules.entries()) {
        const scheduleId = state.schedules[String(index)];
        if (!scheduleId) continue;
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
            warn(
              `Schedule "${schedule.name}": preset "${schedule.preset_name}" not found; using defaults.`
            );
          }
        }
        const missing = schedule.mcp_server_names.filter((n) => !serverIdByName.has(n));
        if (missing.length) {
          warn(`Schedule "${schedule.name}": connect ${missing.join(', ')} before enabling it.`);
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
          await check();
          if (!(await this.unit(() => scheduleRepo.findById(scheduleId)))) {
            await this.unit(() =>
              this.ctx.app
                .service('schedules')
                .create(data as never, withImportedRowId(this.params, scheduleId))
            );
          }
          if (!remap.schedules.includes(scheduleId)) remap.schedules.push(scheduleId);
        } catch (error) {
          if (error instanceof AgorPackImportClaimLostError) throw error;
          warn(
            `Schedule "${schedule.name}" could not be imported (${error instanceof Error ? error.message : 'error'}).`
          );
        }
      }
    }

    // 6. Sessions as archived history (+ tasks, messages), each one written
    // whole in one fenced transaction under its planned id. Attachments get
    // fresh refs (refs are global keys; the originals may exist here or in
    // another workspace), rewritten into message text before it is stored.
    const rewriteRefs = (text: string) => {
      let out = text;
      for (const [from, to] of Object.entries(state.upload_refs)) {
        if (out.includes(from)) out = out.split(from).join(to);
      }
      return out;
    };
    const sessionEntries: Array<{ path: string; file: AgorPackSessionFile }> = [];
    for (const entry of reader.list(path('sessions/'))) {
      if (!entry.path.endsWith('.json')) continue;
      sessionEntries.push({
        path: entry.path,
        file: await reader.readJson(entry.path, agorPackSessionFileSchema),
      });
    }
    const childrenOf = new Map<string, SessionID[]>();
    for (const { file: sessionFile } of sessionEntries) {
      const source = sessionFile.session;
      const parentSource = source.parent_source_session_id ?? source.forked_from_source_session_id;
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
      const sessionId = remap.sessions[source.source_session_id] as SessionID | undefined;
      if (!sessionId) continue;
      const messagesPath = entryPath.replace(/\.json$/, '.messages.jsonl');
      const lines = reader.has(messagesPath)
        ? (await reader.readText(messagesPath)).split('\n').filter(Boolean)
        : [];
      await fenced(async () => {
        if (await sessionsRepo.findById(sessionId)) return;
        const taskIds = new Map(
          sessionFile.tasks.map((task) => [task.source_task_id, generateId() as TaskID])
        );
        const parent = source.parent_source_session_id
          ? remap.sessions[source.parent_source_session_id]
          : undefined;
        const forked = source.forked_from_source_session_id
          ? remap.sessions[source.forked_from_source_session_id]
          : undefined;
        await sessionsRepo.create({
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
        });
        for (const task of sessionFile.tasks) {
          await tasksRepo.create({
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
          });
        }
        const batch: MessageCreate[] = [];
        for (const line of lines) {
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
          if (batch.length >= 500) await messagesRepo.createMany(batch.splice(0, batch.length));
        }
        if (batch.length) await messagesRepo.createMany(batch);
      });
    }

    // 7. Attachments under their planned refs. Bytes are staged as this
    // attempt's own upload (a fresh ref), then published under the planned
    // ref in a claim-fenced transaction that never replaces an existing one.
    // A failed or lost attempt deletes only its own upload, never the
    // planned ref another attempt may already have published.
    const uploadStore = getUploadStagingStore();
    if (!(uploadStore instanceof MetadataUploadStagingStore)) {
      throw new Error('Attachment import requires the database-backed upload store');
    }
    const uploadRows = new UploadRepository(this.ctx.db);
    for (const entry of reader.list(path('uploads/'))) {
      if (!entry.path.endsWith('.json')) continue;
      const meta = await reader.readJson(entry.path, agorPackUploadFileSchema);
      const sessionId = remap.sessions[meta.source_session_id];
      const ref = state.upload_refs[meta.ref] as UploadRef | undefined;
      if (!sessionId || !ref) continue;
      const published = async () =>
        (await uploadRows.findOwned(this.ctx.tenantId, ref))?.status === 'active';
      if (!(await this.unit(published))) {
        await check();
        const owner = {
          tenantId: this.ctx.tenantId,
          sessionId: sessionId as SessionID,
          branchId: branch.branch_id as BranchID,
        };
        let attempt: UploadRef | null = null;
        try {
          attempt = (
            await uploadStore.stage({
              owner: { ...owner, createdBy: userId as UUID },
              name: meta.name,
              mimeType: meta.mime_type,
              provenance: 'import',
              body: await reader.openStream(path(`uploads/${meta.ref}.data`)),
              sizeHint: meta.size,
              ttlMs: 0,
            })
          ).ref;
          const own = attempt;
          const settled = await fenced(async () => {
            if (await published()) return false;
            await uploadStore.publishAs({ ...owner, ref: own }, ref);
            return true;
          });
          if (!settled) await uploadStore.delete({ ...owner, ref: own });
        } catch (error) {
          if (attempt) await uploadStore.delete({ ...owner, ref: attempt }).catch(() => undefined);
          if (error instanceof AgorPackImportClaimLostError) throw error;
          warn(`Attachment "${meta.name}" could not be restored.`);
          continue;
        }
      }
      if (!remap.uploads.includes(ref)) remap.uploads.push(ref);
    }

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
   * Files leg of one teammate (inside the apply claim): wait for the branch
   * checkout, then let the executor write the teammate's git history, files,
   * and Claude memory into it. Returns the result patch; never throws.
   */
  private async materialize(
    record: AgorPackImportRecord,
    result: AgorPackTeammateResult,
    claimToken: string,
    check: () => Promise<void>
  ): Promise<Partial<AgorPackTeammateResult>> {
    const importId = record.import_id;
    const key = result.key;
    try {
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
      // Re-check the claim after the (possibly long) provisioning wait, right
      // before the handoff; the executor's pack download is bound to it too,
      // and its result is saved only while this claim is still current.
      await check();
      await runAgorPackExecutorCommand(this.ctx, {
        command: 'branch.pack.materialize',
        commandId: agorPackMaterializeExecutorCommandId(importId, key, claimToken),
        branch,
        params: { importId, teammateKey: key, claimToken, sourceClaudeProjectSlug: slug },
      });
      return { filesystem: 'ready', filesystem_error: undefined };
    } catch (error) {
      if (error instanceof AgorPackImportClaimLostError) throw error;
      console.error(`[agor-pack] materialize ${importId}/${key} failed:`, error);
      return { filesystem: 'failed', filesystem_error: errorText(error) };
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
