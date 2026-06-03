/**
 * Knowledge graph service
 */

import {
  type Database,
  KnowledgeDocumentRepository,
  type KnowledgeGraphLinkInput,
  type KnowledgeGraphNeighborsQuery,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  type KnowledgeNodeRef,
} from '@agor/core/db';
import { Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeDocument,
  KnowledgeGraphNode,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, parseKnowledgeUri, ROLES } from '@agor/core/types';

export type KnowledgeGraphParams = QueryParams<KnowledgeGraphNeighborsQuery> & AuthenticatedParams;

const KB_DOCUMENT_URI_PREFIX = 'agor://kb/document/';
const KB_UNIT_URI_PREFIX = 'agor://kb/unit/';

export class KnowledgeGraphService {
  private graph: KnowledgeGraphRepository;
  private documents: KnowledgeDocumentRepository;
  private namespaces: KnowledgeNamespaceRepository;

  constructor(db: Database) {
    this.graph = new KnowledgeGraphRepository(db);
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
  }

  async create(data: KnowledgeGraphLinkInput, params?: KnowledgeGraphParams) {
    return this.link(data, params);
  }

  async find(params?: KnowledgeGraphParams) {
    return this.neighbors((params?.query ?? {}) as KnowledgeGraphNeighborsQuery, params);
  }

  private isAdmin(user?: User): boolean {
    return hasMinimumRole(user?.role, ROLES.ADMIN);
  }

  private canRead(document: KnowledgeDocument, user?: User): boolean {
    return (
      !document.archived &&
      (document.visibility === 'public' ||
        this.isAdmin(user) ||
        Boolean(user?.user_id && document.created_by === user.user_id))
    );
  }

  private canWrite(document: KnowledgeDocument, user?: User): boolean {
    return (
      !document.archived &&
      (this.isAdmin(user) ||
        Boolean(user?.user_id && document.created_by === user.user_id) ||
        (document.visibility === 'public' && document.edit_policy === 'public'))
    );
  }

  private async activeDocument(
    document: KnowledgeDocument | null
  ): Promise<KnowledgeDocument | null> {
    if (!document || document.archived) return null;
    const namespace = await this.namespaces.findById(document.namespace_id);
    if (!namespace || namespace.archived) return null;
    return document;
  }

  private documentIdFromRef(ref: KnowledgeNodeRef): string | undefined {
    const documentId = ref.document_id ?? ref.documentId;
    if (documentId) return documentId;
    if (ref.uri?.startsWith(KB_DOCUMENT_URI_PREFIX)) {
      return ref.uri.slice(KB_DOCUMENT_URI_PREFIX.length);
    }
    return undefined;
  }

  private documentIdFromNode(node: KnowledgeGraphNode): string | undefined {
    if (node.document_id) return node.document_id;
    if (node.uri.startsWith(KB_DOCUMENT_URI_PREFIX)) {
      return node.uri.slice(KB_DOCUMENT_URI_PREFIX.length);
    }
    return undefined;
  }

  private unitIdFromRef(ref: KnowledgeNodeRef): string | undefined {
    const unitId = ref.unit_id ?? ref.unitId;
    if (unitId) return unitId;
    if (ref.uri?.startsWith(KB_UNIT_URI_PREFIX)) return ref.uri.slice(KB_UNIT_URI_PREFIX.length);
    return undefined;
  }

  private unitIdFromNode(node: KnowledgeGraphNode): string | undefined {
    if (node.unit_id) return node.unit_id;
    if (node.uri.startsWith(KB_UNIT_URI_PREFIX)) return node.uri.slice(KB_UNIT_URI_PREFIX.length);
    return undefined;
  }

  private isDocumentRef(ref: KnowledgeNodeRef): boolean {
    return Boolean(
      ref.document_id ??
        ref.documentId ??
        this.documentIdFromRef(ref) ??
        this.unitIdFromRef(ref) ??
        ref.namespace ??
        ref.path ??
        parseKnowledgeUri(ref.uri)
    );
  }

  private isDocumentNode(node: KnowledgeGraphNode): boolean {
    return Boolean(
      node.node_type === 'document' ||
        node.node_type === 'document_unit' ||
        node.document_id ||
        this.documentIdFromNode(node) ||
        this.unitIdFromNode(node) ||
        parseKnowledgeUri(node.uri)
    );
  }

  private async documentForRef(ref: KnowledgeNodeRef): Promise<KnowledgeDocument | null> {
    const documentId = this.documentIdFromRef(ref);
    if (documentId) return this.activeDocument(await this.documents.findById(documentId));

    const unitId = this.unitIdFromRef(ref);
    if (unitId) return this.activeDocument(await this.documents.findByUnitId(unitId));

    const parsed = parseKnowledgeUri(ref.uri);
    const namespaceSlug = ref.namespace ?? parsed?.namespace_slug;
    const path = ref.path ?? parsed?.path;
    if (!namespaceSlug || !path) return null;

    const docs = await this.documents.findAll({ namespace_slug: namespaceSlug, path });
    return this.activeDocument(docs[0] ?? null);
  }

  private async assertCanLinkRef(ref: KnowledgeNodeRef, user?: User): Promise<void> {
    const node = await this.graph.findNode(ref);
    const document = node ? await this.documentForNode(node) : await this.documentForRef(ref);
    if (!document && (node ? this.isDocumentNode(node) : this.isDocumentRef(ref))) {
      throw new NotFound('Knowledge document not found');
    }
    if (!document) return;
    if (!this.canWrite(document, user)) {
      throw new Forbidden('You do not have permission to link this knowledge document');
    }
  }

  private async documentForNode(node: KnowledgeGraphNode): Promise<KnowledgeDocument | null> {
    const documentId = this.documentIdFromNode(node);
    if (documentId) {
      return this.activeDocument(await this.documents.findById(documentId));
    }
    const unitId = this.unitIdFromNode(node);
    if (unitId) return this.activeDocument(await this.documents.findByUnitId(unitId));
    const parsed = parseKnowledgeUri(node.uri);
    if (!parsed) return null;
    const docs = await this.documents.findAll({
      namespace_slug: parsed.namespace_slug,
      path: parsed.path,
    });
    return this.activeDocument(docs[0] ?? null);
  }

  private async canReadNode(node: KnowledgeGraphNode, user?: User): Promise<boolean> {
    const document = await this.documentForNode(node);
    if (!document && this.isDocumentNode(node)) return false;
    return document ? this.canRead(document, user) : true;
  }

  private attributionUserId(params?: KnowledgeGraphParams, requestedUserId?: UserID | null) {
    const user = params?.user as User | undefined;
    if (this.isAdmin(user) && requestedUserId) return requestedUserId;
    return (user?.user_id as UserID | undefined) ?? null;
  }

  async link(data: KnowledgeGraphLinkInput, params?: KnowledgeGraphParams) {
    const user = params?.user as User | undefined;
    await this.assertCanLinkRef(data.source, user);
    await this.assertCanLinkRef(data.target, user);
    return this.graph.link({
      ...data,
      created_by: this.attributionUserId(params, data.created_by),
    });
  }

  async neighbors(data: KnowledgeGraphNeighborsQuery, params?: KnowledgeGraphParams) {
    const user = params?.user as User | undefined;
    const result = await this.graph.neighbors(data);
    if (!(await this.canReadNode(result.center, user))) {
      throw new NotFound('Knowledge graph node not found');
    }

    const readableNodeIds = new Set<string>([result.center.node_id]);
    const readableNodes = [];
    for (const node of result.nodes) {
      if (await this.canReadNode(node, user)) {
        readableNodeIds.add(node.node_id);
        readableNodes.push(node);
      }
    }

    return {
      center: result.center,
      nodes: readableNodes,
      edges: result.edges.filter(
        (edge) =>
          readableNodeIds.has(edge.source_node_id) && readableNodeIds.has(edge.target_node_id)
      ),
    };
  }
}

export function createKnowledgeGraphService(db: Database): KnowledgeGraphService {
  return new KnowledgeGraphService(db);
}
