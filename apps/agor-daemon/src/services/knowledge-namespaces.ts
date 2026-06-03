/**
 * Knowledge namespaces service
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, KnowledgeNamespaceRepository } from '@agor/core/db';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Id,
  KnowledgeNamespace,
  NullableId,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
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

  private isAdmin(user?: User): boolean {
    return hasMinimumRole(user?.role, ROLES.ADMIN);
  }

  private assertCanManage(params?: KnowledgeNamespaceParams): void {
    if (!this.isAdmin(params?.user as User | undefined)) {
      throw new Forbidden('Only admins can update or delete knowledge namespaces');
    }
  }

  private attributionUserId(params?: KnowledgeNamespaceParams, requestedUserId?: UserID | null) {
    const user = params?.user as User | undefined;
    if (this.isAdmin(user) && requestedUserId) return requestedUserId;
    return (user?.user_id as UserID | undefined) ?? null;
  }

  private assertSlugUnchanged(
    existing: KnowledgeNamespace,
    data: Partial<KnowledgeNamespace>
  ): void {
    if (data.slug !== undefined && data.slug !== existing.slug) {
      throw new BadRequest('Knowledge namespace slug cannot be changed after creation');
    }
  }

  private async createOne(
    data: Partial<KnowledgeNamespace>,
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespace> {
    const userId = params?.user?.user_id as UserID | undefined;
    const result = await this.repo.create({
      ...data,
      created_by: this.attributionUserId(params, data.created_by),
      owner_user_id: data.owner_user_id ?? userId ?? null,
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

  async patch(
    id: NullableId,
    data: Partial<KnowledgeNamespace>,
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespace> {
    if (id === null) throw new Error('Bulk patch is not supported for knowledge namespaces');
    this.assertCanManage(params);
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge namespace not found: ${id}`);
    this.assertSlugUnchanged(existing, data);
    const result = await this.repo.update(String(id), {
      ...data,
      namespace_id: existing.namespace_id,
      slug: data.slug ?? existing.slug,
      created_by: existing.created_by,
      owner_user_id: data.owner_user_id ?? existing.owner_user_id,
    });
    this.emit?.('patched', result, params);
    return result;
  }

  async update(
    id: Id,
    data: Partial<KnowledgeNamespace>,
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespace> {
    this.assertCanManage(params);
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge namespace not found: ${id}`);
    this.assertSlugUnchanged(existing, data);
    const result = await this.repo.update(String(id), {
      ...data,
      namespace_id: existing.namespace_id,
      slug: existing.slug,
      created_by: existing.created_by,
      owner_user_id: data.owner_user_id ?? existing.owner_user_id,
    });
    this.emit?.('updated', result, params);
    return result;
  }

  async remove(id: NullableId, params?: KnowledgeNamespaceParams): Promise<KnowledgeNamespace> {
    if (id === null) throw new Error('Bulk remove is not supported for knowledge namespaces');
    this.assertCanManage(params);
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge namespace not found: ${id}`);
    await this.repo.delete(String(id));
    this.emit?.('removed', existing, params);
    return existing;
  }
}

export function createKnowledgeNamespacesService(db: Database): KnowledgeNamespacesService {
  return new KnowledgeNamespacesService(db);
}
