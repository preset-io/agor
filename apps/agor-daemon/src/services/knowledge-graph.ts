/**
 * Knowledge graph service
 */

import {
  type Database,
  type KnowledgeGraphLinkInput,
  type KnowledgeGraphNeighborsQuery,
  KnowledgeGraphRepository,
} from '@agor/core/db';
import type { AuthenticatedParams, QueryParams, UserID } from '@agor/core/types';

export type KnowledgeGraphParams = QueryParams<KnowledgeGraphNeighborsQuery> & AuthenticatedParams;

export class KnowledgeGraphService {
  private graph: KnowledgeGraphRepository;

  constructor(db: Database) {
    this.graph = new KnowledgeGraphRepository(db);
  }

  async create(data: KnowledgeGraphLinkInput, params?: KnowledgeGraphParams) {
    return this.link(data, params);
  }

  async find(params?: KnowledgeGraphParams) {
    return this.neighbors((params?.query ?? {}) as KnowledgeGraphNeighborsQuery, params);
  }

  async link(data: KnowledgeGraphLinkInput, params?: KnowledgeGraphParams) {
    const userId = params?.user?.user_id as UserID | undefined;
    return this.graph.link({
      ...data,
      created_by: data.created_by ?? userId ?? null,
    });
  }

  async neighbors(data: KnowledgeGraphNeighborsQuery, _params?: KnowledgeGraphParams) {
    return this.graph.neighbors(data);
  }
}

export function createKnowledgeGraphService(db: Database): KnowledgeGraphService {
  return new KnowledgeGraphService(db);
}
