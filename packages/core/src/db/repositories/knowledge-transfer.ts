import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { transferLiveDigest } from '../../knowledge/transfer';
import { generateId } from '../../lib/ids';
import type {
  KnowledgeTransferInventoryEntry,
  KnowledgeTransferInventoryRow,
  UserID,
} from '../../types';
import { KNOWLEDGE_TRANSFER } from '../../types';
import type { Database } from '../client';
import { insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { kbDocuments, kbDocumentVersions, kbImportReceipts, users } from '../schema';

export class KnowledgeTransferRepository {
  constructor(private db: Database) {}
  async versionHeader(versionId: string, documentId: string) {
    const actualBytes = isPostgresDatabase(this.db)
      ? sql<number>`octet_length(${kbDocumentVersions.content_text})`
      : sql<number>`length(cast(${kbDocumentVersions.content_text} as blob))`;
    return select(this.db, {
      bytes: actualBytes,
      mime: kbDocumentVersions.mime_type,
      hasBlob: sql<boolean>`${kbDocumentVersions.content_blob} is not null`,
    })
      .from(kbDocumentVersions)
      .where(
        and(
          eq(kbDocumentVersions.version_id, versionId),
          eq(kbDocumentVersions.document_id, documentId)
        )
      )
      .one();
  }
  async currentDigest(
    targetId: string,
    owner: UserID,
    namespaceId: string
  ): Promise<string | null> {
    const row = await select(this.db, {
      path: kbDocuments.path,
      title: kbDocuments.title,
      icon_emoji: kbDocuments.icon_emoji,
      kind: kbDocuments.kind,
      status: kbDocuments.status,
      visibility: kbDocuments.visibility,
      edit_policy: kbDocuments.edit_policy,
      metadata: kbDocuments.metadata,
      content_sha256: kbDocumentVersions.content_sha256,
      frontmatter: kbDocumentVersions.frontmatter,
    })
      .from(kbDocuments)
      .innerJoin(
        kbDocumentVersions,
        eq(kbDocuments.current_version_id, kbDocumentVersions.version_id)
      )
      .where(
        and(
          eq(kbDocuments.document_id, targetId),
          eq(kbDocuments.namespace_id, namespaceId),
          eq(kbDocuments.created_by, owner),
          eq(kbDocuments.archived, false)
        )
      )
      .one();
    return row ? transferLiveDigest(row, row) : null;
  }
  async inventory(
    namespaceId: string,
    cursor = ''
  ): Promise<{
    entries: KnowledgeTransferInventoryEntry[];
    total: number;
    next_cursor: string | null;
  }> {
    const scope = and(eq(kbDocuments.namespace_id, namespaceId), eq(kbDocuments.archived, false));
    const count = await select(this.db, { total: sql<number>`count(*)` })
      .from(kbDocuments)
      .where(scope)
      .one();
    const rows = await select(this.db, {
      document_id: kbDocuments.document_id,
      version_id: kbDocuments.current_version_id,
      path: kbDocuments.path,
      title: kbDocuments.title,
      icon_emoji: kbDocuments.icon_emoji,
      kind: kbDocuments.kind,
      status: kbDocuments.status,
      visibility: kbDocuments.visibility,
      edit_policy: kbDocuments.edit_policy,
      metadata: kbDocuments.metadata,
      created_at: kbDocuments.created_at,
      updated_at: kbDocuments.updated_at,
      created_by: kbDocuments.created_by,
      updated_by: kbDocuments.updated_by,
      sha256: kbDocumentVersions.content_sha256,
      bytes: kbDocumentVersions.byte_length,
      mime_type: kbDocumentVersions.mime_type,
      frontmatter: kbDocumentVersions.frontmatter,
      version_metadata: kbDocumentVersions.metadata,
      version_number: kbDocumentVersions.version_number,
      change_summary: kbDocumentVersions.change_summary,
      agentic_tool: kbDocumentVersions.created_by_agentic_tool,
      teammate: kbDocumentVersions.created_by_teammate_name,
    })
      .from(kbDocuments)
      .leftJoin(
        kbDocumentVersions,
        eq(kbDocuments.current_version_id, kbDocumentVersions.version_id)
      )
      .where(and(scope, gt(kbDocuments.document_id, cursor)))
      .orderBy(asc(kbDocuments.document_id))
      .limit(KNOWLEDGE_TRANSFER.pageSize + 1)
      .all();
    const page = rows.slice(0, KNOWLEDGE_TRANSFER.pageSize) as KnowledgeTransferInventoryRow[];
    const ids = [
      ...new Set(
        page
          .flatMap((row) => [row.created_by, row.updated_by])
          .filter((id): id is UserID => Boolean(id))
      ),
    ];
    // Names/IDs are resolved only in this tenant. Never export a malformed foreign author ID.
    const authors = ids.length
      ? await select(this.db, { id: users.user_id, name: users.name })
          .from(users)
          .where(inArray(users.user_id, ids))
          .all()
      : [];
    const names = new Map<string, string | null>(
      authors.map((author: { id: string; name: string | null }) => [author.id, author.name])
    );
    return {
      total: Number(count?.total ?? 0),
      next_cursor: rows.length > page.length ? page.at(-1)!.document_id : null,
      entries: page.map((row: KnowledgeTransferInventoryRow) => ({
        document_id: row.document_id,
        version_id: row.version_id,
        path: row.path,
        title: row.title,
        icon_emoji: row.icon_emoji,
        kind: row.kind,
        status: row.status,
        sha256: row.sha256,
        bytes: row.bytes,
        mime_type: row.mime_type,
        frontmatter: row.frontmatter,
        provenance: JSON.parse(
          JSON.stringify({
            source_uuid: row.document_id,
            source_version_uuid: row.version_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            created_by: row.created_by && names.has(row.created_by) ? row.created_by : null,
            updated_by: row.updated_by && names.has(row.updated_by) ? row.updated_by : null,
            creator_display_name: row.created_by ? (names.get(row.created_by) ?? null) : null,
            updater_display_name: row.updated_by ? (names.get(row.updated_by) ?? null) : null,
            visibility: row.visibility,
            edit_policy: row.edit_policy,
            metadata: row.metadata,
            version_metadata: row.version_metadata,
            version_number: row.version_number,
            change_summary: row.change_summary,
            agentic_tool: row.agentic_tool,
            teammate: row.teammate,
          })
        ),
      })),
    };
  }
  private receiptScope(owner: UserID, bundle: string, slug: string) {
    return and(
      eq(kbImportReceipts.owner_user_id, owner),
      eq(kbImportReceipts.bundle, bundle),
      eq(kbImportReceipts.slug, slug)
    );
  }
  async receipt(owner: UserID, bundle: string, slug: string, key: string) {
    return select(this.db)
      .from(kbImportReceipts)
      .where(and(this.receiptScope(owner, bundle, slug), eq(kbImportReceipts.entry_key, key)))
      .one();
  }
  async receipts(owner: UserID, bundle: string, slug: string, cursor = '') {
    return select(this.db)
      .from(kbImportReceipts)
      .where(and(this.receiptScope(owner, bundle, slug), gt(kbImportReceipts.entry_key, cursor)))
      .orderBy(asc(kbImportReceipts.entry_key))
      .limit(KNOWLEDGE_TRANSFER.pageSize + 1)
      .all();
  }
  async markReconciled(owner: UserID, bundle: string, slug: string, key: string, count: number) {
    await update(this.db, kbImportReceipts)
      .set({ reconciled_count: count })
      .where(and(this.receiptScope(owner, bundle, slug), eq(kbImportReceipts.entry_key, key)))
      .run();
  }
  async usage(owner: UserID, bundle: string, slug: string) {
    const row = await select(this.db, {
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${kbImportReceipts.request_bytes}), 0)`,
    })
      .from(kbImportReceipts)
      .where(and(this.receiptScope(owner, bundle, slug), gt(kbImportReceipts.entry_key, '')))
      .one();
    return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
  }
  async record(
    owner: UserID,
    bundle: string,
    slug: string,
    key: string,
    targetId: string,
    digest: string,
    requestBytes = 0
  ) {
    await insert(this.db, kbImportReceipts)
      .values({
        receipt_id: generateId(),
        owner_user_id: owner,
        bundle,
        slug,
        entry_key: key,
        target_id: targetId,
        digest,
        request_bytes: requestBytes,
        created_at: new Date(),
      })
      .run();
  }
}
