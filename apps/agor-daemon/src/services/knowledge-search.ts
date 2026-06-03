/**
 * Knowledge search service
 */

import { type Database, type KnowledgeSearchQuery, KnowledgeSearchRepository } from '@agor/core/db';
import {
  type AuthenticatedParams,
  hasMinimumRole,
  type QueryParams,
  ROLES,
  type User,
} from '@agor/core/types';

export type KnowledgeSearchParams = QueryParams<KnowledgeSearchQuery> & AuthenticatedParams;

export class KnowledgeSearchService {
  private repo: KnowledgeSearchRepository;

  constructor(db: Database) {
    this.repo = new KnowledgeSearchRepository(db);
  }

  private canRead(
    result: Awaited<ReturnType<KnowledgeSearchRepository['search']>>[number],
    user?: User
  ): boolean {
    return (
      result.document.visibility === 'public' ||
      hasMinimumRole(user?.role, ROLES.ADMIN) ||
      Boolean(user?.user_id && result.document.created_by === user.user_id)
    );
  }

  async find(params?: KnowledgeSearchParams) {
    const results = await this.repo.search(params?.query ?? {});
    return results.filter((result) => this.canRead(result, params?.user as User | undefined));
  }

  async create(data: KnowledgeSearchQuery, params?: KnowledgeSearchParams) {
    const results = await this.repo.search(data ?? {});
    return results.filter((result) => this.canRead(result, params?.user as User | undefined));
  }
}

export function createKnowledgeSearchService(db: Database): KnowledgeSearchService {
  return new KnowledgeSearchService(db);
}
