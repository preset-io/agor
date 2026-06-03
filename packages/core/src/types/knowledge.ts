import type {
  ArtifactID,
  BoardID,
  BranchID,
  MessageID,
  RepoID,
  SessionID,
  TaskID,
  UserID,
  UUID,
} from './id';

export type KnowledgeNamespaceID = UUID;
export type KnowledgeDocumentID = UUID;
export type KnowledgeDocumentVersionID = UUID;
export type KnowledgeDocumentUnitID = UUID;
export type KnowledgeGraphNodeID = UUID;
export type KnowledgeGraphEdgeID = UUID;

export const KNOWLEDGE_NAMESPACE_KINDS = [
  'system',
  'global',
  'user',
  'repo',
  'branch',
  'team',
] as const;

export type KnowledgeNamespaceKind = (typeof KNOWLEDGE_NAMESPACE_KINDS)[number];

export const KNOWLEDGE_DOCUMENT_KINDS = [
  'doc',
  'memory',
  'skill',
  'prompt',
  'guide',
  'decision',
  'bundle',
  'external',
] as const;

export type KnowledgeDocumentKind = (typeof KNOWLEDGE_DOCUMENT_KINDS)[number];

export const KNOWLEDGE_VISIBILITIES = ['public', 'private'] as const;
export type KnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number];

export const KNOWLEDGE_EDIT_POLICIES = ['owner', 'public', 'admins'] as const;
export type KnowledgeEditPolicy = (typeof KNOWLEDGE_EDIT_POLICIES)[number];

/**
 * Internal search/indexing unit. Usually one per document version in V1; can
 * later become one per markdown heading section or skill-bundle file without
 * exposing arbitrary RAG "chunks" as a product concept.
 */
export const KNOWLEDGE_DOCUMENT_UNIT_KINDS = ['document', 'section', 'file', 'auto_split'] as const;

export type KnowledgeDocumentUnitKind = (typeof KNOWLEDGE_DOCUMENT_UNIT_KINDS)[number];

export const KNOWLEDGE_EMBEDDING_STATUSES = [
  'not_configured',
  'pending',
  'ready',
  'stale',
  'error',
] as const;

export type KnowledgeEmbeddingStatus = (typeof KNOWLEDGE_EMBEDDING_STATUSES)[number];

export const KNOWLEDGE_GRAPH_NODE_TYPES = [
  'namespace',
  'document',
  'document_unit',
  'branch',
  'session',
  'task',
  'message',
  'artifact',
  'repo',
  'board',
  'user',
  'tag',
  'external',
] as const;

export type KnowledgeGraphNodeType = (typeof KNOWLEDGE_GRAPH_NODE_TYPES)[number];

export const KNOWLEDGE_GRAPH_EDGE_TYPES = [
  'contains',
  'references',
  'mentions',
  'implements',
  'depends_on',
  'supersedes',
  'derived_from',
  'tagged_with',
  'about',
  'parent_of',
  'related_to',
] as const;

export type KnowledgeGraphEdgeType = (typeof KNOWLEDGE_GRAPH_EDGE_TYPES)[number];

export const KNOWLEDGE_URI_PREFIX = 'agor://kb/';

const INVALID_KNOWLEDGE_PATH_CHARS = new Set(['<', '>', ':', '"', '\\', '|', '?', '*']);
const RESERVED_WINDOWS_NAMES_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const hasInvalidKnowledgePathChar = (segment: string) =>
  [...segment].some((char) => INVALID_KNOWLEDGE_PATH_CHARS.has(char) || char.charCodeAt(0) < 32);

export function normalizeKnowledgePath(path: string): string {
  const normalized = path.trim().replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized) throw new Error('Knowledge document path is required');

  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error('Knowledge document path must not contain empty, "." or ".." segments');
    }
    if (hasInvalidKnowledgePathChar(segment)) {
      throw new Error(
        'Knowledge document path segments cannot contain < > : " \\\\ | ? * or control characters'
      );
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      throw new Error('Knowledge document path segments cannot end with a space or period');
    }
    if (RESERVED_WINDOWS_NAMES_RE.test(segment)) {
      throw new Error(
        `Knowledge document path segment "${segment}" is reserved on some filesystems`
      );
    }
  }
  return normalized;
}

export function normalizeKnowledgeFolderPath(folder?: string | null): string {
  const normalized = (folder ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (!normalized) return '';
  return normalizeKnowledgePath(normalized);
}

export function validateKnowledgePath(path: string, options: { allowEmpty?: boolean } = {}) {
  try {
    if (options.allowEmpty && !path.trim()) return null;
    normalizeKnowledgePath(path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function buildKnowledgeUri(namespaceSlug: string, path: string): string {
  return `${KNOWLEDGE_URI_PREFIX}${namespaceSlug}/${normalizeKnowledgePath(path)}`;
}

export function parseKnowledgeUri(
  uri?: string | null
): { namespace_slug: string; path: string } | null {
  if (!uri?.startsWith(KNOWLEDGE_URI_PREFIX)) return null;
  const rest = uri.slice(KNOWLEDGE_URI_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return {
    namespace_slug: rest.slice(0, slash),
    path: normalizeKnowledgePath(rest.slice(slash + 1)),
  };
}

export function titleFromKnowledgePath(path: string): string {
  const leaf = normalizeKnowledgePath(path).split('/').pop() || path;
  return leaf.replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ') || path;
}

export function titleFromKnowledgeContent(content: string, fallback = 'Untitled'): string {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return fallback;
  return (
    first
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/[*_`~]/g, '')
      .trim() || fallback
  );
}

export interface KnowledgeNamespace {
  namespace_id: KnowledgeNamespaceID;
  slug: string;
  display_name: string;
  description?: string | null;
  kind: KnowledgeNamespaceKind;
  owner_user_id?: UserID | null;
  repo_id?: RepoID | null;
  branch_id?: BranchID | null;
  visibility_default: KnowledgeVisibility;
  metadata?: Record<string, unknown> | null;
  created_by?: UserID | null;
  created_at: Date;
  updated_at?: Date | null;
  archived: boolean;
  archived_at?: Date | null;
}

export interface KnowledgeDocument {
  document_id: KnowledgeDocumentID;
  namespace_id: KnowledgeNamespaceID;
  path: string;
  uri: string;
  /**
   * Computed browser deep link added by the repository layer.
   * Format: `{baseUrl}/ui/kb/{namespaceSlug}/{documentPath}`.
   * `null` when the namespace slug/base URL is unavailable.
   */
  url?: string | null;
  title: string;
  kind: KnowledgeDocumentKind;
  visibility: KnowledgeVisibility;
  edit_policy: KnowledgeEditPolicy;
  current_version_id?: KnowledgeDocumentVersionID | null;
  metadata?: Record<string, unknown> | null;
  created_by?: UserID | null;
  created_at: Date;
  updated_by?: UserID | null;
  updated_at?: Date | null;
  archived: boolean;
  archived_at?: Date | null;
}

export interface KnowledgeDocumentVersion {
  version_id: KnowledgeDocumentVersionID;
  document_id: KnowledgeDocumentID;
  version_number: number;
  content_text?: string | null;
  content_blob?: Uint8Array | null;
  mime_type: string;
  content_md5?: string | null;
  content_sha256?: string | null;
  byte_length?: number | null;
  char_length?: number | null;
  frontmatter?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  change_summary?: string | null;
  created_by?: UserID | null;
  created_at: Date;
}

export interface KnowledgeDocumentUnit {
  unit_id: KnowledgeDocumentUnitID;
  document_id: KnowledgeDocumentID;
  version_id: KnowledgeDocumentVersionID;
  kind: KnowledgeDocumentUnitKind;
  ordinal: number;
  path_anchor?: string | null;
  heading_path?: string | null;
  source_path?: string | null;
  content_text?: string | null;
  content_md5?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  embedding_status: KnowledgeEmbeddingStatus;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
  embedding_hash?: string | null;
  embedding_error?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: Date;
  updated_at?: Date | null;
}

export interface KnowledgeGraphNode {
  node_id: KnowledgeGraphNodeID;
  node_type: KnowledgeGraphNodeType;
  uri: string;
  label?: string | null;
  namespace_id?: KnowledgeNamespaceID | null;
  document_id?: KnowledgeDocumentID | null;
  unit_id?: KnowledgeDocumentUnitID | null;
  branch_id?: BranchID | null;
  session_id?: SessionID | null;
  task_id?: TaskID | null;
  message_id?: MessageID | null;
  artifact_id?: ArtifactID | null;
  repo_id?: RepoID | null;
  board_id?: BoardID | null;
  user_id?: UserID | null;
  external_uri?: string | null;
  metadata?: Record<string, unknown> | null;
  created_by?: UserID | null;
  created_at: Date;
  updated_at?: Date | null;
  archived: boolean;
  archived_at?: Date | null;
}

export interface KnowledgeGraphEdge {
  edge_id: KnowledgeGraphEdgeID;
  source_node_id: KnowledgeGraphNodeID;
  target_node_id: KnowledgeGraphNodeID;
  edge_type: KnowledgeGraphEdgeType;
  confidence?: number | null;
  properties?: Record<string, unknown> | null;
  created_by?: UserID | null;
  created_at: Date;
  archived: boolean;
  archived_at?: Date | null;
}
