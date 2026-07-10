import {
  BoardRepository,
  BranchRepository,
  LinksRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type {
  BoardID,
  BranchID,
  Link,
  Message,
  MessageID,
  SessionID,
  UUID,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { ingestParsedLinksAfterMessageCreate, LINKS_SERVICE_METHODS, LinksService } from './links';

async function seedUser(db: Database, userId: UUID, email: string) {
  await new UsersRepository(db).create({ user_id: userId, email, name: email });
}

async function seedBoard(db: Database, boardId: BoardID) {
  await new BoardRepository(db).create({
    board_id: boardId,
    name: `Links Service Board ${boardId}`,
    created_by: 'owner' as UUID,
  });
}

async function seedBranch(
  db: Database,
  othersCan: 'none' | 'view' = 'none',
  options?: { boardId?: BoardID; archived?: boolean }
) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `links-service-repo-${generateId()}`,
    name: 'Links Service Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/example/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `links-service-branch-${generateId()}`,
    ref: 'refs/heads/test',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    board_id: options?.boardId,
    created_by: 'owner' as UUID,
    permission_source: 'override',
    others_can: othersCan,
    archived: options?.archived,
  });
}

async function seedSession(db: Database, branchId: BranchID) {
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branchId,
    created_by: 'owner' as UUID,
    tasks: [],
    genealogy: { children: [] },
  });
}

describe('LinksService', () => {
  it('does not expose full update over Feathers transports', () => {
    expect(LINKS_SERVICE_METHODS).not.toContain('update');
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

    const first = {
      message_id: generateId() as MessageID,
      session_id: session.session_id,
      type: 'user',
      role: 'user',
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: 'See agor://kb/team/runbook.md',
      content: 'See agor://kb/team/runbook.md and https://github.com/preset-io/agor/issues/90',
    } as Message;
    const second = {
      message_id: generateId() as MessageID,
      session_id: session.session_id,
      type: 'assistant',
      role: 'assistant',
      index: 1,
      timestamp: new Date().toISOString(),
      content_preview: 'PR https://github.com/preset-io/agor/pull/91',
      content: [{ type: 'text', text: 'PR https://github.com/preset-io/agor/pull/91' }],
    } as Message;
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
    const message = {
      message_id: generateId() as MessageID,
      session_id: generateId() as SessionID,
      type: 'user',
      role: 'user',
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: 'See https://example.com/failure',
      content: 'See https://example.com/failure',
    } as Message;

    await expect(hook({ result: message, params: {} } as never)).resolves.toMatchObject({
      result: message,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[Links] Failed to ingest parsed message links:', failure);
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
    const message = {
      message_id: generateId() as MessageID,
      session_id: generateId() as SessionID,
      type: 'user',
      role: 'user',
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: 'See https://example.com/tenant',
      content: 'See https://example.com/tenant',
    } as Message;
    const tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };

    await hook({
      result: message,
      params: {
        provider: 'rest',
        tenant,
        authentication: { payload: { tenant_id: 'tenant-a' } },
        user: { user_id: generateId() as UUID, tenant_id: 'tenant-a' },
      },
    } as never);

    expect(create).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ session_id: message.session_id })]),
      expect.objectContaining({
        provider: undefined,
        tenant,
        authentication: { payload: { tenant_id: 'tenant-a' } },
      })
    );
  });
});
