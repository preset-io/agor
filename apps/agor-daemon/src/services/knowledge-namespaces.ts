/**
 * Knowledge namespaces service
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, KnowledgeNamespaceRepository } from '@agor/core/db';
import type {
  AuthenticatedParams,
  KnowledgeNamespace,
  QueryParams,
  UserID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type KnowledgeNamespaceParams = QueryParams<{
  slug?: string;
  kind?: KnowledgeNamespace['kind'];
  owner_user_id?: UserID;
  repo_id?: string;
  branch_id?: string;
  archived?: boolean;
}> &
  AuthenticatedParams;

export class KnowledgeNamespacesService extends DrizzleService<
  KnowledgeNamespace,
  Partial<KnowledgeNamespace>,
  KnowledgeNamespaceParams
> {
  private repo: KnowledgeNamespaceRepository;

  constructor(db: Database) {
    const repo = new KnowledgeNamespaceRepository(db);
    super(repo, {
      id: 'namespace_id',
      resourceType: 'KnowledgeNamespace',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.repo = repo;
  }

  async find(params?: KnowledgeNamespaceParams): Promise<KnowledgeNamespace[]> {
    return this.repo.findAll(params?.query);
  }

  private async createOne(
    data: Partial<KnowledgeNamespace>,
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespace> {
    const userId = params?.user?.user_id as UserID | undefined;
    const result = await this.repo.create({
      ...data,
      created_by: data.created_by ?? userId ?? null,
    });
    this.emit?.('created', result, params);
    return result;
  }

  async create(
    data: Partial<KnowledgeNamespace> | Partial<KnowledgeNamespace>[],
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespace | KnowledgeNamespace[]> {
    if (Array.isArray(data)) {
      return Promise.all(data.map((item) => this.createOne(item, params)));
    }
    return this.createOne(data, params);
  }
}

export function createKnowledgeNamespacesService(db: Database): KnowledgeNamespacesService {
  return new KnowledgeNamespacesService(db);
}
