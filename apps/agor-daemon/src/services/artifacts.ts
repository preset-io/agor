/**
 * Artifacts Service
 *
 * Provides REST + WebSocket API for artifact management.
 * Artifacts are board-scoped, DB-backed Sandpack applications.
 *
 * Key behavior:
 * - Publish reads a folder from the filesystem, serializes contents into the DB `files` column
 * - getPayload reads from DB (with legacy filesystem fallback for un-migrated artifacts)
 * - Console logs stored in-memory ring buffer for agent debugging
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { generateId } from '@agor/core';
import { getBaseUrl, loadConfig, PAGINATION, resolveProxies } from '@agor/core/config';
import {
  ArtifactRepository,
  BoardRepository,
  type Database,
  WorktreeRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type {
  Artifact,
  ArtifactBuildStatus,
  ArtifactConsoleEntry,
  ArtifactPayload,
  ArtifactStatus,
  BoardID,
  QueryParams,
  SandpackError,
  SandpackManifest,
  SandpackTemplate,
  UserID,
  WorktreeID,
} from '@agor/core/types';
import Handlebars from 'handlebars';
import { DrizzleService } from '../adapters/drizzle.js';
import type { UsersService } from './users.js';

/**
 * Convention: if an artifact contains a file named /agor.config.js,
 * the backend treats it as a Handlebars template and renders it per-user
 * at payload fetch time. Template variables:
 *   {{ user.env.VAR_NAME }} - User's encrypted env var
 *   {{ agor.token }}        - Scoped artifact API token (future)
 *   {{ agor.apiUrl }}       - Daemon URL
 *   {{ artifact.id }}       - Artifact ID
 *   {{ artifact.boardId }}  - Board ID
 */
const AGOR_CONFIG_FILE = '/agor.config.js';

/**
 * Resolve a destination path by canonicalizing the longest existing prefix via
 * `realpath` and re-joining the still-nonexistent tail. Used by `land()` to
 * detect symlinked ancestors that would otherwise defeat a lexical
 * containment check.
 *
 * Example: if `/wt/.agor` is a symlink to `/etc` and the caller passes
 * `.agor/artifacts/x`, the canonicalized destination is `/etc/artifacts/x`,
 * which fails the worktree-root containment check.
 */
async function canonicalizeExistingPrefix(target: string): Promise<string> {
  const segments = target.split(path.sep);
  for (let i = segments.length; i >= 1; i--) {
    const prefix = segments.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = await realpath(prefix);
      const tail = segments.slice(i).join(path.sep);
      return tail ? path.join(real, tail) : real;
    } catch {
      // prefix does not exist yet — shrink and try again
    }
  }
  return target;
}

export type ArtifactParams = QueryParams<{
  board_id?: BoardID;
  worktree_id?: WorktreeID;
  archived?: boolean;
}>;

const MAX_CONSOLE_ENTRIES = 100;

export class ArtifactsService extends DrizzleService<Artifact, Partial<Artifact>, ArtifactParams> {
  private artifactRepo: ArtifactRepository;
  private worktreeRepo: WorktreeRepository;
  private boardRepo: BoardRepository;
  private app: Application;

  /** In-memory ring buffer for console logs per artifact */
  private consoleLogs: Map<string, ArtifactConsoleEntry[]> = new Map();

  /** In-memory Sandpack error state per artifact (from browser iframe) */
  private sandpackErrors: Map<string, SandpackError | null> = new Map();

  /** In-memory Sandpack status per artifact (from browser iframe) */
  private sandpackStatuses: Map<string, string> = new Map();

  /** URL of self-hosted Sandpack bundler (detected at startup, null if not available) */
  selfHostedBundlerURL: string | null = null;

  constructor(db: Database, app: Application) {
    const artifactRepo = new ArtifactRepository(db);
    super(artifactRepo, {
      id: 'artifact_id',
      resourceType: 'Artifact',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.artifactRepo = artifactRepo;
    this.worktreeRepo = new WorktreeRepository(db);
    this.boardRepo = new BoardRepository(db);
    this.app = app;
  }

  // Override Feathers CRUD to enforce lifecycle-safe operations.
  // Artifacts require publish semantics (serializing folder → DB).
  // Raw Feathers create would skip these, causing incomplete state.
  // Use publish() or the agor_artifacts_publish MCP tool instead.

  async create(_data: Partial<Artifact>, _params?: unknown): Promise<Artifact> {
    throw new Error(
      'Direct artifact creation not supported. Use publish() or agor_artifacts_publish MCP tool.'
    );
  }

  /**
   * Feathers patch override: route board_id and placement changes through
   * updateMetadata so the board_objects entry is moved/resized alongside the
   * row update. Plain metadata patches (name, description, public, archived,
   * build state, etc.) fall through to the default DrizzleService patch.
   *
   * Ownership is enforced by Feathers hooks (creator-or-admin); this method
   * additionally forwards the caller's user_id into updateMetadata as a
   * defence-in-depth check for direct internal callers.
   */
  async patch(id: string | number, data: Partial<Artifact>, params?: unknown): Promise<Artifact> {
    const d = data as Partial<Artifact> & {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    const placementFields =
      d.x !== undefined || d.y !== undefined || d.width !== undefined || d.height !== undefined;

    if (d.board_id !== undefined || placementFields) {
      const artifactId = String(id);
      // Resolve short IDs to a full ID through the repository.
      const existing = await this.artifactRepo.findById(artifactId);
      if (!existing) throw new Error(`Artifact ${artifactId} not found`);

      // Pass through the caller's user_id when available (external REST/MCP
      // calls) so updateMetadata's owner check engages. Feathers hooks are
      // the primary gate; this is defence-in-depth for internal callers that
      // forward a user. Internal service-to-service calls without a user
      // still bypass the inline check (matches existing publish() behavior).
      const callerUserId = (params as { user?: { user_id?: string } } | undefined)?.user?.user_id;

      return this.updateMetadata(
        existing.artifact_id,
        {
          name: d.name,
          description: d.description,
          public: d.public,
          archived: d.archived,
          board_id: d.board_id,
          x: d.x,
          y: d.y,
          width: d.width,
          height: d.height,
        },
        callerUserId
      );
    }

    return (await super.patch(id, data as Partial<Artifact>, params as never)) as Artifact;
  }

  /**
   * Centralized visibility predicate.
   * Private artifacts are only readable by their creator; public artifacts
   * are readable by anyone. Used by MCP tools (get, land) to avoid drift.
   */
  isVisibleTo(artifact: Pick<Artifact, 'public' | 'created_by'>, userId?: string): boolean {
    if (artifact.public) return true;
    if (!userId || !artifact.created_by) return false;
    return artifact.created_by === userId;
  }

  async remove(id: string | number, _params?: unknown): Promise<Artifact> {
    const artifactId = String(id);
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    await this.deleteArtifact(artifactId);
    this.app.service('artifacts').emit('removed', artifact);
    return artifact;
  }

  /**
   * Publish a folder as a live Sandpack artifact on a board.
   *
   * Reads all files from folderPath, serializes them into the DB `files` column.
   * If artifactId is provided, updates an existing artifact (must be owned by userId).
   * If artifactId is omitted, creates a new artifact and places it on the board.
   */
  async publish(
    data: {
      folderPath: string;
      board_id: string;
      name: string;
      artifact_id?: string;
      template?: SandpackTemplate;
      public?: boolean;
      use_local_bundler?: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    userId?: string
  ): Promise<Artifact> {
    const folderPath = path.resolve(data.folderPath);
    const template = data.template ?? 'react';
    const isPublic = data.public ?? true;

    // Path containment: only allow reading from worktree paths or temp directories
    await this.validatePublishPath(folderPath);

    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder not found: ${folderPath}`);
    }

    // Read all files from the folder
    const files = this.readFilesRecursive(folderPath, folderPath);

    // Read sandpack.json manifest if present
    const manifestPath = path.join(folderPath, 'sandpack.json');
    let manifest: SandpackManifest = { template };
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }

    // Allow explicit parameter to override manifest
    if (data.use_local_bundler !== undefined) {
      manifest.use_local_bundler = data.use_local_bundler;
    }

    // Validate use_local_bundler opt-in
    if (manifest.use_local_bundler && !this.selfHostedBundlerURL) {
      throw new Error(
        'Cannot publish artifact with use_local_bundler=true: this daemon was not built with --with-sandpack, so no self-hosted Sandpack bundler is available. Either rebuild the daemon with `./build.sh --with-sandpack`, or omit use_local_bundler to use the default CodeSandbox hosted bundler.'
      );
    }

    // Compute content hash from serialized files
    const contentHash = this.computeHashFromFiles(files);

    if (data.artifact_id) {
      // ── UPDATE existing artifact ──
      const existing = await this.artifactRepo.findById(data.artifact_id);
      if (!existing) throw new Error(`Artifact ${data.artifact_id} not found`);
      if (userId && existing.created_by && existing.created_by !== userId) {
        throw new Error('Cannot update artifact: not the owner');
      }

      // Auto-check build status from the files we just read
      const buildResult = this.validateFiles(files);

      const updated = await this.artifactRepo.update(data.artifact_id, {
        name: data.name,
        files,
        dependencies: manifest.dependencies,
        entry: manifest.entry,
        template: manifest.template ?? template,
        content_hash: contentHash,
        use_local_bundler: manifest.use_local_bundler,
        public: isPublic,
        build_status: buildResult.status,
        build_errors: buildResult.errors.length > 0 ? buildResult.errors : undefined,
      });

      // Clear stale in-memory Sandpack state — new content will produce fresh state from the browser
      this.sandpackErrors.delete(data.artifact_id);
      this.sandpackStatuses.delete(data.artifact_id);

      this.app.service('artifacts').emit('patched', updated);
      return updated;
    }

    // ── CREATE new artifact ──
    const artifactId = generateId();

    // Auto-check build status from the files we just read
    const buildResult = this.validateFiles(files);

    const artifact = await this.artifactRepo.create({
      artifact_id: artifactId,
      board_id: data.board_id as BoardID,
      name: data.name,
      path: folderPath,
      template: manifest.template ?? template,
      files,
      dependencies: manifest.dependencies,
      entry: manifest.entry,
      use_local_bundler: manifest.use_local_bundler,
      content_hash: contentHash,
      build_status: buildResult.status,
      build_errors: buildResult.errors.length > 0 ? buildResult.errors : undefined,
      public: isPublic,
      created_by: userId,
    });

    // Place on board as a thin reference
    const objectId = `artifact-${artifactId}`;
    try {
      const updatedBoard = await this.boardRepo.upsertBoardObject(data.board_id, objectId, {
        type: 'artifact',
        artifact_id: artifactId,
        x: data.x ?? 0,
        y: data.y ?? 0,
        width: data.width ?? 600,
        height: data.height ?? 400,
      });

      if (this.app) {
        this.app.service('boards').emit('patched', updatedBoard);
      }
    } catch (boardError) {
      // Compensate: remove DB record if board placement fails
      try {
        await this.artifactRepo.delete(artifactId);
      } catch (deleteError) {
        console.error(
          `Rollback failed: could not delete orphan artifact ${artifactId}:`,
          deleteError
        );
      }
      throw boardError;
    }

    this.app.service('artifacts').emit('created', artifact);
    return artifact;
  }

  /**
   * Update artifact metadata without touching file contents.
   *
   * Supports: name, description, public, archived flag, board move,
   * and board placement (x/y/width/height).
   *
   * When moving between boards, the old board object is removed and a new one
   * is created on the destination board. Placement (x/y/width/height) is
   * preserved unless caller explicitly overrides — this makes cross-board
   * moves layout-preserving by default.
   *
   * For file/content updates use publish() instead.
   */
  async updateMetadata(
    artifactId: string,
    updates: {
      name?: string;
      description?: string;
      public?: boolean;
      archived?: boolean;
      board_id?: BoardID;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    userId?: string
  ): Promise<Artifact> {
    const existing = await this.artifactRepo.findById(artifactId);
    if (!existing) throw new Error(`Artifact ${artifactId} not found`);
    if (userId && existing.created_by && existing.created_by !== userId) {
      throw new Error('Cannot update artifact: not the owner');
    }

    const fullArtifactId = existing.artifact_id;
    const objectId = `artifact-${fullArtifactId}`;
    const oldBoardId = existing.board_id;
    const newBoardId = updates.board_id ?? oldBoardId;
    const moving = newBoardId !== oldBoardId;

    // Pre-validate destination board exists when moving. This avoids persisting
    // a dangling `artifact.board_id` with no matching board_objects entry if
    // the upsert would fail.
    if (moving) {
      const destBoard = await this.boardRepo.findById(newBoardId);
      if (!destBoard) {
        throw new Error(`Destination board ${newBoardId} not found`);
      }
    }

    // Read the current board object (if present) so we can preserve placement
    // when moving or when only some placement fields are provided.
    let currentPlacement: { x: number; y: number; width: number; height: number } | null = null;
    try {
      const oldBoard = await this.boardRepo.findById(oldBoardId);
      const obj = oldBoard?.objects?.[objectId];
      if (obj && obj.type === 'artifact') {
        currentPlacement = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      }
    } catch {
      // Board may have been deleted out from under the artifact — placement
      // falls back to defaults below.
    }

    // Apply DB updates (metadata + board_id).
    const dbUpdates: Partial<Artifact> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.public !== undefined) dbUpdates.public = updates.public;
    if (updates.archived !== undefined) {
      dbUpdates.archived = updates.archived;
      dbUpdates.archived_at = updates.archived ? new Date().toISOString() : undefined;
    }
    if (moving) dbUpdates.board_id = newBoardId;

    let updated = existing;
    if (Object.keys(dbUpdates).length > 0) {
      updated = await this.artifactRepo.update(fullArtifactId, dbUpdates);
    }

    // Sync board_objects if moving OR if placement fields were supplied.
    const placementChanged =
      updates.x !== undefined ||
      updates.y !== undefined ||
      updates.width !== undefined ||
      updates.height !== undefined;

    if (moving || placementChanged) {
      const placement = {
        type: 'artifact' as const,
        artifact_id: fullArtifactId,
        x: updates.x ?? currentPlacement?.x ?? 0,
        y: updates.y ?? currentPlacement?.y ?? 0,
        width: updates.width ?? currentPlacement?.width ?? 600,
        height: updates.height ?? currentPlacement?.height ?? 400,
      };

      // Upsert the destination board object FIRST. Only once the new placement
      // is safely in place do we remove the old one — this way, a failing
      // upsert leaves the old board object intact (we only have to roll back
      // the DB row), rather than leaving the artifact orphaned on both boards.
      try {
        const targetBoard = await this.boardRepo.upsertBoardObject(newBoardId, objectId, placement);
        this.app.service('boards').emit('patched', targetBoard);
      } catch (upsertError) {
        // Compensate: if we already updated the DB row (in particular, moved
        // `board_id` to newBoardId), roll it back so the artifact row and
        // board_objects stay consistent.
        if (Object.keys(dbUpdates).length > 0) {
          try {
            const rollback: Partial<Artifact> = {};
            if (moving) rollback.board_id = oldBoardId;
            if (updates.name !== undefined) rollback.name = existing.name;
            if (updates.description !== undefined) rollback.description = existing.description;
            if (updates.public !== undefined) rollback.public = existing.public;
            if (updates.archived !== undefined) {
              rollback.archived = existing.archived;
              rollback.archived_at = existing.archived_at;
            }
            if (Object.keys(rollback).length > 0) {
              await this.artifactRepo.update(fullArtifactId, rollback);
            }
          } catch (rollbackError) {
            console.error(
              `Rollback failed after board_objects upsert error for artifact ${fullArtifactId}:`,
              rollbackError
            );
          }
        }
        throw upsertError;
      }

      if (moving) {
        try {
          const cleaned = await this.boardRepo.removeBoardObject(oldBoardId, objectId);
          this.app.service('boards').emit('patched', cleaned);
        } catch {
          // Old board may not have this object (e.g. was already cleaned up),
          // or the old board was deleted. The destination upsert already
          // succeeded, so the artifact is reachable on its new board.
        }
      }
    }

    this.app.service('artifacts').emit('patched', updated);
    return updated;
  }

  /**
   * Materialize an artifact's stored file map to a destination under a worktree.
   * Inverse of publish().
   *
   * Security:
   * - destination must resolve strictly inside the worktree (not equal to the
   *   worktree root) — prevents overwriting random files via `subpath`.
   * - per-file paths from the artifact's `files` map are re-validated to block
   *   traversal keys like `../../etc/passwd` that could have been snuck into
   *   the serialized file map.
   * - when overwriting, uses `fs.rm` which removes symlinks rather than
   *   following them.
   */
  async land(
    artifactId: string,
    worktreePath: string,
    options?: { subpath?: string; overwrite?: boolean }
  ): Promise<{ destinationPath: string; fileCount: number; bytesWritten: number }> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (!artifact.files || Object.keys(artifact.files).length === 0) {
      throw new Error(`Artifact ${artifactId} has no stored files to land`);
    }

    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree path does not exist: ${worktreePath}`);
    }
    // Canonicalize the worktree root so a symlinked root (e.g. a worktree
    // whose `path` column is a symlink into $HOME) cannot be used to defeat
    // the containment check below. Mirrors the pattern in
    // apps/agor-daemon/src/services/file.ts and
    // packages/core/src/git/index.ts.
    const worktreeRoot = await realpath(worktreePath);

    // Default destination: .agor/artifacts/<artifact-id>
    const rawSubpath =
      options?.subpath && options.subpath.trim().length > 0
        ? options.subpath
        : path.join('.agor', 'artifacts', artifact.artifact_id);

    // Absolute subpath is always rejected — caller must pass a worktree-relative path.
    if (path.isAbsolute(rawSubpath)) {
      throw new Error(`subpath must be relative to the worktree root: ${rawSubpath}`);
    }

    const destination = path.resolve(worktreeRoot, rawSubpath);

    // Canonicalize any existing portion of the destination path (a
    // pre-existing symlinked parent directory must not lift the write outside
    // the worktree root).
    const canonicalDestination = await canonicalizeExistingPrefix(destination);

    // Path-escape check: destination must be strictly inside the worktree.
    // Equal to worktree root is refused — writing the artifact at the worktree
    // root would stomp user code.
    const assertInsideRoot = (candidate: string, reason: string): void => {
      if (candidate === worktreeRoot) {
        throw new Error(`${reason}: must not resolve to the worktree root`);
      }
      const rel = path.relative(worktreeRoot, candidate);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${reason}: escapes worktree root`);
      }
    };
    assertInsideRoot(destination, `subpath ${rawSubpath}`);
    assertInsideRoot(canonicalDestination, `subpath ${rawSubpath} (canonical)`);

    // Validate file-map keys for traversal. Artifact file keys are stored as
    // `/path/to/file` (leading slash, forward slashes). Strip leading slash,
    // resolve inside destination, and verify containment.
    for (const filePath of Object.keys(artifact.files)) {
      const key = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      if (path.isAbsolute(key)) {
        throw new Error(`Artifact contains absolute file path: ${filePath}`);
      }
      const resolved = path.resolve(destination, key);
      const rel = path.relative(destination, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Artifact file path escapes destination: ${filePath}`);
      }
    }

    // Handle existing destination.
    if (fs.existsSync(destination)) {
      if (!options?.overwrite) {
        throw new Error(
          `Destination already exists: ${destination} (pass overwrite=true to replace)`
        );
      }
      // fs.rm with recursive unlinks symlinks rather than following them.
      await rm(destination, { recursive: true, force: true });
    }

    await mkdir(destination, { recursive: true });

    // Write the file map.
    let bytesWritten = 0;
    let fileCount = 0;
    for (const [filePath, content] of Object.entries(artifact.files)) {
      const key = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      const fullPath = path.join(destination, key);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      bytesWritten += Buffer.byteLength(content, 'utf-8');
      fileCount += 1;
    }

    // Reconstruct sandpack.json for round-trip with publish() (publish skips
    // sandpack.json when reading, and reconstitutes manifest state from DB
    // columns).
    const manifest: SandpackManifest = { template: artifact.template };
    if (artifact.dependencies) manifest.dependencies = artifact.dependencies;
    if (artifact.entry) manifest.entry = artifact.entry;
    if (artifact.use_local_bundler) manifest.use_local_bundler = artifact.use_local_bundler;
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(destination, 'sandpack.json'), manifestJson, 'utf-8');
    bytesWritten += Buffer.byteLength(manifestJson, 'utf-8');
    fileCount += 1;

    return { destinationPath: destination, fileCount, bytesWritten };
  }

  /**
   * Read artifact payload for the frontend.
   * Primary path: reads from DB `files` column.
   * Legacy fallback: reads from filesystem if `files` is null (un-migrated artifacts).
   * If the artifact contains an /agor.config.js file, it is treated as a
   * Handlebars template and rendered with the requesting user's context.
   */
  async getPayload(artifactId: string, userId?: UserID): Promise<ArtifactPayload> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    // Visibility check: private artifacts are only visible to their creator
    if (!artifact.public) {
      if (!userId || !artifact.created_by || artifact.created_by !== userId) {
        throw new Error(`Artifact ${artifactId} not found`);
      }
    }

    if (!artifact.files) {
      throw new Error(`Artifact ${artifactId} has no files in DB — cannot serve payload`);
    }

    const files: Record<string, string> = { ...artifact.files };
    const manifest: SandpackManifest = {
      template: artifact.template as SandpackTemplate,
      dependencies: artifact.dependencies,
      entry: artifact.entry,
      use_local_bundler: artifact.use_local_bundler,
    };

    // Compute hash from files
    const contentHash = this.computeHashFromFiles(files);

    // Render agor.config.js template if present
    let missingEnvVars: string[] | undefined;
    if (files[AGOR_CONFIG_FILE]) {
      const result = await this.renderAgorConfig(files[AGOR_CONFIG_FILE], artifact, userId);
      files[AGOR_CONFIG_FILE] = result.rendered;
      if (result.missingEnvVars.length > 0) {
        missingEnvVars = result.missingEnvVars;
      }
    }

    // Resolve bundlerURL
    let bundlerURL: string | undefined;
    if (manifest.use_local_bundler) {
      if (this.selfHostedBundlerURL) {
        bundlerURL = this.selfHostedBundlerURL;
      } else {
        console.warn(
          `[artifacts] Artifact ${artifactId} opted into local bundler but no self-hosted bundler is available on this daemon. Falling back to CodeSandbox hosted bundler. Rebuild with --with-sandpack to restore local bundling.`
        );
      }
    }

    return {
      artifact_id: artifact.artifact_id,
      name: artifact.name,
      description: artifact.description,
      template: manifest.template ?? (artifact.template as SandpackTemplate),
      files,
      dependencies: manifest.dependencies,
      entry: manifest.entry,
      content_hash: contentHash,
      ...(missingEnvVars ? { missing_env_vars: missingEnvVars } : {}),
      ...(bundlerURL ? { bundlerURL } : {}),
    };
  }

  /**
   * Check build: verify artifact files exist and are non-empty.
   * Reads from a folder path (pre-publish check) or from DB (post-publish check).
   */
  async checkBuildFromFolder(folderPath: string): Promise<{
    status: ArtifactBuildStatus;
    errors: string[];
  }> {
    const resolved = path.resolve(folderPath);
    await this.validatePublishPath(resolved);

    if (!fs.existsSync(resolved)) {
      return { status: 'error', errors: [`Folder not found: ${folderPath}`] };
    }

    const files = this.readFilesRecursive(resolved, resolved);
    return this.validateFiles(files);
  }

  async checkBuild(artifactId: string): Promise<{
    status: ArtifactBuildStatus;
    errors: string[];
  }> {
    const payload = await this.getPayload(artifactId);
    const result = this.validateFiles(payload.files);

    // Update DB
    await this.artifactRepo.updateBuildStatus(
      artifactId,
      result.status,
      result.errors.length > 0 ? result.errors : undefined
    );

    return result;
  }

  /**
   * Store console log entries from frontend
   */
  appendConsoleLogs(artifactId: string, entries: ArtifactConsoleEntry[]): void {
    const existing = this.consoleLogs.get(artifactId) ?? [];
    const combined = [...existing, ...entries];

    // Ring buffer: keep last MAX_CONSOLE_ENTRIES
    if (combined.length > MAX_CONSOLE_ENTRIES) {
      this.consoleLogs.set(artifactId, combined.slice(-MAX_CONSOLE_ENTRIES));
    } else {
      this.consoleLogs.set(artifactId, combined);
    }
  }

  /**
   * Store Sandpack error state from the browser frontend.
   * Called when useSandpack() reports an error change in the iframe.
   */
  setSandpackError(artifactId: string, error: SandpackError | null, status?: string): void {
    this.sandpackErrors.set(artifactId, error);
    if (status !== undefined) {
      this.sandpackStatuses.set(artifactId, status);
    }
  }

  /**
   * Get artifact status (build + console logs + Sandpack state) for agent debugging.
   *
   * build_status reflects the worst state: if Sandpack reports an error,
   * it overrides the file-validation status even if files are structurally valid.
   */
  async getStatus(artifactId: string): Promise<ArtifactStatus> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    const sandpackError = this.sandpackErrors.get(artifactId) ?? null;
    const sandpackStatus = this.sandpackStatuses.get(artifactId);

    // Override build_status if Sandpack reports an error
    let buildStatus = artifact.build_status;
    let buildErrors = artifact.build_errors;

    if (sandpackError) {
      buildStatus = 'error';
      // Merge Sandpack error into build_errors so agents see it in one place
      const sandpackMsg = `[Sandpack] ${sandpackError.message}`;
      buildErrors = [...(buildErrors ?? []), sandpackMsg];
    }

    return {
      artifact_id: artifact.artifact_id,
      build_status: buildStatus,
      build_errors: buildErrors,
      sandpack_error: sandpackError,
      sandpack_status: sandpackStatus,
      console_logs: this.consoleLogs.get(artifactId) ?? [],
      content_hash: artifact.content_hash,
    };
  }

  /**
   * Delete artifact: remove board object and DB record.
   * No filesystem cleanup — files aren't ours to manage.
   */
  async deleteArtifact(artifactId: string): Promise<void> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    // Remove board object reference
    const objectId = `artifact-${artifactId}`;
    try {
      const updatedBoard = await this.boardRepo.removeBoardObject(artifact.board_id, objectId);
      if (this.app && updatedBoard) {
        this.app.service('boards').emit('patched', updatedBoard);
      }
    } catch {
      // Board object may not exist or board may be deleted
    }

    // Clear in-memory state
    this.consoleLogs.delete(artifactId);
    this.sandpackErrors.delete(artifactId);
    this.sandpackStatuses.delete(artifactId);

    // Delete DB record
    await this.artifactRepo.delete(artifactId);
  }

  /**
   * Find artifacts by board ID with visibility filtering.
   * Always enforces visibility: public artifacts + private artifacts owned by userId.
   * Anonymous callers (no userId) see only public artifacts.
   */
  async findByBoardId(boardId: BoardID, userId?: string): Promise<Artifact[]> {
    return this.artifactRepo.findByBoardId(boardId, { userId: userId ?? '__anonymous__' });
  }

  /**
   * Find all visible artifacts (across boards) for a user.
   * Anonymous callers see only public artifacts.
   */
  async findVisible(userId?: string, options?: { limit?: number }): Promise<Artifact[]> {
    return this.artifactRepo.findVisible(userId ?? '__anonymous__', { limit: options?.limit });
  }

  // ── Private helpers ──

  /**
   * Validate that a publish folder path is inside an allowed root directory.
   * Allowed roots: any registered worktree path, /tmp, /var/tmp.
   * Prevents reading arbitrary filesystem paths through the publish API.
   */
  private async validatePublishPath(folderPath: string): Promise<void> {
    const resolved = path.resolve(folderPath);

    // Allow temp directories
    const allowedTempRoots = ['/tmp', '/var/tmp'];
    for (const root of allowedTempRoots) {
      if (resolved.startsWith(root + path.sep) || resolved === root) return;
    }

    // Allow any registered worktree path
    const worktrees = await this.worktreeRepo.findAll();
    for (const wt of worktrees) {
      const wtPath = path.resolve(wt.path);
      if (resolved.startsWith(wtPath + path.sep) || resolved === wtPath) return;
    }

    throw new Error(
      `Publish path rejected: ${folderPath} is not inside a known worktree or temp directory`
    );
  }

  /**
   * Validate files: check that source files exist and are non-empty
   */
  private validateFiles(files: Record<string, string>): {
    status: ArtifactBuildStatus;
    errors: string[];
  } {
    const errors: string[] = [];

    const sourceFiles = Object.entries(files).filter(([fp]) =>
      /\.(js|jsx|ts|tsx|html|css)$/.test(fp)
    );

    if (sourceFiles.length === 0) {
      errors.push('No source files found in artifact');
    }

    for (const [filePath, content] of sourceFiles) {
      if (!content || content.trim().length === 0) {
        errors.push(`${filePath}: file is empty`);
      }
    }

    return { status: errors.length > 0 ? 'error' : 'success', errors };
  }

  /**
   * Render an agor.config.js Handlebars template with user-specific context.
   * Returns the rendered string and a list of user.env.* vars that are missing.
   */
  private async renderAgorConfig(
    rawTemplate: string,
    artifact: Artifact,
    userId?: UserID
  ): Promise<{ rendered: string; missingEnvVars: string[] }> {
    // Extract all user.env.* references from the template AST
    const requiredEnvVars = this.extractUserEnvPaths(rawTemplate);

    // Build template context. Use the canonical base URL resolver so the
    // proxy URLs surfaced to artifacts (`agor.proxies.<vendor>.url`) match
    // what `agor_proxies_list` returns and respect AGOR_BASE_URL /
    // daemon.base_url overrides for deployed instances.
    const daemonUrl = await getBaseUrl();

    // Resolve board slug for template context
    const board = await this.boardRepo.findById(artifact.board_id);

    // Resolve configured HTTP proxies so artifacts can reference
    // {{ agor.proxies.<vendor>.url }} without hardcoding the daemon host.
    // Failure here must not break artifact rendering — fall back to an empty
    // map so missing-proxy lookups render as "" the same way missing env
    // vars do.
    const proxiesContext: Record<
      string,
      { url: string; upstream: string; allowed_methods: string[] }
    > = {};
    try {
      const config = await loadConfig();
      const proxies = resolveProxies(config);
      for (const p of proxies) {
        proxiesContext[p.vendor] = {
          url: `${daemonUrl.replace(/\/$/, '')}/proxies/${p.vendor}`,
          upstream: p.upstream,
          allowed_methods: [...p.allowed_methods],
        };
      }
    } catch (err) {
      console.warn('[artifacts] failed to resolve proxies for template context:', err);
    }

    const context: Record<string, unknown> = {
      artifact: { id: artifact.artifact_id, boardId: artifact.board_id },
      agor: { apiUrl: daemonUrl, proxies: proxiesContext },
      board: { id: artifact.board_id, slug: board?.slug ?? '' },
    };

    let missingEnvVars: string[] = requiredEnvVars; // all missing if no user

    if (userId) {
      try {
        const usersService = this.app.service('users') as unknown as UsersService;
        const [envVars, user] = await Promise.all([
          usersService.getEnvironmentVariables(userId),
          usersService.get(userId),
        ]);
        context.user = { id: userId, name: user.name ?? '', email: user.email, env: envVars };
        missingEnvVars = requiredEnvVars.filter((v) => !envVars[v]);
      } catch (error) {
        console.error(
          `Failed to resolve env vars for artifact ${artifact.artifact_id}, user ${userId}:`,
          error
        );
        context.user = { id: userId, env: {} };
      }
    }

    // Render template using shared core helper (missing values become "")
    const rendered = renderTemplate(rawTemplate, context);
    // renderTemplate returns "" on error; fall back to raw template so the user sees something
    return { rendered: rendered || rawTemplate, missingEnvVars };
  }

  /**
   * Parse a Handlebars template and extract all user.env.* variable names.
   * Performs a full AST traversal to catch references in any position
   * (mustache statements, block params, subexpressions, helpers, etc.).
   */
  private extractUserEnvPaths(templateString: string): string[] {
    try {
      const ast = Handlebars.parse(templateString);
      const paths: string[] = [];

      function collectPathExpression(node: Record<string, unknown>): void {
        if (node.type === 'PathExpression' && typeof node.original === 'string') {
          if (node.original.startsWith('user.env.')) {
            paths.push(node.original.replace('user.env.', ''));
          }
        }
      }

      function walk(node: unknown): void {
        if (!node || typeof node !== 'object') return;
        const n = node as Record<string, unknown>;

        // Check this node itself for PathExpression
        collectPathExpression(n);

        // Traverse all known AST child properties
        for (const key of ['body', 'params', 'hash', 'pairs']) {
          const child = n[key];
          if (Array.isArray(child)) child.forEach(walk);
        }
        for (const key of ['path', 'program', 'inverse', 'value']) {
          if (n[key] && typeof n[key] === 'object') walk(n[key]);
        }
      }

      walk(ast);
      return [...new Set(paths)];
    } catch {
      return [];
    }
  }

  /**
   * Compute content hash from in-memory file map
   */
  private computeHashFromFiles(files: Record<string, string>): string {
    const hash = createHash('md5');
    const sortedKeys = Object.keys(files).sort();

    for (const key of sortedKeys) {
      hash.update(`${key}:${files[key]}`);
    }

    return hash.digest('hex');
  }

  private getFileList(dirPath: string, rootDir?: string): string[] {
    const root = rootDir ?? dirPath;
    const files: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Skip symlinks to prevent escape outside artifact directory
      if (entry.isSymbolicLink()) continue;

      // Verify resolved path stays within root directory
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          files.push(...this.getFileList(fullPath, root));
        }
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }

  private readFilesRecursive(dirPath: string, rootDir: string): Record<string, string> {
    const files: Record<string, string> = {};
    const fileList = this.getFileList(dirPath);

    for (const file of fileList) {
      const relativePath = path.relative(rootDir, file);
      // Skip sandpack.json (it's the manifest, not a source file)
      if (relativePath === 'sandpack.json') continue;
      // Use forward slashes and prefix with /
      const normalizedPath = `/${relativePath.replace(/\\/g, '/')}`;
      files[normalizedPath] = fs.readFileSync(file, 'utf-8');
    }

    return files;
  }
}

export function createArtifactsService(db: Database, app: Application): ArtifactsService {
  return new ArtifactsService(db, app);
}
