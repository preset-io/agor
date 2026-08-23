import {
  KnowledgeDocumentRepository,
  KnowledgeGraphRepository,
  KnowledgeNamespaceRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  HookContext,
  InternalUser,
  KnowledgeDocument,
  KnowledgeGraphNode,
  User,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import {
  canReadKnowledgeDocument,
  hasKnowledgeNamespacePermission,
  isKnowledgeAdmin,
  isKnowledgeDocumentGraphNode,
  resolveKnowledgeGraphNodeDocument,
  resolveKnowledgeNamespacePermission,
} from '../services/knowledge-access.js';

export const KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS = [
  'kb/search',
  'kb/document-edits',
  'kb/indexing/reindex',
] as const;

const SUPPRESSED_CREATE_PATHS = new Set<string>(KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS);
const ADMIN_ONLY_PATHS = new Set(['kb/settings', 'kb/indexing/status']);
const DOCUMENT_PATHS = new Set(['kb/documents', 'kb/versions']);
const INTERNAL_KNOWLEDGE_ADMIN = { role: ROLES.ADMIN } as User;

type KnowledgePublishContext = Pick<HookContext, 'path' | 'id' | 'event' | 'app'>;

export function isKnowledgeRealtimeSuppressedEvent(
  path: string,
  event: string | null | undefined
): boolean {
  return event === 'created' && SUPPRESSED_CREATE_PATHS.has(path.replace(/^\//, ''));
}

function records(data: unknown): Record<string, unknown>[] {
  const values = Array.isArray(data) ? data : [data];
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    result.push(record);
    for (const key of ['document', 'namespace', 'comment', 'edge']) {
      const nested = record[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        result.push(nested as Record<string, unknown>);
      }
    }
  }
  return result;
}

function idsFrom(data: unknown, ...keys: string[]): string[] {
  const ids = new Set<string>();
  for (const record of records(data)) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) ids.add(value);
    }
  }
  return [...ids];
}

async function loadDocuments(
  documents: KnowledgeDocumentRepository,
  documentIds: string[]
): Promise<KnowledgeDocument[] | null> {
  if (documentIds.length === 0) return null;
  const loaded = await Promise.all(documentIds.map((id) => documents.findById(id)));
  return loaded.every((document): document is KnowledgeDocument => document !== null)
    ? loaded
    : null;
}

async function readableDocumentUserIds(
  namespaces: KnowledgeNamespaceRepository,
  documents: KnowledgeDocument[] | null,
  users: User[]
): Promise<Set<string>> {
  const authorized = new Set<string>();
  if (!documents) return authorized;
  for (const user of users) {
    if (
      await everyAsync(documents, (document) =>
        canReadKnowledgeDocument(namespaces, document, user)
      )
    ) {
      authorized.add(user.user_id);
    }
  }
  return authorized;
}

async function everyAsync<T>(values: T[], predicate: (value: T) => Promise<boolean>) {
  for (const value of values) {
    if (!(await predicate(value))) return false;
  }
  return true;
}

async function commentDocumentId(app: Application, data: unknown): Promise<string | undefined> {
  const [direct] = idsFrom(data, 'document_id', 'documentId');
  if (direct) return direct;

  const [parentId] = idsFrom(data, 'parent_comment_id', 'parentCommentId');
  if (!parentId) return undefined;
  try {
    const parent = (await app.service('kb/document-comments').get(parentId, {
      provider: undefined,
      user: INTERNAL_KNOWLEDGE_ADMIN,
    } as never)) as { document_id?: unknown; documentId?: unknown };
    const documentId = parent.document_id ?? parent.documentId;
    return typeof documentId === 'string' && documentId.length > 0 ? documentId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the current reader set for one shared Knowledge event.
 *
 * User principals and the reader set are reloaded for every event so role and
 * direct/group revocation take effect immediately. `null` means the event is
 * not owned by Knowledge; an empty set means a Knowledge parent or ACL could
 * not be resolved and publication must fail closed (trusted service
 * connections are added by the caller).
 */
export async function resolveKnowledgeRealtimeUserIds(options: {
  app: Application;
  db: TenantScopeAwareDatabase | undefined;
  data: unknown;
  context: KnowledgePublishContext;
  userIds: string[];
}): Promise<Set<string> | null> {
  const path = options.context.path?.replace(/^\//, '');
  if (!path?.startsWith('kb/')) return null;
  if (isKnowledgeRealtimeSuppressedEvent(path, options.context.event)) return new Set();
  if (!options.db) return new Set();

  const userRepository = new UsersRepository(options.db);
  const users = (
    await Promise.all(options.userIds.map((userId) => userRepository.findById(userId)))
  ).filter((user): user is InternalUser => user !== null);

  if (SUPPRESSED_CREATE_PATHS.has(path)) {
    return new Set(users.map((user) => user.user_id));
  }

  if (ADMIN_ONLY_PATHS.has(path)) {
    return new Set(users.filter(isKnowledgeAdmin).map((user) => user.user_id));
  }

  const namespaces = new KnowledgeNamespaceRepository(options.db);
  const documents = new KnowledgeDocumentRepository(options.db);

  if (path === 'kb/namespaces') {
    const namespaceIds = idsFrom(options.data, 'namespace_id', 'namespaceId');
    if (namespaceIds.length === 0 && typeof options.context.id === 'string') {
      namespaceIds.push(options.context.id);
    }
    const authorized = new Set<string>();
    if (namespaceIds.length === 0) return authorized;
    for (const user of users) {
      if (
        await everyAsync(namespaceIds, async (namespaceId) =>
          hasKnowledgeNamespacePermission(
            await resolveKnowledgeNamespacePermission(namespaces, namespaceId, user),
            'read'
          )
        )
      ) {
        authorized.add(user.user_id);
      }
    }
    return authorized;
  }

  if (DOCUMENT_PATHS.has(path)) {
    const documentIds = idsFrom(options.data, 'document_id', 'documentId');
    if (
      documentIds.length === 0 &&
      path === 'kb/documents' &&
      typeof options.context.id === 'string'
    ) {
      documentIds.push(options.context.id);
    }
    return readableDocumentUserIds(namespaces, await loadDocuments(documents, documentIds), users);
  }

  if (path === 'kb/document-comments') {
    const documentId = await commentDocumentId(options.app, options.data);
    return readableDocumentUserIds(
      namespaces,
      await loadDocuments(documents, documentId ? [documentId] : []),
      users
    );
  }

  if (path === 'kb/graph') {
    const nodeIds = idsFrom(
      options.data,
      'source_node_id',
      'sourceNodeId',
      'target_node_id',
      'targetNodeId'
    );
    if (nodeIds.length === 0) return new Set();
    const graph = new KnowledgeGraphRepository(options.db);
    const nodes = await Promise.all(
      nodeIds.map((nodeId) => graph.findNode({ node_id: nodeId }, { includeArchived: true }))
    );
    if (!nodes.every((node): node is KnowledgeGraphNode => node !== null)) return new Set();

    const resolvedDocuments = await Promise.all(
      nodes.map((node) => resolveKnowledgeGraphNodeDocument(documents, namespaces, node))
    );
    const documentsById = new Map<string, KnowledgeDocument>();
    for (const [index, document] of resolvedDocuments.entries()) {
      if (!document) {
        if (isKnowledgeDocumentGraphNode(nodes[index])) return new Set();
        continue;
      }
      documentsById.set(document.document_id, document);
    }
    return readableDocumentUserIds(namespaces, [...documentsById.values()], users);
  }

  // Unknown or future Knowledge payloads must declare a parent mapping before
  // they can be safely shared.
  return new Set();
}
