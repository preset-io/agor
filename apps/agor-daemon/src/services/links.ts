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
  LinkSource,
  Message,
  MessageID,
  NullableId,
  Params,
  QueryParams,
  SessionID,
  UUID,
} from '@agor/core/types';
import { extractLinksFromMessage } from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';

export const LINKS_SERVICE_METHODS = ['find', 'get', 'create', 'patch', 'remove'] as const;

export type LinkParams = QueryParams<{
  branch_id?: BranchID;
  session_id?: SessionID;
  source_message_id?: MessageID;
  kind?: LinkKind;
  source?: LinkSource;
}> & {
  _agorSqlLinkAccessUserId?: UUID;
};

export class LinksService extends DrizzleService<Link, Partial<Link>, LinkParams> {
  private linksRepo: LinksRepository;

  constructor(db: TenantScopeAwareDatabase) {
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
    const filter: Parameters<LinksRepository['findAll']>[0] = {};
    if (typeof query.branch_id === 'string') filter.branchId = query.branch_id as BranchID;
    if (typeof query.session_id === 'string') filter.sessionId = query.session_id as SessionID;
    if (typeof query.source_message_id === 'string') {
      filter.sourceMessageId = query.source_message_id as MessageID;
    }
    if (typeof query.kind === 'string') filter.kind = query.kind as LinkKind;
    if (typeof query.source === 'string') filter.source = query.source as LinkSource;
    if (params?._agorSqlLinkAccessUserId) filter.visibleToUserId = params._agorSqlLinkAccessUserId;
    return this.linksRepo.findAll(filter);
  }

  async create(data: Partial<Link> | Partial<Link>[], params?: LinkParams): Promise<Link | Link[]> {
    if (Array.isArray(data)) {
      const results: Link[] = [];
      for (const item of data) {
        results.push((await this.create(item, params)) as Link);
      }
      return results;
    }

    const existing = await this.linksRepo.findByOwnerAndTarget(data as Partial<LinkCreate>);
    const result = await this.linksRepo.upsert(data as Partial<LinkCreate>);
    this.emit?.(existing ? 'patched' : 'created', result, params);
    return result;
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
      for (const link of parsed) {
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
      await linksService.create(drafts, {
        ...context.params,
        provider: undefined,
      } as Params);
    }
    return context;
  };
}
