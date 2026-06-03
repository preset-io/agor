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

  private scopedQuery(query: KnowledgeSearchQuery | undefined, user?: User): KnowledgeSearchQuery {
    const isAdmin = hasMinimumRole(user?.role, ROLES.ADMIN);
    return {
      ...(query ?? {}),
      include_archived: isAdmin && query?.include_archived === true,
      readable_as_admin: isAdmin,
      readable_by_user_id: isAdmin ? undefined : user?.user_id,
    };
  }

  async find(params?: KnowledgeSearchParams) {
    const user = params?.user as User | undefined;
    const results = await this.repo.search(this.scopedQuery(params?.query, user));
    return results.filter((result) => this.canRead(result, params?.user as User | undefined));
  }

  async create(data: KnowledgeSearchQuery, params?: KnowledgeSearchParams) {
    const user = params?.user as User | undefined;
    const results = await this.repo.search(this.scopedQuery(data, user));
    return results.filter((result) => this.canRead(result, params?.user as User | undefined));
  }
}

export function createKnowledgeSearchService(db: Database): KnowledgeSearchService {
  return new KnowledgeSearchService(db);
}
