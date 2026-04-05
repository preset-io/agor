/**
 * Artifacts Service
 *
 * Provides REST + WebSocket API for artifact management.
 * Artifacts are filesystem-backed Sandpack applications managed by agents via MCP tools.
 *
 * Key behavior:
 * - Artifact creation scaffolds a filesystem directory and creates a board object reference
 * - Build checking reads files from disk and validates via esbuild
 * - Refresh re-reads filesystem and broadcasts to connected clients
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

/**
 * Default files for each template when no initial files are provided
 */
const DEFAULT_FILES: Record<string, Record<string, string>> = {
  react: {
    '/App.js': `export default function App() {
  return <h1>Hello from Agor Artifact</h1>;
}`,
  },
  'react-ts': {
    '/App.tsx': `export default function App() {
  return <h1>Hello from Agor Artifact</h1>;
}`,
  },
  vanilla: {
    '/index.js': `document.getElementById("app").innerHTML = "<h1>Hello from Agor Artifact</h1>";`,
    '/index.html': `<!DOCTYPE html>
<html><body><div id="app"></div><script src="index.js"></script></body></html>`,
  },
  'vanilla-ts': {
    '/index.ts': `document.getElementById("app")!.innerHTML = "<h1>Hello from Agor Artifact</h1>";`,
    '/index.html': `<!DOCTYPE html>
<html><body><div id="app"></div><script src="index.ts"></script></body></html>`,
  },
};

export class ArtifactsService extends DrizzleService<Artifact, Partial<Artifact>, ArtifactParams> {
  private artifactRepo: ArtifactRepository;
  private worktreeRepo: WorktreeRepository;
  private boardRepo: BoardRepository;
  private app: Application;

  /** In-memory ring buffer for console logs per artifact */
  private consoleLogs: Map<string, ArtifactConsoleEntry[]> = new Map();

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
  // Artifacts require filesystem scaffolding (create) and cleanup (remove).
  // Raw Feathers create/remove would skip these, causing orphaned state.
  // Use createArtifact() / deleteArtifact() or MCP tools instead.

  async create(_data: Partial<Artifact>, _params?: unknown): Promise<Artifact> {
    throw new Error(
      'Direct artifact creation not supported. Use createArtifact() or agor_artifacts_create MCP tool.'
    );
  }

  async remove(id: string | number, _params?: unknown): Promise<Artifact> {
    const artifactId = String(id);
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    await this.deleteArtifact(artifactId);
    return artifact;
  }

  /**
   * Create an artifact: scaffold filesystem, create DB record, place on board
   */
  async createArtifact(
    data: {
      name: string;
      board_id: string;
      worktree_id: string;
      template?: SandpackTemplate;
      files?: Record<string, string>;
      dependencies?: Record<string, string>;
      entry?: string;
      use_local_bundler?: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    userId?: string
  ): Promise<Artifact> {
    const template = data.template ?? 'react';
    const artifactId = generateId();
    const relativePath = `.agor/artifacts/${artifactId}`;

    // Validate use_local_bundler opt-in: fail fast if the daemon wasn't built
    // with --with-sandpack. Better to error here than to silently render with
    // the wrong bundler on an air-gapped deployment.
    if (data.use_local_bundler && !this.selfHostedBundlerURL) {
      throw new Error(
        'Cannot create artifact with use_local_bundler=true: this daemon was not built with --with-sandpack, so no self-hosted Sandpack bundler is available. Either rebuild the daemon with `./build.sh --with-sandpack`, or omit use_local_bundler to use the default CodeSandbox hosted bundler.'
      );
    }

    // Resolve worktree to get filesystem path
    const worktree = await this.worktreeRepo.findById(data.worktree_id);
    if (!worktree) throw new Error(`Worktree ${data.worktree_id} not found`);

    const artifactDir = path.join(worktree.path, relativePath);

    // Scaffold directory
    fs.mkdirSync(artifactDir, { recursive: true });

    try {
      // Write sandpack.json manifest
      const manifest: SandpackManifest = {
        template,
        dependencies: data.dependencies,
        entry: data.entry,
        ...(data.use_local_bundler ? { use_local_bundler: true } : {}),
      };
      fs.writeFileSync(path.join(artifactDir, 'sandpack.json'), JSON.stringify(manifest, null, 2));

      // Write initial files with path containment check
      const files = data.files ?? DEFAULT_FILES[template] ?? DEFAULT_FILES.react;
      for (const [filePath, content] of Object.entries(files)) {
        const relativePart = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        const fullPath = path.resolve(artifactDir, relativePart);

        // Path traversal guard: ensure resolved path stays within artifact directory
        if (!fullPath.startsWith(artifactDir + path.sep) && fullPath !== artifactDir) {
          throw new Error(
            `Path traversal detected: ${filePath} resolves outside artifact directory`
          );
        }

        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content);
      }

      // Compute initial content hash
      const contentHash = this.computeHash(artifactDir);

      // Create DB record
      const artifact = await this.artifactRepo.create({
        artifact_id: artifactId,
        worktree_id: data.worktree_id as WorktreeID,
        board_id: data.board_id as BoardID,
        name: data.name,
        path: relativePath,
        template,
        content_hash: contentHash,
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

        // Emit board patched event so the UI updates in real-time via WebSocket
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

      return artifact;
    } catch (error) {
      // Compensate: remove scaffolded directory on any failure
      if (fs.existsSync(artifactDir)) {
        fs.rmSync(artifactDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /**
   * Read artifact directory and build the payload for the frontend.
   * If the artifact contains an /agor.config.js file, it is treated as a
   * Handlebars template and rendered with the requesting user's context.
   */
  async getPayload(artifactId: string, userId?: UserID): Promise<ArtifactPayload> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    const worktree = await this.worktreeRepo.findById(artifact.worktree_id);
    if (!worktree) throw new Error(`Worktree ${artifact.worktree_id} not found`);

    const artifactDir = this.resolveArtifactDir(worktree.path, artifact.path);

    if (!fs.existsSync(artifactDir)) {
      throw new Error(`Artifact directory not found: ${artifactDir}`);
    }

    // Read sandpack.json
    const manifestPath = path.join(artifactDir, 'sandpack.json');
    let manifest: SandpackManifest = { template: artifact.template as SandpackTemplate };
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }

    // Read all files from directory (excluding sandpack.json)
    const files = this.readFilesRecursive(artifactDir, artifactDir);

    // Compute hash
    const contentHash = this.computeHash(artifactDir);

    // Render agor.config.js template if present
    let missingEnvVars: string[] | undefined;
    if (files[AGOR_CONFIG_FILE]) {
      const result = await this.renderAgorConfig(files[AGOR_CONFIG_FILE], artifact, userId);
      files[AGOR_CONFIG_FILE] = result.rendered;
      if (result.missingEnvVars.length > 0) {
        missingEnvVars = result.missingEnvVars;
      }
    }

    // Resolve bundlerURL: only when the manifest explicitly opts into the local
    // bundler via use_local_bundler=true. Otherwise omit it so the frontend uses
    // Sandpack's default CodeSandbox hosted bundler. If the artifact opted in but
    // the daemon no longer has a local bundler (e.g. rebuilt without --with-sandpack),
    // silently fall back to hosted — log a warning so operators can notice.
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
   * Get content hash for cache validation
   */
  async getHash(artifactId: string): Promise<string> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    const worktree = await this.worktreeRepo.findById(artifact.worktree_id);
    if (!worktree) throw new Error(`Worktree ${artifact.worktree_id} not found`);

    const artifactDir = this.resolveArtifactDir(worktree.path, artifact.path);
    return this.computeHash(artifactDir);
  }

  /**
   * Check build: verify artifact files exist and are non-empty.
   *
   * Note: `new Function()` was considered for syntax checking but it cannot
   * parse ESM (export/import), JSX, or TypeScript — which are the primary
   * Sandpack use cases. Real syntax validation requires esbuild (v2 enhancement).
   * For now, we validate file existence and structure.
   */
  async checkBuild(artifactId: string): Promise<{
    status: ArtifactBuildStatus;
    errors: string[];
  }> {
    const payload = await this.getPayload(artifactId);
    const errors: string[] = [];

    // Check that at least one source file exists
    const sourceFiles = Object.entries(payload.files).filter(([fp]) =>
      /\.(js|jsx|ts|tsx|html|css)$/.test(fp)
    );

    if (sourceFiles.length === 0) {
      errors.push('No source files found in artifact');
    }

    // Check for empty source files
    for (const [filePath, content] of sourceFiles) {
      if (!content || content.trim().length === 0) {
        errors.push(`${filePath}: file is empty`);
      }
    }

    const status: ArtifactBuildStatus = errors.length > 0 ? 'error' : 'success';

    // Update DB
    await this.artifactRepo.updateBuildStatus(
      artifactId,
      status,
      errors.length > 0 ? errors : undefined
    );

    return { status, errors };
  }

  /**
   * Refresh: re-read filesystem, compute new hash, broadcast update
   */
  async refresh(artifactId: string): Promise<Artifact> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    const worktree = await this.worktreeRepo.findById(artifact.worktree_id);
    if (!worktree) throw new Error(`Worktree ${artifact.worktree_id} not found`);

    const artifactDir = this.resolveArtifactDir(worktree.path, artifact.path);
    const newHash = this.computeHash(artifactDir);

    // Update hash in DB
    const updated = await this.artifactRepo.updateContentHash(artifactId, newHash);

    return updated;
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
   * Get artifact status (build + console logs) for agent debugging
   */
  async getStatus(artifactId: string): Promise<ArtifactStatus> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    return {
      artifact_id: artifact.artifact_id,
      build_status: artifact.build_status,
      build_errors: artifact.build_errors,
      console_logs: this.consoleLogs.get(artifactId) ?? [],
      content_hash: artifact.content_hash,
    };
  }

  /**
   * Delete artifact: remove filesystem, board object, and DB record
   */
  async deleteArtifact(artifactId: string): Promise<void> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    // Remove filesystem directory
    const worktree = await this.worktreeRepo.findById(artifact.worktree_id);
    if (worktree) {
      const artifactDir = this.resolveArtifactDir(worktree.path, artifact.path);
      if (fs.existsSync(artifactDir)) {
        fs.rmSync(artifactDir, { recursive: true, force: true });
      }
    }

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

    // Clear console logs
    this.consoleLogs.delete(artifactId);

    // Delete DB record
    await this.artifactRepo.delete(artifactId);
  }

  /**
   * Find artifacts by board ID
   */
  async findByBoardId(boardId: BoardID): Promise<Artifact[]> {
    return this.artifactRepo.findByBoardId(boardId);
  }

  // ── Private helpers ──

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

      // TODO: generate scoped artifact token via SessionTokenService
      // (context.agor as any).token = await this.generateArtifactToken(artifact, userId);
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
   * Resolve artifact directory with path containment check.
   * Prevents path traversal via malicious artifact.path values.
   */
  private resolveArtifactDir(worktreePath: string, artifactPath: string): string {
    const resolved = path.resolve(worktreePath, artifactPath);
    const worktreeReal = path.resolve(worktreePath);
    if (!resolved.startsWith(worktreeReal + path.sep) && resolved !== worktreeReal) {
      throw new Error('Path traversal detected: artifact path resolves outside worktree');
    }
    return resolved;
  }

  private computeHash(dirPath: string): string {
    if (!fs.existsSync(dirPath)) return '';

    const hash = createHash('md5');
    const files = this.getFileList(dirPath);

    for (const file of files.sort()) {
      const content = fs.readFileSync(file, 'utf-8');
      hash.update(`${path.relative(dirPath, file)}:${content}`);
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
