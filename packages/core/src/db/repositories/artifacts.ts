/**
 * Artifact Repository
 *
 * Type-safe CRUD for artifacts. Artifacts are live web applications rendered
 * via Sandpack on board canvases. JSON columns are de/serialised here so the
 * service layer can deal in plain objects.
 */

import type {
  AgorGrants,
  AgorRuntimeConfig,
  Artifact,
  ArtifactBuildStatus,
  BoardID,
  SandpackConfig,
  SandpackTemplate,
  UUID,
  WorktreeID,
} from '@agor/core/types';
import { prefixToLikePattern } from '@agor/core/types';
import { and, eq, like, or } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { type ArtifactInsert, type ArtifactRow, artifacts } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * JSON columns differ between SQLite (text) and Postgres (jsonb). On
 * Postgres the driver hands us a parsed value; on SQLite we get a string and
 * must JSON.parse. This helper hides the difference from the rest of the
 * repo.
 */
function readJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

/**
 * Mirror of `readJson` for writes. Postgres takes the value as-is (the
 * jsonb driver serialises); SQLite needs a string.
 */
function writeJson(db: Database, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (isPostgresDatabase(db)) return value;
  return JSON.stringify(value);
}

export class ArtifactRepository implements BaseRepository<Artifact, Partial<Artifact>> {
  constructor(private db: Database) {}

  private rowToArtifact(row: ArtifactRow): Artifact {
    return {
      artifact_id: row.artifact_id as UUID,
      worktree_id: (row.worktree_id as WorktreeID) ?? null,
      board_id: row.board_id as BoardID,
      name: row.name,
      description: row.description ?? undefined,
      path: row.path ?? null,
      template: (row.template ?? 'react') as SandpackTemplate,
      build_status: (row.build_status ?? 'unknown') as ArtifactBuildStatus,
      build_errors: readJson<string[]>(row.build_errors),
      content_hash: row.content_hash ?? undefined,
      files: readJson<Record<string, string>>(row.files),
      dependencies: readJson<Record<string, string>>(row.dependencies),
      entry: row.entry ?? undefined,
      sandpack_config: readJson<SandpackConfig>(row.sandpack_config),
      required_env_vars: readJson<string[]>(row.required_env_vars),
      agor_grants: readJson<AgorGrants>(row.agor_grants),
      agor_runtime: readJson<AgorRuntimeConfig>(row.agor_runtime),
      public: row.public !== undefined ? Boolean(row.public) : true,
      created_by: row.created_by ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      archived: Boolean(row.archived),
      archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
    };
  }

  async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) return id;

    const pattern = prefixToLikePattern(id);
    const results = await select(this.db)
      .from(artifacts)
      .where(like(artifacts.artifact_id, pattern))
      .all();

    if (results.length === 0) throw new EntityNotFoundError('Artifact', id);
    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Artifact',
        id,
        results.map((r: { artifact_id: string }) => r.artifact_id)
      );
    }
    return results[0].artifact_id;
  }

  async create(data: Partial<Artifact>): Promise<Artifact> {
    try {
      const now = new Date();
      const artifactId = data.artifact_id ?? generateId();

      const insertData: ArtifactInsert = {
        artifact_id: artifactId,
        worktree_id: data.worktree_id ?? null,
        board_id: data.board_id ?? '',
        name: data.name ?? 'Untitled Artifact',
        description: data.description ?? null,
        path: data.path ?? null,
        template: data.template ?? 'react',
        build_status: data.build_status ?? 'unknown',
        build_errors: writeJson(this.db, data.build_errors) as never,
        content_hash: data.content_hash ?? null,
        files: writeJson(this.db, data.files) as never,
        dependencies: writeJson(this.db, data.dependencies) as never,
        entry: data.entry ?? null,
        sandpack_config: writeJson(this.db, data.sandpack_config) as never,
        required_env_vars: writeJson(this.db, data.required_env_vars) as never,
        agor_grants: writeJson(this.db, data.agor_grants) as never,
        agor_runtime: writeJson(this.db, data.agor_runtime) as never,
        public: data.public ?? true,
        created_by: data.created_by ?? null,
        created_at: now,
        updated_at: now,
        archived: false,
        archived_at: null,
      };

      await insert(this.db, artifacts).values(insertData).run();

      const row = await select(this.db)
        .from(artifacts)
        .where(eq(artifacts.artifact_id, artifactId))
        .one();

      if (!row) throw new RepositoryError('Failed to retrieve created artifact');
      return this.rowToArtifact(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create artifact: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<Artifact | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(artifacts)
        .where(eq(artifacts.artifact_id, fullId))
        .one();
      return row ? this.rowToArtifact(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find artifact: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findAll(): Promise<Artifact[]> {
    try {
      const rows = await select(this.db).from(artifacts).all();
      return rows.map((row: ArtifactRow) => this.rowToArtifact(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all artifacts: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all visible artifacts for a user: public + private owned by userId.
   */
  async findVisible(userId: string, options?: { limit?: number }): Promise<Artifact[]> {
    try {
      let query = select(this.db)
        .from(artifacts)
        .where(or(eq(artifacts.public, true), eq(artifacts.created_by, userId))!);

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      const rows = await query.all();
      return rows.map((row: ArtifactRow) => this.rowToArtifact(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find visible artifacts: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findByWorktreeId(worktreeId: WorktreeID): Promise<Artifact[]> {
    try {
      const rows = await select(this.db)
        .from(artifacts)
        .where(eq(artifacts.worktree_id, worktreeId))
        .all();
      return rows.map((row: ArtifactRow) => this.rowToArtifact(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find artifacts by worktree: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findByBoardId(
    boardId: BoardID,
    options?: { archived?: boolean; limit?: number; userId?: string }
  ): Promise<Artifact[]> {
    try {
      const conditions = [eq(artifacts.board_id, boardId)];
      if (options?.archived !== undefined) {
        conditions.push(eq(artifacts.archived, options.archived));
      }

      // Visibility filtering: public artifacts + private artifacts owned by the user
      if (options?.userId) {
        conditions.push(or(eq(artifacts.public, true), eq(artifacts.created_by, options.userId))!);
      }

      let query = select(this.db)
        .from(artifacts)
        .where(and(...conditions));

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      const rows = await query.all();
      return rows.map((row: ArtifactRow) => this.rowToArtifact(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find artifacts by board: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async update(id: string, updates: Partial<Artifact>): Promise<Artifact> {
    try {
      const fullId = await this.resolveId(id);

      const setData: Record<string, unknown> = {
        updated_at: new Date(),
      };

      if (updates.name !== undefined) setData.name = updates.name;
      if (updates.description !== undefined) setData.description = updates.description ?? null;
      if (updates.board_id !== undefined) setData.board_id = updates.board_id;
      if (updates.template !== undefined) setData.template = updates.template;
      if (updates.build_status !== undefined) setData.build_status = updates.build_status;
      if (updates.build_errors !== undefined) {
        setData.build_errors = writeJson(this.db, updates.build_errors);
      }
      if (updates.content_hash !== undefined) setData.content_hash = updates.content_hash ?? null;
      if (updates.files !== undefined) {
        setData.files = writeJson(this.db, updates.files);
      }
      if (updates.dependencies !== undefined) {
        setData.dependencies = writeJson(this.db, updates.dependencies);
      }
      if (updates.entry !== undefined) setData.entry = updates.entry ?? null;
      if (updates.sandpack_config !== undefined) {
        setData.sandpack_config = writeJson(this.db, updates.sandpack_config);
      }
      if (updates.required_env_vars !== undefined) {
        setData.required_env_vars = writeJson(this.db, updates.required_env_vars);
      }
      if (updates.agor_runtime !== undefined) {
        setData.agor_runtime = writeJson(this.db, updates.agor_runtime);
      }
      if (updates.agor_grants !== undefined) {
        setData.agor_grants = writeJson(this.db, updates.agor_grants);
      }
      if (updates.public !== undefined) setData.public = updates.public;
      if (updates.archived !== undefined) setData.archived = updates.archived;
      if (updates.archived_at !== undefined) {
        setData.archived_at = updates.archived_at ? new Date(updates.archived_at) : null;
      }
      // worktree_id: passing null clears the FK; passing undefined leaves it
      // alone. Required so a republish from a worktree path backfills the FK
      // for artifacts that were created before the column was populated.
      if (updates.worktree_id !== undefined) {
        setData.worktree_id = updates.worktree_id ?? null;
      }

      await update(this.db, artifacts).set(setData).where(eq(artifacts.artifact_id, fullId)).run();

      const row = await select(this.db)
        .from(artifacts)
        .where(eq(artifacts.artifact_id, fullId))
        .one();

      if (!row) throw new EntityNotFoundError('Artifact', id);
      return this.rowToArtifact(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update artifact: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async updateBuildStatus(
    id: string,
    status: ArtifactBuildStatus,
    errors?: string[]
  ): Promise<Artifact> {
    return this.update(id, {
      build_status: status,
      build_errors: errors,
    });
  }

  async updateContentHash(id: string, hash: string): Promise<Artifact> {
    return this.update(id, { content_hash: hash });
  }

  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);
      const result = await deleteFrom(this.db, artifacts)
        .where(eq(artifacts.artifact_id, fullId))
        .run();

      if (result.rowsAffected === 0) throw new EntityNotFoundError('Artifact', id);
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete artifact: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
