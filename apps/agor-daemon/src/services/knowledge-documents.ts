/**
 * Knowledge documents service
 *
 * V1 supports markdown-only create/update. Patching `content_text` creates an
 * immutable document version and advances `current_version_id`.
 */

import { PAGINATION } from '@agor/core/config';
import {
  type CreateKnowledgeDocumentInput,
  isDatabaseUniqueConstraintError,
  isPostgresDatabaseHandle,
  KnowledgeAttributionRepository,
  type KnowledgeDocumentFilters,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  KnowledgeSemanticSettingsRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  type UpdateKnowledgeDocumentInput,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Id,
  KnowledgeDocument,
  KnowledgeDocumentVersion,
  KnowledgeNamespaceID,
  KnowledgeWriteAttribution,
  NullableId,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import {
  buildKnowledgeDocumentUri,
  extractKnowledgeLinks,
  normalizeKnowledgeDocumentIconEmoji,
  parseKnowledgeUri,
  titleFromKnowledgeContent,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { isUsableOpenAIEmbeddingConfig } from '../knowledge/embeddings.js';
import { ensureKnowledgePgvectorStorage } from '../knowledge/pgvector.js';
import { runKnowledgePolicyTransaction } from '../knowledge/policy-transaction.js';
import {
  knowledgeChunkerOptionsFromSettings,
  knowledgeUnitsForMarkdown,
} from '../knowledge/units.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  canReadKnowledgeDocument,
  canWriteKnowledgeDocument,
  hasKnowledgeNamespacePermission,
  isKnowledgeAdmin,
  resolveKnowledgeNamespacePermission,
} from './knowledge-access.js';
import {
  KnowledgeDocumentOwnerOnlyEditError,
  KnowledgeDocumentVersionMismatchError,
} from './knowledge-errors.js';

export type KnowledgeDocumentParams = QueryParams<{
  namespace_id?: KnowledgeNamespaceID;
  namespace_slug?: string;
  path?: string;
  kind?: KnowledgeDocument['kind'];
  visibility?: KnowledgeDocument['visibility'];
  status?: KnowledgeDocument['status'];
  archived?: boolean;
  include_my_drafts?: boolean;
  includeMyDrafts?: boolean;
  include_other_user_drafts?: boolean;
  includeOtherUserDrafts?: boolean;
  include_content?: boolean;
  include_links?: boolean;
  include_indexing?: boolean;
  includeIndexing?: boolean;
  version?: string | number;
}> &
  AuthenticatedParams & {
    /** Server-derived only; MCP callers cannot provide service params. */
    knowledgeWriteAttribution?: KnowledgeWriteAttribution;
  };

type KnowledgeDocumentWriteData = (CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput) & {
  document_id?: string;
  uri?: string;
  namespace_slug?: string;
  first_line_is_title?: boolean;
  create_namespace?: boolean;
  namespace_display_name?: string | null;
  expected_version?: string | number;
};

function assistantAttribution(params?: KnowledgeDocumentParams) {
  const identity = params?.knowledgeWriteAttribution;
  return {
    updated_by_session_id: identity?.sessionId ?? null,
    updated_by_agentic_tool: identity?.agenticTool ?? null,
    updated_by_teammate_name: identity?.teammateName ?? null,
  };
}

type KnowledgeDocumentRef = {
  document_id?: string;
  documentId?: string;
  uri?: string;
  namespace_slug?: string;
  namespace?: string;
  path?: string;
  include_content?: boolean;
  include_links?: boolean;
  include_indexing?: boolean;
  includeIndexing?: boolean;
  version?: string | number;
};

type HydratedKnowledgeDocument = KnowledgeDocument & {
  document: KnowledgeDocument;
  current_version: KnowledgeDocumentVersion | null;
  content: string | null;
  first_line_is_title: boolean;
  links?: unknown[];
};

type HydrateOptions = Pick<
  KnowledgeDocumentRef,
  'include_content' | 'include_links' | 'include_indexing' | 'includeIndexing' | 'version'
>;

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
  private attribution: KnowledgeAttributionRepository;
  private semanticSettings: KnowledgeSemanticSettingsRepository;
  private versions: KnowledgeDocumentVersionRepository;
  private namespaces: KnowledgeNamespaceRepository;
  private graph: KnowledgeGraphRepository;

  constructor(
    private db: TenantScopeAwareDatabase,
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
    this.attribution = new KnowledgeAttributionRepository(db);
    this.semanticSettings = new KnowledgeSemanticSettingsRepository(db);
    this.versions = new KnowledgeDocumentVersionRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
    this.graph = new KnowledgeGraphRepository(db);
  }

  /**
   * Serialize document/unit writes with semantic policy mutations. PostgreSQL
   * requests normally arrive inside the tenant hook's transaction; direct
   * calls and SQLite use an explicit transaction so the aggregate lock, the
   * document version, and its derived units share one commit boundary.
   */
  private async runPolicyDependentWrite<T>(
    work: (service: KnowledgeDocumentsService) => Promise<T>
  ): Promise<T> {
    return runKnowledgePolicyTransaction(this.db, async (tx: TenantScopedDatabase) => {
      const service = new KnowledgeDocumentsService(
        tx as unknown as TenantScopeAwareDatabase,
        this.app
      );
      await service.semanticSettings.lockAggregateForUpdate(tx);
      return work(service);
    });
  }

  private isAdmin(user?: User): boolean {
    return isKnowledgeAdmin(user);
  }

  private async canRead(document: KnowledgeDocument, user?: User): Promise<boolean> {
    return canReadKnowledgeDocument(this.namespaces, document, user);
  }

  private async canEdit(document: KnowledgeDocument, user?: User): Promise<boolean> {
    return canWriteKnowledgeDocument(this.namespaces, document, user);
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
    const statusChanged = data.status !== undefined && data.status !== existing.status;
    if (!visibilityChanged && !editPolicyChanged && !statusChanged) return;
    if (!this.canManageDocument(existing, user)) {
      throw new Forbidden(
        'Only the owner or an admin can change knowledge document visibility, lifecycle status, or edit policy'
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

  private async assertCanWriteNamespace(
    namespaceId: KnowledgeNamespaceID,
    user?: User
  ): Promise<void> {
    const permission = await resolveKnowledgeNamespacePermission(
      this.namespaces,
      namespaceId,
      user
    );
    if (!hasKnowledgeNamespacePermission(permission, 'write')) {
      throw new Forbidden('You do not have permission to write to this knowledge namespace');
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
    if (prepared.icon_emoji !== undefined) {
      prepared.icon_emoji = normalizeKnowledgeDocumentIconEmoji(prepared.icon_emoji);
    }
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
    if (!isPostgresDatabaseHandle(this.db)) return false;
    const settings = await this.semanticSettings.find();
    return (
      isUsableOpenAIEmbeddingConfig(settings, settings.api_key_configured) &&
      (await ensureKnowledgePgvectorStorage(this.db)).available
    );
  }

  private async replaceSearchUnitsForContent(
    doc: KnowledgeDocument,
    content?: string | null
  ): Promise<void> {
    if (typeof content !== 'string' || !doc.current_version_id) return;
    const settings = await this.semanticSettings.findPolicy();
    const chunks = knowledgeUnitsForMarkdown(
      doc.path,
      content,
      knowledgeChunkerOptionsFromSettings(settings)
    );
    await this.repo.replaceUnitsForVersionInTransaction(this.db, doc.current_version_id, chunks, {
      embeddingConfigured: await this.isEmbeddingConfigured(),
    });
  }

  private wakeIndexer(): void {
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
    const wantsHydration = params?.include_content === true || params?.include_links === true;
    const rawVersion = wantsHydration ? await this.versionFor(document, params?.version) : null;
    const projected = await this.attribution.attachToDocumentsAndVersions(
      [document],
      rawVersion ? [rawVersion] : []
    );
    const attributedDocument = projected.documents[0];
    const version = projected.versions[0] ?? null;
    const withIndexing =
      params?.include_indexing === true || params?.includeIndexing === true
        ? ((await this.repo.attachIndexingStatus(attributedDocument)) as KnowledgeDocument)
        : attributedDocument;
    if (!wantsHydration) return withIndexing;
    return this.buildHydratedDocument(withIndexing, version, params);
  }

  private buildHydratedDocument(
    document: KnowledgeDocument,
    version: KnowledgeDocumentVersion | null,
    params?: HydrateOptions
  ): HydratedKnowledgeDocument {
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

  private async versionsForDocuments(
    documents: readonly KnowledgeDocument[],
    versionRef?: string | number
  ): Promise<Array<KnowledgeDocumentVersion | null>> {
    if (versionRef === undefined || versionRef === null || versionRef === '') {
      const versions = await this.versions.findByIds(
        documents.flatMap((document) =>
          document.current_version_id ? [document.current_version_id] : []
        )
      );
      const byId = new Map(versions.map((version) => [version.version_id, version]));
      return documents.map((document) =>
        document.current_version_id ? (byId.get(document.current_version_id) ?? null) : null
      );
    }
    return Promise.all(documents.map((document) => this.versionFor(document, versionRef)));
  }

  private async hydrateDocuments(
    documents: readonly KnowledgeDocument[],
    params: HydrateOptions
  ): Promise<HydratedKnowledgeDocument[]> {
    const rawVersions = await this.versionsForDocuments(documents, params.version);
    const projected = await this.attribution.attachToDocumentsAndVersions(
      documents,
      rawVersions.filter((version): version is KnowledgeDocumentVersion => version !== null)
    );
    const versionById = new Map(projected.versions.map((version) => [version.version_id, version]));
    const projectedDocuments =
      params.include_indexing === true || params.includeIndexing === true
        ? ((await this.repo.attachIndexingStatus(projected.documents)) as KnowledgeDocument[])
        : projected.documents;
    return projectedDocuments.map((document, index) => {
      const rawVersion = rawVersions[index];
      const version = rawVersion ? (versionById.get(rawVersion.version_id) ?? null) : null;
      return this.buildHydratedDocument(document, version, params);
    });
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
      throw new KnowledgeDocumentVersionMismatchError(
        expectedVersion,
        current?.version_number ?? 'none'
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
          status: query.status,
          archived: isAdmin ? query.archived : false,
          include_my_drafts: query.include_my_drafts ?? query.includeMyDrafts ?? true,
          include_other_user_drafts:
            query.include_other_user_drafts ?? query.includeOtherUserDrafts ?? false,
          draft_filter_user_id: user?.user_id as UserID | undefined,
        }
      : {
          include_my_drafts: true,
          include_other_user_drafts: false,
          draft_filter_user_id: user?.user_id as UserID | undefined,
        };
    const rows = await this.repo.findAll(filters);
    const readable: KnowledgeDocument[] = [];
    for (const doc of rows) {
      if (await this.canRead(doc, user)) readable.push(doc);
    }
    if (params?.query?.include_content !== true && params?.query?.include_links !== true) {
      const attributed = await this.attribution.attachToDocuments(readable);
      if (params?.query?.include_indexing === true || params?.query?.includeIndexing === true) {
        return this.repo.attachIndexingStatus(attributed) as Promise<KnowledgeDocument[]>;
      }
      return attributed;
    }
    return this.hydrateDocuments(readable, {
      include_content: params?.query?.include_content,
      include_links: params?.query?.include_links,
      include_indexing: params?.query?.include_indexing,
      includeIndexing: params?.query?.includeIndexing,
      version: params?.query?.version,
    });
  }

  async get(id: Id, params?: KnowledgeDocumentParams): Promise<KnowledgeDocument> {
    const doc = await this.repo.findById(String(id));
    if (!doc) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(doc);
    if (!(await this.canRead(doc, params?.user as User | undefined))) {
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
    if (!(await this.canRead(doc, params?.user as User | undefined))) {
      throw new Forbidden('You do not have permission to view this knowledge document');
    }
    return this.hydrateDocument(doc, data);
  }

  async putDocument(
    data: KnowledgeDocumentWriteData,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument> {
    const write = (service: KnowledgeDocumentsService) => service.writePutDocument(data, params);
    try {
      const result =
        typeof data.content_text === 'string'
          ? await this.runPolicyDependentWrite(write)
          : await write(this);
      if (typeof data.content_text === 'string') this.wakeIndexer();
      return result;
    } catch (error) {
      // `expected_version: 0` is a create-only precondition. Two callers can
      // both observe no document before one wins the unique namespace/path
      // insert. Translate only a confirmed collision on this target into the
      // same stable optimistic-concurrency signal used by ordinary updates.
      if (String(data.expected_version) === '0' && isDatabaseUniqueConstraintError(error)) {
        const expectedVersion = data.expected_version as string | number;
        const concurrent = await this.resolveDocumentRef({
          document_id: data.document_id,
          uri: data.uri,
          namespace_slug: data.namespace_slug,
          path: data.path,
        });
        if (concurrent) {
          // The retrying caller will re-read through normal document
          // authorization. Do not disclose the concurrent document's version
          // from this lower-level identity-collision check.
          throw new KnowledgeDocumentVersionMismatchError(expectedVersion, 'unknown');
        }
      }
      throw error;
    }
  }

  private async writePutDocument(
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
      if (!(await this.canEdit(existing, params?.user as User | undefined))) {
        if (existing.edit_policy === 'owner') {
          throw new KnowledgeDocumentOwnerOnlyEditError();
        }
        throw new Forbidden('You do not have permission to update this knowledge document');
      }
      await this.assertExpectedVersion(existing, data.expected_version);
      const persisted = await this.repo.update(
        existing.document_id,
        this.prepareWriteData(
          {
            ...data,
            created_by: existing.created_by,
            namespace_slug: undefined,
            path: path ?? existing.path,
            updated_by: this.attributionUserId(params, data.updated_by),
            ...assistantAttribution(params),
          },
          existing
        )
      );
      await this.replaceSearchUnitsForContent(persisted, data.content_text);
      await this.syncGraphReferences(persisted, data.content_text, userId);
      const [result] = await this.attribution.attachToDocuments([persisted]);
      this.emitDocumentEvent('patched', result, params);
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
        owner_user_id: userId,
      });
      if (userId) {
        await this.namespaces.upsertNamespaceAclEntry({
          namespace_id: namespace.namespace_id,
          subject_type: 'user',
          subject_id: userId,
          permission: 'own',
          created_by: userId,
        });
      }
    }
    if (!namespace) throw new NotFound(`Knowledge namespace not found: ${namespaceSlug}`);
    if (namespace.archived) throw new NotFound(`Knowledge namespace not found: ${namespaceSlug}`);
    await this.assertCanWriteNamespace(namespace.namespace_id, params?.user as User | undefined);

    const persisted = await this.repo.create(
      this.prepareWriteData({
        ...data,
        namespace_id: namespace.namespace_id,
        namespace_slug: namespace.slug,
        path,
        created_by: userId,
        updated_by: this.attributionUserId(params, data.updated_by),
        ...assistantAttribution(params),
      })
    );
    await this.replaceSearchUnitsForContent(persisted, data.content_text);
    await this.syncGraphReferences(persisted, data.content_text, userId);
    const [result] = await this.attribution.attachToDocuments([persisted]);
    this.emitDocumentEvent('created', result, params);
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
        ...assistantAttribution(params),
      },
      null
    );
    const namespace = prepared.namespace_id
      ? await this.namespaces.findById(prepared.namespace_id)
      : prepared.namespace_slug
        ? await this.namespaces.findBySlug(prepared.namespace_slug)
        : null;
    if (!namespace || namespace.archived) throw new NotFound('Knowledge namespace not found');
    await this.assertCanWriteNamespace(namespace.namespace_id, params?.user as User | undefined);
    const persisted = await this.repo.create({
      ...prepared,
      namespace_id: namespace.namespace_id,
      namespace_slug: namespace.slug,
    });
    await this.replaceSearchUnitsForContent(persisted, data.content_text);
    await this.syncGraphReferences(persisted, data.content_text, userId);
    return (await this.attribution.attachToDocuments([persisted]))[0];
  }

  async create(
    data:
      | CreateKnowledgeDocumentInput
      | UpdateKnowledgeDocumentInput
      | Array<CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput>,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument | KnowledgeDocument[]> {
    const write = async (service: KnowledgeDocumentsService) => {
      if (!Array.isArray(data)) return service.createOne(data, params);
      const created: KnowledgeDocument[] = [];
      for (const item of data) created.push(await service.createOne(item, params));
      return created;
    };
    const materializesUnits =
      (Array.isArray(data) && data.some((item) => typeof item.content_text === 'string')) ||
      (!Array.isArray(data) && typeof data.content_text === 'string');
    const result = materializesUnits
      ? await this.runPolicyDependentWrite(write)
      : await write(this);
    if (materializesUnits) this.wakeIndexer();
    return result;
  }

  async patch(
    id: NullableId,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    const write = (service: KnowledgeDocumentsService) => service.writePatch(id, data, params);
    const result =
      typeof data.content_text === 'string'
        ? await this.runPolicyDependentWrite(write)
        : await write(this);
    if (typeof data.content_text === 'string') this.wakeIndexer();
    return result;
  }

  private async writePatch(
    id: NullableId,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    if (id === null) throw new Error('Bulk patch is not supported for knowledge documents');
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(existing);
    this.assertCanChangeGovernance(existing, data, params?.user as User | undefined);
    if (!(await this.canEdit(existing, params?.user as User | undefined))) {
      throw new Forbidden('You do not have permission to update this knowledge document');
    }
    const persisted = await this.repo.update(String(id), {
      ...this.prepareWriteData(data as KnowledgeDocumentWriteData, existing),
      created_by: existing.created_by,
      updated_by: this.attributionUserId(params, data.updated_by),
      ...assistantAttribution(params),
    });
    await this.replaceSearchUnitsForContent(
      persisted,
      (data as KnowledgeDocumentWriteData).content_text
    );
    await this.syncGraphReferences(
      persisted,
      (data as KnowledgeDocumentWriteData).content_text,
      this.attributionUserId(params, data.updated_by)
    );
    return (await this.attribution.attachToDocuments([persisted]))[0];
  }

  async update(
    id: Id,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    const write = (service: KnowledgeDocumentsService) => service.writeUpdate(id, data, params);
    const result =
      typeof data.content_text === 'string'
        ? await this.runPolicyDependentWrite(write)
        : await write(this);
    if (typeof data.content_text === 'string') this.wakeIndexer();
    return result;
  }

  private async writeUpdate(
    id: Id,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(existing);
    this.assertCanChangeGovernance(existing, data, params?.user as User | undefined);
    if (!(await this.canEdit(existing, params?.user as User | undefined))) {
      throw new Forbidden('You do not have permission to update this knowledge document');
    }
    const persisted = await this.repo.update(String(id), {
      ...this.prepareWriteData(data as KnowledgeDocumentWriteData, existing),
      created_by: existing.created_by,
      updated_by: this.attributionUserId(params, data.updated_by),
      ...assistantAttribution(params),
    });
    await this.replaceSearchUnitsForContent(
      persisted,
      (data as KnowledgeDocumentWriteData).content_text
    );
    await this.syncGraphReferences(
      persisted,
      (data as KnowledgeDocumentWriteData).content_text,
      this.attributionUserId(params, data.updated_by)
    );
    return (await this.attribution.attachToDocuments([persisted]))[0];
  }

  async remove(id: NullableId, params?: KnowledgeDocumentParams): Promise<KnowledgeDocument> {
    if (id === null) throw new Error('Bulk remove is not supported for knowledge documents');
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    await this.assertActiveDocument(existing);
    await this.assertCanWriteNamespace(existing.namespace_id, params?.user as User | undefined);
    if (!this.canManageDocument(existing, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to delete this knowledge document');
    }
    await this.repo.delete(String(id));
    return (await this.attribution.attachToDocuments([existing]))[0];
  }

  private emitDocumentEvent(
    event: 'created' | 'patched',
    document: KnowledgeDocument,
    params?: KnowledgeDocumentParams
  ): void {
    if (!this.app) return;
    emitServiceEvent(this.app, {
      path: 'kb/documents',
      event,
      data: document,
      params,
      id: document.document_id,
    });
  }
}

export function createKnowledgeDocumentsService(
  db: TenantScopeAwareDatabase,
  app?: Application
): KnowledgeDocumentsService {
  return new KnowledgeDocumentsService(db, app);
}
