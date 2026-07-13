/**
 * Links Service
 *
 * Provides REST + WebSocket API for branch/session-owned links and uploaded attachments.
 */

import { PAGINATION } from '@agor/core/config';
import { LinksRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { type Application, BadRequest } from '@agor/core/feathers';
import type {
  BranchID,
  HookContext,
  Id,
  Link,
  LinkCreate,
  LinkKind,
  LinkOwnerScope,
  LinkSource,
  LinkTargetObjectType,
  Message,
  MessageID,
  NullableId,
  Params,
  QueryParams,
  SessionID,
  Task,
  UUID,
} from '@agor/core/types';
import { extractLinksFromMessage, MAX_PARSED_LINKS_PER_MESSAGE } from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { backfillLegacySessionLinks } from './legacy-links-backfill.js';

export const LINKS_SERVICE_METHODS = ['find', 'get', 'create', 'patch', 'remove'] as const;
const LEGACY_BACKFILL_CACHE_MAX_ENTRIES = 500;
const LEGACY_BACKFILL_CACHE_TTL_MS = 15 * 60 * 1000;
type LegacyBackfillCacheEntry = { promise: Promise<boolean>; expiresAt: number };
type LinkParams = QueryParams<{
  board_id?: UUID;
  owner_scope?: LinkOwnerScope;
  branch_id?: BranchID;
  session_id?: SessionID;
  source_message_id?: MessageID;
  kind?: LinkKind;
  source?: LinkSource;
  is_pinned?: boolean;
  target_object_type?: LinkTargetObjectType;
  target_object_id?: UUID;
}> & {
  _agorSqlLinkAccessUserId?: UUID;
  _agorHideInternalLinks?: boolean;
  _agorPreserveExistingOnCreate?: boolean;
};

export class LinksService extends DrizzleService<Link, Partial<Link>, LinkParams> {
  private linksRepo: LinksRepository;
  private legacyBackfills = new Map<string, LegacyBackfillCacheEntry>();

  constructor(private readonly db: TenantScopeAwareDatabase) {
    const linksRepo = new LinksRepository(db);
    super(linksRepo, {
      id: 'link_id',
      resourceType: 'Link',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['create'],
    });
    this.linksRepo = linksRepo;
  }

  protected async fetchData(query: Query, params?: LinkParams): Promise<Link[]> {
    if (typeof query.session_id === 'string') {
      const sessionId = query.session_id as SessionID;
      const backfillKey = `${sessionId}:${params?._agorSqlLinkAccessUserId ?? '*'}`;
      const now = Date.now();
      let entry = this.legacyBackfills.get(backfillKey);
      if (entry && entry.expiresAt <= now) {
        this.legacyBackfills.delete(backfillKey);
        entry = undefined;
      }
      if (!entry) {
        const promise = backfillLegacySessionLinks({
          db: this.db,
          sessionId,
          visibleToUserId: params?._agorSqlLinkAccessUserId,
        });
        while (this.legacyBackfills.size >= LEGACY_BACKFILL_CACHE_MAX_ENTRIES) {
          const oldestKey = this.legacyBackfills.keys().next().value;
          if (oldestKey === undefined) break;
          this.legacyBackfills.delete(oldestKey);
        }
        entry = { promise, expiresAt: now + LEGACY_BACKFILL_CACHE_TTL_MS };
        this.legacyBackfills.set(backfillKey, entry);
      } else {
        // Refresh insertion order so eviction behaves as an LRU.
        this.legacyBackfills.delete(backfillKey);
        this.legacyBackfills.set(backfillKey, entry);
      }
      try {
        const scanned = await entry.promise;
        if (!scanned && this.legacyBackfills.get(backfillKey) === entry) {
          this.legacyBackfills.delete(backfillKey);
        }
      } catch (error) {
        if (this.legacyBackfills.get(backfillKey) === entry) {
          this.legacyBackfills.delete(backfillKey);
        }
        throw error;
      }
    }
    const filter: Parameters<LinksRepository['findAll']>[0] = {};
    if (typeof query.board_id === 'string') filter.boardId = query.board_id as UUID;
    if (
      query.owner_scope === 'branch' ||
      query.owner_scope === 'session' ||
      query.owner_scope === 'all'
    ) {
      filter.ownerScope = query.owner_scope;
    }
    if (typeof query.branch_id === 'string') filter.branchId = query.branch_id as BranchID;
    if (typeof query.session_id === 'string') filter.sessionId = query.session_id as SessionID;
    if (typeof query.source_message_id === 'string') {
      filter.sourceMessageId = query.source_message_id as MessageID;
    }
    if (typeof query.kind === 'string') filter.kind = query.kind as LinkKind;
    if (typeof query.source === 'string') filter.source = query.source as LinkSource;
    if (typeof query.is_pinned === 'boolean') filter.isPinned = query.is_pinned;
    if (typeof query.target_object_type === 'string') {
      filter.targetObjectType = query.target_object_type as LinkTargetObjectType;
    }
    if (typeof query.target_object_id === 'string') {
      filter.targetObjectId = query.target_object_id as UUID;
    }
    if (params?._agorSqlLinkAccessUserId) filter.visibleToUserId = params._agorSqlLinkAccessUserId;
    if (params?._agorHideInternalLinks) filter.hideInternal = true;
    return this.linksRepo.findAll(filter);
  }

  protected filterQueryForInMemory(query: Query): Query {
    const { board_id: _boardId, owner_scope: _ownerScope, ...rowBackedQuery } = query;
    return rowBackedQuery;
  }

  async create(data: Partial<Link> | Partial<Link>[], params?: LinkParams): Promise<Link | Link[]> {
    if (Array.isArray(data)) {
      const results = await this.linksRepo.upsertManyWithStatus(
        data as readonly Partial<LinkCreate>[]
      );
      return results.map((result) => result.link);
    }

    return (
      await this.linksRepo.upsertWithStatus(data as Partial<LinkCreate>, {
        preserveExisting: params?._agorPreserveExistingOnCreate,
      })
    ).link;
  }

  async update(_id: Id, _data: Partial<Link>, _params?: LinkParams): Promise<Link> {
    throw new BadRequest('links.update is not supported; use patch instead');
  }

  async patch(id: NullableId, data: Partial<Link>, params?: LinkParams): Promise<Link | Link[]> {
    if (id === null) {
      throw new BadRequest('links.patch does not support multi operations');
    }
    return super.patch(id, data, params);
  }

  async remove(id: NullableId, params?: LinkParams): Promise<Link | Link[]> {
    if (id === null) {
      throw new BadRequest('links.remove does not support multi operations');
    }
    return super.remove(id, params);
  }
}

export function createLinksService(db: TenantScopeAwareDatabase): LinksService {
  return new LinksService(db);
}

export function registerLinksService(app: Application, db: TenantScopeAwareDatabase): void {
  app.use('/links', createLinksService(db), {
    methods: [...LINKS_SERVICE_METHODS],
  });
}

function normalizeCreatedMessages(result: unknown): Message[] {
  if (Array.isArray(result)) return result as Message[];
  return result ? [result as Message] : [];
}

export function ingestParsedLinksAfterMessageCreate(app: Application) {
  return async (context: HookContext): Promise<HookContext> => {
    const messages = normalizeCreatedMessages(context.result);
    if (messages.length === 0) return context;

    const linksService = app.service('links') as unknown as {
      create(data: Partial<LinkCreate>[], params?: Params): Promise<Link[]>;
    };

    const drafts: Partial<LinkCreate>[] = [];
    for (const message of messages) {
      const parsed = extractLinksFromMessage(message);
      if (parsed.length > MAX_PARSED_LINKS_PER_MESSAGE) {
        console.warn(
          `[Links] Truncated parsed links for message ${message.message_id}: ${parsed.length} found, ${MAX_PARSED_LINKS_PER_MESSAGE} retained`
        );
      }
      for (const link of parsed.slice(0, MAX_PARSED_LINKS_PER_MESSAGE)) {
        drafts.push({
          ...link,
          session_id: message.session_id,
          branch_id: null,
          source_message_id: message.message_id,
          created_by: (context.params.user?.user_id as UUID | undefined) ?? null,
        } as Partial<LinkCreate>);
      }
    }

    if (drafts.length > 0) {
      try {
        await linksService.create(drafts, {
          ...context.params,
          provider: undefined,
        } as Params);
      } catch (error) {
        // Link extraction is derived data. The message has already been persisted
        // when this after hook runs, so a link failure must not turn a successful
        // message write into a client-visible failure (and possible retry).
        console.warn('[Links] Failed to ingest parsed message links:', error);
      }
    }

    for (const message of messages) {
      if (message.role !== 'user') continue;
      if (
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result')
      ) {
        continue;
      }
      if (!message.task_id) continue;
      const taskService = app.service('tasks') as unknown as {
        get(id: string, params?: Params): Promise<Task>;
      };
      const task = await taskService
        .get(message.task_id, { ...context.params, provider: undefined } as Params)
        .catch((error) => {
          console.warn(
            `[Links] Failed to resolve task ${message.task_id} for message ${message.message_id}:`,
            error
          );
          return null;
        });
      const uploadLinkIds = task?.metadata?.upload_link_ids;
      const taskCreatedBy = task?.created_by ?? null;
      if (!Array.isArray(uploadLinkIds) || uploadLinkIds.length === 0) continue;

      const patchableLinksService = app.service('links') as unknown as {
        get(id: string, params?: Params): Promise<Link>;
        patch(id: string, data: Partial<Link>, params?: Params): Promise<Link>;
      };
      await Promise.all(
        uploadLinkIds
          .filter((linkId): linkId is NonNullable<typeof linkId> => typeof linkId === 'string')
          .map(async (linkId) => {
            try {
              const existing = await patchableLinksService.get(linkId, {
                ...context.params,
                provider: undefined,
              } as Params);
              if (existing.source !== 'upload') return;
              if (existing.session_id !== message.session_id) return;
              if (existing.branch_id) return;
              if (existing.source_message_id) return;
              if (existing.created_by && taskCreatedBy && existing.created_by !== taskCreatedBy)
                return;
              await patchableLinksService.patch(linkId, { source_message_id: message.message_id }, {
                ...context.params,
                provider: undefined,
              } as Params);
            } catch (error) {
              console.warn(
                `[Links] Failed to attach upload link ${linkId} to message ${message.message_id}:`,
                error
              );
            }
          })
      );
    }
    return context;
  };
}
