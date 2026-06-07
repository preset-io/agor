/**
 * Knowledge repositories
 *
 * Thin data-access layer for Agor's DB-backed Knowledge feature. V1 is
 * intentionally markdown-only and synchronous: document writes create an
 * immutable version plus one document-level search unit, then update the
 * document's current_version_id pointer in the same transaction.
 */

import { createHash } from 'node:crypto';
import type {
  GroupID,
  KnowledgeDocument,
  KnowledgeDocumentID,
  KnowledgeDocumentIndexingStatus,
  KnowledgeDocumentKind,
  KnowledgeDocumentStatus,
  KnowledgeDocumentUnitID,
  KnowledgeDocumentVersion,
  KnowledgeDocumentVersionID,
  KnowledgeEditPolicy,
  KnowledgeEmbeddingStatus,
  KnowledgeGraphEdge,
  KnowledgeGraphEdgeID,
  KnowledgeGraphEdgeType,
  KnowledgeGraphNode,
  KnowledgeGraphNodeID,
  KnowledgeGraphNodeType,
  KnowledgeNamespace,
  KnowledgeNamespaceAclEntry,
  KnowledgeNamespaceEffectivePermission,
  KnowledgeNamespaceID,
  KnowledgeNamespaceKind,
  KnowledgeNamespaceOthersCan,
  KnowledgeNamespacePermission,
  KnowledgeNamespaceSubjectType,
  KnowledgeSearchMode,
  KnowledgeSearchResult,
  KnowledgeVisibility,
  UserID,
} from '@agor/core/types';
import {
  buildKnowledgeDocumentUri,
  buildKnowledgeUnitUri,
  buildKnowledgeUri,
  KNOWLEDGE_DOCUMENT_URI_PREFIX,
  KNOWLEDGE_EMBEDDING_STATUSES,
  KNOWLEDGE_UNIT_URI_PREFIX,
  normalizeKnowledgeFolderPath,
  normalizeKnowledgePath,
  parseKnowledgeUri,
  titleFromKnowledgePath,
} from '@agor/core/types';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { getBaseUrl } from '../../config/config-manager';
import { generateId } from '../../lib/ids';
import { getKnowledgeUrl } from '../../utils/url';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select, txAsDb, update } from '../database-wrapper';
import {
  groupMemberships,
  groups,
  type KBDocumentInsert,
  type KBDocumentRow,
  type KBDocumentUnitInsert,
  type KBDocumentVersionInsert,
  type KBDocumentVersionRow,
  type KBGraphEdgeInsert,
  type KBGraphEdgeRow,
  type KBGraphNodeInsert,
  type KBGraphNodeRow,
  type KBNamespaceAclInsert,
  type KBNamespaceAclRow,
  type KBNamespaceInsert,
  type KBNamespaceRow,
  kbDocuments,
  kbDocumentUnits,
  kbDocumentVersions,
  kbGraphEdges,
  kbGraphNodes,
  kbNamespaceAcl,
  kbNamespaces,
} from '../schema';
import {
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { deepMerge } from './merge-utils';

const MARKDOWN_MIME_TYPE = 'text/markdown';
export interface KnowledgeNamespaceFilters {
  slug?: string;
  kind?: KnowledgeNamespaceKind;
  owner_user_id?: UserID;
  repo_id?: string;
  branch_id?: string;
  archived?: boolean;
}

export interface KnowledgeDocumentFilters {
  namespace_id?: KnowledgeNamespaceID;
  namespace_slug?: string;
  path?: string;
  kind?: KnowledgeDocumentKind;
  visibility?: KnowledgeVisibility;
  status?: KnowledgeDocumentStatus;
  archived?: boolean;
  /**
   * Draft browsing policy. Defaults are applied by callers/services, but when
   * omitted here they are interpreted as include own drafts and hide other
   * users' drafts.
   */
  include_my_drafts?: boolean;
  include_other_user_drafts?: boolean;
  draft_filter_user_id?: UserID;
}

export interface CreateKnowledgeDocumentInput extends Partial<KnowledgeDocument> {
  namespace_slug?: string;
  content_text: string;
  mime_type?: string;
  frontmatter?: Record<string, unknown> | null;
  version_metadata?: Record<string, unknown> | null;
  change_summary?: string | null;
}

export interface UpdateKnowledgeDocumentInput extends Partial<KnowledgeDocument> {
  content_text?: string;
  mime_type?: string;
  frontmatter?: Record<string, unknown> | null;
  version_metadata?: Record<string, unknown> | null;
  change_summary?: string | null;
}

export interface ReplaceKnowledgeUnitInput {
  kind: 'document' | 'section' | 'file' | 'auto_split';
  ordinal: number;
  path_anchor?: string | null;
  heading_path?: string | null;
  source_path?: string | null;
  content_text: string;
  content_md5: string;
  start_offset?: number | null;
  end_offset?: number | null;
  metadata?: Record<string, unknown> | null;
}

type KnowledgeDocumentWriteInput = Partial<KnowledgeDocument> &
  Partial<CreateKnowledgeDocumentInput> &
  Partial<UpdateKnowledgeDocumentInput>;

export interface KnowledgeSearchQuery {
  q?: string;
  mode?: KnowledgeSearchMode;
  include_chunks?: boolean;
  min_similarity?: number;
  rerank_limit?: number;
  namespace_id?: KnowledgeNamespaceID;
  namespace_slug?: string;
  path_prefix?: string;
  kind?: KnowledgeDocumentKind;
  visibility?: KnowledgeVisibility;
  status?: KnowledgeDocumentStatus;
  include_archived?: boolean;
  include_my_drafts?: boolean;
  includeMyDrafts?: boolean;
  include_other_user_drafts?: boolean;
  includeOtherUserDrafts?: boolean;
  include_indexing?: boolean;
  includeIndexing?: boolean;
  limit?: number;
  readable_by_user_id?: UserID;
  readable_as_admin?: boolean;
  readable_namespace_ids?: KnowledgeNamespaceID[];
}

function deterministicKnowledgeUnitId(
  versionId: KnowledgeDocumentVersionID,
  unit: ReplaceKnowledgeUnitInput
): KnowledgeDocumentUnitID {
  const hash = createHash('sha256')
    .update(`${versionId}:${unit.ordinal}:${unit.path_anchor ?? ''}:${unit.content_md5}`)
    .digest('hex');
  // UUID-shaped deterministic ID for stable `agor://kb/unit/<id>` references.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(
    (Number.parseInt(hash.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, '0')}${hash.slice(18, 20)}-${hash.slice(20, 32)}` as KnowledgeDocumentUnitID;
}

export interface KnowledgeNodeRef {
  node_id?: string;
  nodeId?: string;
  uri?: string;
  node_type?: KnowledgeGraphNodeType;
  nodeType?: KnowledgeGraphNodeType;
  document_id?: string;
  documentId?: string;
  unit_id?: string;
  unitId?: string;
  namespace_id?: string;
  namespaceId?: string;
  namespace?: string;
  path?: string;
  external_uri?: string;
  externalUri?: string;
  branch_id?: string;
  branchId?: string;
  session_id?: string;
  sessionId?: string;
  task_id?: string;
  taskId?: string;
  message_id?: string;
  messageId?: string;
  artifact_id?: string;
  artifactId?: string;
  repo_id?: string;
  repoId?: string;
  board_id?: string;
  boardId?: string;
  user_id?: string;
  userId?: string;
  label?: string;
}

export interface KnowledgeGraphLinkInput {
  source: KnowledgeNodeRef;
  target: KnowledgeNodeRef;
  edge_type: KnowledgeGraphEdgeType;
  confidence?: number | null;
  properties?: Record<string, unknown> | null;
  created_by?: UserID | null;
}

export interface KnowledgeGraphNeighborsQuery {
  node: KnowledgeNodeRef;
  direction?: 'out' | 'in' | 'both';
  edge_types?: KnowledgeGraphEdgeType[];
  node_types?: KnowledgeGraphNodeType[];
  depth?: number;
  limit?: number;
  include_archived?: boolean;
}

export interface KnowledgeGraphNeighborsResult {
  center: KnowledgeGraphNode;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface KnowledgeNamespaceGraphQuery {
  namespace_id: KnowledgeNamespaceID;
  edge_types?: KnowledgeGraphEdgeType[];
  include_archived?: boolean;
}

/** A doc-to-doc edge expressed in document-id terms (graph node ids resolved). */
export interface KnowledgeDocumentEdge {
  source_document_id: KnowledgeDocumentID;
  target_document_id: KnowledgeDocumentID;
  edge_type: KnowledgeGraphEdgeType;
}

function hashContent(content: string): {
  md5: string;
  sha256: string;
  byteLength: number;
  charLength: number;
} {
  return {
    md5: createHash('md5').update(content).digest('hex'),
    sha256: createHash('sha256').update(content).digest('hex'),
    byteLength: Buffer.byteLength(content, 'utf8'),
    charLength: [...content].length,
  };
}

function makeSnippet(content: string | null | undefined, q: string): string | null {
  if (!content) return null;
  const needle = q.trim().toLowerCase();
  if (!needle) return content.slice(0, 240);
  const index = content.toLowerCase().indexOf(needle);
  if (index < 0) return content.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + needle.length + 160);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function knowledgeDraftVisibilityCondition(options: {
  status?: KnowledgeDocumentStatus;
  userId?: UserID;
  includeMyDrafts?: boolean;
  includeOtherUserDrafts?: boolean;
}) {
  const includeMyDrafts = options.includeMyDrafts !== false;
  const includeOtherUserDrafts = options.includeOtherUserDrafts === true;

  if (options.status === 'published') return eq(kbDocuments.status, 'published');
  if (options.status === 'draft') {
    if (includeOtherUserDrafts) return eq(kbDocuments.status, 'draft');
    if (includeMyDrafts && options.userId) {
      return and(eq(kbDocuments.status, 'draft'), eq(kbDocuments.created_by, options.userId));
    }
    return sql`1 = 0`;
  }

  if (includeOtherUserDrafts) return undefined;
  if (includeMyDrafts && options.userId) {
    return or(eq(kbDocuments.status, 'published'), eq(kbDocuments.created_by, options.userId));
  }
  return eq(kbDocuments.status, 'published');
}

const KNOWLEDGE_PERMISSION_RANK: Record<KnowledgeNamespaceEffectivePermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  own: 3,
};

function maxKnowledgePermission(
  permissions: Array<KnowledgeNamespaceEffectivePermission | null | undefined>
): KnowledgeNamespaceEffectivePermission {
  return permissions.reduce<KnowledgeNamespaceEffectivePermission>((best, current) => {
    if (!current) return best;
    return KNOWLEDGE_PERMISSION_RANK[current] > KNOWLEDGE_PERMISSION_RANK[best] ? current : best;
  }, 'none');
}

function othersCanToPermission(
  othersCan: KnowledgeNamespaceOthersCan
): KnowledgeNamespaceEffectivePermission {
  return othersCan === 'none' ? 'none' : othersCan;
}

export interface ResolveKnowledgeNamespacePermissionOptions {
  isAdmin?: boolean;
}

export class KnowledgeNamespaceRepository
  implements BaseRepository<KnowledgeNamespace, Partial<KnowledgeNamespace>>
{
  constructor(private db: Database) {}

  rowToNamespace(row: KBNamespaceRow): KnowledgeNamespace {
    return {
      namespace_id: row.namespace_id as KnowledgeNamespaceID,
      slug: row.slug,
      display_name: row.display_name,
      description: row.description ?? null,
      kind: row.kind as KnowledgeNamespaceKind,
      owner_user_id: (row.owner_user_id as UserID | null) ?? null,
      repo_id: row.repo_id as KnowledgeNamespace['repo_id'],
      branch_id: row.branch_id as KnowledgeNamespace['branch_id'],
      visibility_default: row.visibility_default as KnowledgeVisibility,
      others_can: row.others_can as KnowledgeNamespaceOthersCan,
      metadata: row.metadata ?? null,
      created_by: (row.created_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
      archived: Boolean(row.archived),
      archived_at: row.archived_at ? new Date(row.archived_at) : null,
    };
  }

  private namespaceToInsert(data: Partial<KnowledgeNamespace>): KBNamespaceInsert {
    const now = Date.now();
    const slug = data.slug?.trim();
    if (!slug) throw new RepositoryError('Knowledge namespace slug is required');
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
      throw new RepositoryError(
        'Knowledge namespace slug must use lowercase letters, numbers, dots, underscores, or dashes'
      );
    }

    return {
      namespace_id: (data.namespace_id ?? generateId()) as string,
      slug,
      display_name: data.display_name ?? slug,
      description: data.description ?? null,
      kind: data.kind ?? 'global',
      owner_user_id: data.owner_user_id ?? null,
      repo_id: data.repo_id ?? null,
      branch_id: data.branch_id ?? null,
      visibility_default: data.visibility_default ?? 'public',
      others_can: data.others_can ?? 'write',
      metadata: data.metadata ?? null,
      created_by: data.created_by ?? null,
      created_at: data.created_at ? new Date(data.created_at) : new Date(now),
      updated_at: data.updated_at ? new Date(data.updated_at) : new Date(now),
      archived: data.archived ?? false,
      archived_at: data.archived_at ? new Date(data.archived_at) : null,
    };
  }

  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'KnowledgeNamespace', async (pattern) => {
      const rows = await select(this.db)
        .from(kbNamespaces)
        .where(like(kbNamespaces.namespace_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { namespace_id: string }) => r.namespace_id);
    });
  }

  async create(data: Partial<KnowledgeNamespace>): Promise<KnowledgeNamespace> {
    try {
      const row = await insert(this.db, kbNamespaces)
        .values(this.namespaceToInsert(data))
        .returning()
        .one();
      return this.rowToNamespace(row);
    } catch (error) {
      throw new RepositoryError(
        `Failed to create knowledge namespace: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<KnowledgeNamespace | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(kbNamespaces)
        .where(eq(kbNamespaces.namespace_id, fullId))
        .one();
      return row ? this.rowToNamespace(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  async findBySlug(slug: string): Promise<KnowledgeNamespace | null> {
    const row = await select(this.db)
      .from(kbNamespaces)
      .where(and(eq(kbNamespaces.slug, slug), eq(kbNamespaces.archived, false)))
      .one();
    return row ? this.rowToNamespace(row) : null;
  }

  async findAll(filters?: KnowledgeNamespaceFilters): Promise<KnowledgeNamespace[]> {
    const conditions = [];
    if (filters?.slug) conditions.push(eq(kbNamespaces.slug, filters.slug));
    if (filters?.kind) conditions.push(eq(kbNamespaces.kind, filters.kind));
    if (filters?.owner_user_id)
      conditions.push(eq(kbNamespaces.owner_user_id, filters.owner_user_id));
    if (filters?.repo_id) conditions.push(eq(kbNamespaces.repo_id, filters.repo_id));
    if (filters?.branch_id) conditions.push(eq(kbNamespaces.branch_id, filters.branch_id));
    conditions.push(eq(kbNamespaces.archived, filters?.archived ?? false));

    const rows = await select(this.db)
      .from(kbNamespaces)
      .where(and(...conditions))
      .orderBy(desc(kbNamespaces.updated_at))
      .all();
    return rows.map((row: KBNamespaceRow) => this.rowToNamespace(row));
  }

  async update(id: string, updates: Partial<KnowledgeNamespace>): Promise<KnowledgeNamespace> {
    const fullId = await this.resolveId(id);
    const current = await this.findById(fullId);
    if (!current) throw new EntityNotFoundError('KnowledgeNamespace', id);

    const merged = deepMerge(current, {
      ...updates,
      namespace_id: current.namespace_id,
      created_at: current.created_at,
      created_by: current.created_by,
      updated_at: new Date(),
    });

    const row = await update(this.db, kbNamespaces)
      .set(this.namespaceToInsert(merged))
      .where(eq(kbNamespaces.namespace_id, fullId))
      .returning()
      .one();
    return this.rowToNamespace(row);
  }

  rowToAclEntry(row: KBNamespaceAclRow): KnowledgeNamespaceAclEntry {
    return {
      namespace_acl_id: row.namespace_acl_id as KnowledgeNamespaceAclEntry['namespace_acl_id'],
      namespace_id: row.namespace_id as KnowledgeNamespaceID,
      subject_type: row.subject_type as KnowledgeNamespaceSubjectType,
      subject_id: row.subject_id as UserID | GroupID,
      permission: row.permission as KnowledgeNamespacePermission,
      created_by: (row.created_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
    };
  }

  async listNamespaceAcl(namespaceId: string): Promise<KnowledgeNamespaceAclEntry[]> {
    const fullId = await this.resolveId(namespaceId);
    const rows = await select(this.db)
      .from(kbNamespaceAcl)
      .where(eq(kbNamespaceAcl.namespace_id, fullId))
      .all();
    return rows.map((row: KBNamespaceAclRow) => this.rowToAclEntry(row));
  }

  async upsertNamespaceAclEntry(data: {
    namespace_id: string;
    subject_type: KnowledgeNamespaceSubjectType;
    subject_id: string;
    permission: KnowledgeNamespacePermission;
    created_by?: UserID | null;
  }): Promise<KnowledgeNamespaceAclEntry> {
    const fullId = await this.resolveId(data.namespace_id);
    const now = new Date();
    const existing = await select(this.db)
      .from(kbNamespaceAcl)
      .where(
        and(
          eq(kbNamespaceAcl.namespace_id, fullId),
          eq(kbNamespaceAcl.subject_type, data.subject_type),
          eq(kbNamespaceAcl.subject_id, data.subject_id)
        )
      )
      .one();

    if (existing) {
      await update(this.db, kbNamespaceAcl)
        .set({ permission: data.permission, updated_at: now })
        .where(eq(kbNamespaceAcl.namespace_acl_id, existing.namespace_acl_id))
        .run();
      const updated = await select(this.db)
        .from(kbNamespaceAcl)
        .where(eq(kbNamespaceAcl.namespace_acl_id, existing.namespace_acl_id))
        .one();
      if (!updated) throw new RepositoryError('Failed to retrieve updated namespace ACL entry');
      return this.rowToAclEntry(updated as KBNamespaceAclRow);
    }

    const insertRow: KBNamespaceAclInsert = {
      namespace_acl_id: generateId(),
      namespace_id: fullId,
      subject_type: data.subject_type,
      subject_id: data.subject_id,
      permission: data.permission,
      created_by: data.created_by ?? null,
      created_at: now,
      updated_at: now,
    };
    const row = await insert(this.db, kbNamespaceAcl).values(insertRow).returning().one();
    return this.rowToAclEntry(row);
  }

  async removeNamespaceAclEntry(
    namespaceId: string,
    subjectType: KnowledgeNamespaceSubjectType,
    subjectId: string
  ): Promise<KnowledgeNamespaceAclEntry | null> {
    const fullId = await this.resolveId(namespaceId);
    const existing = await select(this.db)
      .from(kbNamespaceAcl)
      .where(
        and(
          eq(kbNamespaceAcl.namespace_id, fullId),
          eq(kbNamespaceAcl.subject_type, subjectType),
          eq(kbNamespaceAcl.subject_id, subjectId)
        )
      )
      .one();
    if (!existing) return null;
    await deleteFrom(this.db, kbNamespaceAcl)
      .where(eq(kbNamespaceAcl.namespace_acl_id, existing.namespace_acl_id))
      .run();
    return this.rowToAclEntry(existing as KBNamespaceAclRow);
  }

  async replaceNamespaceAcl(
    namespaceId: string,
    entries: Array<{
      subject_type: KnowledgeNamespaceSubjectType;
      subject_id: string;
      permission: KnowledgeNamespacePermission;
      created_by?: UserID | null;
    }>
  ): Promise<KnowledgeNamespaceAclEntry[]> {
    const fullId = await this.resolveId(namespaceId);
    return this.db.transaction(async (tx) => {
      return this.replaceNamespaceAclInDb(txAsDb(tx), fullId, entries);
    });
  }

  private async replaceNamespaceAclInDb(
    db: Database,
    namespaceId: string,
    entries: Array<{
      subject_type: KnowledgeNamespaceSubjectType;
      subject_id: string;
      permission: KnowledgeNamespacePermission;
      created_by?: UserID | null;
    }>
  ): Promise<KnowledgeNamespaceAclEntry[]> {
    await deleteFrom(db, kbNamespaceAcl).where(eq(kbNamespaceAcl.namespace_id, namespaceId)).run();

    const now = new Date();
    const uniqueEntries = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      uniqueEntries.set(`${entry.subject_type}:${entry.subject_id}`, entry);
    }

    for (const entry of uniqueEntries.values()) {
      await insert(db, kbNamespaceAcl)
        .values({
          namespace_acl_id: generateId(),
          namespace_id: namespaceId,
          subject_type: entry.subject_type,
          subject_id: entry.subject_id,
          permission: entry.permission,
          created_by: entry.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .run();
    }

    const rows = await select(db)
      .from(kbNamespaceAcl)
      .where(eq(kbNamespaceAcl.namespace_id, namespaceId))
      .all();
    return rows.map((row: KBNamespaceAclRow) => this.rowToAclEntry(row));
  }

  async createWithAcl(
    data: Partial<KnowledgeNamespace>,
    entries: Array<{
      subject_type: KnowledgeNamespaceSubjectType;
      subject_id: string;
      permission: KnowledgeNamespacePermission;
      created_by?: UserID | null;
    }>
  ): Promise<{ namespace: KnowledgeNamespace; acl: KnowledgeNamespaceAclEntry[] }> {
    return this.db.transaction(async (tx) => {
      const txRepo = new KnowledgeNamespaceRepository(txAsDb(tx));
      const namespace = await txRepo.create(data);
      const acl = await txRepo.replaceNamespaceAclInDb(txAsDb(tx), namespace.namespace_id, entries);
      return { namespace, acl };
    });
  }

  async updateWithAcl(
    id: string,
    updates: Partial<KnowledgeNamespace>,
    entries: Array<{
      subject_type: KnowledgeNamespaceSubjectType;
      subject_id: string;
      permission: KnowledgeNamespacePermission;
      created_by?: UserID | null;
    }>
  ): Promise<{ namespace: KnowledgeNamespace; acl: KnowledgeNamespaceAclEntry[] }> {
    return this.db.transaction(async (tx) => {
      const txRepo = new KnowledgeNamespaceRepository(txAsDb(tx));
      const namespace = await txRepo.update(id, updates);
      const acl = await txRepo.replaceNamespaceAclInDb(txAsDb(tx), namespace.namespace_id, entries);
      return { namespace, acl };
    });
  }

  async resolveNamespacePermission(
    namespaceId: string,
    userId: string,
    options: ResolveKnowledgeNamespacePermissionOptions = {}
  ): Promise<KnowledgeNamespaceEffectivePermission> {
    if (options.isAdmin) return 'own';
    const namespace = await this.findById(namespaceId);
    if (!namespace || namespace.archived) return 'none';

    const directRows = await select(this.db)
      .from(kbNamespaceAcl)
      .where(
        and(
          eq(kbNamespaceAcl.namespace_id, namespace.namespace_id),
          eq(kbNamespaceAcl.subject_type, 'user'),
          eq(kbNamespaceAcl.subject_id, userId)
        )
      )
      .all();

    const groupRows = await select(this.db)
      .from(kbNamespaceAcl)
      .innerJoin(groupMemberships, eq(kbNamespaceAcl.subject_id, groupMemberships.group_id))
      .innerJoin(groups, eq(groupMemberships.group_id, groups.group_id))
      .where(
        and(
          eq(kbNamespaceAcl.namespace_id, namespace.namespace_id),
          eq(kbNamespaceAcl.subject_type, 'group'),
          eq(groupMemberships.user_id, userId),
          eq(groups.archived, false)
        )
      )
      .all();

    return maxKnowledgePermission([
      othersCanToPermission(namespace.others_can),
      namespace.owner_user_id === userId ? 'own' : null,
      ...directRows.map((row: KBNamespaceAclRow) => row.permission as KnowledgeNamespacePermission),
      ...groupRows.map(
        (row: { kb_namespace_acl: KBNamespaceAclRow }) =>
          row.kb_namespace_acl.permission as KnowledgeNamespacePermission
      ),
    ]);
  }

  async findReadableNamespaceIds(
    userId: string,
    options: ResolveKnowledgeNamespacePermissionOptions = {}
  ): Promise<KnowledgeNamespaceID[]> {
    const namespaces = await this.findAll({ archived: false });
    if (options.isAdmin) return namespaces.map((namespace) => namespace.namespace_id);

    const readable: KnowledgeNamespaceID[] = [];
    for (const namespace of namespaces) {
      const permission = await this.resolveNamespacePermission(namespace.namespace_id, userId);
      if (KNOWLEDGE_PERMISSION_RANK[permission] >= KNOWLEDGE_PERMISSION_RANK.read) {
        readable.push(namespace.namespace_id);
      }
    }
    return readable;
  }

  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);
    await this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      const archivedAt = new Date();
      const result = await update(txDb, kbNamespaces)
        .set({ archived: true, archived_at: archivedAt, updated_at: archivedAt })
        .where(eq(kbNamespaces.namespace_id, fullId))
        .run();
      if (result.rowsAffected === 0) throw new EntityNotFoundError('KnowledgeNamespace', id);
      await update(txDb, kbDocuments)
        .set({ archived: true, archived_at: archivedAt, updated_at: archivedAt })
        .where(eq(kbDocuments.namespace_id, fullId))
        .run();
    });
  }
}

export class KnowledgeDocumentVersionRepository
  implements BaseRepository<KnowledgeDocumentVersion, Partial<KnowledgeDocumentVersion>>
{
  constructor(private db: Database) {}

  rowToVersion(row: KBDocumentVersionRow): KnowledgeDocumentVersion {
    return {
      version_id: row.version_id as KnowledgeDocumentVersionID,
      document_id: row.document_id as KnowledgeDocumentID,
      version_number: row.version_number,
      content_text: row.content_text ?? null,
      content_blob: (row.content_blob as Uint8Array | null | undefined) ?? null,
      mime_type: row.mime_type,
      content_md5: row.content_md5 ?? null,
      content_sha256: row.content_sha256 ?? null,
      byte_length: row.byte_length ?? null,
      char_length: row.char_length ?? null,
      frontmatter: row.frontmatter ?? null,
      metadata: row.metadata ?? null,
      change_summary: row.change_summary ?? null,
      created_by: (row.created_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
    };
  }

  private versionToInsert(data: Partial<KnowledgeDocumentVersion>): KBDocumentVersionInsert {
    if (!data.document_id)
      throw new RepositoryError('Knowledge document version needs document_id');
    if (!data.version_number) {
      throw new RepositoryError('Knowledge document version needs version_number');
    }
    const content = data.content_text ?? '';
    const hashes = hashContent(content);
    return {
      version_id: (data.version_id ?? generateId()) as string,
      document_id: data.document_id,
      version_number: data.version_number,
      content_text: data.content_text ?? null,
      content_blob: null,
      mime_type: data.mime_type ?? MARKDOWN_MIME_TYPE,
      content_md5: data.content_md5 ?? hashes.md5,
      content_sha256: data.content_sha256 ?? hashes.sha256,
      byte_length: data.byte_length ?? hashes.byteLength,
      char_length: data.char_length ?? hashes.charLength,
      frontmatter: data.frontmatter ?? null,
      metadata: data.metadata ?? null,
      change_summary: data.change_summary ?? null,
      created_by: data.created_by ?? null,
      created_at: data.created_at ? new Date(data.created_at) : new Date(),
    };
  }

  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'KnowledgeDocumentVersion', async (pattern) => {
      const rows = await select(this.db)
        .from(kbDocumentVersions)
        .where(like(kbDocumentVersions.version_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { version_id: string }) => r.version_id);
    });
  }

  async create(data: Partial<KnowledgeDocumentVersion>): Promise<KnowledgeDocumentVersion> {
    const row = await insert(this.db, kbDocumentVersions)
      .values(this.versionToInsert(data))
      .returning()
      .one();
    return this.rowToVersion(row);
  }

  async findById(id: string): Promise<KnowledgeDocumentVersion | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(kbDocumentVersions)
        .where(eq(kbDocumentVersions.version_id, fullId))
        .one();
      return row ? this.rowToVersion(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  async findAll(filter?: {
    document_id?: KnowledgeDocumentID;
  }): Promise<KnowledgeDocumentVersion[]> {
    let query = select(this.db).from(kbDocumentVersions);
    if (filter?.document_id) {
      query = query.where(eq(kbDocumentVersions.document_id, filter.document_id)) as typeof query;
    }
    const rows = await query.orderBy(desc(kbDocumentVersions.created_at)).all();
    return rows.map((row: KBDocumentVersionRow) => this.rowToVersion(row));
  }

  async findLatestForDocument(
    documentId: KnowledgeDocumentID
  ): Promise<KnowledgeDocumentVersion | null> {
    const row = await select(this.db)
      .from(kbDocumentVersions)
      .where(eq(kbDocumentVersions.document_id, documentId))
      .orderBy(desc(kbDocumentVersions.version_number))
      .limit(1)
      .one();
    return row ? this.rowToVersion(row) : null;
  }

  async update(
    _id: string,
    _updates: Partial<KnowledgeDocumentVersion>
  ): Promise<KnowledgeDocumentVersion> {
    throw new RepositoryError('Knowledge document versions are immutable');
  }

  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);
    const result = await deleteFrom(this.db, kbDocumentVersions)
      .where(eq(kbDocumentVersions.version_id, fullId))
      .run();
    if (result.rowsAffected === 0) throw new EntityNotFoundError('KnowledgeDocumentVersion', id);
  }
}

export class KnowledgeDocumentRepository
  implements BaseRepository<KnowledgeDocument, KnowledgeDocumentWriteInput>
{
  constructor(private db: Database) {}

  rowToDocument(
    row: KBDocumentRow,
    options: { baseUrl?: string; namespaceSlug?: string | null } = {}
  ): KnowledgeDocument {
    const url =
      options.baseUrl && options.namespaceSlug
        ? getKnowledgeUrl(options.namespaceSlug, row.path, options.baseUrl)
        : null;
    return {
      document_id: row.document_id as KnowledgeDocumentID,
      namespace_id: row.namespace_id as KnowledgeNamespaceID,
      path: row.path,
      uri: row.uri,
      url,
      title: row.title,
      kind: row.kind as KnowledgeDocumentKind,
      visibility: row.visibility as KnowledgeVisibility,
      status: (row.status ?? 'published') as KnowledgeDocumentStatus,
      edit_policy: row.edit_policy as KnowledgeEditPolicy,
      current_version_id: (row.current_version_id as KnowledgeDocumentVersionID | null) ?? null,
      metadata: row.metadata ?? null,
      created_by: (row.created_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
      updated_by: (row.updated_by as UserID | null) ?? null,
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
      archived: Boolean(row.archived),
      archived_at: row.archived_at ? new Date(row.archived_at) : null,
    };
  }

  private async rowToDocumentWithUrl(row: KBDocumentRow): Promise<KnowledgeDocument> {
    const [baseUrl, namespace] = await Promise.all([
      getBaseUrl(),
      new KnowledgeNamespaceRepository(this.db).findById(row.namespace_id as KnowledgeNamespaceID),
    ]);
    return this.rowToDocument(row, { baseUrl, namespaceSlug: namespace?.slug });
  }

  private async namespaceByIdOrSlug(data: {
    namespace_id?: KnowledgeNamespaceID | null;
    namespace_slug?: string;
  }): Promise<KnowledgeNamespace> {
    const namespaceRepo = new KnowledgeNamespaceRepository(this.db);
    const ns = data.namespace_id
      ? await namespaceRepo.findById(data.namespace_id)
      : data.namespace_slug
        ? await namespaceRepo.findBySlug(data.namespace_slug)
        : null;
    if (!ns || ns.archived) throw new RepositoryError('Knowledge namespace not found');
    return ns;
  }

  private documentToInsert(
    data: Partial<KnowledgeDocument>,
    namespaceSlug: string
  ): KBDocumentInsert {
    const now = Date.now();
    if (!data.namespace_id)
      throw new RepositoryError('Knowledge document namespace_id is required');
    if (!data.path) throw new RepositoryError('Knowledge document path is required');
    const normalizedPath = normalizeKnowledgePath(data.path);

    return {
      document_id: (data.document_id ?? generateId()) as string,
      namespace_id: data.namespace_id,
      path: normalizedPath,
      uri: data.uri ?? buildKnowledgeUri(namespaceSlug, normalizedPath),
      title: data.title ?? titleFromKnowledgePath(normalizedPath),
      kind: data.kind ?? 'doc',
      visibility: data.visibility ?? 'public',
      status: data.status ?? 'published',
      edit_policy: data.edit_policy ?? 'owner',
      current_version_id: data.current_version_id ?? null,
      metadata: data.metadata ?? null,
      created_by: data.created_by ?? null,
      created_at: data.created_at ? new Date(data.created_at) : new Date(now),
      updated_by: data.updated_by ?? data.created_by ?? null,
      updated_at: data.updated_at ? new Date(data.updated_at) : new Date(now),
      archived: data.archived ?? false,
      archived_at: data.archived_at ? new Date(data.archived_at) : null,
    };
  }

  private unitToInsert(params: {
    documentId: KnowledgeDocumentID;
    versionId: KnowledgeDocumentVersionID;
    content: string;
    contentMd5: string;
  }): KBDocumentUnitInsert {
    return {
      unit_id: generateId() as KnowledgeDocumentUnitID,
      document_id: params.documentId,
      version_id: params.versionId,
      kind: 'document',
      ordinal: 0,
      path_anchor: null,
      heading_path: null,
      source_path: null,
      content_text: params.content,
      content_md5: params.contentMd5,
      start_offset: 0,
      end_offset: [...params.content].length,
      embedding_status: 'not_configured',
      embedding_model: null,
      embedding_dimensions: null,
      embedding_hash: null,
      embedding_error: null,
      metadata: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'KnowledgeDocument', async (pattern) => {
      const rows = await select(this.db)
        .from(kbDocuments)
        .where(like(kbDocuments.document_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { document_id: string }) => r.document_id);
    });
  }

  async create(data: KnowledgeDocumentWriteInput): Promise<KnowledgeDocument> {
    if (data.content_text === undefined) {
      throw new RepositoryError('Knowledge document content_text is required');
    }
    if ((data.mime_type ?? MARKDOWN_MIME_TYPE) !== MARKDOWN_MIME_TYPE) {
      throw new RepositoryError('Knowledge V1 only supports text/markdown documents');
    }

    const namespace = await this.namespaceByIdOrSlug(data);
    const documentId = (data.document_id ?? generateId()) as KnowledgeDocumentID;
    const versionId = generateId() as KnowledgeDocumentVersionID;
    const content = data.content_text;
    const hashes = hashContent(content);
    const baseUrl = await getBaseUrl();

    return await this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      const docInsert = this.documentToInsert(
        {
          ...data,
          document_id: documentId,
          namespace_id: namespace.namespace_id,
          visibility: data.visibility ?? namespace.visibility_default,
          current_version_id: null,
        },
        namespace.slug
      );

      await insert(txDb, kbDocuments).values(docInsert).run();

      await insert(txDb, kbDocumentVersions)
        .values({
          version_id: versionId,
          document_id: documentId,
          version_number: 1,
          content_text: content,
          content_blob: null,
          mime_type: MARKDOWN_MIME_TYPE,
          content_md5: hashes.md5,
          content_sha256: hashes.sha256,
          byte_length: hashes.byteLength,
          char_length: hashes.charLength,
          frontmatter: data.frontmatter ?? null,
          metadata: data.version_metadata ?? null,
          change_summary: data.change_summary ?? null,
          created_by: data.created_by ?? null,
          created_at: new Date(),
        })
        .run();

      await insert(txDb, kbDocumentUnits)
        .values(
          this.unitToInsert({
            documentId,
            versionId,
            content,
            contentMd5: hashes.md5,
          })
        )
        .run();

      const row = await update(txDb, kbDocuments)
        .set({ current_version_id: versionId, updated_at: new Date() })
        .where(eq(kbDocuments.document_id, documentId))
        .returning()
        .one();

      return this.rowToDocument(row, { baseUrl, namespaceSlug: namespace.slug });
    });
  }

  async findById(id: string): Promise<KnowledgeDocument | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(kbDocuments)
        .where(eq(kbDocuments.document_id, fullId))
        .one();
      return row ? this.rowToDocumentWithUrl(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  async findByNamespaceAndPath(
    namespaceId: KnowledgeNamespaceID,
    path: string
  ): Promise<KnowledgeDocument | null> {
    const row = await select(this.db)
      .from(kbDocuments)
      .where(
        and(
          eq(kbDocuments.namespace_id, namespaceId),
          eq(kbDocuments.path, normalizeKnowledgePath(path)),
          eq(kbDocuments.archived, false)
        )
      )
      .one();
    return row ? this.rowToDocumentWithUrl(row) : null;
  }

  async findByNamespaceSlugAndPath(
    namespaceSlug: string,
    path: string
  ): Promise<KnowledgeDocument | null> {
    const namespace = await new KnowledgeNamespaceRepository(this.db).findBySlug(namespaceSlug);
    if (!namespace) return null;
    return this.findByNamespaceAndPath(namespace.namespace_id, path);
  }

  async findByUnitId(unitId: string): Promise<KnowledgeDocument | null> {
    const unit = await select(this.db)
      .from(kbDocumentUnits)
      .where(eq(kbDocumentUnits.unit_id, unitId))
      .one();
    if (!unit) return null;
    return this.findById(unit.document_id);
  }

  async indexingStatusForDocuments(
    documentIds: KnowledgeDocumentID[]
  ): Promise<Map<KnowledgeDocumentID, KnowledgeDocumentIndexingStatus>> {
    const uniqueIds = [...new Set(documentIds)].filter(Boolean);
    const result = new Map<KnowledgeDocumentID, KnowledgeDocumentIndexingStatus>();
    if (uniqueIds.length === 0) return result;

    const emptyCounts = () =>
      Object.fromEntries(KNOWLEDGE_EMBEDDING_STATUSES.map((status) => [status, 0])) as Record<
        KnowledgeEmbeddingStatus,
        number
      >;

    for (const documentId of uniqueIds) {
      result.set(documentId as KnowledgeDocumentID, {
        state: 'empty',
        total_units: 0,
        chunks: emptyCounts(),
        queue_depth: 0,
        embedding_model: null,
        embedding_dimensions: null,
        last_error: null,
        last_updated_at: null,
      });
    }

    const rows = await select(this.db, {
      document_id: kbDocumentUnits.document_id,
      embedding_status: kbDocumentUnits.embedding_status,
      embedding_model: kbDocumentUnits.embedding_model,
      embedding_dimensions: kbDocumentUnits.embedding_dimensions,
      embedding_error: kbDocumentUnits.embedding_error,
      updated_at: kbDocumentUnits.updated_at,
    })
      .from(kbDocumentUnits)
      .innerJoin(
        kbDocuments,
        and(
          eq(kbDocumentUnits.document_id, kbDocuments.document_id),
          eq(kbDocumentUnits.version_id, kbDocuments.current_version_id)
        )
      )
      .where(inArray(kbDocumentUnits.document_id, uniqueIds))
      .all();

    for (const row of rows) {
      const documentId = row.document_id as KnowledgeDocumentID;
      const current =
        result.get(documentId) ??
        ({
          state: 'empty',
          total_units: 0,
          chunks: emptyCounts(),
          queue_depth: 0,
          embedding_model: null,
          embedding_dimensions: null,
          last_error: null,
          last_updated_at: null,
        } satisfies KnowledgeDocumentIndexingStatus);
      const status = row.embedding_status as keyof typeof current.chunks;
      current.total_units += 1;
      current.chunks[status] += 1;
      if (!current.embedding_model && row.embedding_model)
        current.embedding_model = row.embedding_model;
      if (!current.embedding_dimensions && row.embedding_dimensions) {
        current.embedding_dimensions = row.embedding_dimensions;
      }
      if (!current.last_error && row.embedding_error) current.last_error = row.embedding_error;
      const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
      if (
        updatedAt &&
        (!current.last_updated_at || updatedAt.getTime() > current.last_updated_at.getTime())
      ) {
        current.last_updated_at = updatedAt;
      }
      result.set(documentId, current);
    }

    for (const status of result.values()) {
      status.queue_depth = status.chunks.pending + status.chunks.stale;
      if (status.total_units === 0) status.state = 'empty';
      else if (status.chunks.error > 0) status.state = 'error';
      else if (status.chunks.stale > 0) status.state = 'stale';
      else if (status.chunks.pending > 0) status.state = 'queued';
      else if (status.chunks.ready === status.total_units) status.state = 'ready';
      else if (status.chunks.not_configured === status.total_units) status.state = 'not_configured';
      else status.state = 'mixed';
    }

    return result;
  }

  async attachIndexingStatus<T extends KnowledgeDocument>(documents: T | T[]): Promise<T | T[]> {
    const list = Array.isArray(documents) ? documents : [documents];
    const statuses = await this.indexingStatusForDocuments(list.map((doc) => doc.document_id));
    const withStatus = list.map((doc) => ({
      ...doc,
      indexing_status: statuses.get(doc.document_id) ?? null,
    }));
    return Array.isArray(documents) ? withStatus : withStatus[0];
  }

  async findAll(filters?: KnowledgeDocumentFilters): Promise<KnowledgeDocument[]> {
    const conditions = [];
    let namespaceId = filters?.namespace_id;
    if (!namespaceId && filters?.namespace_slug) {
      const namespace = await new KnowledgeNamespaceRepository(this.db).findBySlug(
        filters.namespace_slug
      );
      namespaceId = namespace?.namespace_id;
      if (!namespaceId) return [];
    }
    if (namespaceId) conditions.push(eq(kbDocuments.namespace_id, namespaceId));
    if (filters?.path) conditions.push(eq(kbDocuments.path, normalizeKnowledgePath(filters.path)));
    if (filters?.kind) conditions.push(eq(kbDocuments.kind, filters.kind));
    if (filters?.visibility) conditions.push(eq(kbDocuments.visibility, filters.visibility));
    const draftCondition = knowledgeDraftVisibilityCondition({
      status: filters?.status,
      userId: filters?.draft_filter_user_id,
      includeMyDrafts: filters?.include_my_drafts,
      includeOtherUserDrafts: filters?.include_other_user_drafts,
    });
    if (draftCondition) conditions.push(draftCondition);
    conditions.push(eq(kbDocuments.archived, filters?.archived ?? false));
    if (filters?.archived !== true) {
      conditions.push(sql`exists (
        select 1 from ${kbNamespaces}
        where ${kbNamespaces.namespace_id} = ${kbDocuments.namespace_id}
          and ${kbNamespaces.archived} = false
      )`);
    }

    const rows = await select(this.db)
      .from(kbDocuments)
      .where(and(...conditions))
      .orderBy(desc(kbDocuments.updated_at))
      .all();
    const [baseUrl, namespaceRows] = await Promise.all([
      getBaseUrl(),
      select(this.db).from(kbNamespaces).all(),
    ]);
    const namespaceSlugById = new Map<string, string>(
      namespaceRows.map((row: KBNamespaceRow) => [row.namespace_id, row.slug])
    );
    return rows.map((row: KBDocumentRow) =>
      this.rowToDocument(row, {
        baseUrl,
        namespaceSlug: namespaceSlugById.get(row.namespace_id),
      })
    );
  }

  async update(id: string, updates: KnowledgeDocumentWriteInput): Promise<KnowledgeDocument> {
    const fullId = await this.resolveId(id);
    if (updates.mime_type && updates.mime_type !== MARKDOWN_MIME_TYPE) {
      throw new RepositoryError('Knowledge V1 only supports text/markdown documents');
    }
    const baseUrl = await getBaseUrl();

    return await this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      await lockRowForUpdate(txDb, this.db, kbDocuments, eq(kbDocuments.document_id, fullId));

      const currentRow = await select(txDb)
        .from(kbDocuments)
        .where(eq(kbDocuments.document_id, fullId))
        .one();
      if (!currentRow) throw new EntityNotFoundError('KnowledgeDocument', id);
      const current = this.rowToDocument(currentRow);
      const namespace = await new KnowledgeNamespaceRepository(txDb).findById(current.namespace_id);
      if (!namespace) throw new RepositoryError('Knowledge namespace not found');

      let nextVersionId = current.current_version_id ?? null;
      if (updates.content_text !== undefined) {
        const latestRow = await select(txDb)
          .from(kbDocumentVersions)
          .where(eq(kbDocumentVersions.document_id, current.document_id))
          .orderBy(desc(kbDocumentVersions.version_number))
          .limit(1)
          .one();
        const versionNumber = (latestRow?.version_number ?? 0) + 1;
        const content = updates.content_text;
        const hashes = hashContent(content);
        nextVersionId = generateId() as KnowledgeDocumentVersionID;

        await insert(txDb, kbDocumentVersions)
          .values({
            version_id: nextVersionId,
            document_id: current.document_id,
            version_number: versionNumber,
            content_text: content,
            content_blob: null,
            mime_type: MARKDOWN_MIME_TYPE,
            content_md5: hashes.md5,
            content_sha256: hashes.sha256,
            byte_length: hashes.byteLength,
            char_length: hashes.charLength,
            frontmatter: updates.frontmatter ?? null,
            metadata: updates.version_metadata ?? null,
            change_summary: updates.change_summary ?? null,
            created_by: updates.updated_by ?? current.updated_by ?? current.created_by ?? null,
            created_at: new Date(),
          })
          .run();

        await insert(txDb, kbDocumentUnits)
          .values(
            this.unitToInsert({
              documentId: current.document_id,
              versionId: nextVersionId,
              content,
              contentMd5: hashes.md5,
            })
          )
          .run();
      }

      const merged = deepMerge(current, {
        ...updates,
        document_id: current.document_id,
        namespace_id: current.namespace_id,
        created_at: current.created_at,
        created_by: current.created_by,
        current_version_id: nextVersionId,
        updated_at: new Date(),
      });
      delete (merged as Partial<UpdateKnowledgeDocumentInput>).content_text;
      delete (merged as Partial<UpdateKnowledgeDocumentInput>).frontmatter;
      delete (merged as Partial<UpdateKnowledgeDocumentInput>).version_metadata;
      delete (merged as Partial<UpdateKnowledgeDocumentInput>).change_summary;
      delete (merged as Partial<UpdateKnowledgeDocumentInput>).mime_type;
      merged.uri = buildKnowledgeUri(namespace.slug, normalizeKnowledgePath(merged.path));

      const row = await update(txDb, kbDocuments)
        .set(this.documentToInsert(merged, namespace.slug))
        .where(eq(kbDocuments.document_id, fullId))
        .returning()
        .one();
      return this.rowToDocument(row, { baseUrl, namespaceSlug: namespace.slug });
    });
  }

  async replaceUnitsForVersion(
    versionId: KnowledgeDocumentVersionID,
    units: ReplaceKnowledgeUnitInput[],
    options: { embeddingConfigured?: boolean } = {}
  ): Promise<void> {
    const version = await new KnowledgeDocumentVersionRepository(this.db).findById(versionId);
    if (!version) throw new EntityNotFoundError('KnowledgeDocumentVersion', versionId);
    await this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      await deleteFrom(txDb, kbDocumentUnits)
        .where(eq(kbDocumentUnits.version_id, versionId))
        .run();
      if (units.length === 0) return;
      await insert(txDb, kbDocumentUnits)
        .values(
          units.map((unit) => ({
            unit_id: deterministicKnowledgeUnitId(version.version_id, unit),
            document_id: version.document_id,
            version_id: version.version_id,
            kind: unit.kind,
            ordinal: unit.ordinal,
            path_anchor: unit.path_anchor ?? null,
            heading_path: unit.heading_path ?? null,
            source_path: unit.source_path ?? null,
            content_text: unit.content_text,
            content_md5: unit.content_md5,
            start_offset: unit.start_offset ?? null,
            end_offset: unit.end_offset ?? null,
            embedding_status: options.embeddingConfigured ? 'pending' : 'not_configured',
            embedding_model: null,
            embedding_dimensions: null,
            embedding_hash: null,
            embedding_error: null,
            metadata: unit.metadata ?? null,
            created_at: new Date(),
            updated_at: new Date(),
          }))
        )
        .run();
    });
  }

  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);
    const result = await update(this.db, kbDocuments)
      .set({ archived: true, archived_at: new Date(), updated_at: new Date() })
      .where(eq(kbDocuments.document_id, fullId))
      .run();
    if (result.rowsAffected === 0) throw new EntityNotFoundError('KnowledgeDocument', id);
  }
}

export class KnowledgeSearchRepository {
  private documents: KnowledgeDocumentRepository;
  private namespaces: KnowledgeNamespaceRepository;
  private versions: KnowledgeDocumentVersionRepository;

  constructor(private db: Database) {
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
    this.versions = new KnowledgeDocumentVersionRepository(db);
  }

  async search(query: KnowledgeSearchQuery): Promise<KnowledgeSearchResult[]> {
    const mode = query.mode ?? 'text';
    if (mode !== 'text') {
      throw new RepositoryError(
        'Semantic Knowledge search is not configured yet. Use mode:"text" or configure Postgres + pgvector embeddings.'
      );
    }
    const q = query.q?.trim() ?? '';
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    let namespaceId = query.namespace_id;
    if (!namespaceId && query.namespace_slug) {
      const namespace = await this.namespaces.findBySlug(query.namespace_slug);
      namespaceId = namespace?.namespace_id;
      if (!namespaceId) return [];
    }

    const conditions = [];
    if (!query.include_archived) {
      conditions.push(eq(kbDocuments.archived, false));
      conditions.push(eq(kbNamespaces.archived, false));
    }
    if (query.readable_namespace_ids) {
      if (query.readable_namespace_ids.length === 0) return [];
      conditions.push(inArray(kbDocuments.namespace_id, query.readable_namespace_ids));
    }
    if (namespaceId) conditions.push(eq(kbDocuments.namespace_id, namespaceId));
    if (query.path_prefix) {
      const prefix = normalizeKnowledgeFolderPath(query.path_prefix);
      if (prefix) {
        conditions.push(or(eq(kbDocuments.path, prefix), like(kbDocuments.path, `${prefix}/%`))!);
      }
    }
    if (query.kind) conditions.push(eq(kbDocuments.kind, query.kind));
    if (query.visibility) conditions.push(eq(kbDocuments.visibility, query.visibility));
    const draftCondition = knowledgeDraftVisibilityCondition({
      status: query.status,
      userId: query.readable_by_user_id,
      includeMyDrafts: query.include_my_drafts ?? query.includeMyDrafts,
      includeOtherUserDrafts: query.include_other_user_drafts ?? query.includeOtherUserDrafts,
    });
    if (draftCondition) conditions.push(draftCondition);
    if (!query.readable_as_admin) {
      conditions.push(
        query.readable_by_user_id
          ? or(
              eq(kbDocuments.visibility, 'public'),
              eq(kbDocuments.created_by, query.readable_by_user_id)
            )!
          : eq(kbDocuments.visibility, 'public')
      );
    }

    const needle = q.toLowerCase();
    const terms = needle
      .split(/[^a-z0-9-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);

    if (q) {
      const patterns = [`%${needle}%`, ...terms.map((term) => `%${term}%`)];
      conditions.push(
        or(
          ...patterns.flatMap((pattern) => [
            sql`lower(${kbDocuments.title}) like ${pattern}`,
            sql`lower(${kbDocuments.path}) like ${pattern}`,
            sql`lower(${kbDocumentVersions.content_text}) like ${pattern}`,
          ])
        )!
      );
    }

    let dbQuery = select(this.db)
      .from(kbDocuments)
      .innerJoin(kbNamespaces, eq(kbDocuments.namespace_id, kbNamespaces.namespace_id))
      .leftJoin(
        kbDocumentVersions,
        eq(kbDocuments.current_version_id, kbDocumentVersions.version_id)
      );
    if (conditions.length > 0) {
      dbQuery = dbQuery.where(and(...conditions)) as typeof dbQuery;
    }

    const rows = (await dbQuery
      .orderBy(desc(kbDocuments.updated_at))
      .limit(q ? Math.max(limit, 100) : limit)
      .all()) as Array<Record<string, unknown>>;
    const baseUrl = await getBaseUrl();

    return rows
      .map((row: Record<string, unknown>): KnowledgeSearchResult => {
        const namespace = this.namespaces.rowToNamespace(row.kb_namespaces as KBNamespaceRow);
        const document = this.documents.rowToDocument(row.kb_documents as KBDocumentRow, {
          baseUrl,
          namespaceSlug: namespace.slug,
        });
        const version = row.kb_document_versions
          ? this.versions.rowToVersion(row.kb_document_versions as KBDocumentVersionRow)
          : null;
        const hayTitle = document.title.toLowerCase();
        const hayPath = document.path.toLowerCase();
        const hayContent = (version?.content_text ?? '').toLowerCase();
        let score = 0;
        if (needle) {
          if (hayTitle === needle) score += 100;
          else if (hayTitle.includes(needle)) score += 60;
          if (hayPath.includes(needle)) score += 30;
          if (hayContent.includes(needle)) score += 15;
          let matchedTerms = 0;
          for (const term of terms) {
            const matched =
              hayTitle.includes(term) || hayPath.includes(term) || hayContent.includes(term);
            if (!matched) continue;
            matchedTerms += 1;
            if (hayTitle.includes(term)) score += 10;
            if (hayPath.includes(term)) score += 5;
            if (hayContent.includes(term)) score += 2;
          }
          if (terms.length > 0 && matchedTerms === terms.length) score += 20;
        }
        return {
          document,
          namespace,
          current_version: version,
          snippet: makeSnippet(version?.content_text, q),
          score,
          mode: 'text' as const,
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          new Date(b.document.updated_at ?? 0).getTime() -
            new Date(a.document.updated_at ?? 0).getTime()
      )
      .slice(0, limit);
  }
}

function canonicalNodeRef(ref: KnowledgeNodeRef): KnowledgeNodeRef {
  return {
    ...ref,
    node_id: ref.node_id ?? ref.nodeId,
    node_type: ref.node_type ?? ref.nodeType,
    document_id: ref.document_id ?? ref.documentId,
    unit_id: ref.unit_id ?? ref.unitId,
    namespace_id: ref.namespace_id ?? ref.namespaceId,
    external_uri: ref.external_uri ?? ref.externalUri,
    branch_id: ref.branch_id ?? ref.branchId,
    session_id: ref.session_id ?? ref.sessionId,
    task_id: ref.task_id ?? ref.taskId,
    message_id: ref.message_id ?? ref.messageId,
    artifact_id: ref.artifact_id ?? ref.artifactId,
    repo_id: ref.repo_id ?? ref.repoId,
    board_id: ref.board_id ?? ref.boardId,
    user_id: ref.user_id ?? ref.userId,
  };
}

function firstPresent<T extends string>(
  ref: KnowledgeNodeRef,
  keys: Array<keyof KnowledgeNodeRef>
): T | undefined {
  for (const key of keys) {
    const value = ref[key];
    if (typeof value === 'string' && value) return value as T;
  }
  return undefined;
}

export class KnowledgeGraphRepository {
  constructor(private db: Database) {}

  rowToNode(row: KBGraphNodeRow): KnowledgeGraphNode {
    return {
      node_id: row.node_id as KnowledgeGraphNodeID,
      node_type: row.node_type as KnowledgeGraphNodeType,
      uri: row.uri,
      label: row.label ?? null,
      namespace_id: (row.namespace_id as KnowledgeNamespaceID | null) ?? null,
      document_id: (row.document_id as KnowledgeDocumentID | null) ?? null,
      unit_id: (row.unit_id as KnowledgeDocumentUnitID | null) ?? null,
      branch_id: row.branch_id as KnowledgeGraphNode['branch_id'],
      session_id: row.session_id as KnowledgeGraphNode['session_id'],
      task_id: row.task_id as KnowledgeGraphNode['task_id'],
      message_id: row.message_id as KnowledgeGraphNode['message_id'],
      artifact_id: row.artifact_id as KnowledgeGraphNode['artifact_id'],
      repo_id: row.repo_id as KnowledgeGraphNode['repo_id'],
      board_id: row.board_id as KnowledgeGraphNode['board_id'],
      user_id: row.user_id as KnowledgeGraphNode['user_id'],
      external_uri: row.external_uri ?? null,
      metadata: row.metadata ?? null,
      created_by: (row.created_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
      archived: Boolean(row.archived),
      archived_at: row.archived_at ? new Date(row.archived_at) : null,
    };
  }

  rowToEdge(row: KBGraphEdgeRow): KnowledgeGraphEdge {
    return {
      edge_id: row.edge_id as KnowledgeGraphEdgeID,
      source_node_id: row.source_node_id as KnowledgeGraphNodeID,
      target_node_id: row.target_node_id as KnowledgeGraphNodeID,
      edge_type: row.edge_type as KnowledgeGraphEdgeType,
      // DB stores confidence as basis points (0..10000) so SQLite/Postgres can
      // keep the dual-schema integer shape while the API exposes 0..1.
      confidence: row.confidence == null ? null : row.confidence / 10000,
      properties: row.properties ?? null,
      created_by: (row.created_by as UserID | null) ?? null,
      created_at: new Date(row.created_at),
      archived: Boolean(row.archived),
      archived_at: row.archived_at ? new Date(row.archived_at) : null,
    };
  }

  private async resolveNodeById(id: string): Promise<KnowledgeGraphNode | null> {
    const fullId = await resolveByShortIdPrefix(id, 'KnowledgeGraphNode', async (pattern) => {
      const rows = await select(this.db)
        .from(kbGraphNodes)
        .where(like(kbGraphNodes.node_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { node_id: string }) => r.node_id);
    });
    const row = await select(this.db)
      .from(kbGraphNodes)
      .where(eq(kbGraphNodes.node_id, fullId))
      .one();
    return row ? this.rowToNode(row) : null;
  }

  private deriveNodeInsert(
    refInput: KnowledgeNodeRef,
    createdBy?: UserID | null
  ): KBGraphNodeInsert {
    const ref = canonicalNodeRef(refInput);
    const uri = this.deriveNodeUri(ref);
    const nodeType = this.deriveNodeType(ref);
    return {
      node_id: generateId(),
      node_type: nodeType,
      uri,
      label: ref.label ?? null,
      namespace_id: ref.namespace_id ?? null,
      document_id: ref.document_id ?? null,
      unit_id: ref.unit_id ?? null,
      branch_id: ref.branch_id ?? null,
      session_id: ref.session_id ?? null,
      task_id: ref.task_id ?? null,
      message_id: ref.message_id ?? null,
      artifact_id: ref.artifact_id ?? null,
      repo_id: ref.repo_id ?? null,
      board_id: ref.board_id ?? null,
      user_id: ref.user_id ?? null,
      external_uri: ref.external_uri ?? (nodeType === 'external' ? uri : null),
      metadata: null,
      created_by: createdBy ?? null,
      created_at: new Date(),
      updated_at: new Date(),
      archived: false,
      archived_at: null,
    };
  }

  private deriveNodeType(ref: KnowledgeNodeRef): KnowledgeGraphNodeType {
    if (ref.node_type) return ref.node_type;
    // Document/unit refs carry a `namespace_id` too, so resolve them before the
    // bare-namespace check — otherwise a document node gets mistyped as
    // 'namespace' and drops out of document-scoped graph queries.
    if (ref.unit_id || ref.uri?.startsWith(KNOWLEDGE_UNIT_URI_PREFIX)) return 'document_unit';
    if (
      ref.document_id ||
      (ref.namespace && ref.path) ||
      ref.uri?.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX) ||
      parseKnowledgeUri(ref.uri)
    )
      return 'document';
    if (ref.namespace_id) return 'namespace';
    if (ref.branch_id) return 'branch';
    if (ref.session_id) return 'session';
    if (ref.task_id) return 'task';
    if (ref.message_id) return 'message';
    if (ref.artifact_id) return 'artifact';
    if (ref.repo_id) return 'repo';
    if (ref.board_id) return 'board';
    if (ref.user_id) return 'user';
    if (ref.external_uri || ref.uri) return 'external';
    throw new RepositoryError('Unable to infer knowledge graph node type');
  }

  private deriveNodeUri(ref: KnowledgeNodeRef): string {
    if (ref.uri) return ref.uri;
    if (ref.namespace && ref.path)
      return buildKnowledgeUri(ref.namespace, normalizeKnowledgePath(ref.path));
    // Document/unit refs carry a `namespace_id` too, so derive their typed URIs
    // before the bare-namespace fallback — otherwise a document node would get a
    // namespace URI while `deriveNodeType` types it as 'document', producing a
    // mismatched node.
    if (ref.document_id) return buildKnowledgeDocumentUri(ref.document_id);
    if (ref.unit_id) return buildKnowledgeUnitUri(ref.unit_id);
    const typed = [
      ['namespace', ref.namespace_id],
      ['branch', ref.branch_id],
      ['session', ref.session_id],
      ['task', ref.task_id],
      ['message', ref.message_id],
      ['artifact', ref.artifact_id],
      ['repo', ref.repo_id],
      ['board', ref.board_id],
      ['user', ref.user_id],
    ] as const;
    for (const [kind, value] of typed) {
      if (value) return `agor://${kind}/${value}`;
    }
    if (ref.external_uri) return ref.external_uri;
    throw new RepositoryError('Unable to derive knowledge graph node URI');
  }

  async getOrCreateNode(
    refInput: KnowledgeNodeRef,
    createdBy?: UserID | null
  ): Promise<KnowledgeGraphNode> {
    const ref = canonicalNodeRef(refInput);
    const nodeId = firstPresent(ref, ['node_id']);
    if (nodeId) {
      const byId = await this.resolveNodeById(nodeId);
      if (byId) return byId;
    }

    const uri = this.deriveNodeUri(ref);
    const existing = await select(this.db)
      .from(kbGraphNodes)
      .where(and(eq(kbGraphNodes.uri, uri), eq(kbGraphNodes.archived, false)))
      .one();
    if (existing) return this.rowToNode(existing);

    const row = await insert(this.db, kbGraphNodes)
      .values(this.deriveNodeInsert({ ...ref, uri }, createdBy))
      .returning()
      .one();
    return this.rowToNode(row);
  }

  async findNode(
    refInput: KnowledgeNodeRef,
    options?: { includeArchived?: boolean }
  ): Promise<KnowledgeGraphNode | null> {
    const ref = canonicalNodeRef(refInput);
    const nodeId = firstPresent(ref, ['node_id']);
    if (nodeId) {
      try {
        const node = await this.resolveNodeById(nodeId);
        if (!node) return null;
        if (node.archived && !options?.includeArchived) return null;
        return node;
      } catch (error) {
        if (error instanceof EntityNotFoundError) return null;
        throw error;
      }
    }

    const uri = this.deriveNodeUri(ref);
    const conditions = [eq(kbGraphNodes.uri, uri)];
    if (!options?.includeArchived) conditions.push(eq(kbGraphNodes.archived, false));
    const row = await select(this.db)
      .from(kbGraphNodes)
      .where(and(...conditions))
      .one();
    return row ? this.rowToNode(row) : null;
  }

  async link(input: KnowledgeGraphLinkInput): Promise<KnowledgeGraphEdge> {
    const source = await this.getOrCreateNode(input.source, input.created_by);
    const target = await this.getOrCreateNode(input.target, input.created_by);
    const existing = await select(this.db)
      .from(kbGraphEdges)
      .where(
        and(
          eq(kbGraphEdges.source_node_id, source.node_id),
          eq(kbGraphEdges.target_node_id, target.node_id),
          eq(kbGraphEdges.edge_type, input.edge_type),
          eq(kbGraphEdges.archived, false)
        )
      )
      .one();
    if (existing) return this.rowToEdge(existing);

    const row = await insert(this.db, kbGraphEdges)
      .values({
        edge_id: generateId(),
        source_node_id: source.node_id,
        target_node_id: target.node_id,
        edge_type: input.edge_type,
        confidence: input.confidence == null ? null : Math.round(input.confidence * 10000),
        properties: input.properties ?? null,
        created_by: input.created_by ?? null,
        created_at: new Date(),
        archived: false,
        archived_at: null,
      } satisfies KBGraphEdgeInsert)
      .returning()
      .one();
    return this.rowToEdge(row);
  }

  /**
   * Idempotently replace the set of outgoing edges of a single type from one
   * source node. Edges to targets no longer present are archived; new targets
   * are linked. Used to keep derived edges (e.g. doc-to-doc `references`) in
   * sync with a document's content on every save.
   */
  async syncOutgoingEdges(input: {
    source: KnowledgeNodeRef;
    edge_type: KnowledgeGraphEdgeType;
    targets: KnowledgeNodeRef[];
    created_by?: UserID | null;
  }): Promise<void> {
    const source = await this.getOrCreateNode(input.source, input.created_by);

    const desiredTargetIds = new Set<string>();
    for (const ref of input.targets) {
      const target = await this.getOrCreateNode(ref, input.created_by);
      if (target.node_id === source.node_id) continue;
      desiredTargetIds.add(target.node_id);
    }

    const existingEdges = await select(this.db)
      .from(kbGraphEdges)
      .where(
        and(
          eq(kbGraphEdges.source_node_id, source.node_id),
          eq(kbGraphEdges.edge_type, input.edge_type),
          eq(kbGraphEdges.archived, false)
        )
      )
      .all();
    const existingTargetIds = new Set(existingEdges.map((e: KBGraphEdgeRow) => e.target_node_id));

    for (const edge of existingEdges) {
      if (desiredTargetIds.has(edge.target_node_id)) continue;
      await update(this.db, kbGraphEdges)
        .set({ archived: true, archived_at: new Date() })
        .where(eq(kbGraphEdges.edge_id, edge.edge_id))
        .run();
    }

    for (const targetNodeId of desiredTargetIds) {
      if (existingTargetIds.has(targetNodeId)) continue;
      await insert(this.db, kbGraphEdges)
        .values({
          edge_id: generateId(),
          source_node_id: source.node_id,
          target_node_id: targetNodeId,
          edge_type: input.edge_type,
          confidence: null,
          properties: null,
          created_by: input.created_by ?? null,
          created_at: new Date(),
          archived: false,
          archived_at: null,
        } satisfies KBGraphEdgeInsert)
        .run();
    }
  }

  async neighbors(query: KnowledgeGraphNeighborsQuery): Promise<KnowledgeGraphNeighborsResult> {
    const center = await this.findNode(query.node, { includeArchived: query.include_archived });
    if (!center) throw new EntityNotFoundError('KnowledgeGraphNode', JSON.stringify(query.node));
    const direction = query.direction ?? 'both';
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const edgeConditions = [];
    if (!query.include_archived) edgeConditions.push(eq(kbGraphEdges.archived, false));
    if (query.edge_types?.length) {
      edgeConditions.push(or(...query.edge_types.map((t) => eq(kbGraphEdges.edge_type, t)))!);
    }
    const dirCondition =
      direction === 'out'
        ? eq(kbGraphEdges.source_node_id, center.node_id)
        : direction === 'in'
          ? eq(kbGraphEdges.target_node_id, center.node_id)
          : or(
              eq(kbGraphEdges.source_node_id, center.node_id),
              eq(kbGraphEdges.target_node_id, center.node_id)
            )!;
    edgeConditions.push(dirCondition);

    const edgeRows = await select(this.db)
      .from(kbGraphEdges)
      .where(and(...edgeConditions))
      .limit(limit)
      .all();
    const edges = edgeRows.map((row: KBGraphEdgeRow) => this.rowToEdge(row));
    const nodeIds = new Set<string>();
    for (const edge of edges) {
      nodeIds.add(edge.source_node_id);
      nodeIds.add(edge.target_node_id);
    }
    nodeIds.delete(center.node_id);

    const nodes: KnowledgeGraphNode[] = [];
    for (const nodeId of nodeIds) {
      const row = await select(this.db)
        .from(kbGraphNodes)
        .where(eq(kbGraphNodes.node_id, nodeId))
        .one();
      if (!row) continue;
      const node = this.rowToNode(row);
      if (node.archived && !query.include_archived) continue;
      if (query.node_types?.length && !query.node_types.includes(node.node_type)) continue;
      nodes.push(node);
    }

    return { center, nodes, edges };
  }

  /**
   * Return every doc-to-doc edge whose endpoints are both document nodes in the
   * given namespace, expressed in document-id terms. Powers the namespace-wide
   * graph view. Cross-namespace edges (one endpoint outside the namespace) are
   * excluded since only nodes carrying this `namespace_id` are considered.
   */
  async documentEdgesForNamespace(
    query: KnowledgeNamespaceGraphQuery
  ): Promise<KnowledgeDocumentEdge[]> {
    const nodeRows = await select(this.db)
      .from(kbGraphNodes)
      .where(
        and(
          eq(kbGraphNodes.namespace_id, query.namespace_id),
          eq(kbGraphNodes.node_type, 'document'),
          eq(kbGraphNodes.archived, false)
        )
      )
      .all();

    const documentIdByNodeId = new Map<string, KnowledgeDocumentID>();
    for (const row of nodeRows) {
      if (row.document_id) {
        documentIdByNodeId.set(row.node_id, row.document_id as KnowledgeDocumentID);
      }
    }
    const nodeIds = [...documentIdByNodeId.keys()];
    if (nodeIds.length === 0) return [];

    const edgeConditions = [
      inArray(kbGraphEdges.source_node_id, nodeIds),
      inArray(kbGraphEdges.target_node_id, nodeIds),
    ];
    if (!query.include_archived) edgeConditions.push(eq(kbGraphEdges.archived, false));
    if (query.edge_types?.length) {
      edgeConditions.push(or(...query.edge_types.map((t) => eq(kbGraphEdges.edge_type, t)))!);
    }

    const edgeRows = await select(this.db)
      .from(kbGraphEdges)
      .where(and(...edgeConditions))
      .all();

    const edges: KnowledgeDocumentEdge[] = [];
    for (const row of edgeRows) {
      const source = documentIdByNodeId.get(row.source_node_id);
      const target = documentIdByNodeId.get(row.target_node_id);
      if (!source || !target || source === target) continue;
      edges.push({
        source_document_id: source,
        target_document_id: target,
        edge_type: row.edge_type as KnowledgeGraphEdgeType,
      });
    }
    return edges;
  }
}
