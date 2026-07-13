import type {
  BranchID,
  Link,
  LinkCreate,
  LinkID,
  LinkKind,
  LinkOwnerScope,
  LinkPatch,
  LinkSource,
  LinkTargetObjectType,
  MessageID,
  SessionID,
  UUID,
} from '@agor/core/types';
import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  countLinkTargets,
  getLinkTargetCompatibilityError,
  isLinkKind,
  isLinkSource,
  normalizeLinkTargetKey,
} from '../../types/link';
import type { Database } from '../client';
import { isUniqueConstraintError } from '../constraint-errors';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { branches, type LinkInsert, type LinkRow, links, sessions } from '../schema';
import { attachHiddenTenant, RepositoryError } from './base';
import {
  visibleBranchReferenceAccessExists,
  visibleSessionReferenceAccessExists,
} from './branch-access';

export interface LinkFindFilter {
  boardId?: UUID;
  ownerScope?: LinkOwnerScope;
  branchId?: BranchID;
  branchIds?: BranchID[];
  sessionId?: SessionID;
  sessionIds?: SessionID[];
  sourceMessageId?: MessageID;
  kind?: LinkKind;
  source?: LinkSource;
  isPinned?: boolean;
  targetObjectType?: LinkTargetObjectType;
  targetObjectId?: UUID;
  visibleToUserId?: UUID;
  hideInternal?: boolean;
}

function countPresent(values: unknown[]): number {
  return values.filter((value) => value !== undefined && value !== null && value !== '').length;
}

function normalizeTargetKey(data: {
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
  target_object_type?: LinkTargetObjectType | string | null;
  target_object_id?: UUID | string | null;
}): string {
  const targetKey = normalizeLinkTargetKey(data);
  if (targetKey) return targetKey;
  throw new RepositoryError(
    'Link target_key requires exactly one target: url, ref_uri, or file_path'
  );
}

function hasOwn<K extends PropertyKey>(data: object, key: K): boolean {
  return Object.hasOwn(data, key);
}

function patchValue<K extends keyof LinkPatch>(data: LinkPatch, existing: Link[K], key: K) {
  return hasOwn(data, key) ? (data[key] ?? null) : (existing ?? null);
}

function validateLinkSemantics(data: {
  kind: LinkKind;
  source: LinkSource;
  url?: string | null;
  ref_uri?: string | null;
  file_path?: string | null;
  target_object_type?: LinkTargetObjectType | string | null;
  target_object_id?: UUID | string | null;
}): void {
  const error = getLinkTargetCompatibilityError(data);
  if (error) throw new RepositoryError(error);
}

const MAX_LINK_UPDATE_ATTEMPTS = 5;

function isDefinedCondition<T>(condition: T | undefined): condition is T {
  return condition !== undefined;
}

function postgresBranchTenantMatchesLink(db: Database) {
  return isPostgresDatabase(db)
    ? sql.raw('"branches"."tenant_id" = "links"."tenant_id"')
    : undefined;
}

function postgresSessionTenantMatchesLink(db: Database) {
  return isPostgresDatabase(db)
    ? sql.raw('"sessions"."tenant_id" = "links"."tenant_id"')
    : undefined;
}

function activeBranchOwnerExists(db: Database, boardId?: UUID) {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads.
    (db as any)
      .select({ _: sql`1` })
      .from(branches)
      .where(
        and(
          ...[
            postgresBranchTenantMatchesLink(db),
            eq(branches.branch_id, links.branch_id),
            boardId ? eq(branches.board_id, boardId) : undefined,
            eq(branches.archived, false),
          ].filter(isDefinedCondition)
        )
      )
  );
}

function sessionOwnerOnBoardExists(db: Database, boardId: UUID) {
  return exists(
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle select has complex cross-dialect overloads.
    (db as any)
      .select({ _: sql`1` })
      .from(sessions)
      .innerJoin(branches, eq(sessions.branch_id, branches.branch_id))
      .where(
        and(
          ...[
            postgresSessionTenantMatchesLink(db),
            postgresBranchTenantMatchesLink(db),
            eq(sessions.session_id, links.session_id),
            eq(branches.board_id, boardId),
            eq(branches.archived, false),
            eq(sessions.archived, false),
          ].filter(isDefinedCondition)
        )
      )
  );
}

function isGlobalPinnedBranchLifecycleFilter(filter: LinkFindFilter): boolean {
  return (
    filter.ownerScope === 'branch' &&
    filter.isPinned === true &&
    !filter.boardId &&
    !filter.branchId &&
    filter.branchIds === undefined
  );
}

export class LinksRepository {
  constructor(private db: Database) {}

  private rowToLink(row: LinkRow): Link {
    return attachHiddenTenant(
      {
        link_id: row.link_id as LinkID,
        branch_id: (row.branch_id as BranchID | null) ?? null,
        session_id: (row.session_id as SessionID | null) ?? null,
        source_message_id: (row.source_message_id as MessageID | null) ?? null,
        kind: row.kind as LinkKind,
        source: row.source as LinkSource,
        url: row.url ?? null,
        ref_uri: row.ref_uri ?? null,
        file_path: row.file_path ?? null,
        target_object_type: (row.target_object_type as LinkTargetObjectType | null) ?? null,
        target_object_id: (row.target_object_id as UUID | null) ?? null,
        target_key: row.target_key,
        is_pinned: Boolean(row.is_pinned),
        title: row.title ?? null,
        mime_type: row.mime_type ?? null,
        metadata: row.metadata ?? null,
        created_by: (row.created_by as UUID | null) ?? null,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        revision: row.revision,
      },
      row
    );
  }

  private validateCreate(data: Partial<LinkCreate>): asserts data is LinkCreate {
    const ownerCount = countPresent([data.branch_id, data.session_id]);
    if (ownerCount !== 1) {
      throw new RepositoryError('Link requires exactly one owner: branch_id XOR session_id');
    }

    const targetCount = countLinkTargets(data);
    if (targetCount !== 1) {
      throw new RepositoryError('Link requires exactly one target: url, ref_uri, or file_path');
    }

    const { kind, source } = data;
    if (!isLinkKind(kind)) throw new RepositoryError(`Invalid link kind: ${kind}`);
    if (!isLinkSource(source)) throw new RepositoryError(`Invalid link source: ${source}`);
    validateLinkSemantics({ ...data, kind, source });
  }

  private validatePatch(data: LinkPatch): void {
    if (data.kind !== undefined && !isLinkKind(data.kind)) {
      throw new RepositoryError(`Invalid link kind: ${data.kind}`);
    }
    if (data.source !== undefined && !isLinkSource(data.source)) {
      throw new RepositoryError(`Invalid link source: ${data.source}`);
    }
  }

  private createToInsert(data: LinkCreate): LinkInsert {
    const now = new Date();
    const tenantId = (data as Partial<LinkCreate> & { tenant_id?: string }).tenant_id;
    return {
      ...(tenantId ? { tenant_id: tenantId } : {}),
      link_id: data.link_id ?? generateId(),
      branch_id: data.branch_id ?? null,
      session_id: data.session_id ?? null,
      source_message_id: data.source_message_id ?? null,
      kind: data.kind,
      source: data.source,
      url: data.url ?? null,
      ref_uri: data.ref_uri ?? null,
      file_path: data.file_path ?? null,
      target_object_type: data.target_object_type ?? null,
      target_object_id: data.target_object_id ?? null,
      target_key: normalizeTargetKey(data),
      is_pinned: data.is_pinned ?? false,
      title: data.title ?? null,
      mime_type: data.mime_type ?? null,
      metadata: data.metadata ?? null,
      created_by: data.created_by ?? null,
      created_at: now,
      updated_at: now,
      revision: 1,
    } as LinkInsert;
  }

  async create(data: Partial<LinkCreate>): Promise<Link> {
    return (await this.upsertWithStatus(data)).link;
  }

  async upsertWithStatus(
    data: Partial<LinkCreate>,
    options: { preserveExisting?: boolean } = {}
  ): Promise<{ link: Link; created: boolean }> {
    this.validateCreate(data);
    const existing = await this.findByOwnerAndTarget(data);
    if (existing) {
      return {
        link: options.preserveExisting ? existing : await this.update(existing.link_id, data),
        created: false,
      };
    }

    const row = this.createToInsert(data);
    try {
      const inserted = await insert(this.db, links).values(row).returning().one();
      return { link: this.rowToLink(inserted as LinkRow), created: true };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const racedExisting = await this.findByOwnerAndTarget(data);
      if (!racedExisting) throw err;
      return {
        link: options.preserveExisting
          ? racedExisting
          : await this.update(racedExisting.link_id, data),
        created: false,
      };
    }
  }

  /**
   * Upsert a batch atomically. Callers use the returned statuses to publish
   * realtime events only after the transaction has committed.
   */
  async upsertManyWithStatus(
    data: readonly Partial<LinkCreate>[]
  ): Promise<Array<{ link: Link; created: boolean }>> {
    if (data.length === 0) return [];
    return runDatabaseTransaction(this.db, async (tx) => {
      const repository = new LinksRepository(tx);
      const results: Array<{ link: Link; created: boolean }> = [];
      for (const item of data) {
        results.push(await repository.upsertWithStatus(item));
      }
      return results;
    });
  }

  async upsert(data: Partial<LinkCreate>): Promise<Link> {
    return this.create(data);
  }

  async findByOwnerAndTarget(data: {
    branch_id?: BranchID | null;
    session_id?: SessionID | null;
    url?: string | null;
    ref_uri?: string | null;
    file_path?: string | null;
    target_object_type?: LinkTargetObjectType | string | null;
    target_object_id?: UUID | string | null;
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
    if (filter?.ownerScope === 'branch') conditions.push(isNotNull(links.branch_id));
    if (filter?.ownerScope === 'session') conditions.push(isNotNull(links.session_id));
    if (filter && isGlobalPinnedBranchLifecycleFilter(filter)) {
      conditions.push(activeBranchOwnerExists(this.db));
    }
    if (filter?.boardId) {
      const branchScope = activeBranchOwnerExists(this.db, filter.boardId);
      const sessionScope = sessionOwnerOnBoardExists(this.db, filter.boardId);
      if (filter.ownerScope === 'branch') conditions.push(branchScope);
      else if (filter.ownerScope === 'session') conditions.push(sessionScope);
      else conditions.push(or(branchScope, sessionScope));
    }
    if (filter?.branchId) conditions.push(eq(links.branch_id, filter.branchId));
    if (filter?.branchIds !== undefined)
      conditions.push(inArray(links.branch_id, filter.branchIds));
    if (filter?.sessionId) conditions.push(eq(links.session_id, filter.sessionId));
    if (filter?.sessionIds !== undefined)
      conditions.push(inArray(links.session_id, filter.sessionIds));
    if (filter?.sourceMessageId)
      conditions.push(eq(links.source_message_id, filter.sourceMessageId));
    if (filter?.kind) conditions.push(eq(links.kind, filter.kind));
    if (filter?.hideInternal) {
      conditions.push(
        ne(links.kind, 'internal'),
        isNull(links.target_object_type),
        isNull(links.target_object_id)
      );
    }
    if (filter?.source) conditions.push(eq(links.source, filter.source));
    if (filter?.isPinned !== undefined) conditions.push(eq(links.is_pinned, filter.isPinned));
    if (filter?.targetObjectType)
      conditions.push(eq(links.target_object_type, filter.targetObjectType));
    if (filter?.targetObjectId) conditions.push(eq(links.target_object_id, filter.targetObjectId));
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
    for (let attempt = 0; attempt < MAX_LINK_UPDATE_ATTEMPTS; attempt += 1) {
      const existing = await this.findById(id);
      if (!existing) throw new RepositoryError(`Link ${id} not found`);

      // Provenance is write-once: retries and concurrent association flows
      // keep the first committed source message while still filling a null one.
      const sourceMessageId =
        hasOwn(data, 'source_message_id') && existing.source_message_id
          ? existing.source_message_id
          : patchValue(data, existing.source_message_id, 'source_message_id');
      const url = patchValue(data, existing.url, 'url');
      const refUri = patchValue(data, existing.ref_uri, 'ref_uri');
      const filePath = patchValue(data, existing.file_path, 'file_path');
      const targetObjectType = patchValue(data, existing.target_object_type, 'target_object_type');
      const targetObjectId = patchValue(data, existing.target_object_id, 'target_object_id');
      const targetCount = countLinkTargets({ url, ref_uri: refUri, file_path: filePath });
      if (targetCount !== 1) {
        throw new RepositoryError('Link requires exactly one target: url, ref_uri, or file_path');
      }

      const nextKind = data.kind ?? existing.kind;
      const nextSource = data.source ?? existing.source;
      const next = {
        source_message_id: sourceMessageId,
        kind: nextKind,
        source: nextSource,
        url,
        ref_uri: refUri,
        file_path: filePath,
        target_object_type: targetObjectType,
        target_object_id: targetObjectId,
        target_key: normalizeTargetKey({
          url,
          ref_uri: refUri,
          file_path: filePath,
          target_object_type: targetObjectType,
          target_object_id: targetObjectId,
        }),
        is_pinned: patchValue(data, existing.is_pinned, 'is_pinned') ?? false,
        title: patchValue(data, existing.title, 'title'),
        mime_type: patchValue(data, existing.mime_type, 'mime_type'),
        metadata: patchValue(data, existing.metadata, 'metadata'),
        updated_at: new Date(),
      } satisfies Partial<LinkInsert>;
      validateLinkSemantics({
        kind: nextKind,
        source: nextSource,
        url: next.url,
        ref_uri: next.ref_uri,
        file_path: next.file_path,
        target_object_type: next.target_object_type,
        target_object_id: next.target_object_id,
      });

      // Compare-and-swap the full validated row. If another patch won after
      // our read, rebuild from its result so disjoint fields are not restored
      // from a stale snapshot and cross-field semantics are revalidated.
      const expectedRevision = existing.revision ?? 1;
      const updated = (await update(this.db, links)
        .set({ ...next, revision: sql`${links.revision} + 1` })
        .where(and(eq(links.link_id, id), eq(links.revision, expectedRevision)))
        .returning()
        .one()) as LinkRow | undefined;
      if (updated) return this.rowToLink(updated);
    }

    throw new RepositoryError(`Link ${id} changed concurrently; retry update`);
  }

  async delete(id: string): Promise<void> {
    await deleteFrom(this.db, links).where(eq(links.link_id, id)).run();
  }
}
