import { BranchRepository, LinksRepository, MessagesRepository } from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type {
  BoardID,
  BranchID,
  HookContext,
  Link,
  Message,
  MessageID,
  SessionID,
  UUID,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import {
  seedLinkBoard as seedBoard,
  seedLinkBranch,
  seedLinkSession as seedSession,
  seedLinkUser as seedUser,
} from '../../../../packages/core/src/db/repositories/links.test-helpers';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import {
  ingestParsedLinksAfterMessageCreate,
  LINKS_SERVICE_METHODS,
  LinksService,
  registerLinksService,
} from './links';
import { linksHooks } from './links-hooks';

async function seedBranch(
  db: Database,
  othersCan: 'none' | 'view' = 'none',
  options?: { boardId?: BoardID; archived?: boolean }
) {
  return seedLinkBranch(db, {
    boardId: options?.boardId,
    archived: options?.archived,
    othersCan,
  });
}

function message(content: Message['content'], patch: Partial<Message> = {}): Message {
  return {
    message_id: generateId() as MessageID,
    session_id: generateId() as SessionID,
    type: 'user',
    role: 'user',
    index: 0,
    timestamp: new Date().toISOString(),
    content_preview: typeof content === 'string' ? content : '',
    content,
    ...patch,
  } as Message;
}

describe('LinksService', () => {
  it('does not expose full update over Feathers transports', () => {
    expect(LINKS_SERVICE_METHODS).not.toContain('update');
  });

  dbTest('does not retain empty legacy-backfill lookups', async ({ db }) => {
    const service = new LinksService(db);

    await service.find({ query: { session_id: generateId() as SessionID } });

    const cache = (
      service as unknown as {
        legacyBackfills: Map<string, unknown>;
      }
    ).legacyBackfills;
    expect(cache.size).toBe(0);
  });

  dbTest('allows bulk create but rejects multi patch/remove', async ({ db }) => {
    const branch = await seedBranch(db, 'view');
    const session = await seedSession(db, branch.branch_id);
    const service = new LinksService(db);

    const created = await service.create([
      {
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/a',
      },
      {
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/b',
      },
    ]);

    expect(created).toHaveLength(2);
    await expect(service.patch(null, { title: 'changed' }, { query: {} })).rejects.toThrow(
      /does not support multi/
    );
    await expect(service.remove(null, { query: {} })).rejects.toThrow(/does not support multi/);
  });

  dbTest(
    'emits one event per CRUD result through the registered Feathers service',
    async ({ db }) => {
      const branch = await seedBranch(db, 'view');
      const session = await seedSession(db, branch.branch_id);
      const app = feathers();
      registerLinksService(app as Application, db);
      const service = app.service('links');
      const created: Link[] = [];
      const patched: Link[] = [];
      const removed: Link[] = [];
      service.on('created', (link: Link) => created.push(link));
      service.on('patched', (link: Link) => patched.push(link));
      service.on('removed', (link: Link) => removed.push(link));

      const first = (await service.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/events/first',
      })) as Link;
      const many = (await service.create([
        {
          session_id: session.session_id,
          kind: 'url',
          source: 'manual',
          url: 'https://example.com/events/second',
        },
        {
          session_id: session.session_id,
          kind: 'url',
          source: 'manual',
          url: 'https://example.com/events/third',
        },
      ])) as Link[];
      const changed = (await service.patch(first.link_id, { title: 'Changed' })) as Link;
      const deleted = (await service.remove(first.link_id)) as Link;

      expect(created.map((link) => link.link_id)).toEqual([
        first.link_id,
        many[0].link_id,
        many[1].link_id,
      ]);
      expect(patched.map((link) => link.link_id)).toEqual([changed.link_id]);
      expect(removed.map((link) => link.link_id)).toEqual([deleted.link_id]);
    }
  );

  dbTest('rolls back every row when an atomic multi-create fails', async ({ db }) => {
    const branch = await seedBranch(db, 'view');
    const session = await seedSession(db, branch.branch_id);
    const service = new LinksService(db);

    await expect(
      service.create([
        {
          session_id: session.session_id,
          kind: 'url',
          source: 'manual',
          url: 'https://example.com/atomic-first',
        },
        {
          session_id: session.session_id,
          kind: 'document',
          source: 'manual',
          url: 'https://example.com/invalid-document-target',
        },
      ])
    ).rejects.toThrow(/requires target file_path/);

    await expect(
      new LinksRepository(db).findByOwnerAndTarget({
        session_id: session.session_id,
        url: 'https://example.com/atomic-first',
      })
    ).resolves.toBeNull();
  });

  dbTest('rejects full update while preserving single patch/remove', async ({ db }) => {
    const branch = await seedBranch(db, 'view');
    const session = await seedSession(db, branch.branch_id);
    const service = new LinksService(db);
    const created = (await service.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/single',
    })) as Link;

    await expect(
      service.update(created.link_id, {
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/replaced',
      })
    ).rejects.toThrow(/update is not supported/);

    const patched = await service.patch(created.link_id, { title: 'single patch works' });
    expect(Array.isArray(patched)).toBe(false);
    expect((patched as { title: string | null }).title).toBe('single patch works');

    const removed = await service.remove(created.link_id);
    expect(Array.isArray(removed)).toBe(false);
    expect((removed as { link_id: string }).link_id).toBe(created.link_id);
  });

  dbTest('scopes find to links whose owner branch/session is visible to caller', async ({ db }) => {
    const viewer = generateId() as UUID;
    await seedUser(db, viewer, 'links-service-viewer@example.com');
    const visibleBranch = await seedBranch(db);
    const hiddenBranch = await seedBranch(db);
    await new BranchRepository(db).addOwner(visibleBranch.branch_id, viewer);

    const visibleSession = await seedSession(db, visibleBranch.branch_id);
    const hiddenSession = await seedSession(db, hiddenBranch.branch_id);
    const repo = new LinksRepository(db);
    const visible = await repo.create({
      session_id: visibleSession.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/visible',
    });
    await repo.create({
      session_id: hiddenSession.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/hidden',
    });

    const service = new LinksService(db);
    const result = await service.find({
      query: {},
      _agorSqlLinkAccessUserId: viewer,
    });

    const rows = Array.isArray(result) ? result : result.data;
    expect(rows.map((link) => link.link_id)).toEqual([visible.link_id]);
  });

  dbTest('hides internal links from external find requests', async ({ db }) => {
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id);
    const repo = new LinksRepository(db);
    const publicLink = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/public',
    });
    await repo.create({
      session_id: session.session_id,
      kind: 'internal',
      source: 'manual',
      ref_uri: `agor://session/${session.session_id}`,
      target_object_type: 'session',
      target_object_id: session.session_id,
    });

    const service = new LinksService(db);
    const result = await service.find({ query: {}, _agorHideInternalLinks: true });
    const rows = Array.isArray(result) ? result : result.data;

    expect(rows.map((link) => link.link_id)).toEqual([publicLink.link_id]);
    const unfiltered = await service.find({ query: {} });
    expect(Array.isArray(unfiltered) ? unfiltered : unfiltered.data).toHaveLength(2);
  });

  dbTest(
    'hides internal links in external hooks even when branch RBAC is disabled',
    async ({ db }) => {
      const branch = await seedBranch(db);
      const session = await seedSession(db, branch.branch_id);
      const internalLink = await new LinksRepository(db).create({
        session_id: session.session_id,
        kind: 'internal',
        source: 'manual',
        ref_uri: `agor://session/${session.session_id}`,
        target_object_type: 'session',
        target_object_id: session.session_id,
      });
      const hooks = linksHooks({
        db,
        branchRepository: new BranchRepository(db),
        branchRbacEnabled: false,
        requireAuth: async (context) => context,
        sessionsService: {} as never,
        superadminOpts: { allowSuperadmin: false },
      });
      const findHook = hooks.before.find[0] as (context: HookContext) => HookContext;
      const getHook = hooks.before.get[0] as (context: HookContext) => Promise<HookContext>;
      const findContext = {
        method: 'find',
        params: { provider: 'rest', user: { user_id: generateId(), role: 'member' } },
      } as HookContext;

      expect(findHook(findContext).params).toMatchObject({ _agorHideInternalLinks: true });
      await expect(
        getHook({
          method: 'get',
          id: internalLink.link_id,
          params: { provider: 'rest', user: findContext.params.user },
        } as HookContext)
      ).rejects.toMatchObject({ code: 404 });
    }
  );

  dbTest(
    'maps board_id and owner_scope query params into board-scoped link filters',
    async ({ db }) => {
      const boardId = generateId() as BoardID;
      const otherBoardId = generateId() as BoardID;
      await seedBoard(db, boardId);
      await seedBoard(db, otherBoardId);
      const branch = await seedBranch(db, 'view', { boardId });
      const otherBranch = await seedBranch(db, 'view', { boardId: otherBoardId });
      const session = await seedSession(db, branch.branch_id);
      const repo = new LinksRepository(db);
      const branchPinned = await repo.create({
        branch_id: branch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/branch-pinned',
        is_pinned: true,
      });
      await repo.create({
        branch_id: otherBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/other-board',
        is_pinned: true,
      });
      await repo.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/session-pinned',
        is_pinned: true,
      });

      const service = new LinksService(db);
      const result = await service.find({
        query: { board_id: boardId, owner_scope: 'branch', is_pinned: true },
      });

      const rows = Array.isArray(result) ? result : result.data;
      expect(rows.map((link) => link.link_id)).toEqual([branchPinned.link_id]);
    }
  );

  dbTest(
    'excludes archived branch owners from global pinned branch lifecycle queries',
    async ({ db }) => {
      const activeBranch = await seedBranch(db, 'view');
      const archivedBranch = await seedBranch(db, 'view', { archived: true });
      const repo = new LinksRepository(db);
      const activePinned = await repo.create({
        branch_id: activeBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/active-branch-pinned',
        is_pinned: true,
      });
      await repo.create({
        branch_id: archivedBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/archived-branch-pinned',
        is_pinned: true,
      });

      const service = new LinksService(db);
      const result = await service.find({
        query: { owner_scope: 'branch', is_pinned: true },
      });

      const rows = Array.isArray(result) ? result : result.data;
      expect(rows.map((link) => link.link_id)).toEqual([activePinned.link_id]);
    }
  );

  dbTest('ingests parsed links after single and array message creates', async ({ db }) => {
    const branch = await seedBranch(db, 'view');
    const session = await seedSession(db, branch.branch_id);
    const service = new LinksService(db);
    const app = {
      service: vi.fn((path: string) => {
        if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
        return service;
      }),
    };
    const hook = ingestParsedLinksAfterMessageCreate(app as never);

    const first = message(
      'See agor://kb/team/runbook.md and https://github.com/preset-io/agor/issues/90',
      { session_id: session.session_id }
    );
    const second = message(
      [{ type: 'text', text: 'PR https://github.com/preset-io/agor/pull/91' }],
      { session_id: session.session_id, type: 'assistant', role: 'assistant', index: 1 }
    );
    const messagesRepo = new MessagesRepository(db);
    await messagesRepo.create(first);
    await messagesRepo.create(second);

    await hook({ result: first, params: {} } as never);
    await hook({ result: [second], params: {} } as never);

    const repo = new LinksRepository(db);
    const links = await repo.findAll({ sessionId: session.session_id, source: 'parsed' });
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'kb_ref', ref_uri: 'agor://kb/team/runbook.md' }),
        expect.objectContaining({
          kind: 'issue',
          url: 'https://github.com/preset-io/agor/issues/90',
        }),
        expect.objectContaining({ kind: 'pr', url: 'https://github.com/preset-io/agor/pull/91' }),
      ])
    );
    expect(links).toHaveLength(3);
  });

  it('does not fail a persisted message when derived link ingestion fails', async () => {
    const failure = new Error('link store unavailable');
    const create = vi.fn(async () => {
      throw failure;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = {
      service: vi.fn((path: string) => {
        if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
        return { create };
      }),
    };
    const hook = ingestParsedLinksAfterMessageCreate(app as never);
    const failedMessage = message('See https://example.com/failure');

    await expect(hook({ result: failedMessage, params: {} } as never)).resolves.toMatchObject({
      result: failedMessage,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[Links] Failed to ingest parsed message links:', failure);
    warn.mockRestore();
  });

  it('caps parsed links per message and reports truncation', async () => {
    const create = vi.fn(async () => []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hook = ingestParsedLinksAfterMessageCreate({
      service: () => ({ create }),
    } as never);
    const cappedMessage = message(
      Array.from({ length: 101 }, (_, index) => `https://example.com/${index}`).join(' ')
    );

    await hook({ result: cappedMessage, params: {} } as never);

    expect(create).toHaveBeenCalledWith(expect.any(Array), expect.any(Object));
    expect(create.mock.calls[0][0]).toHaveLength(100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('101 found, 100 retained'));
    warn.mockRestore();
  });

  it('preserves tenant context for internal parsed-link creation', async () => {
    const create = vi.fn(async () => []);
    const app = {
      service: vi.fn((path: string) => {
        if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
        return { create };
      }),
    };
    const hook = ingestParsedLinksAfterMessageCreate(app as never);
    const tenantMessage = message('See https://example.com/tenant');
    const tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };

    await hook({
      result: tenantMessage,
      params: {
        provider: 'rest',
        tenant,
        authentication: { payload: { tenant_id: 'tenant-a' } },
        user: { user_id: generateId() as UUID, tenant_id: 'tenant-a' },
      },
    } as never);

    expect(create).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ session_id: tenantMessage.session_id })]),
      expect.objectContaining({
        provider: undefined,
        tenant,
        authentication: { payload: { tenant_id: 'tenant-a' } },
      })
    );
  });

  it('only stamps trusted upload links that belong to the created message session', async () => {
    const userId = generateId() as UUID;
    const sessionId = generateId() as SessionID;
    const messageId = generateId() as MessageID;
    const validLink = {
      link_id: 'valid-upload-link',
      session_id: sessionId,
      branch_id: null,
      source_message_id: null,
      source: 'upload',
      kind: 'document',
      file_path: '/tmp/upload.pdf',
      target_key: 'file:/tmp/upload.pdf',
      is_pinned: false,
      created_by: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as Link;
    const linkById = new Map<string, Link>([
      [validLink.link_id, validLink],
      [
        'manual-link',
        {
          ...validLink,
          link_id: 'manual-link',
          source: 'manual',
        } as Link,
      ],
      [
        'other-session-link',
        {
          ...validLink,
          link_id: 'other-session-link',
          session_id: generateId() as SessionID,
        } as Link,
      ],
      [
        'branch-owned-link',
        {
          ...validLink,
          link_id: 'branch-owned-link',
          branch_id: generateId() as BranchID,
        } as Link,
      ],
      [
        'already-associated-link',
        {
          ...validLink,
          link_id: 'already-associated-link',
          source_message_id: generateId() as MessageID,
        } as Link,
      ],
      [
        'other-owner-link',
        {
          ...validLink,
          link_id: 'other-owner-link',
          created_by: generateId() as UUID,
        } as Link,
      ],
    ]);
    const patch = vi.fn(async (id: string, data: Partial<Link>) => ({
      ...linkById.get(id),
      ...data,
    }));
    const app = {
      service: vi.fn((path: string) => {
        if (path === 'tasks') {
          return {
            get: vi.fn(async () => ({
              task_id: 'task-1',
              session_id: sessionId,
              created_by: userId,
              metadata: {
                upload_link_ids: Array.from(linkById.keys()),
              },
            })),
          };
        }
        if (path === 'links') {
          return {
            create: vi.fn(async () => []),
            get: vi.fn(async (id: string) => {
              const link = linkById.get(id);
              if (!link) throw new Error(`missing link ${id}`);
              return link;
            }),
            patch,
          };
        }
        throw new Error(`Unexpected service: ${path}`);
      }),
    };
    const hook = ingestParsedLinksAfterMessageCreate(app as never);

    await hook({
      result: message('Uploaded a file', {
        message_id: messageId,
        session_id: sessionId,
        task_id: 'task-1',
      }),
      params: { user: { user_id: userId } },
    } as never);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      validLink.link_id,
      { source_message_id: messageId },
      expect.objectContaining({ provider: undefined })
    );
  });
});
