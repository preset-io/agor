/**
 * Knowledge documents service
 *
 * V1 supports markdown-only create/update. Patching `content_text` creates an
 * immutable document version and advances `current_version_id`.
 */

import { loadConfig, PAGINATION } from '@agor/core/config';
import {
  AppVariableRepository,
  type CreateKnowledgeDocumentInput,
  type Database,
  isPostgresDatabase,
  type KnowledgeDocumentFilters,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  type UpdateKnowledgeDocumentInput,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
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
  buildKnowledgeDocumentUri,
  extractKnowledgeLinks,
  hasMinimumRole,
  parseKnowledgeUri,
  ROLES,
  titleFromKnowledgeContent,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import {
  isUsableOpenAIEmbeddingConfig,
  KNOWLEDGE_EMBEDDINGS_API_KEY,
  KNOWLEDGE_EMBEDDINGS_NAMESPACE,
} from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import {
  knowledgeChunkerOptionsFromConfig,
  knowledgeUnitsForMarkdown,
} from '../knowledge/units.js';

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
  private variables: AppVariableRepository;
  private versions: KnowledgeDocumentVersionRepository;
  private namespaces: KnowledgeNamespaceRepository;
  private graph: KnowledgeGraphRepository;

  constructor(
    private db: Database,
    private app?: Application
  ) {
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
    this.variables = new AppVariableRepository(db);
    this.versions = new KnowledgeDocumentVersionRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
    this.graph = new KnowledgeGraphRepository(db);
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

  /**
   * Keep the knowledge graph's outgoing `references` edges for a document in
   * sync with the doc-to-doc links in its markdown. Only runs when content was
   * (re)written; metadata-only saves leave existing edges untouched. Failures
   * are swallowed so graph upkeep never blocks a save.
   */

  private async isEmbeddingConfigured(): Promise<boolean> {
    const config = await loadConfig();
    if (!isPostgresDatabase(this.db)) return false;
    const apiKey = await this.variables.find(
      KNOWLEDGE_EMBEDDINGS_NAMESPACE,
      KNOWLEDGE_EMBEDDINGS_API_KEY
    );
    return (
      isUsableOpenAIEmbeddingConfig(
        config.knowledge?.semantic_search ?? {},
        Boolean(apiKey?.value_encrypted)
      ) && (await ensureKnowledgePgvectorStorage(this.db)).available
    );
  }

  private async replaceSearchUnitsForContent(
    doc: KnowledgeDocument,
    content?: string | null
  ): Promise<void> {
    if (typeof content !== 'string' || !doc.current_version_id) return;
    const config = await loadConfig();
    const chunks = knowledgeUnitsForMarkdown(
      doc.path,
      content,
      knowledgeChunkerOptionsFromConfig(config)
    );
    await this.repo.replaceUnitsForVersion(doc.current_version_id, chunks, {
      embeddingConfigured: await this.isEmbeddingConfigured(),
    });
    const indexer = (this.app as unknown as { get?: (key: string) => unknown } | undefined)?.get?.(
      'knowledgeEmbeddingIndexer'
    ) as { wake?: () => void } | undefined;
    indexer?.wake?.();
  }

  private async syncGraphReferences(
    doc: KnowledgeDocument,
    content: string | null | undefined,
    userId: UserID | null
  ): Promise<void> {
    if (typeof content !== 'string') return;
    try {
      const links = extractKnowledgeLinks(content);
      // Key graph nodes by the rename-proof `agor://kb/document/<id>` URI rather
      // than the path-based `doc.uri`, so renaming a document doesn't orphan its
      // graph node (and its edges) behind a stale path.
      const targets: { uri: string; document_id: string; namespace_id: string }[] = [];
      const seen = new Set<string>();
      for (const link of links) {
        const target = await this.resolveDocumentRef(
          link.document_id
            ? { document_id: link.document_id }
            : { namespace_slug: link.namespace_slug, path: link.path }
        );
        if (!target || target.archived) continue;
        if (target.document_id === doc.document_id) continue;
        if (seen.has(target.document_id)) continue;
        seen.add(target.document_id);
        targets.push({
          uri: buildKnowledgeDocumentUri(target.document_id),
          document_id: target.document_id,
          namespace_id: target.namespace_id,
        });
      }
      await this.graph.syncOutgoingEdges({
        source: {
          uri: buildKnowledgeDocumentUri(doc.document_id),
          document_id: doc.document_id,
          namespace_id: doc.namespace_id,
        },
        edge_type: 'references',
        targets,
        created_by: userId,
      });
    } catch (err) {
      console.error('Failed to sync knowledge graph references:', err);
    }
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
      ...(params?.include_links
        ? { links: extractKnowledgeLinks(version?.content_text ?? '') }
        : {}),
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
      await this.replaceSearchUnitsForContent(result, data.content_text);
      await this.syncGraphReferences(result, data.content_text, userId);
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
    await this.replaceSearchUnitsForContent(result, data.content_text);
    await this.syncGraphReferences(result, data.content_text, userId);
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
    await this.replaceSearchUnitsForContent(result, data.content_text);
    await this.syncGraphReferences(result, data.content_text, userId);
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
    await this.replaceSearchUnitsForContent(
      result,
      (data as KnowledgeDocumentWriteData).content_text
    );
    await this.syncGraphReferences(
      result,
      (data as KnowledgeDocumentWriteData).content_text,
      this.attributionUserId(params, data.updated_by)
    );
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
    await this.replaceSearchUnitsForContent(
      result,
      (data as KnowledgeDocumentWriteData).content_text
    );
    await this.syncGraphReferences(
      result,
      (data as KnowledgeDocumentWriteData).content_text,
      this.attributionUserId(params, data.updated_by)
    );
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

export function createKnowledgeDocumentsService(
  db: Database,
  app?: Application
): KnowledgeDocumentsService {
  return new KnowledgeDocumentsService(db, app);
}
