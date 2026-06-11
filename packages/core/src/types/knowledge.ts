import type {
  ArtifactID,
  BoardID,
  BranchID,
  GroupID,
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
export type KnowledgeEmbeddingSpaceID = UUID;
export type KnowledgeGraphNodeID = UUID;
export type KnowledgeGraphEdgeID = UUID;
export type KnowledgeNamespaceAclEntryID = UUID;

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

export const KNOWLEDGE_DOCUMENT_STATUSES = ['draft', 'published'] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

export const KNOWLEDGE_EDIT_POLICIES = ['owner', 'public', 'admins'] as const;
export type KnowledgeEditPolicy = (typeof KNOWLEDGE_EDIT_POLICIES)[number];

export const KNOWLEDGE_NAMESPACE_OTHERS_CAN = ['none', 'read', 'write'] as const;
export type KnowledgeNamespaceOthersCan = (typeof KNOWLEDGE_NAMESPACE_OTHERS_CAN)[number];

export const KNOWLEDGE_NAMESPACE_SUBJECT_TYPES = ['user', 'group'] as const;
export type KnowledgeNamespaceSubjectType = (typeof KNOWLEDGE_NAMESPACE_SUBJECT_TYPES)[number];

export const KNOWLEDGE_NAMESPACE_PERMISSIONS = ['read', 'write', 'own'] as const;
export type KnowledgeNamespacePermission = (typeof KNOWLEDGE_NAMESPACE_PERMISSIONS)[number];

export type KnowledgeNamespaceEffectivePermission = KnowledgeNamespacePermission | 'none';

export interface KnowledgeNamespaceAclEntry {
  namespace_acl_id: KnowledgeNamespaceAclEntryID;
  namespace_id: KnowledgeNamespaceID;
  subject_type: KnowledgeNamespaceSubjectType;
  subject_id: UserID | GroupID;
  permission: KnowledgeNamespacePermission;
  created_by?: UserID | null;
  created_at: Date;
  updated_at?: Date | null;
}

export interface KnowledgeNamespacePermissionSummary {
  effective_permission: KnowledgeNamespaceEffectivePermission;
  direct_permission?: KnowledgeNamespacePermission | null;
  group_permission?: KnowledgeNamespacePermission | null;
  others_can: KnowledgeNamespaceOthersCan;
  is_admin?: boolean;
  group_ids?: GroupID[];
}

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

export const KNOWLEDGE_DOCUMENT_INDEXING_STATES = [
  'empty',
  'not_configured',
  'queued',
  'ready',
  'stale',
  'error',
  'mixed',
] as const;

export type KnowledgeDocumentIndexingState = (typeof KNOWLEDGE_DOCUMENT_INDEXING_STATES)[number];

export const KNOWLEDGE_SEARCH_MODES = ['text', 'semantic', 'hybrid'] as const;
export type KnowledgeSearchMode = (typeof KNOWLEDGE_SEARCH_MODES)[number];

export const KNOWLEDGE_EMBEDDING_PROVIDERS = ['openai', 'voyage', 'openai-compatible'] as const;
export type KnowledgeEmbeddingProvider = (typeof KNOWLEDGE_EMBEDDING_PROVIDERS)[number];

export const KNOWLEDGE_VECTOR_STORAGE_TYPES = ['vector', 'halfvec', 'bit', 'sparsevec'] as const;
export type KnowledgeVectorStorageType = (typeof KNOWLEDGE_VECTOR_STORAGE_TYPES)[number];

export const KNOWLEDGE_VECTOR_DISTANCES = ['cosine', 'inner_product', 'l2'] as const;
export type KnowledgeVectorDistance = (typeof KNOWLEDGE_VECTOR_DISTANCES)[number];

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

export const KNOWLEDGE_DOCUMENT_ICON_EMOJI_MAX_LENGTH = 32;

export function normalizeKnowledgeDocumentIconEmoji(
  icon: string | null | undefined
): string | null {
  if (typeof icon !== 'string') return null;
  const trimmed = icon.trim();
  if (!trimmed) return null;
  return [...trimmed].slice(0, KNOWLEDGE_DOCUMENT_ICON_EMOJI_MAX_LENGTH).join('');
}

export const KNOWLEDGE_URI_PREFIX = 'agor://kb/';

/**
 * Canonical, rename-proof URI for an in-content reference to a Knowledge Base
 * document. Distinct from the path-based content address `agor://kb/<slug>/<path>`
 * (which doubles as the doc's address in the MCP/REST API): the literal
 * `document` type segment guarantees the two grammars never collide, and it
 * matches the typed node-URI scheme used by the knowledge graph repository.
 */
export const KNOWLEDGE_DOCUMENT_URI_PREFIX = 'agor://kb/document/';

/**
 * Canonical, rename-proof URI for a knowledge document *unit* (search/indexing
 * sub-part of a document). Mirrors `KNOWLEDGE_DOCUMENT_URI_PREFIX` and the typed
 * node-URI scheme used by the knowledge graph repository.
 */
export const KNOWLEDGE_UNIT_URI_PREFIX = 'agor://kb/unit/';

export interface KnowledgeVersionToken {
  version_id: KnowledgeDocumentVersionID;
  version_number: number;
  content_sha256: string | null;
  etag: string;
}

export interface KnowledgeEditChangedRange {
  start_line: number;
  end_line: number;
  content: string;
}

export type KnowledgeEditOp =
  | {
      type: 'replace_line_range';
      startLine: number;
      endLine: number;
      replacement: string;
      expectedText?: string;
      expectedMd5?: string;
    }
  | {
      type: 'insert_at_line';
      line: number;
      position?: 'before' | 'after';
      content: string;
      expectedNeighborText?: string;
    }
  | {
      type: 'delete_line_range';
      startLine: number;
      endLine: number;
      expectedText?: string;
      expectedMd5?: string;
    }
  | {
      type: 'replace_literal';
      find: string;
      replace: string;
      expectedCount: number;
    };

export interface KnowledgeEditResultSummary {
  dryRun: boolean;
  baseVersion: KnowledgeVersionToken;
  newVersion?: KnowledgeVersionToken;
  diff: string;
  changedRanges: KnowledgeEditChangedRange[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildKnowledgeDocumentUri(documentId: string): string {
  return `${KNOWLEDGE_DOCUMENT_URI_PREFIX}${documentId}`;
}

export function buildKnowledgeUnitUri(unitId: string): string {
  return `${KNOWLEDGE_UNIT_URI_PREFIX}${unitId}`;
}

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

/**
 * A reference to a KB document extracted from markdown. Either a rename-proof id
 * reference (`agor://kb/document/<uuid>`) or a path-based content address
 * (`agor://kb/<slug>/<path>` or the in-app route variants).
 */
export type KnowledgeLinkRef =
  | { document_id: KnowledgeDocumentID; namespace_slug?: undefined; path?: undefined }
  | { document_id?: undefined; namespace_slug: string; path: string };

// Matches both canonical URIs (agor://kb/<slug>/<path>) and in-app route links
// (/kb/<slug>/<path> or /knowledge/<slug>/<path>) as inserted by the editor's
// `@` autocomplete. Path segments may be percent-encoded.
const KNOWLEDGE_LINK_RE =
  /(?:agor:\/\/kb\/|\/(?:kb|knowledge)\/)([A-Za-z0-9._~%-]+)\/([^\s)"'<>]+)/g;

const safeDecodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Extract references to other Knowledge Base documents from markdown. Returns a
 * deduplicated list of `{ namespace_slug, path }`. Non-throwing: malformed
 * targets are skipped so callers can run this during save without guarding.
 */
export function extractKnowledgeLinks(markdown?: string | null): KnowledgeLinkRef[] {
  if (!markdown) return [];
  const results: KnowledgeLinkRef[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(KNOWLEDGE_LINK_RE)) {
    const namespaceSlug = safeDecodeSegment(match[1]).trim();
    if (!namespaceSlug) continue;
    const rawPath = match[2].split(/[?#]/)[0];

    // Rename-proof id reference: agor://kb/document/<uuid>. The `document` type
    // segment is reserved, so this never collides with a real namespace slug.
    if (match[0].startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX) && UUID_RE.test(rawPath)) {
      const documentId = rawPath.toLowerCase() as KnowledgeDocumentID;
      const key = `id:${documentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ document_id: documentId });
      continue;
    }

    let path: string;
    try {
      path = normalizeKnowledgePath(rawPath.split('/').map(safeDecodeSegment).join('/'));
    } catch {
      continue;
    }
    const key = `${namespaceSlug}/${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ namespace_slug: namespaceSlug, path });
  }
  return results;
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
  others_can: KnowledgeNamespaceOthersCan;
  /**
   * Request-scoped permission summary populated by services that list or fetch
   * namespaces for a specific user. Not stored on the namespace row.
   */
  effective_permission?: KnowledgeNamespaceEffectivePermission;
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
  /** Optional Notion-style emoji icon shown beside this document in Knowledge UI. */
  icon_emoji?: string | null;
  kind: KnowledgeDocumentKind;
  visibility: KnowledgeVisibility;
  /**
   * Lifecycle status. Drafts are not secret and direct reads still use normal
   * visibility checks, but browsing/search hide other users' drafts by default.
   */
  status: KnowledgeDocumentStatus;
  edit_policy: KnowledgeEditPolicy;
  current_version_id?: KnowledgeDocumentVersionID | null;
  metadata?: Record<string, unknown> | null;
  created_by?: UserID | null;
  created_at: Date;
  updated_by?: UserID | null;
  updated_at?: Date | null;
  archived: boolean;
  archived_at?: Date | null;
  /**
   * Optional aggregate over the current version's internal search/indexing
   * units. Included by API calls that request `include_indexing`.
   */
  indexing_status?: KnowledgeDocumentIndexingStatus | null;
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

export interface KnowledgeDocumentIndexingStatus {
  state: KnowledgeDocumentIndexingState;
  total_units: number;
  chunks: Record<KnowledgeEmbeddingStatus, number>;
  queue_depth: number;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
  last_error?: string | null;
  last_updated_at?: Date | null;
}

export interface KnowledgeEmbeddingSpace {
  embedding_space_id: KnowledgeEmbeddingSpaceID;
  provider: KnowledgeEmbeddingProvider;
  model: string;
  dimensions: number;
  storage_type: KnowledgeVectorStorageType;
  distance: KnowledgeVectorDistance;
  active: boolean;
  metadata?: Record<string, unknown> | null;
  created_at: Date;
  updated_at?: Date | null;
}

export interface KnowledgeSearchChunkResult {
  unit_id: KnowledgeDocumentUnitID;
  reference_uri: string;
  heading_path?: string | null;
  path_anchor?: string | null;
  content_text?: string | null;
  snippet?: string | null;
  score: number;
  distance?: number | null;
  start_offset?: number | null;
  end_offset?: number | null;
}

export interface KnowledgeSearchResult {
  document: KnowledgeDocument;
  namespace: KnowledgeNamespace;
  current_version?: KnowledgeDocumentVersion | null;
  snippet?: string | null;
  score: number;
  mode?: KnowledgeSearchMode;
  chunks?: KnowledgeSearchChunkResult[];
}

export interface KnowledgeIndexingStatus {
  enabled: boolean;
  configured: boolean;
  dialect: 'sqlite' | 'postgresql' | 'unknown';
  /** True only when semantic search can use pgvector storage end-to-end. */
  pgvector_available: boolean;
  /** Whether the Postgres pgvector extension is installed in this database. */
  pgvector_extension_installed?: boolean;
  /** Whether Agor's optional Knowledge vector table exists and is usable. */
  pgvector_storage_ready?: boolean;
  /** Human-readable reason semantic pgvector storage is unavailable, when known. */
  pgvector_reason?: string | null;
  /** Admin setup hint for enabling pgvector, when unavailable. */
  pgvector_setup_hint?: string | null;
  provider?: KnowledgeEmbeddingProvider | null;
  model?: string | null;
  dimensions?: number | null;
  chunks: Record<KnowledgeEmbeddingStatus, number>;
  queue_depth: number;
  last_indexed_at?: Date | null;
  last_error?: string | null;
}

export interface KnowledgeSemanticSettingsPublic {
  enabled: boolean;
  provider?: KnowledgeEmbeddingProvider | null;
  model?: string | null;
  dimensions?: number | null;
  api_key_configured: boolean;
  chunking?: {
    target_tokens?: number;
    max_tokens?: number;
    overlap_tokens?: number;
    min_tokens?: number;
  };
  indexing?: {
    paused?: boolean;
    batch_size?: number;
    concurrency?: number;
  };
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

/** A document node in the namespace-wide knowledge graph view. */
export interface KnowledgeGraphDocNode {
  document_id: KnowledgeDocumentID;
  title: string;
  icon_emoji?: string | null;
  path: string;
  uri: string;
  kind: KnowledgeDocumentKind;
  visibility: KnowledgeVisibility;
  status: KnowledgeDocumentStatus;
}

/** A doc-to-doc edge in the namespace-wide knowledge graph view. */
export interface KnowledgeGraphDocEdge {
  source_document_id: KnowledgeDocumentID;
  target_document_id: KnowledgeDocumentID;
  edge_type: KnowledgeGraphEdgeType;
}

/**
 * Whole-namespace document graph: every readable document in a namespace plus
 * the doc-to-doc edges between them. Powers the Knowledge graph home view.
 */
export interface KnowledgeNamespaceGraph {
  namespace_id: KnowledgeNamespaceID | null;
  nodes: KnowledgeGraphDocNode[];
  edges: KnowledgeGraphDocEdge[];
}
