/**
 * Knowledge documents service
 *
 * V1 supports markdown-only create/update. Patching `content_text` creates an
 * immutable document version and advances `current_version_id`.
 */

import { PAGINATION } from '@agor/core/config';
import {
  type CreateKnowledgeDocumentInput,
  type Database,
  type KnowledgeDocumentFilters,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  type UpdateKnowledgeDocumentInput,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Id,
  KnowledgeDocument,
  KnowledgeDocumentVersion,
  KnowledgeNamespaceID,
  NullableId,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import {
  hasMinimumRole,
  parseKnowledgeUri,
  ROLES,
  titleFromKnowledgeContent,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type KnowledgeDocumentParams = QueryParams<{
  namespace_id?: KnowledgeNamespaceID;
  namespace_slug?: string;
  path?: string;
  kind?: KnowledgeDocument['kind'];
  visibility?: KnowledgeDocument['visibility'];
  archived?: boolean;
  include_content?: boolean;
  include_links?: boolean;
  version?: string | number;
}> &
  AuthenticatedParams;

type KnowledgeDocumentWriteData = (CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput) & {
  document_id?: string;
  uri?: string;
  namespace_slug?: string;
  first_line_is_title?: boolean;
  create_namespace?: boolean;
  namespace_display_name?: string | null;
  expected_version?: string | number;
};

type KnowledgeDocumentRef = {
  document_id?: string;
  documentId?: string;
  uri?: string;
  namespace_slug?: string;
  namespace?: string;
  path?: string;
  include_content?: boolean;
  include_links?: boolean;
  version?: string | number;
};

type HydratedKnowledgeDocument = KnowledgeDocument & {
  document: KnowledgeDocument;
  current_version: KnowledgeDocumentVersion | null;
  content: string | null;
  first_line_is_title: boolean;
  links?: unknown[];
};

type HydrateOptions = Pick<KnowledgeDocumentRef, 'include_content' | 'include_links' | 'version'>;

function wantsFirstLineTitle(data: KnowledgeDocumentWriteData): boolean {
  if (typeof data.first_line_is_title === 'boolean') return data.first_line_is_title;
  return data.metadata?.title_from_content === true;
}

export class KnowledgeDocumentsService extends DrizzleService<
  KnowledgeDocument,
  CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
  KnowledgeDocumentParams
> {
  private repo: KnowledgeDocumentRepository;
  private versions: KnowledgeDocumentVersionRepository;
  private namespaces: KnowledgeNamespaceRepository;

  constructor(db: Database) {
    const repo = new KnowledgeDocumentRepository(db);
    super(repo, {
      id: 'document_id',
      resourceType: 'KnowledgeDocument',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.repo = repo;
    this.versions = new KnowledgeDocumentVersionRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
  }

  private isAdmin(user?: User): boolean {
    return hasMinimumRole(user?.role, ROLES.ADMIN);
  }

  private canRead(document: KnowledgeDocument, user?: User): boolean {
    return (
      document.visibility === 'public' ||
      this.isAdmin(user) ||
      Boolean(user?.user_id && document.created_by === user.user_id)
    );
  }

  private canEdit(document: KnowledgeDocument, user?: User): boolean {
    return (
      this.isAdmin(user) ||
      Boolean(user?.user_id && document.created_by === user.user_id) ||
      (document.visibility === 'public' && document.edit_policy === 'public')
    );
  }

  private canManageDocument(document: KnowledgeDocument, user?: User): boolean {
    return this.isAdmin(user) || Boolean(user?.user_id && document.created_by === user.user_id);
  }

  private assertCanChangeGovernance(
    existing: KnowledgeDocument,
    data: Partial<KnowledgeDocument>,
    user?: User
  ): void {
    const visibilityChanged =
      data.visibility !== undefined && data.visibility !== existing.visibility;
    const editPolicyChanged =
      data.edit_policy !== undefined && data.edit_policy !== existing.edit_policy;
    if (!visibilityChanged && !editPolicyChanged) return;
    if (!this.canManageDocument(existing, user)) {
      throw new Forbidden(
        'Only the owner or an admin can change knowledge document visibility or edit policy'
      );
    }
  }

  private attributionUserId(params?: KnowledgeDocumentParams, requestedUserId?: UserID | null) {
    const user = params?.user as User | undefined;
    if (this.isAdmin(user) && requestedUserId) return requestedUserId;
    return (user?.user_id as UserID | undefined) ?? null;
  }

  private async assertActiveDocument(document: KnowledgeDocument): Promise<void> {
    if (document.archived) {
      throw new NotFound('Knowledge document not found');
    }
    const namespace = await this.namespaces.findById(document.namespace_id);
    if (!namespace || namespace.archived) {
      throw new NotFound('Knowledge document not found');
    }
  }

  private prepareWriteData(
    data: KnowledgeDocumentWriteData,
    existing?: KnowledgeDocument | null
  ): KnowledgeDocumentWriteData {
    const metadata = {
      ...(existing?.metadata ?? {}),
      ...(data.metadata ?? {}),
      ...(typeof data.first_line_is_title === 'boolean'
        ? { title_from_content: data.first_line_is_title }
        : {}),
    };
    const prepared: KnowledgeDocumentWriteData = { ...data, metadata };
    if (wantsFirstLineTitle(prepared) && typeof prepared.content_text === 'string') {
      prepared.title = titleFromKnowledgeContent(
        prepared.content_text,
        prepared.title ?? existing?.title ?? 'Untitled'
      );
    }
    delete prepared.first_line_is_title;
    delete prepared.expected_version;
    delete prepared.create_namespace;
    delete prepared.namespace_display_name;
    return prepared;
  }

  private async resolveDocumentRef(ref: KnowledgeDocumentRef): Promise<KnowledgeDocument | null> {
    const documentId = ref.document_id ?? ref.documentId;
    if (documentId) return this.repo.findById(String(documentId));

    const parsed = parseKnowledgeUri(ref.uri);
    const namespaceSlug = ref.namespace_slug ?? ref.namespace ?? parsed?.namespace_slug;
    const path = ref.path ?? parsed?.path;
    if (!namespaceSlug || !path) return null;

    const namespace = await this.namespaces.findBySlug(String(namespaceSlug));
    if (!namespace || namespace.archived) return null;
    return this.repo.findByNamespaceAndPath(namespace.namespace_id, String(path));
  }

  private async versionFor(
    document: KnowledgeDocument,
    versionRef?: string | number
  ): Promise<KnowledgeDocumentVersion | null> {
    if (versionRef === undefined || versionRef === null || versionRef === '') {
      if (!document.current_version_id) return null;
      return this.versions.findById(document.current_version_id);
    }

    const versions = await this.versions.findAll({ document_id: document.document_id });
    const numeric =
      typeof versionRef === 'number'
        ? versionRef
        : /^\d+$/.test(versionRef)
          ? Number(versionRef)
          : null;
    if (numeric !== null) {
      return versions.find((version) => version.version_number === numeric) ?? null;
    }
    const byId = await this.versions.findById(String(versionRef));
    return byId?.document_id === document.document_id ? byId : null;
  }

  private async hydrateDocument(
    document: KnowledgeDocument,
    params?: HydrateOptions
  ): Promise<KnowledgeDocument | HydratedKnowledgeDocument> {
    if (params?.include_content !== true && params?.include_links !== true) return document;
    const version = await this.versionFor(document, params?.version);
    return {
      ...document,
      document,
      current_version: version,
      content: version?.content_text ?? null,
      first_line_is_title: document.metadata?.title_from_content === true,
      ...(params?.include_links ? { links: [] } : {}),
    };
  }

  private async assertExpectedVersion(
    document: KnowledgeDocument,
    expectedVersion: string | number | undefined
  ): Promise<void> {
    if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
    const current = await this.versionFor(document);
    const matches =
      current?.version_id === String(expectedVersion) ||
      String(current?.version_number) === String(expectedVersion);
    if (!matches) {
      throw new BadRequest(
        `Knowledge document version mismatch: expected ${expectedVersion}, current is ${current?.version_number ?? 'none'}`
      );
    }
  }

  async find(params?: KnowledgeDocumentParams): Promise<KnowledgeDocument[]> {
    const query = params?.query;
    const user = params?.user as User | undefined;
    const isAdmin = this.isAdmin(user);
    const filters: KnowledgeDocumentFilters | undefined = query
      ? {
          namespace_id: query.namespace_id,
          namespace_slug: query.namespace_slug,
          path: query.path,
          kind: query.kind,
          visibility: query.visibility,
          archived: isAdmin ? query.archived : false,
        }
      : undefined;
    const rows = await this.repo.findAll(filters);
    const readable = rows.filter((doc) => this.canRead(doc, user));
    if (params?.query?.include_content !== true && params?.query?.include_links !== true) {
      return readable;
    }
    return Promise.all(
      readable.map((doc) =>
        this.hydrateDocument(doc, {
          include_content: params?.query?.include_content,
          include_links: params?.query?.include_links,
          version: params?.query?.version,
        })
      )
    );
  }

  async get(id: Id, params?: KnowledgeDocumentParams): Promise<KnowledgeDocument> {
    const doc = await this.repo.findById(String(id));
    if (!doc) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(doc);
    if (!this.canRead(doc, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to view this knowledge document');
    }
    return this.hydrateDocument(doc, params?.query);
  }

  async getDocument(
    data: KnowledgeDocumentRef,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument | HydratedKnowledgeDocument> {
    const doc = await this.resolveDocumentRef(data);
    if (!doc) throw new NotFound('Knowledge document not found');
    await this.assertActiveDocument(doc);
    if (!this.canRead(doc, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to view this knowledge document');
    }
    return this.hydrateDocument(doc, data);
  }

  async putDocument(
    data: KnowledgeDocumentWriteData,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument> {
    const userId = this.attributionUserId(params, data.created_by);

    const parsed = parseKnowledgeUri(data.uri);
    const namespaceSlug = data.namespace_slug ?? parsed?.namespace_slug;
    const path = data.path ?? parsed?.path;
    const existing = await this.resolveDocumentRef({
      document_id: data.document_id,
      uri: data.uri,
      namespace_slug: namespaceSlug,
      path,
    });

    if (existing) {
      await this.assertActiveDocument(existing);
      this.assertCanChangeGovernance(existing, data, params?.user as User | undefined);
      if (!this.canEdit(existing, params?.user as User | undefined)) {
        throw new Forbidden('You do not have permission to update this knowledge document');
      }
      await this.assertExpectedVersion(existing, data.expected_version);
      const result = await this.repo.update(
        existing.document_id,
        this.prepareWriteData(
          {
            ...data,
            created_by: existing.created_by,
            namespace_slug: undefined,
            path: path ?? existing.path,
            updated_by: this.attributionUserId(params, data.updated_by),
          },
          existing
        )
      );
      this.emit?.('patched', result, params);
      return result;
    }

    if (!namespaceSlug || !path) {
      throw new BadRequest(
        'Provide documentId, a valid agor://kb/<namespace>/<path> uri, or namespace + path.'
      );
    }

    let namespace = await this.namespaces.findBySlug(namespaceSlug);
    if (!namespace && data.create_namespace === true) {
      namespace = await this.namespaces.create({
        slug: namespaceSlug,
        display_name: data.namespace_display_name ?? namespaceSlug,
        kind: 'global',
        visibility_default: data.visibility ?? 'public',
        created_by: userId,
      });
    }
    if (!namespace) throw new NotFound(`Knowledge namespace not found: ${namespaceSlug}`);
    if (namespace.archived) throw new NotFound(`Knowledge namespace not found: ${namespaceSlug}`);

    const result = await this.repo.create(
      this.prepareWriteData({
        ...data,
        namespace_id: namespace.namespace_id,
        namespace_slug: namespace.slug,
        path,
        created_by: userId,
        updated_by: this.attributionUserId(params, data.updated_by),
      })
    );
    this.emit?.('created', result, params);
    return result;
  }

  private async createOne(
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument> {
    const userId = this.attributionUserId(params, data.created_by);
    const prepared = this.prepareWriteData(
      {
        ...data,
        created_by: userId,
        updated_by: this.attributionUserId(params, data.updated_by),
      },
      null
    );
    const result = await this.repo.create({
      ...prepared,
    });
    this.emit?.('created', result, params);
    return result;
  }

  async create(
    data:
      | CreateKnowledgeDocumentInput
      | UpdateKnowledgeDocumentInput
      | Array<CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput>,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument | KnowledgeDocument[]> {
    if (Array.isArray(data)) {
      return Promise.all(data.map((item) => this.createOne(item, params)));
    }
    return this.createOne(data, params);
  }

  async patch(
    id: NullableId,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    if (id === null) throw new Error('Bulk patch is not supported for knowledge documents');
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(existing);
    this.assertCanChangeGovernance(existing, data, params?.user as User | undefined);
    if (!this.canEdit(existing, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to update this knowledge document');
    }
    const result = await this.repo.update(String(id), {
      ...this.prepareWriteData(data as KnowledgeDocumentWriteData, existing),
      created_by: existing.created_by,
      updated_by: this.attributionUserId(params, data.updated_by),
    });
    this.emit?.('patched', result, params);
    return result;
  }

  async update(
    id: Id,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(existing);
    this.assertCanChangeGovernance(existing, data, params?.user as User | undefined);
    if (!this.canEdit(existing, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to update this knowledge document');
    }
    const result = await this.repo.update(String(id), {
      ...this.prepareWriteData(data as KnowledgeDocumentWriteData, existing),
      created_by: existing.created_by,
      updated_by: this.attributionUserId(params, data.updated_by),
    });
    this.emit?.('updated', result, params);
    return result;
  }

  async remove(id: NullableId, params?: KnowledgeDocumentParams): Promise<KnowledgeDocument> {
    if (id === null) throw new Error('Bulk remove is not supported for knowledge documents');
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(existing);
    if (!this.canManageDocument(existing, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to delete this knowledge document');
    }
    await this.repo.delete(String(id));
    this.emit?.('removed', existing, params);
    return existing;
  }
}

export function createKnowledgeDocumentsService(db: Database): KnowledgeDocumentsService {
  return new KnowledgeDocumentsService(db);
}
