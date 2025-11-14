/**
 * Patterns Repository
 *
 * Type-safe CRUD operations for learned development patterns with short ID support.
 * Supports pattern learning, confidence scoring, and semantic search.
 */

import type {
  Pattern,
  PatternApplication,
  PatternCategory,
  PatternID,
  PatternOutcome,
  PatternSearchOptions,
  PatternSuggestion,
  SessionID,
  TaskID,
  UUID,
  WorktreeID,
} from '@agor/core/types';
import { and, desc, eq, gte, like, or, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  type PatternApplicationInsert,
  type PatternApplicationRow,
  type PatternInsert,
  type PatternRow,
  patternApplications,
  patterns,
} from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

/**
 * Patterns repository implementation
 */
export class PatternsRepository implements BaseRepository<Pattern, Partial<Pattern>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Pattern type
   */
  private rowToPattern(row: PatternRow): Pattern {
    const data = row.data as {
      summary: string;
      context: string;
      implementation: string;
      tags?: string[];
      related_patterns?: string[];
      source?: {
        session_id?: string;
        task_id?: string;
        worktree_id?: string;
      };
    };

    return {
      pattern_id: row.pattern_id as PatternID,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date(row.created_at).toISOString(),
      category: row.category as PatternCategory,
      confidence: row.confidence,
      usage_count: row.usage_count,
      success_count: row.success_count,
      created_by: row.created_by as UUID,
      summary: data.summary,
      context: data.context,
      implementation: data.implementation,
      tags: data.tags,
      related_patterns: data.related_patterns as PatternID[] | undefined,
      source: data.source
        ? {
            session_id: data.source.session_id as SessionID | undefined,
            task_id: data.source.task_id as TaskID | undefined,
            worktree_id: data.source.worktree_id as WorktreeID | undefined,
          }
        : undefined,
    };
  }

  /**
   * Convert Pattern to database insert format
   */
  private patternToInsert(pattern: Partial<Pattern>): PatternInsert {
    const now = Date.now();
    const patternId = pattern.pattern_id ?? generateId();

    return {
      pattern_id: patternId,
      created_at: new Date(pattern.created_at ?? now),
      updated_at: pattern.updated_at ? new Date(pattern.updated_at) : null,
      category: pattern.category!,
      confidence: pattern.confidence ?? 50,
      usage_count: pattern.usage_count ?? 0,
      success_count: pattern.success_count ?? 0,
      created_by: pattern.created_by ?? 'anonymous',
      data: {
        summary: pattern.summary ?? '',
        context: pattern.context ?? '',
        implementation: pattern.implementation ?? '',
        tags: pattern.tags,
        related_patterns: pattern.related_patterns,
        source: pattern.source,
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await this.db
      .select({ pattern_id: patterns.pattern_id })
      .from(patterns)
      .where(like(patterns.pattern_id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Pattern', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Pattern',
        id,
        results.map((r) => formatShortId(r.pattern_id as UUID))
      );
    }

    return results[0].pattern_id as UUID;
  }

  /**
   * Create a new pattern
   */
  async create(data: Partial<Pattern>): Promise<Pattern> {
    try {
      const insert = this.patternToInsert(data);
      await this.db.insert(patterns).values(insert);

      const row = await this.db
        .select()
        .from(patterns)
        .where(eq(patterns.pattern_id, insert.pattern_id))
        .get();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created pattern');
      }

      return this.rowToPattern(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create pattern: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find pattern by ID (supports short ID)
   */
  async findById(id: string): Promise<Pattern | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await this.db
        .select()
        .from(patterns)
        .where(eq(patterns.pattern_id, fullId))
        .get();

      return row ? this.rowToPattern(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find pattern: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all patterns (optionally filtered)
   */
  async findAll(filters?: {
    category?: PatternCategory;
    minConfidence?: number;
    minUsageCount?: number;
    created_by?: string;
  }): Promise<Pattern[]> {
    try {
      let query = this.db.select().from(patterns);

      // Apply filters
      const conditions = [];
      if (filters?.category) {
        conditions.push(eq(patterns.category, filters.category));
      }
      if (filters?.minConfidence !== undefined) {
        conditions.push(gte(patterns.confidence, filters.minConfidence));
      }
      if (filters?.minUsageCount !== undefined) {
        conditions.push(gte(patterns.usage_count, filters.minUsageCount));
      }
      if (filters?.created_by) {
        conditions.push(eq(patterns.created_by, filters.created_by));
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      // Order by confidence and usage
      query = query.orderBy(desc(patterns.confidence), desc(patterns.usage_count)) as typeof query;

      const rows = await query.all();
      return rows.map((row) => this.rowToPattern(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find patterns: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update pattern by ID
   */
  async update(id: string, updates: Partial<Pattern>): Promise<Pattern> {
    try {
      const fullId = await this.resolveId(id);

      // Get current pattern to merge updates
      const current = await this.findById(fullId);
      if (!current) {
        throw new EntityNotFoundError('Pattern', id);
      }

      const merged = { ...current, ...updates, updated_at: new Date().toISOString() };
      const insert = this.patternToInsert(merged);

      await this.db
        .update(patterns)
        .set({
          category: insert.category,
          confidence: insert.confidence,
          usage_count: insert.usage_count,
          success_count: insert.success_count,
          updated_at: new Date(),
          data: insert.data,
        })
        .where(eq(patterns.pattern_id, fullId));

      const updated = await this.findById(fullId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated pattern');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update pattern: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete pattern by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await this.db.delete(patterns).where(eq(patterns.pattern_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Pattern', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete pattern: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Simple text-based search (will be replaced with vector search)
   */
  async search(query: string, options?: PatternSearchOptions): Promise<PatternSuggestion[]> {
    try {
      const searchTerm = `%${query.toLowerCase()}%`;

      let dbQuery = this.db
        .select()
        .from(patterns)
        .where(
          or(
            sql`LOWER(json_extract(${patterns.data}, '$.summary')) LIKE ${searchTerm}`,
            sql`LOWER(json_extract(${patterns.data}, '$.context')) LIKE ${searchTerm}`,
            sql`LOWER(json_extract(${patterns.data}, '$.implementation')) LIKE ${searchTerm}`
          )
        );

      // Apply filters
      const conditions = [];
      if (options?.category) {
        conditions.push(eq(patterns.category, options.category));
      }
      if (options?.minConfidence !== undefined) {
        conditions.push(gte(patterns.confidence, options.minConfidence));
      }
      if (options?.minUsageCount !== undefined) {
        conditions.push(gte(patterns.usage_count, options.minUsageCount));
      }

      if (conditions.length > 0) {
        dbQuery = dbQuery.where(and(...conditions)) as typeof dbQuery;
      }

      // Order by confidence and usage
      dbQuery = dbQuery.orderBy(
        desc(patterns.confidence),
        desc(patterns.usage_count)
      ) as typeof dbQuery;

      if (options?.limit) {
        dbQuery = dbQuery.limit(options.limit) as typeof dbQuery;
      }

      const rows = await dbQuery.all();

      // Convert to suggestions with relevance score (placeholder for now)
      return rows.map((row) => ({
        ...this.rowToPattern(row),
        relevance: row.confidence / 100, // Simple confidence-based relevance for now
        reason: 'Text match',
      }));
    } catch (error) {
      throw new RepositoryError(
        `Failed to search patterns: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find patterns by category
   */
  async findByCategory(category: PatternCategory, limit?: number): Promise<Pattern[]> {
    return this.findAll({ category }).then((patterns) =>
      limit ? patterns.slice(0, limit) : patterns
    );
  }

  /**
   * Get top patterns (by confidence and usage)
   */
  async getTopPatterns(limit = 10, category?: PatternCategory): Promise<Pattern[]> {
    return this.findAll({ category, minConfidence: 70 }).then((patterns) =>
      patterns.slice(0, limit)
    );
  }

  /**
   * Increment usage count and update confidence based on outcome
   */
  async recordUsage(
    patternId: string,
    outcome: PatternOutcome,
    sessionId: string,
    taskId?: string,
    feedback?: string
  ): Promise<Pattern> {
    try {
      const pattern = await this.findById(patternId);
      if (!pattern) {
        throw new EntityNotFoundError('Pattern', patternId);
      }

      // Update usage statistics
      const newUsageCount = pattern.usage_count + 1;
      const newSuccessCount =
        outcome === 'success' ? pattern.success_count + 1 : pattern.success_count;

      // Calculate new confidence (weighted average of success rate and current confidence)
      const successRate = (newSuccessCount / newUsageCount) * 100;
      const newConfidence = Math.round(pattern.confidence * 0.7 + successRate * 0.3);

      // Update pattern
      const updated = await this.update(patternId, {
        usage_count: newUsageCount,
        success_count: newSuccessCount,
        confidence: Math.max(0, Math.min(100, newConfidence)),
      });

      // Record application (handled by PatternApplicationsRepository in production)
      // For now, we'll just return the updated pattern

      return updated;
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to record pattern usage: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

/**
 * Pattern Applications Repository
 *
 * Tracks pattern usage and outcomes for reinforcement learning.
 */
export class PatternApplicationsRepository
  implements BaseRepository<PatternApplication, Partial<PatternApplication>>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to PatternApplication type
   */
  private rowToApplication(row: PatternApplicationRow): PatternApplication {
    const data = row.data as {
      feedback?: string;
      modifications?: string;
    };

    return {
      application_id: row.application_id,
      created_at: new Date(row.created_at).toISOString(),
      pattern_id: row.pattern_id as PatternID,
      session_id: row.session_id as SessionID,
      task_id: row.task_id ? (row.task_id as TaskID) : undefined,
      outcome: row.outcome as PatternOutcome,
      created_by: row.created_by as UUID,
      feedback: data.feedback,
      modifications: data.modifications,
    };
  }

  /**
   * Convert PatternApplication to database insert format
   */
  private applicationToInsert(
    application: Partial<PatternApplication>
  ): PatternApplicationInsert {
    const now = Date.now();
    const applicationId = application.application_id ?? generateId();

    return {
      application_id: applicationId,
      created_at: new Date(application.created_at ?? now),
      pattern_id: application.pattern_id!,
      session_id: application.session_id!,
      task_id: application.task_id ?? null,
      outcome: application.outcome!,
      created_by: application.created_by ?? 'anonymous',
      data: {
        feedback: application.feedback,
        modifications: application.modifications,
      },
    };
  }

  /**
   * Create a new pattern application record
   */
  async create(data: Partial<PatternApplication>): Promise<PatternApplication> {
    try {
      const insert = this.applicationToInsert(data);
      await this.db.insert(patternApplications).values(insert);

      const row = await this.db
        .select()
        .from(patternApplications)
        .where(eq(patternApplications.application_id, insert.application_id))
        .get();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created pattern application');
      }

      return this.rowToApplication(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create pattern application: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find pattern application by ID
   */
  async findById(id: string): Promise<PatternApplication | null> {
    try {
      const row = await this.db
        .select()
        .from(patternApplications)
        .where(eq(patternApplications.application_id, id))
        .get();

      return row ? this.rowToApplication(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find pattern application: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all pattern applications (optionally filtered)
   */
  async findAll(filters?: {
    pattern_id?: string;
    session_id?: string;
    task_id?: string;
    outcome?: PatternOutcome;
  }): Promise<PatternApplication[]> {
    try {
      let query = this.db.select().from(patternApplications);

      const conditions = [];
      if (filters?.pattern_id) {
        conditions.push(eq(patternApplications.pattern_id, filters.pattern_id));
      }
      if (filters?.session_id) {
        conditions.push(eq(patternApplications.session_id, filters.session_id));
      }
      if (filters?.task_id) {
        conditions.push(eq(patternApplications.task_id, filters.task_id));
      }
      if (filters?.outcome) {
        conditions.push(eq(patternApplications.outcome, filters.outcome));
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      query = query.orderBy(desc(patternApplications.created_at)) as typeof query;

      const rows = await query.all();
      return rows.map((row) => this.rowToApplication(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find pattern applications: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update pattern application (mainly for adding feedback)
   */
  async update(
    id: string,
    updates: Partial<PatternApplication>
  ): Promise<PatternApplication> {
    try {
      const current = await this.findById(id);
      if (!current) {
        throw new EntityNotFoundError('PatternApplication', id);
      }

      const merged = { ...current, ...updates };
      const insert = this.applicationToInsert(merged);

      await this.db
        .update(patternApplications)
        .set({
          outcome: insert.outcome,
          data: insert.data,
        })
        .where(eq(patternApplications.application_id, id));

      const updated = await this.findById(id);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated pattern application');
      }

      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update pattern application: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete pattern application by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const result = await this.db
        .delete(patternApplications)
        .where(eq(patternApplications.application_id, id))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('PatternApplication', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete pattern application: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Get statistics for a pattern
   */
  async getPatternStats(patternId: string): Promise<{
    total_applications: number;
    success_count: number;
    failure_count: number;
    partial_count: number;
    success_rate: number;
  }> {
    try {
      const applications = await this.findAll({ pattern_id: patternId });

      const stats = {
        total_applications: applications.length,
        success_count: applications.filter((a) => a.outcome === 'success').length,
        failure_count: applications.filter((a) => a.outcome === 'failure').length,
        partial_count: applications.filter((a) => a.outcome === 'partial').length,
        success_rate: 0,
      };

      if (stats.total_applications > 0) {
        stats.success_rate = (stats.success_count / stats.total_applications) * 100;
      }

      return stats;
    } catch (error) {
      throw new RepositoryError(
        `Failed to get pattern stats: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
