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

export type KnowledgeNamespaceKind = 'system' | 'global' | 'user' | 'repo' | 'branch' | 'team';

export type KnowledgeDocumentKind =
  | 'doc'
  | 'memory'
  | 'skill'
  | 'prompt'
  | 'guide'
  | 'decision'
  | 'bundle'
  | 'external';

export type KnowledgeVisibility = 'public' | 'private';
export type KnowledgeEditPolicy = 'owner' | 'public' | 'admins';

/**
 * Internal search/indexing unit. Usually one per document version in V1; can
 * later become one per markdown heading section or skill-bundle file without
 * exposing arbitrary RAG "chunks" as a product concept.
 */
export type KnowledgeDocumentUnitKind = 'document' | 'section' | 'file' | 'auto_split';

export type KnowledgeEmbeddingStatus = 'not_configured' | 'pending' | 'ready' | 'stale' | 'error';

export type KnowledgeGraphNodeType =
  | 'namespace'
  | 'document'
  | 'document_unit'
  | 'branch'
  | 'session'
  | 'task'
  | 'message'
  | 'artifact'
  | 'repo'
  | 'board'
  | 'user'
  | 'tag'
  | 'external';

export type KnowledgeGraphEdgeType =
  | 'contains'
  | 'references'
  | 'mentions'
  | 'implements'
  | 'depends_on'
  | 'supersedes'
  | 'derived_from'
  | 'tagged_with'
  | 'about'
  | 'parent_of'
  | 'related_to';

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
