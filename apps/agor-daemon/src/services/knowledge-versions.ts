/**
 * Knowledge document versions service
 */

import { PAGINATION } from '@agor/core/config';
import {
  type Database,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  hasMinimumRole,
  type KnowledgeDocument,
  type KnowledgeDocumentVersion,
  parseKnowledgeUri,
  type QueryParams,
  ROLES,
  type User,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type KnowledgeVersionParams = QueryParams<{
  document_id?: string;
  documentId?: string;
  uri?: string;
  namespace_slug?: string;
  namespace?: string;
  path?: string;
  include_content?: boolean;
  limit?: number;
}> &
  AuthenticatedParams;

export class KnowledgeVersionsService extends DrizzleService<
  KnowledgeDocumentVersion,
  Partial<KnowledgeDocumentVersion>,
  KnowledgeVersionParams
> {
  private versions: KnowledgeDocumentVersionRepository;
  private documents: KnowledgeDocumentRepository;
  private namespaces: KnowledgeNamespaceRepository;

  constructor(db: Database) {
    const versions = new KnowledgeDocumentVersionRepository(db);
    super(versions, {
      id: 'version_id',
      resourceType: 'KnowledgeDocumentVersion',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.versions = versions;
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
  }

  private canRead(document: KnowledgeDocument, user?: User): boolean {
    return (
      document.visibility === 'public' ||
      hasMinimumRole(user?.role, ROLES.ADMIN) ||
      Boolean(user?.user_id && document.created_by === user.user_id)
    );
  }

  async find(params?: KnowledgeVersionParams) {
    const query = params?.query ?? {};
    let documentId = query.document_id ?? query.documentId;
    if (!documentId) {
      const parsed = parseKnowledgeUri(query.uri);
      const namespaceSlug = query.namespace_slug ?? query.namespace ?? parsed?.namespace_slug;
      const path = query.path ?? parsed?.path;
      if (namespaceSlug && path) {
        const docs = await this.documents.findAll({ namespace_slug: namespaceSlug, path });
        documentId = docs[0]?.document_id;
      }
    }
    if (!documentId) return [];

    const document = await this.documents.findById(String(documentId));
    if (!document) return [];
    if (document.archived) return [];
    const namespace = await this.namespaces.findById(document.namespace_id);
    if (!namespace || namespace.archived) return [];
    if (!this.canRead(document, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to view this knowledge document history');
    }

    const versions = await this.versions.findAll({
      document_id: documentId as KnowledgeDocumentVersion['document_id'],
    });
    const rawLimit = (query as { $limit?: unknown }).$limit ?? query.limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : undefined;
    const capped = limit ? versions.slice(0, Math.min(Math.max(limit, 1), 100)) : versions;
    if (query.include_content === true) return capped;
    return capped.map((version) => ({ ...version, content_text: null, content_blob: null }));
  }

  async get(): Promise<never> {
    throw new BadRequest('Knowledge document versions are only available through find()');
  }

  async create(): Promise<never> {
    throw new BadRequest('Knowledge document versions are immutable');
  }

  async patch(): Promise<never> {
    throw new BadRequest('Knowledge document versions are immutable');
  }

  async update(): Promise<never> {
    throw new BadRequest('Knowledge document versions are immutable');
  }

  async remove(): Promise<never> {
    throw new BadRequest('Knowledge document versions are immutable');
  }
}

export function createKnowledgeVersionsService(db: Database): KnowledgeVersionsService {
  return new KnowledgeVersionsService(db);
}
