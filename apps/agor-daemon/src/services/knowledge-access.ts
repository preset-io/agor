import type { KnowledgeNamespaceRepository, KnowledgeSearchRepository } from '@agor/core/db';
import type {
  KnowledgeDocument,
  KnowledgeNamespaceEffectivePermission,
  KnowledgeNamespaceID,
  User,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

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

export async function canReadKnowledgeSearchResult(
  namespaces: KnowledgeNamespaceRepository,
  result: Awaited<ReturnType<KnowledgeSearchRepository['search']>>[number],
  user?: User
): Promise<boolean> {
  return canReadKnowledgeDocument(namespaces, result.document, user);
}
