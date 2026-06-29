/**
 * Knowledge namespaces service
 */

import { PAGINATION } from '@agor/core/config';
import {
  GroupRepository,
  KnowledgeNamespaceRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  GroupID,
  Id,
  KnowledgeNamespace,
  KnowledgeNamespaceAclEntry,
  KnowledgeNamespaceEffectivePermission,
  KnowledgeNamespacePermission,
  KnowledgeNamespaceSubjectType,
  NullableId,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { isKnowledgeAdmin } from './knowledge-access.js';

export type KnowledgeNamespaceParams = QueryParams<{
  slug?: string;
  kind?: KnowledgeNamespace['kind'];
  owner_user_id?: UserID;
  repo_id?: string;
  branch_id?: string;
  archived?: boolean;
}> &
  AuthenticatedParams;

type KnowledgeNamespaceAclDraftEntry = {
  subject_type?: KnowledgeNamespaceSubjectType;
  subjectType?: KnowledgeNamespaceSubjectType;
  subject_id?: string;
  subjectId?: string;
  permission?: KnowledgeNamespacePermission;
};

type KnowledgeNamespaceWithAclResult = {
  namespace: KnowledgeNamespace;
  acl: KnowledgeNamespaceAclEntry[];
};

export class KnowledgeNamespacesService extends DrizzleService<
  KnowledgeNamespace,
  Partial<KnowledgeNamespace>,
  KnowledgeNamespaceParams
> {
  private repo: KnowledgeNamespaceRepository;
  private groups: GroupRepository;

  constructor(db: TenantScopeAwareDatabase) {
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
    this.groups = new GroupRepository(db);
  }

  private withEffectivePermission(
    namespace: KnowledgeNamespace,
    permission: KnowledgeNamespaceEffectivePermission
  ): KnowledgeNamespace {
    return { ...namespace, effective_permission: permission };
  }

  async find(params?: KnowledgeNamespaceParams): Promise<KnowledgeNamespace[]> {
    const user = params?.user as User | undefined;
    const namespaces = await this.repo.findAll(params?.query);
    if (this.isAdmin(user)) {
      return namespaces.map((namespace) => this.withEffectivePermission(namespace, 'own'));
    }
    const userId = user?.user_id;
    if (!userId) return [];

    const readable: KnowledgeNamespace[] = [];
    for (const namespace of namespaces) {
      const permission = await this.repo.resolveNamespacePermission(namespace.namespace_id, userId);
      if (permission !== 'none') readable.push(this.withEffectivePermission(namespace, permission));
    }
    return readable;
  }

  async get(id: Id, params?: KnowledgeNamespaceParams): Promise<KnowledgeNamespace> {
    const namespace = await this.repo.findById(String(id));
    if (!namespace || namespace.archived)
      throw new NotFound(`Knowledge namespace not found: ${id}`);
    await this.assertCanReadNamespace(namespace, params);
    return this.withEffectivePermission(
      namespace,
      await this.namespacePermission(namespace, params)
    );
  }

  private isAdmin(user?: User): boolean {
    return isKnowledgeAdmin(user);
  }

  private async namespacePermission(
    namespace: KnowledgeNamespace,
    params?: KnowledgeNamespaceParams
  ) {
    const user = params?.user as User | undefined;
    return this.repo.resolveNamespacePermission(
      namespace.namespace_id,
      String(user?.user_id ?? ''),
      {
        isAdmin: this.isAdmin(user),
      }
    );
  }

  private async assertCanReadNamespace(
    namespace: KnowledgeNamespace,
    params?: KnowledgeNamespaceParams
  ): Promise<void> {
    const permission = await this.namespacePermission(namespace, params);
    if (permission === 'none') {
      throw new Forbidden('You do not have permission to view this knowledge namespace');
    }
  }

  private async assertCanManage(
    namespace: KnowledgeNamespace,
    params?: KnowledgeNamespaceParams
  ): Promise<void> {
    const permission = await this.namespacePermission(namespace, params);
    if (permission !== 'own') {
      throw new Forbidden('You do not have permission to manage this knowledge namespace');
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

  private normalizeAclEntries(
    entries: KnowledgeNamespaceAclDraftEntry[] | undefined,
    params?: KnowledgeNamespaceParams
  ) {
    const createdBy = (params?.user?.user_id as UserID | undefined) ?? null;
    const deduped = new Map<
      string,
      {
        subject_type: KnowledgeNamespaceSubjectType;
        subject_id: string;
        permission: KnowledgeNamespacePermission;
        created_by: UserID | null;
      }
    >();
    for (const entry of entries ?? []) {
      const subjectType = entry.subject_type ?? entry.subjectType;
      const subjectId = entry.subject_id ?? entry.subjectId;
      if (!subjectType || !subjectId || !entry.permission) {
        throw new BadRequest('ACL entries require subject_type, subject_id, and permission');
      }
      deduped.set(`${subjectType}:${subjectId}`, {
        subject_type: subjectType,
        subject_id: subjectId,
        permission: entry.permission,
        created_by: createdBy,
      });
    }
    return [...deduped.values()];
  }

  private ensureCallerOwnAcl(
    entries: ReturnType<KnowledgeNamespacesService['normalizeAclEntries']>,
    params?: KnowledgeNamespaceParams
  ) {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) return entries;
    const key = `user:${userId}`;
    const existing = entries.find((entry) => `${entry.subject_type}:${entry.subject_id}` === key);
    if (existing) {
      existing.permission = 'own';
      return entries;
    }
    return [
      ...entries,
      {
        subject_type: 'user' as const,
        subject_id: userId,
        permission: 'own' as const,
        created_by: userId,
      },
    ];
  }

  private async callerOwnsOutsideAclSubject(
    namespace: KnowledgeNamespace,
    params: KnowledgeNamespaceParams | undefined,
    subject: { subject_type: KnowledgeNamespaceSubjectType; subject_id: string }
  ): Promise<boolean> {
    const user = params?.user as User | undefined;
    if (this.isAdmin(user)) return true;
    const userId = user?.user_id as UserID | undefined;
    if (!userId) return false;
    if (namespace.owner_user_id === userId) return true;

    const groupIds = new Set<GroupID>(await this.groups.getGroupIdsForUser(userId));
    const acl = await this.repo.listNamespaceAcl(namespace.namespace_id);
    for (const entry of acl) {
      if (entry.permission !== 'own') continue;
      if (entry.subject_type === subject.subject_type && entry.subject_id === subject.subject_id) {
        continue;
      }
      if (entry.subject_type === 'user' && entry.subject_id === userId) return true;
      if (groupIds.has(entry.subject_id as GroupID)) {
        const group = await this.groups.findById(entry.subject_id);
        if (group && !group.archived) return true;
      }
    }
    return false;
  }

  private async callerOwnsThroughAcl(
    namespace: KnowledgeNamespace,
    params: KnowledgeNamespaceParams | undefined
  ): Promise<boolean> {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) return false;
    const groupIds = new Set<GroupID>(await this.groups.getGroupIdsForUser(userId));
    const acl = await this.repo.listNamespaceAcl(namespace.namespace_id);
    for (const entry of acl) {
      if (entry.permission !== 'own') continue;
      if (entry.subject_type === 'user' && entry.subject_id === userId) return true;
      if (groupIds.has(entry.subject_id as GroupID)) {
        const group = await this.groups.findById(entry.subject_id);
        if (group && !group.archived) return true;
      }
    }
    return false;
  }

  private async callerDependsOnAclSubject(
    params: KnowledgeNamespaceParams | undefined,
    subjectType: KnowledgeNamespaceSubjectType,
    subjectId: string
  ): Promise<boolean> {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) return false;
    if (subjectType === 'user') return subjectId === userId;
    const groupIds = await this.groups.getGroupIdsForUser(userId);
    return groupIds.includes(subjectId as GroupID);
  }

  private async assertAclChangeKeepsCallerOwner(
    namespace: KnowledgeNamespace,
    params: KnowledgeNamespaceParams | undefined,
    subjectType: KnowledgeNamespaceSubjectType,
    subjectId: string,
    nextPermission?: KnowledgeNamespacePermission
  ): Promise<void> {
    if (this.isAdmin(params?.user as User | undefined)) return;
    if (nextPermission === 'own') return;
    if (!(await this.callerDependsOnAclSubject(params, subjectType, subjectId))) return;
    if (
      await this.callerOwnsOutsideAclSubject(namespace, params, {
        subject_type: subjectType,
        subject_id: subjectId,
      })
    ) {
      return;
    }
    throw new BadRequest('Cannot remove your last owner access to this knowledge namespace');
  }

  private async assertOwnerUserChangeKeepsCallerOwner(
    existing: KnowledgeNamespace,
    data: Partial<KnowledgeNamespace>,
    params?: KnowledgeNamespaceParams
  ): Promise<void> {
    if (data.owner_user_id === undefined || data.owner_user_id === existing.owner_user_id) return;
    const user = params?.user as User | undefined;
    if (this.isAdmin(user)) return;
    const userId = user?.user_id as UserID | undefined;
    if (!userId || existing.owner_user_id !== userId) return;
    if (await this.callerOwnsThroughAcl(existing, params)) return;
    throw new BadRequest('Cannot remove your last owner access to this knowledge namespace');
  }

  private async createOne(
    data: Partial<KnowledgeNamespace>,
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespace> {
    const userId = params?.user?.user_id as UserID | undefined;
    const createdBy = this.attributionUserId(params, data.created_by);
    const result = await this.repo.create({
      ...data,
      created_by: createdBy,
      owner_user_id: data.owner_user_id ?? userId ?? null,
    });
    if (userId) {
      await this.repo.upsertNamespaceAclEntry({
        namespace_id: result.namespace_id,
        subject_type: 'user',
        subject_id: userId,
        permission: 'own',
        created_by: createdBy,
      });
    }
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
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge namespace not found: ${id}`);
    await this.assertCanManage(existing, params);
    await this.assertOwnerUserChangeKeepsCallerOwner(existing, data, params);
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
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge namespace not found: ${id}`);
    await this.assertCanManage(existing, params);
    await this.assertOwnerUserChangeKeepsCallerOwner(existing, data, params);
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
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge namespace not found: ${id}`);
    await this.assertCanManage(existing, params);
    await this.repo.delete(String(id));
    this.emit?.('removed', existing, params);
    return existing;
  }

  async saveWithAcl(
    data: {
      namespace_id?: string;
      namespaceId?: string;
      namespace?: Partial<KnowledgeNamespace>;
      acl?: KnowledgeNamespaceAclDraftEntry[];
    },
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespaceWithAclResult> {
    const namespaceId = data.namespace_id ?? data.namespaceId;
    const namespaceData = data.namespace ?? {};
    const acl = this.ensureCallerOwnAcl(this.normalizeAclEntries(data.acl, params), params);

    if (namespaceId) {
      const existing = await this.repo.findById(String(namespaceId));
      if (!existing) throw new NotFound(`Knowledge namespace not found: ${namespaceId}`);
      await this.assertCanManage(existing, params);
      this.assertSlugUnchanged(existing, namespaceData);
      const result = await this.repo.updateWithAcl(
        existing.namespace_id,
        {
          ...namespaceData,
          namespace_id: existing.namespace_id,
          slug: existing.slug,
          created_by: existing.created_by,
          owner_user_id: namespaceData.owner_user_id ?? existing.owner_user_id,
        },
        acl
      );
      this.emit?.('patched', result.namespace, params);
      return result;
    }

    const userId = params?.user?.user_id as UserID | undefined;
    const createdBy = this.attributionUserId(params, namespaceData.created_by);
    const result = await this.repo.createWithAcl(
      {
        ...namespaceData,
        created_by: createdBy,
        owner_user_id: namespaceData.owner_user_id ?? userId ?? null,
      },
      acl
    );
    this.emit?.('created', result.namespace, params);
    return result;
  }

  async listAcl(
    data: { namespace_id?: string; namespaceId?: string } | string,
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespaceAclEntry[]> {
    const namespaceId = typeof data === 'string' ? data : (data.namespace_id ?? data.namespaceId);
    if (!namespaceId) throw new BadRequest('namespace_id is required');
    const namespace = await this.repo.findById(String(namespaceId));
    if (!namespace || namespace.archived) throw new NotFound('Knowledge namespace not found');
    await this.assertCanManage(namespace, params);
    return this.repo.listNamespaceAcl(namespace.namespace_id);
  }

  async setAcl(
    data: {
      namespace_id?: string;
      namespaceId?: string;
      subject_type?: KnowledgeNamespaceSubjectType;
      subjectType?: KnowledgeNamespaceSubjectType;
      subject_id?: string;
      subjectId?: string;
      permission?: KnowledgeNamespacePermission;
    },
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespaceAclEntry> {
    const namespaceId = data.namespace_id ?? data.namespaceId;
    const subjectType = data.subject_type ?? data.subjectType;
    const subjectId = data.subject_id ?? data.subjectId;
    if (!namespaceId || !subjectType || !subjectId || !data.permission) {
      throw new BadRequest('namespace_id, subject_type, subject_id, and permission are required');
    }
    const namespace = await this.repo.findById(String(namespaceId));
    if (!namespace || namespace.archived) throw new NotFound('Knowledge namespace not found');
    await this.assertCanManage(namespace, params);
    await this.assertAclChangeKeepsCallerOwner(
      namespace,
      params,
      subjectType,
      subjectId,
      data.permission
    );
    return this.repo.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: subjectType,
      subject_id: subjectId,
      permission: data.permission,
      created_by: (params?.user?.user_id as UserID | undefined) ?? null,
    });
  }

  async removeAcl(
    data: {
      namespace_id?: string;
      namespaceId?: string;
      subject_type?: KnowledgeNamespaceSubjectType;
      subjectType?: KnowledgeNamespaceSubjectType;
      subject_id?: string;
      subjectId?: string;
    },
    params?: KnowledgeNamespaceParams
  ): Promise<KnowledgeNamespaceAclEntry | null> {
    const namespaceId = data.namespace_id ?? data.namespaceId;
    const subjectType = data.subject_type ?? data.subjectType;
    const subjectId = data.subject_id ?? data.subjectId;
    if (!namespaceId || !subjectType || !subjectId) {
      throw new BadRequest('namespace_id, subject_type, and subject_id are required');
    }
    const namespace = await this.repo.findById(String(namespaceId));
    if (!namespace || namespace.archived) throw new NotFound('Knowledge namespace not found');
    await this.assertCanManage(namespace, params);
    await this.assertAclChangeKeepsCallerOwner(namespace, params, subjectType, subjectId);
    return this.repo.removeNamespaceAclEntry(namespace.namespace_id, subjectType, subjectId);
  }
}

export function createKnowledgeNamespacesService(
  db: TenantScopeAwareDatabase
): KnowledgeNamespacesService {
  return new KnowledgeNamespacesService(db);
}
