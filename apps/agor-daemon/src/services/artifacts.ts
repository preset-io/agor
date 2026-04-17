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
import * as path from 'node:path';
import { generateId } from '@agor/core';
import { PAGINATION } from '@agor/core/config';
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

    // Build template context
    const daemonUrl =
      process.env.VITE_DAEMON_URL || `http://localhost:${process.env.PORT || '3030'}`;

    // Resolve board slug for template context
    const board = await this.boardRepo.findById(artifact.board_id);

    const context: Record<string, unknown> = {
      artifact: { id: artifact.artifact_id, boardId: artifact.board_id },
      agor: { apiUrl: daemonUrl },
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
