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
  NullableId,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type KnowledgeDocumentParams = QueryParams<{
  namespace_id?: string;
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

function parseKnowledgeUri(uri?: string | null): { namespace_slug: string; path: string } | null {
  if (!uri?.startsWith('agor://kb/')) return null;
  const rest = uri.slice('agor://kb/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { namespace_slug: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

function normalizeFirstLineTitle(content: string, fallback: string): string {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return fallback;
  return (
    first
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/[*_`~]/g, '')
      .trim() || fallback
  );
}

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

  private canWrite(document: KnowledgeDocument, user?: User): boolean {
    return (
      this.isAdmin(user) ||
      document.edit_policy === 'public' ||
      Boolean(user?.user_id && document.created_by === user.user_id)
    );
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
      prepared.title = normalizeFirstLineTitle(
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
    if (!namespace) return null;
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
    const rows = await this.repo.findAll(
      params?.query as Parameters<KnowledgeDocumentRepository['findAll']>[0]
    );
    const readable = rows.filter((doc) => this.canRead(doc, params?.user as User | undefined));
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
    if (!this.canRead(doc, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to view this knowledge document');
    }
    return this.hydrateDocument(doc, data);
  }

  async putDocument(
    data: KnowledgeDocumentWriteData,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument> {
    const userId = params?.user?.user_id as UserID | undefined;

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
      if (!this.canWrite(existing, params?.user as User | undefined)) {
        throw new Forbidden('You do not have permission to update this knowledge document');
      }
      await this.assertExpectedVersion(existing, data.expected_version);
      const result = await this.repo.update(
        existing.document_id,
        this.prepareWriteData(
          {
            ...data,
            namespace_slug: undefined,
            path: path ?? existing.path,
            updated_by: data.updated_by ?? userId ?? null,
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
        created_by: userId ?? null,
      });
    }
    if (!namespace) throw new NotFound(`Knowledge namespace not found: ${namespaceSlug}`);

    const result = await this.repo.create(
      this.prepareWriteData({
        ...data,
        namespace_id: namespace.namespace_id,
        namespace_slug: namespace.slug,
        path,
        created_by: data.created_by ?? userId ?? null,
        updated_by: data.updated_by ?? userId ?? null,
      })
    );
    this.emit?.('created', result, params);
    return result;
  }

  private async createOne(
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ): Promise<KnowledgeDocument> {
    const userId = params?.user?.user_id as UserID | undefined;
    const prepared = this.prepareWriteData(
      {
        ...data,
        created_by: data.created_by ?? userId ?? null,
        updated_by: data.updated_by ?? userId ?? null,
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
    const userId = params?.user?.user_id as UserID | undefined;
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    if (!this.canWrite(existing, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to update this knowledge document');
    }
    const result = await this.repo.update(String(id), {
      ...this.prepareWriteData(data as KnowledgeDocumentWriteData, existing),
      updated_by: data.updated_by ?? userId ?? null,
    });
    this.emit?.('patched', result, params);
    return result;
  }

  async update(
    id: Id,
    data: CreateKnowledgeDocumentInput | UpdateKnowledgeDocumentInput,
    params?: KnowledgeDocumentParams
  ) {
    const userId = params?.user?.user_id as UserID | undefined;
    const existing = await this.repo.findById(String(id));
    if (!existing) throw new NotFound(`Knowledge document not found: ${id}`);
    if (!this.canWrite(existing, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to update this knowledge document');
    }
    const result = await this.repo.update(String(id), {
      ...this.prepareWriteData(data as KnowledgeDocumentWriteData, existing),
      updated_by: data.updated_by ?? userId ?? null,
    });
    this.emit?.('updated', result, params);
    return result;
  }
}

export function createKnowledgeDocumentsService(db: Database): KnowledgeDocumentsService {
  return new KnowledgeDocumentsService(db);
}
