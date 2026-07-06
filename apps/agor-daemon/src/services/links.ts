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
import { extractLinksFromMessage, shortId } from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';

export const LINKS_SERVICE_METHODS = ['find', 'get', 'create', 'patch', 'remove'] as const;

export type LinkParams = QueryParams<{
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
    if (typeof query.is_pinned === 'boolean') filter.isPinned = query.is_pinned;
    if (typeof query.target_object_type === 'string') {
      filter.targetObjectType = query.target_object_type as LinkTargetObjectType;
    }
    if (typeof query.target_object_id === 'string') {
      filter.targetObjectId = query.target_object_id as UUID;
    }
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

function uploadLinkIdsFromTask(task: Pick<Task, 'metadata'> | null | undefined): string[] {
  const ids = task?.metadata?.upload_link_ids;
  if (!Array.isArray(ids)) return [];
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) result.push(id);
  }
  return result;
}

export async function associateUploadLinksWithMessage(
  app: Application,
  message: Message,
  params?: Params
): Promise<void> {
  if (!message.task_id) return;

  const task = (await app
    .service('tasks')
    .get(message.task_id, {
      ...params,
      provider: undefined,
    } as Params)
    .catch((err: unknown) => {
      console.warn(
        `⚠️  [Links] Failed to load task ${shortId(message.task_id as string)} for upload link association:`,
        err
      );
      return null;
    })) as Task | null;
  const uploadLinkIds = uploadLinkIdsFromTask(task);
  if (uploadLinkIds.length === 0) return;

  const linksService = app.service('links') as unknown as {
    get(id: string, params?: Params): Promise<Link>;
    patch(id: string, data: Partial<Link>, params?: Params): Promise<Link | Link[]>;
  };

  await Promise.all(
    uploadLinkIds.map(async (linkId) => {
      try {
        const link = await linksService.get(linkId, {
          ...params,
          provider: undefined,
        } as Params);
        if (
          link.session_id !== message.session_id ||
          link.source !== 'upload' ||
          link.source_message_id
        ) {
          return;
        }
        await linksService.patch(linkId, { source_message_id: message.message_id }, {
          ...params,
          provider: undefined,
        } as Params);
      } catch (linkErr) {
        console.warn(
          `⚠️  [Links] Failed to associate upload link ${String(linkId).slice(0, 8)} with message ${shortId(message.message_id)}:`,
          linkErr
        );
      }
    })
  );
}

export function associateUploadLinksAfterMessageCreate(app: Application) {
  return async (context: HookContext): Promise<HookContext> => {
    const messages = normalizeCreatedMessages(context.result);
    if (messages.length === 0) return context;

    await Promise.all(
      messages.map((message) => associateUploadLinksWithMessage(app, message, context.params))
    );
    return context;
  };
}
