import {
  BoardRepository,
  BranchRepository,
  LinksRepository,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { BoardID, BranchID, Link, SessionID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { LinkPromotionService } from './link-promotion';
import { LinksService } from './links';

async function seedUser(db: Database, userId: UUID, email = `${userId}@example.com`) {
  await new UsersRepository(db).create({ user_id: userId, email, name: email });
}

async function seedBoard(db: Database) {
  return new BoardRepository(db).create({
    board_id: generateId() as BoardID,
    name: 'Link promotion board',
    created_by: 'owner' as UUID,
  });
}

async function seedBranch(
  db: Database,
  options: { assistant?: boolean; othersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all' } = {}
) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `link-promotion-${generateId()}`,
    name: 'Link Promotion Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/example/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const board = await seedBoard(db);
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `link-promotion-branch-${generateId()}`,
    ref: 'refs/heads/test',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    board_id: board.board_id,
    created_by: 'owner' as UUID,
    permission_source: 'override',
    others_can: options.othersCan ?? 'none',
    custom_context: options.assistant ? { assistant: { kind: 'assistant' } } : undefined,
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

function promotionService(db: Database, options: { branchRbacEnabled?: boolean } = {}) {
  const linksService = new LinksService(db);
  const app = {
    service(path: string) {
      if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
      return linksService;
    },
  };
  return {
    linksService,
    service: new LinkPromotionService({
      app: app as never,
      db,
      branchRbacEnabled: options.branchRbacEnabled ?? false,
      superadminOpts: { allowSuperadmin: true },
    }),
  };
}

describe('LinkPromotionService', () => {
  dbTest('promotes URL links to assistant-owned pinned branch links', async ({ db }) => {
    const branch = await seedBranch(db);
    const assistant = await seedBranch(db, { assistant: true });
    const source = await new LinksRepository(db).create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/promote-me',
      title: 'Promote me',
      metadata: { source_note: 'trusted' },
    });

    const { service } = promotionService(db);
    const promoted = await service.create(
      { target: 'assistant', assistant_branch_id: assistant.branch_id },
      { route: { sourceLinkId: source.link_id } }
    );

    expect(promoted).toMatchObject({
      branch_id: assistant.branch_id,
      session_id: null,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/promote-me',
      is_pinned: true,
      title: 'Promote me',
    });
    expect(promoted.metadata).toMatchObject({
      source_note: 'trusted',
      promoted_from_link_id: source.link_id,
      promoted_from_owner: { branch_id: branch.branch_id, session_id: null },
    });
  });

  dbTest('promotes ref_uri links with internal object target fields', async ({ db }) => {
    const branch = await seedBranch(db);
    const assistant = await seedBranch(db, { assistant: true });
    const objectId = generateId() as UUID;
    const source = await new LinksRepository(db).create({
      branch_id: branch.branch_id,
      kind: 'internal',
      source: 'manual',
      ref_uri: `agor://branch/${objectId}`,
      target_object_type: 'branch',
      target_object_id: objectId,
    });

    const { service } = promotionService(db);
    const promoted = await service.create(
      { target: 'assistant', assistant_branch_id: assistant.branch_id },
      { route: { sourceLinkId: source.link_id } }
    );

    expect(promoted).toMatchObject({
      branch_id: assistant.branch_id,
      kind: 'internal',
      source: 'manual',
      ref_uri: `agor://branch/${objectId}`,
      target_object_type: 'branch',
      target_object_id: objectId,
      is_pinned: true,
    });
  });

  dbTest('promotes file-backed uploaded links by copying trusted file fields', async ({ db }) => {
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id);
    const assistant = await seedBranch(db, { assistant: true });
    const source = await new LinksRepository(db).create({
      session_id: session.session_id,
      kind: 'image',
      source: 'upload',
      file_path: '/tmp/agor-upload/image.png',
      title: 'image.png',
      mime_type: 'image/png',
      metadata: { filename: 'stored.png', size: 123 },
    });

    const { service } = promotionService(db);
    const promoted = await service.create(
      {
        target: 'assistant',
        assistant_branch_id: assistant.branch_id,
        file_path: '/tmp/client-spoof.png',
      } as never,
      { route: { sourceLinkId: source.link_id } }
    );

    expect(promoted).toMatchObject({
      branch_id: assistant.branch_id,
      kind: 'image',
      source: 'upload',
      file_path: '/tmp/agor-upload/image.png',
      title: 'image.png',
      mime_type: 'image/png',
      is_pinned: true,
    });
    expect(promoted.metadata).toMatchObject({
      filename: 'stored.png',
      size: 123,
      promoted_from_owner: { branch_id: null, session_id: session.session_id },
    });
  });

  dbTest('rejects promotion to a non-assistant branch', async ({ db }) => {
    const branch = await seedBranch(db);
    const nonAssistant = await seedBranch(db);
    const source = await new LinksRepository(db).create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/nope',
    });

    const { service } = promotionService(db);
    await expect(
      service.create(
        { target: 'assistant', assistant_branch_id: nonAssistant.branch_id },
        { route: { sourceLinkId: source.link_id } }
      )
    ).rejects.toThrow(BadRequest);
  });

  dbTest('requires all permission on assistant branch when RBAC is enabled', async ({ db }) => {
    const userId = generateId() as UUID;
    await seedUser(db, userId, 'link-promoter@example.com');
    const branch = await seedBranch(db, { othersCan: 'view' });
    const assistant = await seedBranch(db, { assistant: true, othersCan: 'view' });
    const source = await new LinksRepository(db).create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/rbac',
    });

    const { service } = promotionService(db, { branchRbacEnabled: true });
    const params = {
      provider: 'rest',
      route: { sourceLinkId: source.link_id },
      user: { user_id: userId, email: 'link-promoter@example.com', role: 'member' },
    };

    await expect(
      service.create({ target: 'assistant', assistant_branch_id: assistant.branch_id }, params)
    ).rejects.toThrow(Forbidden);

    await new BranchRepository(db).addOwner(assistant.branch_id, userId);
    const promoted = await service.create(
      { target: 'assistant', assistant_branch_id: assistant.branch_id },
      params
    );
    expect(promoted.branch_id).toBe(assistant.branch_id);
  });

  dbTest('dedupes by assistant owner and target key and re-pins existing copy', async ({ db }) => {
    const branch = await seedBranch(db);
    const assistant = await seedBranch(db, { assistant: true });
    const repo = new LinksRepository(db);
    const source = await repo.create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/dedupe#source',
    });
    const existing = await repo.create({
      branch_id: assistant.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/dedupe#other',
      is_pinned: false,
    });

    const { service } = promotionService(db);
    const promoted = await service.create(
      { target: 'assistant', assistant_branch_id: assistant.branch_id },
      { route: { sourceLinkId: source.link_id } }
    );

    expect(promoted.link_id).toBe(existing.link_id);
    expect(promoted.is_pinned).toBe(true);
  });

  dbTest('removing assistant-owned copy leaves source link intact', async ({ db }) => {
    const branch = await seedBranch(db);
    const assistant = await seedBranch(db, { assistant: true });
    const repo = new LinksRepository(db);
    const source = await repo.create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/remove-copy',
    });

    const { service, linksService } = promotionService(db);
    const promoted = await service.create(
      { target: 'assistant', assistant_branch_id: assistant.branch_id },
      { route: { sourceLinkId: source.link_id } }
    );

    await linksService.remove(promoted.link_id);
    expect(await repo.findById(promoted.link_id)).toBeNull();
    expect(await repo.findById(source.link_id)).toMatchObject({ link_id: source.link_id });
  });

  dbTest(
    'uses caller params for source get but internal params for trusted create',
    async ({ db }) => {
      const assistant = await seedBranch(db, { assistant: true });
      const source = {
        link_id: generateId(),
        branch_id: null,
        session_id: null,
        kind: 'document',
        source: 'upload',
        file_path: '/trusted/source.pdf',
        target_key: 'file:/trusted/source.pdf',
        is_pinned: false,
        title: 'source.pdf',
        mime_type: 'application/pdf',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as Link;
      const get = vi.fn(async () => source);
      const create = vi.fn(async (data: Partial<Link>) => ({
        ...source,
        ...data,
        link_id: generateId(),
      }));
      const app = {
        service(path: string) {
          if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
          return { get, create };
        },
      };
      const service = new LinkPromotionService({
        app: app as never,
        db,
        branchRbacEnabled: true,
        superadminOpts: { allowSuperadmin: true },
      });
      const params = {
        provider: 'rest',
        route: { sourceLinkId: source.link_id },
        user: { user_id: generateId() as UUID, email: 'admin@example.com', role: 'superadmin' },
      };

      await service.create(
        {
          target: 'assistant',
          assistant_branch_id: assistant.branch_id,
          file_path: '/client/spoof.pdf',
        } as never,
        params
      );

      expect(get).toHaveBeenCalledWith(source.link_id, params);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ file_path: '/trusted/source.pdf' }),
        expect.objectContaining({ provider: undefined })
      );
    }
  );
});
