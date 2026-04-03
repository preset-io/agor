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
  WorktreeID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle.js';

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
   * Read artifact directory and build the payload for the frontend
   */
  async getPayload(artifactId: string): Promise<ArtifactPayload> {
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

    return {
      artifact_id: artifact.artifact_id,
      name: artifact.name,
      description: artifact.description,
      template: manifest.template ?? (artifact.template as SandpackTemplate),
      files,
      dependencies: manifest.dependencies,
      entry: manifest.entry,
      content_hash: contentHash,
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
