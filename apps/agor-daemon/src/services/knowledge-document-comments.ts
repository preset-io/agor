/**
 * Knowledge document comments service
 *
 * Threaded discussion on Knowledge documents. Every method resolves the target
 * document first and authorizes against its namespace ACL — reading needs
 * document read access, writing needs namespace `write`.
 */

import { PAGINATION } from '@agor/core/config';
import {
  KnowledgeDocumentCommentsRepository,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Id,
  KnowledgeDocument,
  KnowledgeDocumentComment,
  NullableId,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  canCommentOnKnowledgeDocument,
  canReadKnowledgeDocument,
  isKnowledgeAdmin,
} from './knowledge-access.js';

export const KNOWLEDGE_DOCUMENT_COMMENTS_PATH = 'kb/document-comments';

export type KnowledgeDocumentCommentParams = QueryParams<{
  document_id?: string;
  resolved?: boolean;
  created_by?: string;
}> &
  AuthenticatedParams;

type KnowledgeDocumentCommentWriteData = Partial<KnowledgeDocumentComment> & {
  document_id?: string;
  parent_comment_id?: string;
};

export class KnowledgeDocumentCommentsService extends DrizzleService<
  KnowledgeDocumentComment,
  Partial<KnowledgeDocumentComment>,
  KnowledgeDocumentCommentParams
> {
  private comments: KnowledgeDocumentCommentsRepository;
  private documents: KnowledgeDocumentRepository;
  private namespaces: KnowledgeNamespaceRepository;
  private app?: Application;

  constructor(db: TenantScopeAwareDatabase, app?: Application) {
    const comments = new KnowledgeDocumentCommentsRepository(db);
    super(comments, {
      id: 'comment_id',
      resourceType: 'KnowledgeDocumentComment',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.comments = comments;
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
    this.app = app;
  }

  private async loadDocument(documentId: string): Promise<KnowledgeDocument> {
    const document = await this.documents.findById(documentId);
    if (!document || document.archived) {
      throw new NotFound(`Knowledge document not found: ${documentId}`);
    }
    const namespace = await this.namespaces.findById(document.namespace_id);
    if (!namespace || namespace.archived) {
      throw new NotFound(`Knowledge document not found: ${documentId}`);
    }
    return document;
  }

  private async assertCanRead(documentId: string, user?: User): Promise<KnowledgeDocument> {
    const document = await this.loadDocument(documentId);
    if (!(await canReadKnowledgeDocument(this.namespaces, document, user))) {
      throw new Forbidden('You do not have permission to view this knowledge document');
    }
    return document;
  }

  private async assertCanComment(documentId: string, user?: User): Promise<KnowledgeDocument> {
    const document = await this.loadDocument(documentId);
    if (!(await canCommentOnKnowledgeDocument(this.namespaces, document, user))) {
      throw new Forbidden('You need write access to this Knowledge space to comment');
    }
    return document;
  }

  private async loadComment(id: Id): Promise<KnowledgeDocumentComment> {
    const comment = await this.comments.findById(String(id));
    if (!comment) {
      throw new NotFound(`Knowledge document comment not found: ${id}`);
    }
    return comment;
  }

  /** Editing and deleting stay with the author; admins can moderate. */
  private assertIsAuthor(comment: KnowledgeDocumentComment, user?: User): void {
    if (isKnowledgeAdmin(user)) return;
    if (comment.created_by !== user?.user_id) {
      throw new Forbidden('Only the comment author can change this comment');
    }
  }

  async find(params?: KnowledgeDocumentCommentParams) {
    const query = params?.query ?? {};
    const documentId = query.document_id;
    if (!documentId) {
      throw new BadRequest('document_id is required to list knowledge document comments');
    }
    await this.assertCanRead(documentId, params?.user as User | undefined);

    const filters = {
      document_id: documentId,
      resolved: query.resolved,
      created_by: query.created_by,
    };
    const $limit = query.$limit ?? PAGINATION.DEFAULT_LIMIT;
    const $skip = query.$skip ?? 0;
    const [total, data] = await Promise.all([
      this.comments.count(filters),
      this.comments.findAll(filters, { limit: $limit, offset: $skip }),
    ]);
    return { total, limit: $limit, skip: $skip, data };
  }

  async get(id: Id, params?: KnowledgeDocumentCommentParams): Promise<KnowledgeDocumentComment> {
    const comment = await this.loadComment(id);
    await this.assertCanRead(comment.document_id, params?.user as User | undefined);
    return comment;
  }

  /** A `parent_comment_id` turns this into a reply on that thread. */
  async create(
    data: KnowledgeDocumentCommentWriteData,
    params?: KnowledgeDocumentCommentParams
  ): Promise<KnowledgeDocumentComment> {
    const user = params?.user as User | undefined;
    if (!user?.user_id) {
      throw new Forbidden('You must be signed in to comment');
    }

    if (data.parent_comment_id) {
      const parent = await this.loadComment(data.parent_comment_id);
      await this.assertCanComment(parent.document_id, user);
      const reply = await this.comments.createReply(parent.comment_id, {
        created_by: user.user_id as UserID,
        content: data.content,
        mentions: data.mentions,
      });
      this.emitCommentEvent('created', reply, params);
      return reply;
    }

    if (!data.document_id) {
      throw new BadRequest('document_id is required to create a knowledge document comment');
    }
    const document = await this.assertCanComment(data.document_id, user);

    const created = await this.comments.create({
      document_id: document.document_id,
      created_by: user.user_id as UserID,
      content: data.content,
      anchor_slug: data.anchor_slug ?? null,
      anchor_label: data.anchor_label ?? null,
      mentions: data.mentions,
    });
    this.emitCommentEvent('created', created, params);
    return created;
  }

  /**
   * Resolving is a collaborative action any writer may take; changing the text
   * stays with the author.
   */
  async patch(
    id: NullableId,
    data: Partial<KnowledgeDocumentComment>,
    params?: KnowledgeDocumentCommentParams
  ): Promise<KnowledgeDocumentComment> {
    if (id === null) {
      throw new BadRequest('Bulk patching knowledge document comments is not supported');
    }
    const user = params?.user as User | undefined;
    const comment = await this.loadComment(id);
    await this.assertCanComment(comment.document_id, user);
    if (data.content !== undefined) {
      this.assertIsAuthor(comment, user);
    }

    const patched = await this.comments.update(comment.comment_id, {
      ...(data.content !== undefined ? { content: data.content } : {}),
      ...(data.resolved !== undefined ? { resolved: data.resolved } : {}),
    });
    this.emitCommentEvent('patched', patched, params);
    return patched;
  }

  async update(): Promise<never> {
    throw new BadRequest('Use patch to update a knowledge document comment');
  }

  async remove(
    id: NullableId,
    params?: KnowledgeDocumentCommentParams
  ): Promise<KnowledgeDocumentComment> {
    if (id === null) {
      throw new BadRequest('Bulk removing knowledge document comments is not supported');
    }
    const user = params?.user as User | undefined;
    const comment = await this.loadComment(id);
    await this.assertCanComment(comment.document_id, user);
    this.assertIsAuthor(comment, user);

    await this.comments.delete(comment.comment_id);
    this.emitCommentEvent('removed', comment, params);
    return comment;
  }

  /** Custom method: add or remove the caller's emoji reaction. */
  async toggleReaction(
    data: { comment_id?: string; emoji?: string },
    params?: KnowledgeDocumentCommentParams
  ): Promise<KnowledgeDocumentComment> {
    const user = params?.user as User | undefined;
    if (!user?.user_id) {
      throw new Forbidden('You must be signed in to react');
    }
    if (!data.comment_id || !data.emoji) {
      throw new BadRequest('comment_id and emoji are required');
    }

    const comment = await this.loadComment(data.comment_id);
    await this.assertCanComment(comment.document_id, user);

    const updated = await this.comments.toggleReaction(
      comment.comment_id,
      user.user_id,
      data.emoji
    );
    this.emitCommentEvent('patched', updated, params);
    return updated;
  }

  private emitCommentEvent(
    event: 'created' | 'patched' | 'removed',
    comment: KnowledgeDocumentComment,
    params?: KnowledgeDocumentCommentParams
  ): void {
    if (!this.app) return;
    emitServiceEvent(this.app, {
      path: KNOWLEDGE_DOCUMENT_COMMENTS_PATH,
      event,
      data: comment,
      params,
      id: comment.comment_id,
    });
  }
}

export function createKnowledgeDocumentCommentsService(
  db: TenantScopeAwareDatabase,
  app?: Application
): KnowledgeDocumentCommentsService {
  return new KnowledgeDocumentCommentsService(db, app);
}
