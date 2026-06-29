/**
 * Knowledge graph service
 */

import {
  KnowledgeDocumentRepository,
  type KnowledgeGraphLinkInput,
  type KnowledgeGraphNeighborsQuery,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  type KnowledgeNodeRef,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  KnowledgeDocument,
  KnowledgeGraphDocNode,
  KnowledgeGraphEdgeType,
  KnowledgeGraphNode,
  KnowledgeNamespaceGraph,
  QueryParams,
  User,
  UserID,
} from '@agor/core/types';
import {
  KNOWLEDGE_DOCUMENT_URI_PREFIX,
  KNOWLEDGE_UNIT_URI_PREFIX,
  parseKnowledgeUri,
} from '@agor/core/types';
import {
  canReadKnowledgeDocument,
  canWriteKnowledgeDocument,
  hasKnowledgeNamespacePermission,
  isKnowledgeAdmin,
  resolveKnowledgeNamespacePermission,
} from './knowledge-access.js';

/** Query for the namespace-wide graph view (whole-namespace document graph). */
export interface KnowledgeNamespaceGraphRequest {
  namespace?: string;
  namespace_id?: string;
  edge_types?: KnowledgeGraphEdgeType[];
  include_my_drafts?: boolean;
  includeMyDrafts?: boolean;
  include_other_user_drafts?: boolean;
  includeOtherUserDrafts?: boolean;
}

export type KnowledgeGraphParams = QueryParams<
  KnowledgeGraphNeighborsQuery & KnowledgeNamespaceGraphRequest
> &
  AuthenticatedParams;

export class KnowledgeGraphService {
  private graph: KnowledgeGraphRepository;
  private documents: KnowledgeDocumentRepository;
  private namespaces: KnowledgeNamespaceRepository;

  constructor(db: TenantScopeAwareDatabase) {
    this.graph = new KnowledgeGraphRepository(db);
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
  }

  async create(data: KnowledgeGraphLinkInput, params?: KnowledgeGraphParams) {
    return this.link(data, params);
  }

  async find(params?: KnowledgeGraphParams) {
    const query = (params?.query ?? {}) as KnowledgeGraphNeighborsQuery &
      KnowledgeNamespaceGraphRequest;
    // Whole-namespace graph view when no center node is given.
    if (!query.node && (query.namespace || query.namespace_id)) {
      return this.namespaceGraph(query, params);
    }
    return this.neighbors(query, params);
  }

  /**
   * Build the whole-namespace document graph: every readable, non-archived
   * document in the namespace as a node, plus the doc-to-doc edges between
   * them. Edges touching a document the caller cannot read are dropped so the
   * graph never leaks private document ids.
   */
  async namespaceGraph(
    request: KnowledgeNamespaceGraphRequest,
    params?: KnowledgeGraphParams
  ): Promise<KnowledgeNamespaceGraph> {
    const user = params?.user as User | undefined;
    const namespace = request.namespace_id
      ? await this.namespaces.findById(request.namespace_id)
      : request.namespace
        ? await this.namespaces.findBySlug(request.namespace)
        : null;
    if (!namespace || namespace.archived) {
      return { namespace_id: null, nodes: [], edges: [] };
    }

    const namespacePermission = await this.namespacePermission(namespace.namespace_id, user);
    if (!hasKnowledgeNamespacePermission(namespacePermission, 'read')) {
      return { namespace_id: null, nodes: [], edges: [] };
    }

    const docs = await this.documents.findAll({
      namespace_id: namespace.namespace_id,
      include_my_drafts: request.include_my_drafts ?? request.includeMyDrafts ?? true,
      include_other_user_drafts:
        request.include_other_user_drafts ?? request.includeOtherUserDrafts ?? false,
      draft_filter_user_id: user?.user_id as UserID | undefined,
    });
    const readable: KnowledgeDocument[] = [];
    for (const doc of docs) {
      if (await this.canRead(doc, user)) readable.push(doc);
    }
    const readableIds = new Set<string>(readable.map((doc) => doc.document_id));

    const nodes: KnowledgeGraphDocNode[] = readable.map((doc) => ({
      document_id: doc.document_id,
      title: doc.title,
      icon_emoji: doc.icon_emoji ?? null,
      path: doc.path,
      uri: doc.uri,
      kind: doc.kind,
      visibility: doc.visibility,
      status: doc.status,
    }));

    const rawEdges = await this.graph.documentEdgesForNamespace({
      namespace_id: namespace.namespace_id,
      edge_types: request.edge_types,
    });
    const edges = rawEdges.filter(
      (edge) => readableIds.has(edge.source_document_id) && readableIds.has(edge.target_document_id)
    );

    return { namespace_id: namespace.namespace_id, nodes, edges };
  }

  private async namespacePermission(namespaceId: string, user?: User) {
    return resolveKnowledgeNamespacePermission(this.namespaces, namespaceId, user);
  }

  private async canRead(document: KnowledgeDocument, user?: User): Promise<boolean> {
    if (document.archived) return false;
    return canReadKnowledgeDocument(this.namespaces, document, user);
  }

  private async canWrite(document: KnowledgeDocument, user?: User): Promise<boolean> {
    if (document.archived) return false;
    return canWriteKnowledgeDocument(this.namespaces, document, user);
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
    if (ref.uri?.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX)) {
      return ref.uri.slice(KNOWLEDGE_DOCUMENT_URI_PREFIX.length);
    }
    return undefined;
  }

  private documentIdFromNode(node: KnowledgeGraphNode): string | undefined {
    if (node.document_id) return node.document_id;
    if (node.uri.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX)) {
      return node.uri.slice(KNOWLEDGE_DOCUMENT_URI_PREFIX.length);
    }
    return undefined;
  }

  private unitIdFromRef(ref: KnowledgeNodeRef): string | undefined {
    const unitId = ref.unit_id ?? ref.unitId;
    if (unitId) return unitId;
    if (ref.uri?.startsWith(KNOWLEDGE_UNIT_URI_PREFIX))
      return ref.uri.slice(KNOWLEDGE_UNIT_URI_PREFIX.length);
    return undefined;
  }

  private unitIdFromNode(node: KnowledgeGraphNode): string | undefined {
    if (node.unit_id) return node.unit_id;
    if (node.uri.startsWith(KNOWLEDGE_UNIT_URI_PREFIX))
      return node.uri.slice(KNOWLEDGE_UNIT_URI_PREFIX.length);
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

    return this.activeDocument(
      await this.documents.findByNamespaceSlugAndPath(namespaceSlug, path)
    );
  }

  private async assertCanLinkRef(ref: KnowledgeNodeRef, user?: User): Promise<void> {
    const node = await this.graph.findNode(ref);
    const document = node ? await this.documentForNode(node) : await this.documentForRef(ref);
    if (!document && (node ? this.isDocumentNode(node) : this.isDocumentRef(ref))) {
      throw new NotFound('Knowledge document not found');
    }
    if (!document) return;
    if (!(await this.canWrite(document, user))) {
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
    return this.activeDocument(
      await this.documents.findByNamespaceSlugAndPath(parsed.namespace_slug, parsed.path)
    );
  }

  private async canReadNode(node: KnowledgeGraphNode, user?: User): Promise<boolean> {
    const document = await this.documentForNode(node);
    if (!document && this.isDocumentNode(node)) return false;
    return document ? this.canRead(document, user) : true;
  }

  private attributionUserId(params?: KnowledgeGraphParams, requestedUserId?: UserID | null) {
    const user = params?.user as User | undefined;
    if (isKnowledgeAdmin(user) && requestedUserId) return requestedUserId;
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

export function createKnowledgeGraphService(db: TenantScopeAwareDatabase): KnowledgeGraphService {
  return new KnowledgeGraphService(db);
}
