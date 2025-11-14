/**
 * Patterns Service
 *
 * Provides REST + WebSocket API for learned development patterns and agent orchestration.
 * Uses DrizzleService adapter with PatternsRepository and PatternApplicationsRepository.
 *
 * Features:
 * - Pattern CRUD operations
 * - Semantic search (text-based for now, vector search later)
 * - Pattern application tracking
 * - Confidence scoring and reinforcement learning
 * - Pattern suggestions for workflows
 */

import {
  PatternApplicationsRepository,
  PatternsRepository,
  type Database,
} from '@agor/core/db';
import type {
  Pattern,
  PatternApplication,
  PatternCategory,
  PatternOutcome,
  PatternSearchOptions,
  PatternSuggestion,
  QueryParams,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Patterns service params
 */
export type PatternsParams = QueryParams<{
  category?: PatternCategory;
  minConfidence?: number;
  minUsageCount?: number;
  created_by?: string;
}>;

/**
 * Pattern applications service params
 */
export type PatternApplicationsParams = QueryParams<{
  pattern_id?: string;
  session_id?: string;
  task_id?: string;
  outcome?: PatternOutcome;
}>;

/**
 * Extended patterns service with custom methods
 */
export class PatternsService extends DrizzleService<Pattern, Partial<Pattern>, PatternsParams> {
  private patternsRepo: PatternsRepository;
  private applicationsRepo: PatternApplicationsRepository;

  constructor(db: Database) {
    const patternsRepo = new PatternsRepository(db);
    super(patternsRepo, {
      id: 'pattern_id',
      resourceType: 'Pattern',
      paginate: {
        default: 50,
        max: 200,
      },
    });

    this.patternsRepo = patternsRepo;
    this.applicationsRepo = new PatternApplicationsRepository(db);
  }

  /**
   * Override find to support filtering by category, confidence, etc.
   * Returns paginated results for FeathersJS compatibility.
   */
  async find(params?: PatternsParams) {
    const filters = params?.query || {};

    // Get all matching patterns
    const allPatterns = await this.patternsRepo.findAll({
      category: filters.category,
      minConfidence: filters.minConfidence,
      minUsageCount: filters.minUsageCount,
      created_by: filters.created_by,
    });

    // Apply pagination if requested (default: 50)
    const $limit = filters.$limit || 50;
    const $skip = filters.$skip || 0;
    const paginated = allPatterns.slice($skip, $skip + $limit);

    // Return paginated result format expected by FeathersJS
    return {
      total: allPatterns.length,
      limit: $limit,
      skip: $skip,
      data: paginated,
    };
  }

  /**
   * Custom method: Search patterns with text query
   */
  async search(
    query: string,
    options?: PatternSearchOptions,
    _params?: PatternsParams
  ): Promise<PatternSuggestion[]> {
    return this.patternsRepo.search(query, options);
  }

  /**
   * Custom method: Find patterns by category
   */
  async findByCategory(
    category: PatternCategory,
    limit?: number,
    _params?: PatternsParams
  ): Promise<Pattern[]> {
    return this.patternsRepo.findByCategory(category, limit);
  }

  /**
   * Custom method: Get top patterns
   */
  async getTopPatterns(
    limit = 10,
    category?: PatternCategory,
    _params?: PatternsParams
  ): Promise<Pattern[]> {
    return this.patternsRepo.getTopPatterns(limit, category);
  }

  /**
   * Custom method: Record pattern usage
   */
  async recordUsage(
    patternId: string,
    outcome: PatternOutcome,
    sessionId: string,
    taskId?: string,
    feedback?: string,
    _params?: PatternsParams
  ): Promise<Pattern> {
    // Record application
    await this.applicationsRepo.create({
      pattern_id: patternId,
      session_id: sessionId,
      task_id: taskId,
      outcome,
      feedback,
      created_by: _params?.user?.user_id || 'anonymous',
    });

    // Update pattern statistics and confidence
    return this.patternsRepo.recordUsage(patternId, outcome, sessionId, taskId, feedback);
  }

  /**
   * Custom method: Capture a new pattern from a successful session/task
   */
  async captureFromTask(
    data: {
      category: PatternCategory;
      summary: string;
      context: string;
      implementation: string;
      tags?: string[];
      session_id: string;
      task_id?: string;
      worktree_id?: string;
    },
    _params?: PatternsParams
  ): Promise<Pattern> {
    return this.patternsRepo.create({
      category: data.category,
      summary: data.summary,
      context: data.context,
      implementation: data.implementation,
      tags: data.tags,
      source: {
        session_id: data.session_id,
        task_id: data.task_id,
        worktree_id: data.worktree_id,
      },
      confidence: 70, // Start with medium-high confidence for manually captured patterns
      created_by: _params?.user?.user_id || 'anonymous',
    });
  }

  /**
   * Custom method: Get pattern suggestions for a worktree/task
   */
  async getSuggestionsForContext(
    context: {
      query: string;
      category?: PatternCategory;
      worktree_id?: string;
      minConfidence?: number;
    },
    _params?: PatternsParams
  ): Promise<PatternSuggestion[]> {
    return this.patternsRepo.search(context.query, {
      category: context.category,
      minConfidence: context.minConfidence || 70,
      limit: 5,
    });
  }
}

/**
 * Pattern applications service
 */
export class PatternApplicationsService extends DrizzleService<
  PatternApplication,
  Partial<PatternApplication>,
  PatternApplicationsParams
> {
  private applicationsRepo: PatternApplicationsRepository;

  constructor(db: Database) {
    const applicationsRepo = new PatternApplicationsRepository(db);
    super(applicationsRepo, {
      id: 'application_id',
      resourceType: 'PatternApplication',
      paginate: {
        default: 100,
        max: 500,
      },
    });

    this.applicationsRepo = applicationsRepo;
  }

  /**
   * Override find to support filtering
   */
  async find(params?: PatternApplicationsParams) {
    const filters = params?.query || {};

    // Get all matching applications
    const allApplications = await this.applicationsRepo.findAll({
      pattern_id: filters.pattern_id,
      session_id: filters.session_id,
      task_id: filters.task_id,
      outcome: filters.outcome,
    });

    // Apply pagination
    const $limit = filters.$limit || 100;
    const $skip = filters.$skip || 0;
    const paginated = allApplications.slice($skip, $skip + $limit);

    return {
      total: allApplications.length,
      limit: $limit,
      skip: $skip,
      data: paginated,
    };
  }

  /**
   * Custom method: Get statistics for a pattern
   */
  async getPatternStats(
    patternId: string,
    _params?: PatternApplicationsParams
  ): Promise<{
    total_applications: number;
    success_count: number;
    failure_count: number;
    partial_count: number;
    success_rate: number;
  }> {
    return this.applicationsRepo.getPatternStats(patternId);
  }
}

/**
 * Service factory functions
 */
export function createPatternsService(db: Database): PatternsService {
  return new PatternsService(db);
}

export function createPatternApplicationsService(db: Database): PatternApplicationsService {
  return new PatternApplicationsService(db);
}
