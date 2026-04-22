/**
 * Artifact Repository
 *
 * Type-safe CRUD operations for artifacts with short ID support.
 * Artifacts are live web applications rendered via Sandpack on board canvases.
 */

import type {
  Artifact,
  ArtifactBuildStatus,
  BoardID,
  SandpackTemplate,
  UUID,
  WorktreeID,
} from '@agor/core/types';
import { and, eq, like, or } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type ArtifactInsert, type ArtifactRow, artifacts } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

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
      build_errors: row.build_errors ? JSON.parse(row.build_errors) : undefined,
      content_hash: row.content_hash ?? undefined,
      files: row.files ? JSON.parse(row.files as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
      entry: row.entry ?? undefined,
      use_local_bundler: Boolean(row.use_local_bundler),
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

    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;
    const results = await select(this.db)
      .from(artifacts)
      .where(like(artifacts.artifact_id, pattern))
      .all();

    if (results.length === 0) throw new EntityNotFoundError('Artifact', id);
    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Artifact',
        id,
        results.map((r: { artifact_id: string }) => formatShortId(r.artifact_id as UUID))
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
        build_errors: data.build_errors ? JSON.stringify(data.build_errors) : null,
        content_hash: data.content_hash ?? null,
        files: data.files ? JSON.stringify(data.files) : null,
        dependencies: data.dependencies ? JSON.stringify(data.dependencies) : null,
        entry: data.entry ?? null,
        use_local_bundler: data.use_local_bundler ?? false,
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
        setData.build_errors = updates.build_errors ? JSON.stringify(updates.build_errors) : null;
      }
      if (updates.content_hash !== undefined) setData.content_hash = updates.content_hash ?? null;
      if (updates.files !== undefined) {
        setData.files = updates.files ? JSON.stringify(updates.files) : null;
      }
      if (updates.dependencies !== undefined) {
        setData.dependencies = updates.dependencies ? JSON.stringify(updates.dependencies) : null;
      }
      if (updates.entry !== undefined) setData.entry = updates.entry ?? null;
      if (updates.use_local_bundler !== undefined)
        setData.use_local_bundler = updates.use_local_bundler;
      if (updates.public !== undefined) setData.public = updates.public;
      if (updates.archived !== undefined) setData.archived = updates.archived;
      if (updates.archived_at !== undefined) {
        setData.archived_at = updates.archived_at ? new Date(updates.archived_at) : null;
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
