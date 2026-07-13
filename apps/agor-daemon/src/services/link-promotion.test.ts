import { BranchRepository, LinksRepository } from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { BranchID, Link, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import {
  seedLinkBranch,
  seedLinkSession as seedSession,
  seedLinkUser as seedUser,
} from '../../../../packages/core/src/db/repositories/links.test-helpers';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { LinkPromotionService } from './link-promotion';
import { LinksService } from './links';

async function seedBranch(
  db: Database,
  options: { teammate?: boolean; othersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all' } = {}
) {
  return seedLinkBranch(db, {
    createBoard: true,
    teammate: options.teammate,
    othersCan: options.othersCan ?? 'none',
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

function createUrl(db: Database, branchId: BranchID, url: string, patch: Partial<Link> = {}) {
  return new LinksRepository(db).create({
    branch_id: branchId,
    kind: 'url',
    source: 'manual',
    url,
    ...patch,
  });
}

function promote(service: LinkPromotionService, source: Link, teammateBranchId: BranchID) {
  return service.create(
    { target: 'teammate', teammate_branch_id: teammateBranchId },
    { route: { sourceLinkId: source.link_id } }
  );
}

describe('LinkPromotionService', () => {
  dbTest('promotes URL links to teammate-owned pinned branch links', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const source = await createUrl(db, branch.branch_id, 'https://example.com/promote-me', {
      title: 'Promote me',
      metadata: { source_note: 'trusted' },
    });

    const { service } = promotionService(db);
    const promoted = await promote(service, source, teammate.branch_id);

    expect(promoted).toMatchObject({
      branch_id: teammate.branch_id,
      session_id: null,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/promote-me',
      is_pinned: true,
      title: 'Promote me',
      metadata: { teammate_promotion: true },
    });
  });

  dbTest('promotes knowledge references without copying source metadata', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const source = await new LinksRepository(db).create({
      branch_id: branch.branch_id,
      kind: 'kb_ref',
      source: 'parsed',
      ref_uri: 'agor://kb/team/runbook.md',
      metadata: { private_source_context: true },
    });

    const { service } = promotionService(db);
    const promoted = await promote(service, source, teammate.branch_id);

    expect(promoted).toMatchObject({
      branch_id: teammate.branch_id,
      kind: 'kb_ref',
      source: 'manual',
      ref_uri: 'agor://kb/team/runbook.md',
      is_pinned: true,
      metadata: { teammate_promotion: true },
    });
  });

  dbTest('rejects file-backed promotion until file lifetime is defined', async ({ db }) => {
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id);
    const teammate = await seedBranch(db, { teammate: true });
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
    await expect(promote(service, source, teammate.branch_id)).rejects.toThrow(
      'File-backed links cannot be promoted'
    );
  });

  dbTest('rejects internal links until target access checks are enforced', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
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
    await expect(promote(service, source, teammate.branch_id)).rejects.toThrow(
      'Internal links cannot be promoted'
    );
  });

  dbTest('rejects promotion to a non-teammate branch', async ({ db }) => {
    const branch = await seedBranch(db);
    const nonTeammate = await seedBranch(db);
    const source = await createUrl(db, branch.branch_id, 'https://example.com/nope');

    const { service } = promotionService(db);
    await expect(promote(service, source, nonTeammate.branch_id)).rejects.toThrow(BadRequest);
  });

  dbTest('requires all permission on teammate branch when RBAC is enabled', async ({ db }) => {
    const userId = generateId() as UUID;
    await seedUser(db, userId, 'link-promoter@example.com');
    const branch = await seedBranch(db, { othersCan: 'view' });
    const teammate = await seedBranch(db, { teammate: true, othersCan: 'view' });
    const source = await createUrl(db, branch.branch_id, 'https://example.com/rbac');

    const { service } = promotionService(db, { branchRbacEnabled: true });
    const params = {
      provider: 'rest',
      route: { sourceLinkId: source.link_id },
      user: { user_id: userId, email: 'link-promoter@example.com', role: 'member' },
    };

    await expect(
      service.create({ target: 'teammate', teammate_branch_id: teammate.branch_id }, params)
    ).rejects.toThrow(Forbidden);

    await new BranchRepository(db).addOwner(teammate.branch_id, userId);
    const promoted = await service.create(
      { target: 'teammate', teammate_branch_id: teammate.branch_id },
      params
    );
    expect(promoted.branch_id).toBe(teammate.branch_id);
  });

  dbTest('does not mutate an existing teammate-owned target during dedupe', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const source = await createUrl(db, branch.branch_id, 'https://example.com/dedupe#source');
    const existing = await createUrl(db, teammate.branch_id, 'https://example.com/dedupe#other', {
      is_pinned: false,
      title: 'Teammate title',
      metadata: { teammate_owned: true },
    });

    const { service } = promotionService(db);
    const promoted = await promote(service, source, teammate.branch_id);

    expect(promoted.link_id).toBe(existing.link_id);
    expect(promoted.is_pinned).toBe(false);
    expect(promoted.title).toBe('Teammate title');
    expect(promoted.metadata).toEqual({ teammate_owned: true });
  });

  dbTest('does not mutate a teammate-owned target created during promotion', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const source = await createUrl(db, branch.branch_id, 'https://example.com/raced#source');
    const existing = await createUrl(db, teammate.branch_id, 'https://example.com/raced#other', {
      is_pinned: false,
      title: 'Concurrent teammate title',
      metadata: { teammate_owned: true },
    });
    const findTarget = vi
      .spyOn(LinksRepository.prototype, 'findByOwnerAndTarget')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    try {
      const { service } = promotionService(db);
      const promoted = await promote(service, source, teammate.branch_id);

      expect(findTarget).toHaveBeenCalledTimes(3);
      expect(promoted.link_id).toBe(existing.link_id);
      expect(promoted.is_pinned).toBe(false);
      expect(promoted.title).toBe('Concurrent teammate title');
      expect(promoted.metadata).toEqual({ teammate_owned: true });
    } finally {
      findTarget.mockRestore();
    }
  });

  dbTest('removing teammate-owned copy leaves source link intact', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const repo = new LinksRepository(db);
    const source = await createUrl(db, branch.branch_id, 'https://example.com/remove-copy');

    const { service, linksService } = promotionService(db);
    const promoted = await promote(service, source, teammate.branch_id);

    await linksService.remove(promoted.link_id);
    expect(await repo.findById(promoted.link_id)).toBeNull();
    expect(await repo.findById(source.link_id)).toMatchObject({ link_id: source.link_id });
  });

  dbTest(
    'uses caller params for source get but internal params for trusted create',
    async ({ db }) => {
      const teammate = await seedBranch(db, { teammate: true });
      const source = {
        link_id: generateId(),
        branch_id: null,
        session_id: null,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/trusted-source',
        ref_uri: null,
        file_path: null,
        target_key: 'url:https://example.com/trusted-source',
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
      const patch = vi.fn();
      const app = {
        service(path: string) {
          if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
          return { get, create, patch };
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

      await service.create({ target: 'teammate', teammate_branch_id: teammate.branch_id }, params);

      expect(get).toHaveBeenCalledWith(source.link_id, params);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com/trusted-source', source: 'manual' }),
        expect.objectContaining({
          provider: undefined,
          _agorPreserveExistingOnCreate: true,
        })
      );
    }
  );
});
