import type {
  KnowledgeDocument,
  KnowledgeDocumentVersion,
  KnowledgeUserAttribution,
} from '@agor/core/types';
import { inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { users } from '../schema';

const UNATTRIBUTED_USER: KnowledgeUserAttribution = {
  status: 'unattributed',
  display_name: 'System or former user',
};

const UNAVAILABLE_USER: KnowledgeUserAttribution = {
  status: 'unavailable',
  display_name: 'Unavailable user',
};

/**
 * Resolve only the names attached to already-authorized Knowledge records.
 *
 * The query runs through the caller's existing tenant database scope, so
 * PostgreSQL RLS remains the final boundary. A non-null ID that is invisible
 * in that scope gets a generic result rather than a broader lookup. Emails and
 * other User fields are never selected.
 */
export class KnowledgeAttributionRepository {
  constructor(private db: Database) {}

  private async usersById(ids: Array<string | null | undefined>) {
    const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (uniqueIds.length === 0) return new Map<string, string | null>();

    const rows = (await select(this.db, { user_id: users.user_id, name: users.name })
      .from(users)
      .where(inArray(users.user_id, uniqueIds))
      .all()) as Array<{ user_id: string; name: string | null }>;
    return new Map<string, string | null>(rows.map((row) => [row.user_id, row.name]));
  }

  private attributionFor(
    userId: string | null | undefined,
    usersById: ReadonlyMap<string, string | null>
  ): KnowledgeUserAttribution {
    if (!userId) return { ...UNATTRIBUTED_USER };
    if (!usersById.has(userId)) return { ...UNAVAILABLE_USER };
    return {
      status: 'resolved',
      display_name: usersById.get(userId)?.trim() || 'User',
    };
  }

  private projectDocuments(
    documents: readonly KnowledgeDocument[],
    resolvedUsers: ReadonlyMap<string, string | null>
  ): KnowledgeDocument[] {
    return documents.map((document) => {
      const attribution = this.attributionFor(document.updated_by, resolvedUsers);
      const creatorAttribution = this.attributionFor(document.created_by, resolvedUsers);
      return {
        ...document,
        // Do not transport an opaque user identifier from outside the active
        // tenant even when malformed historical data contains one.
        created_by: creatorAttribution.status === 'unavailable' ? null : document.created_by,
        updated_by: attribution.status === 'unavailable' ? null : document.updated_by,
        updated_by_user: attribution,
      };
    });
  }

  private projectVersions(
    versions: readonly KnowledgeDocumentVersion[],
    resolvedUsers: ReadonlyMap<string, string | null>
  ): KnowledgeDocumentVersion[] {
    return versions.map((version) => {
      const attribution = this.attributionFor(version.created_by, resolvedUsers);
      return {
        ...version,
        // Keep the same non-enumeration rule as the current-document response.
        created_by: attribution.status === 'unavailable' ? null : version.created_by,
        created_by_user: attribution,
      };
    });
  }

  /**
   * Project documents and versions with one tenant-scoped User query. Search
   * and hydrated-list responses use this to keep their nested contract
   * consistent without an author-query N+1.
   */
  async attachToDocumentsAndVersions(
    documents: readonly KnowledgeDocument[],
    versions: readonly KnowledgeDocumentVersion[]
  ): Promise<{
    documents: KnowledgeDocument[];
    versions: KnowledgeDocumentVersion[];
  }> {
    const resolvedUsers = await this.usersById([
      ...documents.flatMap((document) => [document.created_by, document.updated_by]),
      ...versions.map((version) => version.created_by),
    ]);
    return {
      documents: this.projectDocuments(documents, resolvedUsers),
      versions: this.projectVersions(versions, resolvedUsers),
    };
  }

  async attachToDocuments(documents: readonly KnowledgeDocument[]): Promise<KnowledgeDocument[]> {
    return (await this.attachToDocumentsAndVersions(documents, [])).documents;
  }

  async attachToVersions(
    versions: readonly KnowledgeDocumentVersion[]
  ): Promise<KnowledgeDocumentVersion[]> {
    return (await this.attachToDocumentsAndVersions([], versions)).versions;
  }
}
