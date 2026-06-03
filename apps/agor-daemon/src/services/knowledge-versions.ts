/**
 * Knowledge document versions service
 */

import { PAGINATION } from '@agor/core/config';
import {
  type Database,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  hasMinimumRole,
  type KnowledgeDocument,
  type KnowledgeDocumentVersion,
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
}> &
  AuthenticatedParams;

export class KnowledgeVersionsService extends DrizzleService<
  KnowledgeDocumentVersion,
  Partial<KnowledgeDocumentVersion>,
  KnowledgeVersionParams
> {
  private versions: KnowledgeDocumentVersionRepository;
  private documents: KnowledgeDocumentRepository;

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
  }

  private parseUri(uri?: string): { namespace_slug: string; path: string } | null {
    if (!uri?.startsWith('agor://kb/')) return null;
    const rest = uri.slice('agor://kb/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    return { namespace_slug: rest.slice(0, slash), path: rest.slice(slash + 1) };
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
      const parsed = this.parseUri(query.uri);
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
    if (!this.canRead(document, params?.user as User | undefined)) {
      throw new Forbidden('You do not have permission to view this knowledge document history');
    }

    const versions = await this.versions.findAll({
      document_id: documentId as KnowledgeDocumentVersion['document_id'],
    });
    if (query.include_content === true) return versions;
    return versions.map((version) => ({ ...version, content_text: null, content_blob: null }));
  }
}

export function createKnowledgeVersionsService(db: Database): KnowledgeVersionsService {
  return new KnowledgeVersionsService(db);
}
