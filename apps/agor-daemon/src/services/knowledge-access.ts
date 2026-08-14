import type {
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  KnowledgeSearchRepository,
} from '@agor/core/db';
import type {
  KnowledgeDocument,
  KnowledgeGraphNode,
  KnowledgeNamespaceEffectivePermission,
  KnowledgeNamespaceID,
  User,
} from '@agor/core/types';
import {
  hasMinimumRole,
  KNOWLEDGE_DOCUMENT_URI_PREFIX,
  KNOWLEDGE_UNIT_URI_PREFIX,
  parseKnowledgeUri,
  ROLES,
} from '@agor/core/types';

const KNOWLEDGE_NAMESPACE_PERMISSION_RANK: Record<KnowledgeNamespaceEffectivePermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  own: 3,
};

export type KnowledgeNamespaceRequiredPermission = Exclude<
  KnowledgeNamespaceEffectivePermission,
  'none'
>;

export function isKnowledgeAdmin(user?: User): boolean {
  return hasMinimumRole(user?.role, ROLES.ADMIN);
}

export function hasKnowledgeNamespacePermission(
  actual: KnowledgeNamespaceEffectivePermission,
  required: KnowledgeNamespaceRequiredPermission
): boolean {
  return (
    KNOWLEDGE_NAMESPACE_PERMISSION_RANK[actual] >= KNOWLEDGE_NAMESPACE_PERMISSION_RANK[required]
  );
}

export async function resolveKnowledgeNamespacePermission(
  namespaces: KnowledgeNamespaceRepository,
  namespaceId: KnowledgeNamespaceID | string,
  user?: User
): Promise<KnowledgeNamespaceEffectivePermission> {
  return namespaces.resolveNamespacePermission(namespaceId, String(user?.user_id ?? ''), {
    isAdmin: isKnowledgeAdmin(user),
  });
}

/**
 * Document visibility is a narrower overlay on top of namespace read access.
 */
export function canReadKnowledgeDocumentOverlay(document: KnowledgeDocument, user?: User): boolean {
  return (
    document.visibility === 'public' ||
    isKnowledgeAdmin(user) ||
    Boolean(user?.user_id && document.created_by === user.user_id)
  );
}

/**
 * Document edit policy is a narrower overlay on top of namespace write access.
 */
export function canWriteKnowledgeDocumentOverlay(
  document: KnowledgeDocument,
  user?: User
): boolean {
  return (
    isKnowledgeAdmin(user) ||
    Boolean(user?.user_id && document.created_by === user.user_id) ||
    (document.visibility === 'public' && document.edit_policy === 'public')
  );
}

export async function canReadKnowledgeDocument(
  namespaces: KnowledgeNamespaceRepository,
  document: KnowledgeDocument,
  user?: User
): Promise<boolean> {
  const namespacePermission = await resolveKnowledgeNamespacePermission(
    namespaces,
    document.namespace_id,
    user
  );
  return (
    hasKnowledgeNamespacePermission(namespacePermission, 'read') &&
    canReadKnowledgeDocumentOverlay(document, user)
  );
}

export async function canWriteKnowledgeDocument(
  namespaces: KnowledgeNamespaceRepository,
  document: KnowledgeDocument,
  user?: User
): Promise<boolean> {
  const namespacePermission = await resolveKnowledgeNamespacePermission(
    namespaces,
    document.namespace_id,
    user
  );
  return (
    hasKnowledgeNamespacePermission(namespacePermission, 'write') &&
    canWriteKnowledgeDocumentOverlay(document, user)
  );
}

function graphNodeDocumentId(node: KnowledgeGraphNode): string | undefined {
  if (node.document_id) return node.document_id;
  if (node.uri.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX)) {
    return node.uri.slice(KNOWLEDGE_DOCUMENT_URI_PREFIX.length);
  }
  return undefined;
}

function graphNodeUnitId(node: KnowledgeGraphNode): string | undefined {
  if (node.unit_id) return node.unit_id;
  if (node.uri.startsWith(KNOWLEDGE_UNIT_URI_PREFIX)) {
    return node.uri.slice(KNOWLEDGE_UNIT_URI_PREFIX.length);
  }
  return undefined;
}

export function isKnowledgeDocumentGraphNode(node: KnowledgeGraphNode): boolean {
  return Boolean(
    node.node_type === 'document' ||
      node.node_type === 'document_unit' ||
      node.document_id ||
      graphNodeDocumentId(node) ||
      graphNodeUnitId(node) ||
      parseKnowledgeUri(node.uri)
  );
}

/** Resolve a graph node through the same active document/namespace boundary as graph reads. */
export async function resolveKnowledgeGraphNodeDocument(
  documents: KnowledgeDocumentRepository,
  namespaces: KnowledgeNamespaceRepository,
  node: KnowledgeGraphNode
): Promise<KnowledgeDocument | null> {
  const documentId = graphNodeDocumentId(node);
  const unitId = graphNodeUnitId(node);
  const parsed = parseKnowledgeUri(node.uri);
  const document = documentId
    ? await documents.findById(documentId)
    : unitId
      ? await documents.findByUnitId(unitId)
      : parsed
        ? await documents.findByNamespaceSlugAndPath(parsed.namespace_slug, parsed.path)
        : null;
  if (!document || document.archived) return null;
  const namespace = await namespaces.findById(document.namespace_id);
  return !namespace || namespace.archived ? null : document;
}

export async function canReadKnowledgeGraphNode(
  documents: KnowledgeDocumentRepository,
  namespaces: KnowledgeNamespaceRepository,
  node: KnowledgeGraphNode,
  user?: User
): Promise<boolean> {
  const document = await resolveKnowledgeGraphNodeDocument(documents, namespaces, node);
  if (!document && isKnowledgeDocumentGraphNode(node)) return false;
  return document ? canReadKnowledgeDocument(namespaces, document, user) : true;
}

export async function canReadKnowledgeSearchResult(
  namespaces: KnowledgeNamespaceRepository,
  result: Awaited<ReturnType<KnowledgeSearchRepository['search']>>[number],
  user?: User
): Promise<boolean> {
  return canReadKnowledgeDocument(namespaces, result.document, user);
}
