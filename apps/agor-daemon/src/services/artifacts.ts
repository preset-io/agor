/**
 * Artifacts Service
 *
 * REST + WebSocket API for artifact management. Artifacts are board-scoped,
 * DB-backed Sandpack apps. The format is deliberately small: a file map +
 * declarative metadata (`required_env_vars`, `agor_grants`, `sandpack_config`).
 * The daemon handles secret/grant injection at render time and never persists
 * the synthesized values.
 *
 * No backwards compatibility with the legacy `sandpack.json`/`agor.config.js`
 * sidecar format — `detectLegacyFormat` flags old artifacts so the UI can
 * surface a self-service upgrade prompt.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { generateId } from '@agor/core';
import {
  getBaseUrl,
  loadConfig,
  PAGINATION,
  resolveProxies,
  resolveUserEnvironment,
} from '@agor/core/config';
import {
  ArtifactRepository,
  ArtifactTrustGrantRepository,
  BoardRepository,
  type Database,
  WorktreeRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AgorGrants,
  AgorRuntimeConfig,
  Artifact,
  ArtifactBuildStatus,
  ArtifactConsoleEntry,
  ArtifactPayload,
  ArtifactStatus,
  ArtifactTrustScopeType,
  BoardID,
  QueryParams,
  SandpackConfig,
  SandpackError,
  SandpackTemplate,
  UserID,
  UserRole,
  WorktreeID,
} from '@agor/core/types';
import {
  ARTIFACT_SCOPED_ONLY_GRANT_KEYS,
  GRANT_ENV_VAR_NAMES,
  hasMinimumRole,
  NO_CONSENT_GRANT_KEYS,
  proxyGrantEnvName,
  ROLES,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { DrizzleService } from '../adapters/drizzle.js';
import { AGOR_RUNTIME_SOURCE } from '../utils/agor-runtime-source.js';
import {
  detectLegacyFormat,
  envVarPrefixForTemplate,
  sanitizeSandpackConfig,
} from '../utils/sandpack-config.js';
import type { UsersService } from './users.js';

/**
 * Resolve a destination path by canonicalizing the longest existing prefix via
 * `realpath` and re-joining the still-nonexistent tail. Used by `land()` to
 * detect symlinked ancestors that would otherwise defeat a lexical
 * containment check.
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

/**
 * Lazily-built data URL carrying the agor-runtime IIFE. Sandpack injects
 * each `externalResources` entry as a `<script src="...">` tag in the
 * iframe HTML, so a `data:text/javascript;base64,…` URL avoids any extra
 * HTTP round-trip and any cross-origin coupling. Built once per process —
 * the source is a static constant.
 *
 * The `#agor-runtime.js` fragment is necessary because Sandpack's static
 * client infers content type from the URL's last extension via
 * `/\.([^.]*)$/` and rejects anything that isn't `.js` or `.css` (see
 * `@codesandbox/sandpack-client/dist/index-*.mjs` -> `injectExternalResources`).
 * A bare `data:text/javascript;base64,…` ends in base64 chars, which would
 * be silently rejected. Browsers strip the fragment when fetching, so the
 * decoded body runs identically.
 */
let cachedAgorRuntimeDataUrl: string | null = null;
function agorRuntimeDataUrl(): string {
  if (cachedAgorRuntimeDataUrl !== null) return cachedAgorRuntimeDataUrl;
  const b64 = Buffer.from(AGOR_RUNTIME_SOURCE, 'utf-8').toString('base64');
  cachedAgorRuntimeDataUrl = `data:text/javascript;base64,${b64}#agor-runtime.js`;
  return cachedAgorRuntimeDataUrl;
}

/**
 * Return a copy of `cfg` with the agor-runtime data URL set as the sole
 * entry in `options.externalResources`. The persisted `sandpack_config`
 * is never mutated — this builds a new object for the served payload only.
 *
 * `externalResources` is daemon-owned: `sanitizeSandpackConfig` deliberately
 * strips it on write (XSS into the iframe), so we don't preserve any
 * author-supplied entries here even though `SandpackConfig` allows the
 * shape — re-emitting them would re-enable a prop the sanitizer blocked.
 */
function withInjectedAgorRuntime(cfg: SandpackConfig | undefined): SandpackConfig {
  const dataUrl = agorRuntimeDataUrl();
  return {
    ...(cfg ?? {}),
    options: {
      ...(cfg?.options ?? {}),
      externalResources: [dataUrl],
    },
  };
}

/**
 * Build the default `.agor/artifacts/<folder>` name used when `land()` is
 * called without a custom subpath. Combines a slugified artifact name with
 * the first 8 chars of the UUID — readable AND collision-resistant — so the
 * folder is easy to navigate while still uniquely identifying the artifact.
 */
function defaultLandFolderName(artifact: { name: string; artifact_id: string }): string {
  const slug = artifact.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const shortId = artifact.artifact_id.replace(/-/g, '').slice(0, 8);
  return slug.length > 0 ? `${slug}-${shortId}` : artifact.artifact_id;
}

/**
 * Round-trip sidecar shape written by `land()` and read back by `publishArtifact()`.
 * Carries metadata that doesn't fit into the file map (template, sandpack
 * config, declarative consent surface).
 */
interface ArtifactSidecar {
  template?: SandpackTemplate;
  sandpack_config?: SandpackConfig;
  required_env_vars?: string[];
  agor_grants?: AgorGrants;
  agor_runtime?: AgorRuntimeConfig;
}

/**
 * Read `agor.artifact.json` from a folder if present. Returns null when the
 * file is missing or unparseable — the caller treats absence and corruption
 * the same way (fall through to other defaults).
 */
function readArtifactSidecar(folderPath: string): ArtifactSidecar | null {
  const sidecarPath = path.join(folderPath, 'agor.artifact.json');
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ArtifactSidecar>;
    return {
      template:
        typeof parsed.template === 'string' ? (parsed.template as SandpackTemplate) : undefined,
      sandpack_config:
        parsed.sandpack_config && typeof parsed.sandpack_config === 'object'
          ? (parsed.sandpack_config as SandpackConfig)
          : undefined,
      required_env_vars: Array.isArray(parsed.required_env_vars)
        ? parsed.required_env_vars
        : undefined,
      agor_grants:
        parsed.agor_grants && typeof parsed.agor_grants === 'object'
          ? (parsed.agor_grants as AgorGrants)
          : undefined,
      agor_runtime:
        parsed.agor_runtime && typeof parsed.agor_runtime === 'object'
          ? (parsed.agor_runtime as AgorRuntimeConfig)
          : undefined,
    };
  } catch (err) {
    console.warn(`[artifacts] Failed to parse agor.artifact.json in ${folderPath}:`, err);
    return null;
  }
}

export type ArtifactParams = QueryParams<{
  board_id?: BoardID;
  worktree_id?: WorktreeID;
  archived?: boolean;
}>;

const MAX_CONSOLE_ENTRIES = 100;

/** Path the synthesized .env file lands at in the file map. */
const SYNTHESIZED_ENV_PATH = '/.env';

export class ArtifactsService extends DrizzleService<Artifact, Partial<Artifact>, ArtifactParams> {
  private artifactRepo: ArtifactRepository;
  private trustRepo: ArtifactTrustGrantRepository;
  private worktreeRepo: WorktreeRepository;
  private boardRepo: BoardRepository;
  private app: Application;
  /** Held for `resolveUserEnvironment` (scope-aware env-var resolution). */
  private dbRef: Database;

  /**
   * In-memory ring buffer for console logs.
   *
   * Keyed by `${artifactId}:${userId}` — NOT just artifactId. After a viewer
   * grants trust, the daemon injects their secrets into the artifact's
   * runtime; an artifact that does `console.log(import.meta.env.VITE_X)`
   * would otherwise leak that secret into a global-per-artifact buffer
   * readable by anyone via agor_artifacts_status. Per-viewer keying
   * isolates each viewer's render output.
   */
  private consoleLogs: Map<string, ArtifactConsoleEntry[]> = new Map();

  /** In-memory Sandpack error state, keyed by `${artifactId}:${userId}`. */
  private sandpackErrors: Map<string, SandpackError | null> = new Map();

  /** In-memory Sandpack status, keyed by `${artifactId}:${userId}`. */
  private sandpackStatuses: Map<string, string> = new Map();

  /**
   * Just-once / session-scope grants live here only — never persisted.
   * Keyed by `${userId}:${artifactId}`. Cleared when the daemon restarts.
   */
  private sessionGrants: Map<string, { envVars: Set<string>; grants: AgorGrants }> = new Map();

  /**
   * In-flight runtime queries keyed by request_id.
   *
   * When an agent calls `agor_artifacts_query_dom`, the daemon emits a
   * service event a viewer's browser picks up, dispatches into the
   * Sandpack iframe via postMessage, and POSTs the iframe's reply back.
   * That POST resolves the pending entry here. Cleaned up on timeout.
   *
   * `requesterId` is checked against the response endpoint's authenticated
   * user — only the original requester can fulfill their own query, so a
   * different viewer's browser tab can't return that user's rendered DOM.
   */
  private pendingRuntimeQueries: Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
      requesterId: string;
    }
  > = new Map();

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
    this.trustRepo = new ArtifactTrustGrantRepository(db);
    this.worktreeRepo = new WorktreeRepository(db);
    this.boardRepo = new BoardRepository(db);
    this.app = app;
    this.dbRef = db;
  }

  // Direct Feathers create is intentionally rejected — artifacts require
  // the publishArtifact() lifecycle (folder → DB).
  async create(_data: Partial<Artifact>, _params?: unknown): Promise<Artifact> {
    throw new Error(
      'Direct artifact creation not supported. Use publishArtifact() or agor_artifacts_publish MCP tool.'
    );
  }

  /**
   * Patch override: route board_id and placement changes through
   * updateMetadata so the board_objects entry is moved/resized alongside the
   * row update. Plain metadata patches fall through to the default
   * DrizzleService patch.
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
      const existing = await this.artifactRepo.findById(artifactId);
      if (!existing) throw new Error(`Artifact ${artifactId} not found`);
      const callerParams = params as { user?: { user_id?: string; role?: UserRole } } | undefined;
      const callerUserId = callerParams?.user?.user_id;
      const callerRole = callerParams?.user?.role;

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
        callerUserId,
        callerRole
      );
    }

    return (await super.patch(id, data as Partial<Artifact>, params as never)) as Artifact;
  }

  /**
   * Centralized visibility predicate. Private artifacts are only readable
   * by their creator; public artifacts are readable by anyone.
   */
  isVisibleTo(artifact: Pick<Artifact, 'public' | 'created_by'>, userId?: string): boolean {
    if (artifact.public) return true;
    if (!userId || !artifact.created_by) return false;
    return artifact.created_by === userId;
  }

  async remove(id: string | number, params?: unknown): Promise<Artifact> {
    const artifactId = String(id);
    const callerParams = params as { user?: { user_id?: string; role?: UserRole } } | undefined;
    // Thread the authenticated caller through so deleteArtifact() can run
    // its owner/admin check. The Feathers REST hook chain has already
    // gated this call (see ensureArtifactOwnerOrAdmin in register-hooks),
    // so the inline check is redundant for REST callers — but it stays as
    // a defense-in-depth and as the single auth point for non-Feathers
    // callers (e.g. internal lifecycle code).
    const artifact = await this.deleteArtifact(
      artifactId,
      callerParams?.user?.user_id,
      callerParams?.user?.role
    );
    this.app.service('artifacts').emit('removed', artifact);
    return artifact;
  }

  /**
   * Publish a folder as a live Sandpack artifact on a board. Reads files from
   * `folderPath`, serializes them into the DB, and places (or updates) the
   * artifact on the board.
   *
   * Named `publishArtifact` (not `publish`) on purpose: `service.publish`
   * is a reserved Feathers channel-mixin hook — if a service defines a
   * `publish()` method, the mixin assumes custom channel routing and
   * skips all event subscriptions, including the default
   * `created`/`patched`/`removed` and custom events like `agor-query`.
   * That breaks every WebSocket fan-out from this service. See
   * `@feathersjs/transport-commons` channels/index.ts.
   */
  async publishArtifact(
    data: {
      folderPath: string;
      board_id?: string;
      name?: string;
      artifact_id?: string;
      template?: SandpackTemplate;
      public?: boolean;
      sandpack_config?: SandpackConfig;
      required_env_vars?: string[];
      agor_grants?: AgorGrants;
      agor_runtime?: AgorRuntimeConfig;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    },
    userId?: string
  ): Promise<Artifact> {
    const folderPath = path.resolve(data.folderPath);

    // Path containment: only allow reading from worktree paths or temp dirs.
    // The matching worktree id (if any) is stored on the row for provenance
    // + future "list artifacts I published from worktree X" filtering.
    const matchedWorktreeId = await this.validatePublishPath(folderPath);

    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder not found: ${folderPath}`);
    }

    // Round-trip metadata: read agor.artifact.json (written by land()). Acts
    // as a fallback for fields the caller didn't supply explicitly.
    const sidecar = readArtifactSidecar(folderPath);

    // For updates, load the existing row up-front so it can serve as the
    // bottom of the fallback chain (data > sidecar > existing > default).
    let existing: Artifact | null = null;
    if (data.artifact_id) {
      existing = await this.artifactRepo.findById(data.artifact_id);
      if (!existing) throw new Error(`Artifact ${data.artifact_id} not found`);
      if (userId && existing.created_by && existing.created_by !== userId) {
        throw new Error('Cannot update artifact: not the owner');
      }
    }

    const files = this.readFilesRecursive(folderPath, folderPath);

    // Resolution chain for each field: explicit data > sidecar > existing > default.
    const resolvedSandpackConfig = sanitizeSandpackConfig(
      data.sandpack_config ?? sidecar?.sandpack_config ?? existing?.sandpack_config
    );
    const template = (data.template ??
      resolvedSandpackConfig.template ??
      sidecar?.template ??
      existing?.template ??
      'react') as SandpackTemplate;
    if (!resolvedSandpackConfig.template) resolvedSandpackConfig.template = template;
    const requiredEnvVars = sanitizeEnvVarNames(
      data.required_env_vars ?? sidecar?.required_env_vars ?? existing?.required_env_vars
    );
    const agorGrants = sanitizeAgorGrants(
      data.agor_grants ?? sidecar?.agor_grants ?? existing?.agor_grants
    );
    // agor_runtime is a small flag bag (currently just `enabled`). Same
    // explicit-data > sidecar > existing > default chain. Default is
    // implicit-enabled (i.e. `undefined` reads as enabled at render time).
    const agorRuntime: AgorRuntimeConfig | undefined =
      data.agor_runtime ?? sidecar?.agor_runtime ?? existing?.agor_runtime ?? undefined;

    // Name and board are required on create; on update they default to the
    // existing row so a routine republish doesn't have to know them.
    const resolvedName = data.name ?? existing?.name;
    if (!resolvedName) {
      throw new Error('name is required when creating a new artifact');
    }
    const resolvedBoardId = (data.board_id ?? existing?.board_id) as BoardID | undefined;
    if (!resolvedBoardId) {
      throw new Error('boardId is required when creating a new artifact');
    }

    const isPublic = data.public ?? existing?.public ?? true;

    // package.json#dependencies is the source of truth; cache it on the row
    // for cheap list-friendly reads.
    const cachedDeps = this.extractDependenciesFromPackageJson(files);
    const cachedEntry = resolvedSandpackConfig.customSetup?.entry;

    const contentHash = this.computeHashFromFiles(files);

    if (existing) {
      const buildResult = this.validateFiles(files);

      const updated = await this.artifactRepo.update(existing.artifact_id, {
        name: resolvedName,
        worktree_id: matchedWorktreeId ?? existing.worktree_id ?? null,
        files,
        dependencies: cachedDeps,
        entry: cachedEntry,
        template,
        sandpack_config: resolvedSandpackConfig,
        required_env_vars: requiredEnvVars,
        agor_grants: agorGrants,
        agor_runtime: agorRuntime,
        content_hash: contentHash,
        public: isPublic,
        build_status: buildResult.status,
        build_errors: buildResult.errors.length > 0 ? buildResult.errors : undefined,
      });

      // Stale Sandpack state — new content will produce fresh state from
      // the browser. Use the helper to clear ALL per-viewer entries; bare
      // `delete(artifact_id)` no longer matches the keys (which are now
      // `${artifactId}:${userId}` after the per-viewer console isolation
      // fix), so without this every viewer kept their stale error/status
      // across republishes.
      this.clearAllViewerBuffersFor(existing.artifact_id);

      this.app.service('artifacts').emit('patched', updated);
      return updated;
    }

    const artifactId = generateId();
    const buildResult = this.validateFiles(files);

    const artifact = await this.artifactRepo.create({
      artifact_id: artifactId,
      board_id: resolvedBoardId,
      worktree_id: matchedWorktreeId,
      name: resolvedName,
      path: folderPath,
      template,
      files,
      dependencies: cachedDeps,
      entry: cachedEntry,
      sandpack_config: resolvedSandpackConfig,
      required_env_vars: requiredEnvVars,
      agor_grants: agorGrants,
      agor_runtime: agorRuntime,
      content_hash: contentHash,
      build_status: buildResult.status,
      build_errors: buildResult.errors.length > 0 ? buildResult.errors : undefined,
      public: isPublic,
      created_by: userId,
    });

    const objectId = `artifact-${artifactId}`;
    try {
      const updatedBoard = await this.boardRepo.upsertBoardObject(resolvedBoardId, objectId, {
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
      // Compensate: remove DB record if board placement fails.
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
   * Update artifact metadata without touching files.
   * For file/content changes use publishArtifact().
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
      required_env_vars?: string[];
      agor_grants?: AgorGrants;
      agor_runtime?: AgorRuntimeConfig;
      sandpack_config?: SandpackConfig;
    },
    userId?: string,
    userRole?: UserRole
  ): Promise<Artifact> {
    const existing = await this.artifactRepo.findById(artifactId);
    if (!existing) throw new Error(`Artifact ${artifactId} not found`);
    // Owner-or-admin: matches the Feathers REST hook (ensureArtifactOwner-
    // OrAdmin) and the agor_artifacts_update tool description. Without the
    // role check, an admin authorized by the hook still got rejected here.
    const isOwner = !!userId && existing.created_by === userId;
    const isAdmin = !!userRole && hasMinimumRole(userRole, ROLES.ADMIN);
    if (userId && !isOwner && !isAdmin) {
      throw new Error("Forbidden: only the artifact's creator or an admin may update it");
    }

    const fullArtifactId = existing.artifact_id;
    const objectId = `artifact-${fullArtifactId}`;
    const oldBoardId = existing.board_id;
    const newBoardId = updates.board_id ?? oldBoardId;
    const moving = newBoardId !== oldBoardId;

    if (moving) {
      const destBoard = await this.boardRepo.findById(newBoardId);
      if (!destBoard) {
        throw new Error(`Destination board ${newBoardId} not found`);
      }
    }

    let currentPlacement: { x: number; y: number; width: number; height: number } | null = null;
    try {
      const oldBoard = await this.boardRepo.findById(oldBoardId);
      const obj = oldBoard?.objects?.[objectId];
      if (obj && obj.type === 'artifact') {
        currentPlacement = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      }
    } catch {
      // Old board may have been deleted.
    }

    const dbUpdates: Partial<Artifact> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.public !== undefined) dbUpdates.public = updates.public;
    if (updates.archived !== undefined) {
      dbUpdates.archived = updates.archived;
      // Explicit null on unarchive — `undefined` would be ignored by the
      // repo's `!== undefined` gate, leaving the stale archive timestamp
      // in place and confusing anything that reads it for archive history.
      dbUpdates.archived_at = updates.archived ? new Date().toISOString() : null;
    }
    if (moving) dbUpdates.board_id = newBoardId;
    if (updates.required_env_vars !== undefined) {
      dbUpdates.required_env_vars = sanitizeEnvVarNames(updates.required_env_vars);
    }
    if (updates.agor_grants !== undefined) {
      dbUpdates.agor_grants = sanitizeAgorGrants(updates.agor_grants);
    }
    if (updates.agor_runtime !== undefined) {
      dbUpdates.agor_runtime = updates.agor_runtime;
    }
    if (updates.sandpack_config !== undefined) {
      dbUpdates.sandpack_config = sanitizeSandpackConfig(updates.sandpack_config);
    }

    let updated = existing;
    if (Object.keys(dbUpdates).length > 0) {
      updated = await this.artifactRepo.update(fullArtifactId, dbUpdates);
    }

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

      try {
        const targetBoard = await this.boardRepo.upsertBoardObject(newBoardId, objectId, placement);
        this.app.service('boards').emit('patched', targetBoard);
      } catch (upsertError) {
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
          // Old board may not have this object.
        }
      }
    }

    this.app.service('artifacts').emit('patched', updated);
    return updated;
  }

  /**
   * Materialize an artifact's stored file map to a destination under a worktree.
   * Inverse of publishArtifact(). Sandpack metadata is reconstructed as a sidecar
   * `agor.artifact.json` so a round-trip via publishArtifact() round-trips the
   * metadata that doesn't live in the file map.
   *
   * Security:
   * - destination must resolve strictly inside the worktree root.
   * - per-file paths from the artifact's `files` map are re-validated to
   *   block traversal keys.
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
    const worktreeRoot = await realpath(worktreePath);

    const rawSubpath =
      options?.subpath && options.subpath.trim().length > 0
        ? options.subpath
        : path.join('.agor', 'artifacts', defaultLandFolderName(artifact));

    if (path.isAbsolute(rawSubpath)) {
      throw new Error(`subpath must be relative to the worktree root: ${rawSubpath}`);
    }

    const destination = path.resolve(worktreeRoot, rawSubpath);
    const canonicalDestination = await canonicalizeExistingPrefix(destination);

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

    if (fs.existsSync(destination)) {
      if (!options?.overwrite) {
        throw new Error(
          `Destination already exists: ${destination} (pass overwrite=true to replace)`
        );
      }
      await rm(destination, { recursive: true, force: true });
    }

    await mkdir(destination, { recursive: true });

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

    // Round-trip sidecar: persist artifact-level metadata that has no place in
    // a normal file tree (template, sandpack_config, required_env_vars,
    // agor_grants). publishArtifact() reads agor.artifact.json back if present;
    // ordinary builds/Vite/CRA never look at it.
    //
    // Always emit every field — even when empty — so the sidecar is
    // self-documenting: an agent reading it knows the artifact's full
    // declarative contract without inferring from absence.
    const sidecar = {
      $schema: 'https://agor.live/schemas/artifact/2026-05-09.json',
      template: artifact.template,
      sandpack_config: artifact.sandpack_config ?? {},
      required_env_vars: artifact.required_env_vars ?? [],
      agor_grants: artifact.agor_grants ?? {},
      agor_runtime: artifact.agor_runtime ?? {},
    };
    const sidecarJson = `${JSON.stringify(sidecar, null, 2)}\n`;
    await writeFile(path.join(destination, 'agor.artifact.json'), sidecarJson, 'utf-8');
    bytesWritten += Buffer.byteLength(sidecarJson, 'utf-8');
    fileCount += 1;

    return { destinationPath: destination, fileCount, bytesWritten };
  }

  /**
   * Read artifact payload for the frontend.
   *
   * Resolves trust state, synthesizes a per-viewer `.env` (when consent
   * permits), runs legacy detection, and returns everything the renderer
   * needs.
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

    const filesOut: Record<string, string> = { ...artifact.files };
    const requiredEnvVars = artifact.required_env_vars ?? [];
    const grants = artifact.agor_grants ?? {};
    const consentRelevantGrants = pickConsentRelevantGrants(grants);

    // "Needs consent" gates the trust prompt. "Has injectables" gates the
    // .env synthesis — no-consent grants (artifact_id, board_id) still want
    // values written even when the artifact is otherwise untrusted.
    const needsConsent =
      requiredEnvVars.length > 0 || Object.keys(consentRelevantGrants).length > 0;
    const hasInjectables = requiredEnvVars.length > 0 || Object.keys(grants).length > 0;

    let trustState: ArtifactPayload['trust_state'] = 'no_secrets_needed';
    let trustScope: ArtifactPayload['trust_scope'] | undefined;
    let envValues: Record<string, string> = {};

    if (needsConsent) {
      const decision = await this.resolveTrust({
        artifact,
        userId,
        requiredEnvVars,
        grants,
      });
      trustState = decision.state;
      trustScope = decision.scope;
      if (decision.state === 'self' || decision.state === 'trusted') {
        envValues = await this.resolveEnvVarValues(userId, requiredEnvVars);
      }
    }

    if (hasInjectables) {
      const envFile = await this.synthesizeEnvFile({
        template: artifact.template,
        requiredEnvVars,
        envValues,
        grants,
        artifact,
        userId,
        injectConsentGated: trustState === 'self' || trustState === 'trusted',
      });
      // Only emit a .env if we have something meaningful to put in it AND
      // the artifact's bundler can read it. For vanilla/static templates the
      // file is irrelevant (synthesizeEnvFile returns null).
      if (envFile !== null) filesOut[SYNTHESIZED_ENV_PATH] = envFile;
    }

    // Inject the iframe-side runtime that powers agent-driven introspection
    // (DOM queries, etc.) via `sandpack_config.options.externalResources` —
    // Sandpack adds the resulting `<script src="...">` to the iframe HTML
    // before any user code runs. We use a `data:` URL so no extra HTTP
    // round-trip is required and no daemon-served origin needs to be
    // CORS-allowed by the bundler. Default-on; authors can opt out via
    // `agor_runtime.enabled = false`. Render-time only — never persisted,
    // never touches user files.
    const runtimeEnabled = artifact.agor_runtime?.enabled !== false;
    const servedSandpackConfig = runtimeEnabled
      ? withInjectedAgorRuntime(artifact.sandpack_config)
      : artifact.sandpack_config;

    const contentHash = this.computeHashFromFiles(filesOut);
    const legacy = detectLegacyFormat(artifact);

    const payload: ArtifactPayload = {
      artifact_id: artifact.artifact_id,
      name: artifact.name,
      description: artifact.description,
      template: artifact.template,
      files: filesOut,
      sandpack_config: servedSandpackConfig,
      dependencies: artifact.dependencies,
      entry: artifact.entry,
      content_hash: contentHash,
      required_env_vars: requiredEnvVars.length > 0 ? requiredEnvVars : undefined,
      agor_grants: Object.keys(grants).length > 0 ? grants : undefined,
      trust_state: trustState,
      ...(trustScope ? { trust_scope: trustScope } : {}),
      ...(legacy.is_legacy ? { legacy } : {}),
    };
    return payload;
  }

  /**
   * Resolve consent for an artifact's requested env vars + grants.
   * Returns the trust state and (when applicable) the scope of the matching grant.
   *
   * Resolution order matches the roadmap:
   *   1. Author is the viewer → 'self'.
   *   2. agor_token requested → ONLY artifact-scoped grants apply.
   *   3. instance > author > artifact > session — first matching wins.
   */
  private async resolveTrust(input: {
    artifact: Artifact;
    userId?: UserID;
    requiredEnvVars: string[];
    grants: AgorGrants;
  }): Promise<{ state: ArtifactPayload['trust_state']; scope?: ArtifactTrustScopeType }> {
    const { artifact, userId, requiredEnvVars, grants } = input;
    if (userId && artifact.created_by && artifact.created_by === userId) {
      return { state: 'self', scope: 'self' };
    }
    if (!userId) return { state: 'untrusted' };

    const wantsAgorToken = !!grants.agor_token;
    const consentRelevantGrants = pickConsentRelevantGrants(grants);

    // agor_token is artifact-scoped only — author/instance grants do NOT cover it.
    if (wantsAgorToken) {
      const artifactGrants = await this.trustRepo.findActiveForScope({
        userId,
        scopeType: 'artifact',
        scopeValue: artifact.artifact_id,
      });
      if (artifactGrants.some((g) => coversRequest(g, requiredEnvVars, consentRelevantGrants))) {
        return { state: 'trusted', scope: 'artifact' };
      }
      // Even if a non-token grant covers, agor_token requires artifact scope.
      // Fall through to untrusted unless a session grant matches (below).
    } else {
      const tryScopes: {
        type: Exclude<ArtifactTrustScopeType, 'session' | 'self'>;
        value: string | null;
      }[] = [
        { type: 'instance', value: null },
        { type: 'author', value: artifact.created_by ?? null },
        { type: 'artifact', value: artifact.artifact_id },
      ];
      for (const sc of tryScopes) {
        if (sc.type === 'author' && !sc.value) continue;
        const matches = await this.trustRepo.findActiveForScope({
          userId,
          scopeType: sc.type,
          scopeValue: sc.value,
        });
        if (matches.some((g) => coversRequest(g, requiredEnvVars, consentRelevantGrants))) {
          return { state: 'trusted', scope: sc.type };
        }
      }
    }

    const sessionKey = `${userId}:${artifact.artifact_id}`;
    const sessionGrant = this.sessionGrants.get(sessionKey);
    if (sessionGrant) {
      const envCovered = requiredEnvVars.every((v) => sessionGrant.envVars.has(v));
      const grantsCovered = grantsAreSubset(consentRelevantGrants, sessionGrant.grants);
      // agor_token is artifact-scoped only; for the session-scope path we
      // additionally require that the grant explicitly listed agor_token.
      const tokenCovered = !wantsAgorToken || sessionGrant.grants.agor_token === true;
      if (envCovered && grantsCovered && tokenCovered) {
        return { state: 'trusted', scope: 'session' };
      }
    }

    return { state: 'untrusted' };
  }

  /**
   * Build the synthesized `.env` body. Returns null for templates without a
   * dotenv path (vanilla/static), in which case nothing is injected.
   *
   * Injection rules:
   *   - `requiredEnvVars`: emitted with the consented value when trusted,
   *     empty string otherwise.
   *   - No-consent grants (artifact_id, board_id): always emitted with their
   *     real values regardless of trust state — they are pure metadata.
   *   - Consent-gated grants (agor_token, agor_api_url, agor_user_email,
   *     agor_proxies): emitted with real values when trusted, empty when not.
   *     Empty keys are still emitted so the artifact can detect "untrusted"
   *     rather than crash on a ReferenceError.
   */
  private async synthesizeEnvFile(input: {
    template: SandpackTemplate;
    requiredEnvVars: string[];
    envValues: Record<string, string>;
    grants: AgorGrants;
    artifact: Artifact;
    userId?: UserID;
    injectConsentGated: boolean;
  }): Promise<string | null> {
    const prefix = envVarPrefixForTemplate(input.template);
    if (prefix === null) {
      if (input.requiredEnvVars.length > 0 || Object.keys(input.grants).length > 0) {
        console.warn(
          `[artifacts] Artifact ${input.artifact.artifact_id} (template=${input.template}) requests env vars/grants but the template has no dotenv path. Nothing was injected.`
        );
      }
      return null;
    }

    const lines: string[] = [];

    for (const name of input.requiredEnvVars) {
      const value = input.envValues[name] ?? '';
      lines.push(`${prefix}${name}=${escapeEnvValue(value)}`);
    }

    // No-consent grants: always inject with real values.
    const noConsentGrants = pickNoConsentGrants(input.grants);
    if (Object.keys(noConsentGrants).length > 0) {
      const noConsentValues = await this.resolveGrantValues({
        grants: noConsentGrants,
        artifact: input.artifact,
        userId: input.userId,
      });
      for (const [name, value] of Object.entries(noConsentValues)) {
        lines.push(`${prefix}${name}=${escapeEnvValue(value)}`);
      }
    }

    // Consent-gated grants: real values when trusted, empty otherwise.
    const consentGated = pickConsentRelevantGrants(input.grants);
    if (input.injectConsentGated) {
      const injected = await this.resolveGrantValues({
        grants: consentGated,
        artifact: input.artifact,
        userId: input.userId,
      });
      for (const [name, value] of Object.entries(injected)) {
        lines.push(`${prefix}${name}=${escapeEnvValue(value)}`);
      }
    } else {
      for (const [grantName, fixedEnvName] of Object.entries(GRANT_ENV_VAR_NAMES)) {
        if (NO_CONSENT_GRANT_KEYS.includes(grantName as never)) continue;
        if ((consentGated as Record<string, unknown>)[grantName]) {
          lines.push(`${prefix}${fixedEnvName}=`);
        }
      }
      if (consentGated.agor_proxies) {
        for (const vendor of consentGated.agor_proxies) {
          lines.push(`${prefix}${proxyGrantEnvName(vendor)}=`);
        }
      }
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : null;
  }

  /**
   * Resolve the runtime values for each granted capability. Mints a JWT for
   * `agor_token`, looks up the daemon URL for `agor_api_url`, etc.
   */
  private async resolveGrantValues(input: {
    grants: AgorGrants;
    artifact: Artifact;
    userId?: UserID;
  }): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const { grants, artifact, userId } = input;

    if (grants.agor_token && userId) {
      out[GRANT_ENV_VAR_NAMES.agor_token] = await this.mintViewerJwt(userId);
    }
    if (grants.agor_api_url) {
      out[GRANT_ENV_VAR_NAMES.agor_api_url] = await getBaseUrl();
    }
    if (grants.agor_user_email && userId) {
      try {
        const usersService = this.app.service('users') as unknown as UsersService;
        const user = await usersService.get(userId);
        if (user?.email) out[GRANT_ENV_VAR_NAMES.agor_user_email] = user.email;
      } catch {
        // Fall through — leave the variable empty.
      }
    }
    if (grants.agor_artifact_id) {
      out[GRANT_ENV_VAR_NAMES.agor_artifact_id] = artifact.artifact_id;
    }
    if (grants.agor_board_id) {
      out[GRANT_ENV_VAR_NAMES.agor_board_id] = artifact.board_id;
    }

    if (grants.agor_proxies && grants.agor_proxies.length > 0) {
      try {
        const config = await loadConfig();
        const proxies = resolveProxies(config);
        const baseUrl = await getBaseUrl();
        const origin = new URL(baseUrl).origin;
        const configuredVendors = new Set(proxies.map((p) => p.vendor));
        for (const vendor of grants.agor_proxies) {
          if (!configuredVendors.has(vendor)) continue;
          out[proxyGrantEnvName(vendor)] = `${origin}/proxies/${vendor}`;
        }
      } catch (err) {
        console.warn('[artifacts] failed to resolve proxy URLs for grant injection:', err);
      }
    }

    return out;
  }

  private async mintViewerJwt(userId: string): Promise<string> {
    const authConfig = this.app.get('authentication') as { secret?: string } | undefined;
    const jwtSecret = authConfig?.secret;
    if (!jwtSecret) {
      console.warn('[artifacts] no auth.secret set — AGOR_TOKEN will render empty');
      return '';
    }
    return jwt.sign({ sub: userId, type: 'access' }, jwtSecret, {
      expiresIn: '15m',
      issuer: 'agor',
      audience: 'https://agor.dev',
    });
  }

  private async resolveEnvVarValues(
    userId: UserID | undefined,
    names: string[]
  ): Promise<Record<string, string>> {
    if (!userId || names.length === 0) return {};
    try {
      // Scope-aware resolution: artifact rendering must NOT receive vars the
      // user scoped to specific sessions (`scope: 'session'`) — those only
      // unlock when a matching `sessionId` is passed. With no sessionId here,
      // session-scoped vars are skipped (see env-resolver.ts:179-183, 220-232).
      const all = await resolveUserEnvironment(userId, this.dbRef, {});
      const out: Record<string, string> = {};
      for (const n of names) {
        if (all[n] !== undefined) out[n] = all[n];
      }
      return out;
    } catch (err) {
      console.error(`[artifacts] failed to resolve env vars for user ${userId}:`, err);
      return {};
    }
  }

  // ── Trust grants management (called from REST routes / consent modal) ──

  /**
   * Persist a trust grant for `(viewer, scope_type, scope_value)`. The
   * consent surface (env vars + grants) is derived server-side from the
   * artifact's CURRENT request — the client never gets to nominate what it
   * is consenting to. This is intentional: the grant must reflect "what the
   * server will inject" at the moment of consent, not whatever the client
   * thinks should be covered. If the artifact later expands its requested
   * set, the grant becomes insufficient via `coversRequest`'s subset check
   * and the user is re-prompted.
   *
   * `session`-scope grants live in-process only (no DB write).
   */
  async grantTrust(input: {
    userId: string;
    artifactId: string;
    scopeType: ArtifactTrustScopeType;
  }): Promise<{ scope: ArtifactTrustScopeType; persisted: boolean }> {
    if (input.scopeType === 'self') {
      throw new Error("'self' grants are implicit and cannot be persisted");
    }

    // Server-derive the consent surface from the artifact's current request.
    const artifact = await this.artifactRepo.findById(input.artifactId);
    if (!artifact) throw new Error(`Artifact ${input.artifactId} not found`);
    if (!this.isVisibleTo(artifact, input.userId)) {
      // Mirror getPayload's privacy guarantee — don't leak existence of a
      // private artifact via the trust endpoint.
      throw new Error(`Artifact ${input.artifactId} not found`);
    }
    const sanitizedEnv = sanitizeEnvVarNames(artifact.required_env_vars ?? []);
    const sanitizedGrants = sanitizeAgorGrants(artifact.agor_grants ?? {});

    if (input.scopeType === 'session') {
      const key = `${input.userId}:${input.artifactId}`;
      this.sessionGrants.set(key, {
        envVars: new Set(sanitizedEnv),
        grants: sanitizedGrants,
      });
      return { scope: 'session', persisted: false };
    }

    // Resolve scope_value from artifact when needed.
    let scopeValue: string | null = null;
    if (input.scopeType === 'artifact') {
      scopeValue = input.artifactId;
    } else if (input.scopeType === 'author') {
      if (!artifact.created_by) {
        throw new Error('Cannot grant author-scope trust: artifact has no recorded author');
      }
      scopeValue = artifact.created_by;
    } else if (input.scopeType === 'instance') {
      scopeValue = null;
      // Instance-wide trust is meaningful only on single-user instances. On
      // multi-user setups it would mean "trust any artifact published by any
      // user on this server with my secrets" — too broad. Reject.
      const config = await loadConfig();
      const unixMode = config.execution?.unix_user_mode ?? 'simple';
      if (unixMode !== 'simple') {
        throw new Error(
          "'instance'-scope trust grants are disabled when execution.unix_user_mode is not 'simple' (multi-user instance)"
        );
      }
    }

    // agor_token must be artifact-scoped only.
    const wantsAgorToken = !!sanitizedGrants.agor_token;
    if (wantsAgorToken && input.scopeType !== 'artifact') {
      throw new Error(
        `Cannot grant agor_token at scope '${input.scopeType}' — agor_token requires artifact-scoped consent`
      );
    }

    await this.trustRepo.create({
      user_id: input.userId,
      scope_type: input.scopeType,
      scope_value: scopeValue,
      env_vars_set: sanitizedEnv,
      agor_grants_set: sanitizedGrants,
    });
    return { scope: input.scopeType, persisted: true };
  }

  async listTrustGrants(userId: string) {
    return this.trustRepo.findActiveByUser(userId);
  }

  async revokeTrustGrant(userId: string, grantId: string): Promise<void> {
    const grant = await this.trustRepo.findById(grantId);
    if (!grant) throw new Error(`Trust grant ${grantId} not found`);
    if (grant.user_id !== userId) {
      throw new Error('Cannot revoke a trust grant owned by another user');
    }
    await this.trustRepo.revoke(grantId);
  }

  // ── External "open in" / export ────────────────────────────────────────

  /**
   * Build a CodeSandbox define-API payload from the artifact's stored files
   * and POST it. Returns the resulting sandbox URL on success.
   *
   * Caveats inherent to the eject path (caller should surface to users):
   *  - daemon-supplied capabilities (AGOR_TOKEN / AGOR_PROXY_*) are stripped
   *    server-side anyway and won't function on CodeSandbox;
   *  - the synthesized `.env` and round-trip sidecars are dropped — they're
   *    Agor-only artifacts;
   *  - CodeSandbox's define endpoint is sometimes Cloudflare-throttled.
   *
   * Throws `Error` on every failure (visibility, missing files, network,
   * non-JSON 200 — typically a Cloudflare interstitial). Callers should
   * catch and present a friendly message.
   */
  async exportToCodeSandbox(
    artifactId: string,
    userId?: UserID
  ): Promise<{ artifactId: string; sandboxId: string; url: string; note: string }> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (!this.isVisibleTo(artifact, userId)) {
      // Same shape as a hard-not-found — don't leak existence of private artifacts.
      throw new Error(`Artifact ${artifactId} not found`);
    }
    if (!artifact.files || Object.keys(artifact.files).length === 0) {
      throw new Error(`Artifact ${artifactId} has no files to export`);
    }

    // Strip Agor-only sidecars + the synthesized .env. CodeSandbox expects
    // `src/index.js` keys, not `/src/index.js` (no leading slash). Hold the
    // user's package.json aside so we can merge dependencies into it before
    // adding it back — CSB infers the runtime (CRA / vue-cli / svelte / …)
    // from the dependency graph in package.json, so getting this right is
    // what makes the export validate.
    const filesPayload: Record<string, { content: string }> = {};
    let userPackageJson: string | null = null;
    for (const [filePath, content] of Object.entries(artifact.files)) {
      const stripped = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      if (
        stripped === 'agor.config.js' ||
        stripped === 'agor.artifact.json' ||
        stripped === '.env'
      ) {
        continue;
      }
      if (stripped === 'package.json') {
        userPackageJson = content;
        continue;
      }
      filesPayload[stripped] = { content };
    }

    let userPkg: Record<string, unknown> = {};
    if (userPackageJson) {
      try {
        const parsed = JSON.parse(userPackageJson);
        if (typeof parsed === 'object' && parsed !== null) {
          userPkg = parsed as Record<string, unknown>;
        }
      } catch {
        // Forgive malformed user package.json — synthesize one from the
        // dependency cache rather than failing the whole export.
      }
    }
    const customSetupDeps = artifact.sandpack_config?.customSetup?.dependencies ?? {};
    const cachedDeps = artifact.dependencies ?? {};
    const mergedDeps: Record<string, string> = {
      ...customSetupDeps,
      ...cachedDeps,
      ...((userPkg.dependencies as Record<string, string> | undefined) ?? {}),
    };
    const finalPkg: Record<string, unknown> = {
      name: 'artifact-export',
      version: '0.0.0',
      main: artifact.entry ?? userPkg.main ?? 'src/index.js',
      ...userPkg,
      dependencies: mergedDeps,
    };
    filesPayload['package.json'] = { content: JSON.stringify(finalPkg, null, 2) };

    // Don't send a top-level `template` — Sandpack template names (`react`,
    // `react-ts`, `vue3`, …) are NOT valid CSB template names (`create-
    // react-app`, `vue-cli`, …). CSB returns "Unable to process params"
    // when given a Sandpack name. Letting CSB infer from package.json deps
    // is both simpler and more reliable.
    const definePayload = { files: filesPayload };

    let res: Response;
    try {
      res = await fetch('https://codesandbox.io/api/v1/sandboxes/define?json=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(definePayload),
      });
    } catch (err) {
      throw new Error(
        `CodeSandbox define API unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      // Failure bodies are typically Cloudflare HTML interstitials. Don't
      // dump them — they bloat logs/UIs without adding signal.
      const ct = res.headers.get('content-type') ?? '';
      let hint = '';
      if (ct.includes('application/json')) {
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          const msg = body.error ?? body.message;
          if (typeof msg === 'string' && msg.length > 0) hint = `: ${msg.slice(0, 200)}`;
        } catch {}
      }
      throw new Error(
        `CodeSandbox define API failed (${res.status} ${res.statusText})${hint}. The endpoint is sometimes throttled by Cloudflare; retry in a moment.`
      );
    }
    let body: { sandbox_id?: string };
    try {
      body = (await res.json()) as { sandbox_id?: string };
    } catch (err) {
      throw new Error(
        `CodeSandbox returned a non-JSON 200 response (likely a Cloudflare interstitial). Try again later. ${err instanceof Error ? err.message : ''}`.trim()
      );
    }
    const sandboxId = body.sandbox_id;
    if (!sandboxId) {
      throw new Error('CodeSandbox returned a 200 with no sandbox_id');
    }

    const url = `https://codesandbox.io/s/${sandboxId}`;
    const requiredVars = artifact.required_env_vars ?? [];
    const note = requiredVars.length
      ? `This artifact declares required_env_vars=${JSON.stringify(requiredVars)}. Set the prefixed names (e.g. VITE_${requiredVars[0]}) in CodeSandbox → Settings → Secret Keys to make them available at runtime.`
      : 'No required env vars to configure.';

    return { artifactId, sandboxId, url, note };
  }

  // ── Runtime queries (DOM introspection from agent → viewer's iframe) ──

  /**
   * Send a query to the requester's own browser tab(s) viewing this
   * artifact. The browser dispatches into the Sandpack iframe via
   * postMessage; agor-runtime.js (auto-injected at render time) replies;
   * the browser POSTs the reply to `/artifacts/:id/runtime-response/...`,
   * which calls `resolveRuntimeQuery` to complete this promise.
   *
   * Visibility-checked. Rejects if:
   * - the artifact is private and the caller can't see it,
   * - the artifact has `agor_runtime.enabled === false`,
   * - or no browser tab fulfilled the query within `timeoutMs`.
   *
   * Scope: the response endpoint requires the responding user to match
   * `requesterId`. So even though the dispatch event is broadcast, only
   * the requester's own browser can complete the round-trip with their
   * own (potentially secret-bearing) DOM. Cross-user introspection of
   * a third party's render is structurally prevented.
   */
  async queryArtifactRuntime(input: {
    artifactId: string;
    userId: string;
    kind: 'query_dom' | 'document_html';
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    const artifact = await this.artifactRepo.findById(input.artifactId);
    if (!artifact) throw new Error(`Artifact ${input.artifactId} not found`);
    if (!this.isVisibleTo(artifact, input.userId)) {
      throw new Error(`Artifact ${input.artifactId} not found`);
    }
    if (artifact.agor_runtime?.enabled === false) {
      throw new Error(
        `Runtime introspection is disabled for artifact ${input.artifactId} (agor_runtime.enabled = false). The artifact author can re-enable it via agor_artifacts_update.`
      );
    }

    const requestId = generateId();
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 5000, 500), 30000);

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRuntimeQueries.delete(requestId);
        reject(
          new Error(
            `Runtime query timed out after ${timeoutMs}ms. Open the artifact in your browser (so the runtime can answer), then retry.`
          )
        );
      }, timeoutMs);

      this.pendingRuntimeQueries.set(requestId, {
        resolve,
        reject,
        timeout,
        requesterId: input.userId,
      });
    });

    // Broadcast on the artifacts service. The client filters: only respond
    // if currently viewing this artifact AND logged in as the requester.
    this.app.service('artifacts').emit('agor-query', {
      request_id: requestId,
      artifact_id: input.artifactId,
      requested_by_user_id: input.userId,
      kind: input.kind,
      args: input.args,
    });

    return promise;
  }

  /**
   * Called by the response REST endpoint when a viewer's browser POSTs
   * the iframe's reply. The auth boundary already authenticated the
   * caller; we additionally check that the responder matches the original
   * requester so a different user can't fulfill someone else's query.
   *
   * Silently no-op when the request id is unknown (timed out, never
   * existed, or already completed). Stale POSTs are common — multiple
   * tabs may answer the same query and only the first wins.
   */
  resolveRuntimeQuery(input: {
    requestId: string;
    responderUserId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }): void {
    const pending = this.pendingRuntimeQueries.get(input.requestId);
    if (!pending) return;
    if (pending.requesterId !== input.responderUserId) return;
    clearTimeout(pending.timeout);
    this.pendingRuntimeQueries.delete(input.requestId);
    if (input.ok) {
      pending.resolve(input.result);
    } else {
      pending.reject(new Error(input.error || 'Runtime query failed (no error provided)'));
    }
  }

  // ── Build / status / console / find helpers (mostly unchanged) ──

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
    await this.artifactRepo.updateBuildStatus(
      artifactId,
      result.status,
      result.errors.length > 0 ? result.errors : undefined
    );
    return result;
  }

  /** Compose the per-viewer key for the in-memory console/error/status maps. */
  private viewerKey(artifactId: string, userId: string): string {
    return `${artifactId}:${userId}`;
  }

  /** Drop every per-viewer buffer entry for an artifact (called on delete). */
  private clearAllViewerBuffersFor(artifactId: string): void {
    const prefix = `${artifactId}:`;
    for (const key of this.consoleLogs.keys()) {
      if (key.startsWith(prefix)) this.consoleLogs.delete(key);
    }
    for (const key of this.sandpackErrors.keys()) {
      if (key.startsWith(prefix)) this.sandpackErrors.delete(key);
    }
    for (const key of this.sandpackStatuses.keys()) {
      if (key.startsWith(prefix)) this.sandpackStatuses.delete(key);
    }
  }

  appendConsoleLogs(artifactId: string, userId: string, entries: ArtifactConsoleEntry[]): void {
    const key = this.viewerKey(artifactId, userId);
    const existing = this.consoleLogs.get(key) ?? [];
    const combined = [...existing, ...entries];
    if (combined.length > MAX_CONSOLE_ENTRIES) {
      this.consoleLogs.set(key, combined.slice(-MAX_CONSOLE_ENTRIES));
    } else {
      this.consoleLogs.set(key, combined);
    }
  }

  setSandpackError(
    artifactId: string,
    userId: string,
    error: SandpackError | null,
    status?: string
  ): void {
    const key = this.viewerKey(artifactId, userId);
    this.sandpackErrors.set(key, error);
    if (status !== undefined) {
      this.sandpackStatuses.set(key, status);
    }
  }

  /**
   * Returns the artifact's runtime status — visibility-checked. The console
   * logs and Sandpack-error fields are scoped to the calling user's render
   * (see `viewerKey`); other viewers' captured output is never returned.
   */
  async getStatus(artifactId: string, userId?: UserID): Promise<ArtifactStatus> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (!this.isVisibleTo(artifact, userId)) {
      // Don't leak existence of private artifacts.
      throw new Error(`Artifact ${artifactId} not found`);
    }

    const key = userId ? this.viewerKey(artifactId, userId) : null;
    const sandpackError = key ? (this.sandpackErrors.get(key) ?? null) : null;
    const sandpackStatus = key ? this.sandpackStatuses.get(key) : undefined;
    const consoleLogs = key ? (this.consoleLogs.get(key) ?? []) : [];

    let buildStatus = artifact.build_status;
    let buildErrors = artifact.build_errors;

    if (sandpackError) {
      buildStatus = 'error';
      const sandpackMsg = `[Sandpack] ${sandpackError.message}`;
      buildErrors = [...(buildErrors ?? []), sandpackMsg];
    }

    return {
      artifact_id: artifact.artifact_id,
      build_status: buildStatus,
      build_errors: buildErrors ?? [],
      sandpack_error: sandpackError,
      sandpack_status: sandpackStatus,
      console_logs: consoleLogs,
      content_hash: artifact.content_hash,
    };
  }

  /**
   * Delete an artifact, its board placement, and its in-memory buffers.
   * Owner-or-admin only — agent-facing tools must pass `userId` and the
   * caller's role. The Feathers REST hook chain enforces the same rule for
   * direct PATCH/REMOVE; this method is what the MCP tool calls and used
   * to be unchecked.
   */
  async deleteArtifact(
    artifactId: string,
    userId?: string,
    userRole?: UserRole
  ): Promise<Artifact> {
    const artifact = await this.artifactRepo.findById(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

    const isOwner = !!userId && artifact.created_by === userId;
    const isAdmin = !!userRole && hasMinimumRole(userRole, ROLES.ADMIN);
    if (!isOwner && !isAdmin) {
      throw new Error("Forbidden: only the artifact's creator or an admin may delete it");
    }

    const objectId = `artifact-${artifactId}`;
    try {
      const updatedBoard = await this.boardRepo.removeBoardObject(artifact.board_id, objectId);
      if (this.app && updatedBoard) {
        this.app.service('boards').emit('patched', updatedBoard);
      }
    } catch {
      // Board object may not exist or board may be deleted.
    }

    this.clearAllViewerBuffersFor(artifactId);
    await this.artifactRepo.delete(artifactId);
    // Returned so callers can emit `removed` events without a redundant
    // pre-delete fetch.
    return artifact;
  }

  async findByBoardId(boardId: BoardID, userId?: string): Promise<Artifact[]> {
    return this.artifactRepo.findByBoardId(boardId, { userId: userId ?? '__anonymous__' });
  }

  async findVisible(userId?: string, options?: { limit?: number }): Promise<Artifact[]> {
    return this.artifactRepo.findVisible(userId ?? '__anonymous__', { limit: options?.limit });
  }

  // ── Private helpers ──

  /**
   * Restrict publish folder paths to known-safe roots: any registered
   * worktree path, or /tmp / /var/tmp. Returns the matching worktree's id
   * when the path is inside a worktree (caller persists this on the
   * artifact row for provenance + by-worktree filtering); returns null for
   * temp-dir paths.
   */
  private async validatePublishPath(folderPath: string): Promise<WorktreeID | null> {
    const resolved = path.resolve(folderPath);

    const allowedTempRoots = ['/tmp', '/var/tmp'];
    for (const root of allowedTempRoots) {
      if (resolved.startsWith(root + path.sep) || resolved === root) return null;
    }

    const worktrees = await this.worktreeRepo.findAll();
    for (const wt of worktrees) {
      const wtPath = path.resolve(wt.path);
      if (resolved.startsWith(wtPath + path.sep) || resolved === wtPath) {
        return wt.worktree_id as WorktreeID;
      }
    }

    throw new Error(
      `Publish path rejected: ${folderPath} is not inside a known worktree or temp directory`
    );
  }

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

  private extractDependenciesFromPackageJson(
    files: Record<string, string>
  ): Record<string, string> | undefined {
    const pkg = files['/package.json'] ?? files['package.json'];
    if (!pkg) return undefined;
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      return parsed.dependencies && Object.keys(parsed.dependencies).length > 0
        ? parsed.dependencies
        : undefined;
    } catch {
      return undefined;
    }
  }

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
      if (entry.isSymbolicLink()) continue;
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
      // The `agor.artifact.json` sidecar is land()'s round-trip carrier for
      // metadata that doesn't fit in the file map. publishArtifact() consumes it
      // separately (callers pass the parsed values via the publish args).
      // Either way it doesn't belong in the served file map.
      if (relativePath === 'agor.artifact.json') continue;
      // Skip the synthesized .env so a round-trip via land() → publishArtifact()
      // doesn't accidentally bake the viewer's secrets into the next publish.
      if (relativePath === '.env') continue;
      const normalizedPath = `/${relativePath.replace(/\\/g, '/')}`;
      files[normalizedPath] = fs.readFileSync(file, 'utf-8');
    }

    return files;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (testable; no service state)
// ─────────────────────────────────────────────────────────────────────────────

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function sanitizeEnvVarNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string') continue;
    if (!ENV_VAR_NAME_RE.test(v)) continue;
    seen.add(v);
  }
  return [...seen];
}

export function sanitizeAgorGrants(input: unknown): AgorGrants {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const src = input as Record<string, unknown>;
  const out: AgorGrants = {};
  for (const key of Object.keys(GRANT_ENV_VAR_NAMES)) {
    if (src[key] === true) (out as Record<string, unknown>)[key] = true;
  }
  if (Array.isArray(src.agor_proxies)) {
    out.agor_proxies = (src.agor_proxies as unknown[])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map((v) => v.toLowerCase().replace(/[^a-z0-9-_]+/g, ''))
      // Re-filter post-normalisation: strings like "!!!" reduce to "" above.
      .filter((v) => v.length > 0);
  }
  return out;
}

/** Strip informational grants that don't need consent. */
export function pickConsentRelevantGrants(grants: AgorGrants): AgorGrants {
  const out: AgorGrants = { ...grants };
  // agor_artifact_id and agor_board_id are pure metadata — no consent.
  delete out.agor_artifact_id;
  delete out.agor_board_id;
  return out;
}

/** Inverse of `pickConsentRelevantGrants`: only the no-consent metadata keys. */
export function pickNoConsentGrants(grants: AgorGrants): AgorGrants {
  const out: AgorGrants = {};
  for (const key of NO_CONSENT_GRANT_KEYS) {
    if (grants[key]) out[key] = true;
  }
  return out;
}

/**
 * Strict subset check: the existing grant must cover every requested env var
 * AND every requested non-informational grant.
 */
function coversRequest(
  grant: { env_vars_set: string[]; agor_grants_set: AgorGrants },
  requiredEnvVars: string[],
  requestedGrants: AgorGrants
): boolean {
  const env = new Set(grant.env_vars_set);
  for (const v of requiredEnvVars) {
    if (!env.has(v)) return false;
  }
  if (!grantsAreSubset(requestedGrants, grant.agor_grants_set)) return false;
  // agor_token specifically must already be in the existing grant if requested.
  for (const k of ARTIFACT_SCOPED_ONLY_GRANT_KEYS) {
    if (
      (requestedGrants as Record<string, unknown>)[k] === true &&
      (grant.agor_grants_set as Record<string, unknown>)[k] !== true
    ) {
      return false;
    }
  }
  return true;
}

function grantsAreSubset(needs: AgorGrants, has: AgorGrants): boolean {
  for (const key of Object.keys(GRANT_ENV_VAR_NAMES) as (keyof typeof GRANT_ENV_VAR_NAMES)[]) {
    if ((needs as Record<string, unknown>)[key] && !(has as Record<string, unknown>)[key]) {
      return false;
    }
  }
  if (needs.agor_proxies && needs.agor_proxies.length > 0) {
    const hasSet = new Set(has.agor_proxies ?? []);
    for (const v of needs.agor_proxies) {
      if (!hasSet.has(v)) return false;
    }
  }
  return true;
}

/** Escape a `.env` value: quote, escape backslashes/quotes/newlines. */
function escapeEnvValue(value: string): string {
  if (!value) return '';
  // Always quote — covers spaces, `#`, `=` in the value, etc.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function createArtifactsService(db: Database, app: Application): ArtifactsService {
  return new ArtifactsService(db, app);
}
