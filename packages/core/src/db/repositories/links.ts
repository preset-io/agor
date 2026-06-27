import type {
  BranchID,
  Link,
  LinkCreate,
  LinkID,
  LinkKind,
  LinkPatch,
  LinkSource,
  MessageID,
  SessionID,
  UUID,
} from '@agor/core/types';
import {
  isLinkKind,
  isLinkSource,
  normalizeFileTargetKey,
  normalizeRefTargetKey,
  normalizeUrlTargetKey,
} from '@agor/core/types';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { type LinkInsert, type LinkRow, links } from '../schema';
import { RepositoryError } from './base';
import {
  visibleBranchReferenceAccessExists,
  visibleSessionReferenceAccessExists,
} from './branch-access';

export interface LinkFindFilter {
  branchId?: BranchID;
  branchIds?: BranchID[];
  sessionId?: SessionID;
  sessionIds?: SessionID[];
  sourceMessageId?: MessageID;
  kind?: LinkKind;
  source?: LinkSource;
  visibleToUserId?: UUID;
}

function countPresent(values: unknown[]): number {
  return values.filter((value) => value !== undefined && value !== null && value !== '').length;
}

function normalizeTargetKey(data: {
  target_key?: string | null;
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
}): string {
  if (data.target_key?.trim()) return data.target_key.trim();
  if (data.url) return normalizeUrlTargetKey(data.url);
  if (data.ref_uri) return normalizeRefTargetKey(data.ref_uri);
  if (data.file_path) return normalizeFileTargetKey(data.file_path);
  throw new RepositoryError('Link target_key requires url, ref_uri, or file_path');
}

export class LinksRepository {
  constructor(private db: Database) {}

  private rowToLink(row: LinkRow): Link {
    return {
      link_id: row.link_id as LinkID,
      branch_id: (row.branch_id as BranchID | null) ?? null,
      session_id: (row.session_id as SessionID | null) ?? null,
      source_message_id: (row.source_message_id as MessageID | null) ?? null,
      kind: row.kind as LinkKind,
      source: row.source as LinkSource,
      url: row.url ?? null,
      ref_uri: row.ref_uri ?? null,
      file_path: row.file_path ?? null,
      target_key: row.target_key,
      title: row.title ?? null,
      mime_type: row.mime_type ?? null,
      metadata: row.metadata ?? null,
      created_by: (row.created_by as UUID | null) ?? null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  private validateCreate(data: Partial<LinkCreate>): asserts data is LinkCreate {
    const ownerCount = countPresent([data.branch_id, data.session_id]);
    if (ownerCount !== 1) {
      throw new RepositoryError('Link requires exactly one owner: branch_id XOR session_id');
    }

    const targetCount = countPresent([data.url, data.ref_uri, data.file_path]);
    if (targetCount < 1) {
      throw new RepositoryError('Link requires at least one target: url, ref_uri, or file_path');
    }

    if (!isLinkKind(data.kind)) throw new RepositoryError(`Invalid link kind: ${data.kind}`);
    if (!isLinkSource(data.source))
      throw new RepositoryError(`Invalid link source: ${data.source}`);
  }

  private validatePatch(data: LinkPatch): void {
    if (data.kind !== undefined && !isLinkKind(data.kind)) {
      throw new RepositoryError(`Invalid link kind: ${data.kind}`);
    }
    if (data.source !== undefined && !isLinkSource(data.source)) {
      throw new RepositoryError(`Invalid link source: ${data.source}`);
    }
    if ('url' in data || 'ref_uri' in data || 'file_path' in data || 'target_key' in data) {
      const targetCount = countPresent([data.url, data.ref_uri, data.file_path]);
      if (targetCount < 1 && !data.target_key) {
        throw new RepositoryError('Link requires at least one target: url, ref_uri, or file_path');
      }
    }
  }

  private createToInsert(data: Partial<LinkCreate>, existing?: Link): LinkInsert {
    this.validateCreate(data);
    const now = new Date();
    const tenantId = (data as Partial<LinkCreate> & { tenant_id?: string }).tenant_id;
    return {
      ...(tenantId ? { tenant_id: tenantId } : {}),
      link_id: data.link_id ?? existing?.link_id ?? generateId(),
      branch_id: data.branch_id ?? null,
      session_id: data.session_id ?? null,
      source_message_id: data.source_message_id ?? null,
      kind: data.kind,
      source: data.source,
      url: data.url ?? null,
      ref_uri: data.ref_uri ?? null,
      file_path: data.file_path ?? null,
      target_key: normalizeTargetKey(data),
      title: data.title ?? null,
      mime_type: data.mime_type ?? null,
      metadata: data.metadata ?? null,
      created_by: data.created_by ?? null,
      created_at: existing?.created_at ? new Date(existing.created_at) : now,
      updated_at: now,
    } as LinkInsert;
  }

  async create(data: Partial<LinkCreate>): Promise<Link> {
    const existing = await this.findByOwnerAndTarget(data);
    if (existing) {
      return this.update(existing.link_id, data as LinkPatch);
    }

    const row = this.createToInsert(data);
    const inserted = await insert(this.db, links).values(row).returning().one();
    return this.rowToLink(inserted as LinkRow);
  }

  async upsert(data: Partial<LinkCreate>): Promise<Link> {
    return this.create(data);
  }

  async findByOwnerAndTarget(data: {
    branch_id?: BranchID | null;
    session_id?: SessionID | null;
    target_key?: string | null;
    url?: string | null;
    ref_uri?: string | null;
    file_path?: string | null;
  }): Promise<Link | null> {
    const targetKey = normalizeTargetKey(data);
    const ownerCount = countPresent([data.branch_id, data.session_id]);
    if (ownerCount !== 1) return null;

    const ownerCondition = data.branch_id
      ? and(eq(links.branch_id, data.branch_id), isNull(links.session_id))
      : and(eq(links.session_id, data.session_id as SessionID), isNull(links.branch_id));

    const row = await select(this.db)
      .from(links)
      .where(and(ownerCondition, eq(links.target_key, targetKey)))
      .one();
    return row ? this.rowToLink(row as LinkRow) : null;
  }

  async findById(id: string): Promise<Link | null> {
    const row = await select(this.db).from(links).where(eq(links.link_id, id)).one();
    return row ? this.rowToLink(row as LinkRow) : null;
  }

  async findAll(filter?: LinkFindFilter): Promise<Link[]> {
    if (filter?.branchIds !== undefined && filter.branchIds.length === 0) return [];
    if (filter?.sessionIds !== undefined && filter.sessionIds.length === 0) return [];

    const conditions = [];
    if (filter?.branchId) conditions.push(eq(links.branch_id, filter.branchId));
    if (filter?.branchIds !== undefined)
      conditions.push(inArray(links.branch_id, filter.branchIds));
    if (filter?.sessionId) conditions.push(eq(links.session_id, filter.sessionId));
    if (filter?.sessionIds !== undefined)
      conditions.push(inArray(links.session_id, filter.sessionIds));
    if (filter?.sourceMessageId)
      conditions.push(eq(links.source_message_id, filter.sourceMessageId));
    if (filter?.kind) conditions.push(eq(links.kind, filter.kind));
    if (filter?.source) conditions.push(eq(links.source, filter.source));
    if (filter?.visibleToUserId) {
      conditions.push(
        or(
          visibleBranchReferenceAccessExists(this.db, filter.visibleToUserId, links.branch_id),
          visibleSessionReferenceAccessExists(this.db, filter.visibleToUserId, links.session_id)
        )
      );
    }

    let query = select(this.db).from(links);
    if (conditions.length > 0) query = query.where(and(...conditions));
    const rows = await query.orderBy(links.created_at).all();
    return (rows as LinkRow[]).map((row: LinkRow) => this.rowToLink(row));
  }

  async update(id: string, data: LinkPatch): Promise<Link> {
    this.validatePatch(data);
    const existing = await this.findById(id);
    if (!existing) throw new RepositoryError(`Link ${id} not found`);

    const next = {
      source_message_id: data.source_message_id ?? existing.source_message_id ?? null,
      kind: data.kind ?? existing.kind,
      source: data.source ?? existing.source,
      url: data.url ?? existing.url ?? null,
      ref_uri: data.ref_uri ?? existing.ref_uri ?? null,
      file_path: data.file_path ?? existing.file_path ?? null,
      target_key: normalizeTargetKey({
        target_key: data.target_key ?? existing.target_key,
        url: data.url ?? existing.url,
        ref_uri: data.ref_uri ?? existing.ref_uri,
        file_path: data.file_path ?? existing.file_path,
      }),
      title: data.title ?? existing.title ?? null,
      mime_type: data.mime_type ?? existing.mime_type ?? null,
      metadata: data.metadata ?? existing.metadata ?? null,
      updated_at: new Date(),
    } satisfies Partial<LinkInsert>;

    const updated = await update(this.db, links)
      .set(next)
      .where(eq(links.link_id, id))
      .returning()
      .one();
    return this.rowToLink(updated as LinkRow);
  }

  async delete(id: string): Promise<void> {
    await deleteFrom(this.db, links).where(eq(links.link_id, id)).run();
  }
}
