import { BranchRepository, LinksRepository } from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { BranchID, Link, UUID } from '@agor/core/types';
import { LINK_PROMOTION_TARGET } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import {
  seedLinkBranch,
  seedLinkSession as seedSession,
  seedLinkUser as seedUser,
} from '../../../../packages/core/src/db/repositories/links.test-helpers';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { LinkPlacementService } from './link-promotion';
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
    service: new LinkPlacementService({
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

function promote(service: LinkPlacementService, source: Link, teammateBranchId: BranchID) {
  return service.create(
    { target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: teammateBranchId },
    { route: { sourceLinkId: source.link_id } }
  );
}

function promoteToBranch(service: LinkPlacementService, source: Link, branchId: BranchID) {
  return service.create(
    { target: LINK_PROMOTION_TARGET.branch, branch_id: branchId },
    { route: { sourceLinkId: source.link_id } }
  );
}

describe('LinkPlacementService', () => {
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
      metadata: {
        teammate_promotion: true,
        promoted_from_owner: { branch_id: branch.branch_id, link_id: source.link_id },
      },
    });
  });

  dbTest(
    'promotes knowledge references without carrying private source metadata',
    async ({ db }) => {
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
        metadata: {
          teammate_promotion: true,
          promoted_from_owner: { branch_id: branch.branch_id, link_id: source.link_id },
        },
      });
    }
  );

  dbTest('promotes a session link to its branch without removing the source', async ({ db }) => {
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id);
    const repository = new LinksRepository(db);
    const source = await repository.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/session-source',
      title: 'Session source',
    });

    const { service } = promotionService(db);
    const promoted = await promoteToBranch(service, source, branch.branch_id);

    expect(promoted).toMatchObject({
      branch_id: branch.branch_id,
      session_id: null,
      source: 'manual',
      url: source.url,
      metadata: {
        promoted_from_owner: { session_id: session.session_id, link_id: source.link_id },
      },
    });
    await expect(repository.findById(source.link_id)).resolves.toMatchObject({
      session_id: session.session_id,
      branch_id: null,
    });
  });

  dbTest('rejects promotion from a teammate into an ephemeral branch', async ({ db }) => {
    const teammate = await seedBranch(db, { teammate: true });
    const destinationBranch = await seedBranch(db);
    const repository = new LinksRepository(db);
    const source = await createUrl(db, teammate.branch_id, 'https://example.com/teammate-source');

    const { service } = promotionService(db);
    await expect(promoteToBranch(service, source, destinationBranch.branch_id)).rejects.toThrow(
      'Links cannot be promoted from teammate to branch'
    );
    await expect(repository.findById(source.link_id)).resolves.toMatchObject({
      branch_id: teammate.branch_id,
      session_id: null,
    });
  });

  dbTest(
    'lists and removes a destination placement without removing its source',
    async ({ db }) => {
      const branch = await seedBranch(db);
      const teammate = await seedBranch(db, { teammate: true });
      const source = await createUrl(db, branch.branch_id, 'https://example.com/placement-state');
      const { service } = promotionService(db);
      const promoted = await promote(service, source, teammate.branch_id);

      await expect(service.find({ route: { sourceLinkId: source.link_id } })).resolves.toEqual(
        expect.arrayContaining([source, promoted])
      );

      await expect(
        service.remove(null, {
          route: { sourceLinkId: source.link_id },
          query: {
            target: LINK_PROMOTION_TARGET.teammate,
            teammate_branch_id: teammate.branch_id,
          },
        })
      ).resolves.toMatchObject({ link_id: promoted.link_id });
      await expect(new LinksRepository(db).findById(source.link_id)).resolves.toMatchObject({
        link_id: source.link_id,
      });
      await expect(new LinksRepository(db).findById(promoted.link_id)).resolves.toBeNull();
    }
  );

  dbTest('removes a legacy promotion-managed teammate placement', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const repository = new LinksRepository(db);
    const source = await createUrl(db, branch.branch_id, 'https://example.com/legacy-placement');
    const legacyPlacement = await createUrl(
      db,
      teammate.branch_id,
      'https://example.com/legacy-placement',
      { metadata: { teammate_promotion: true } }
    );
    const { service } = promotionService(db);

    await expect(
      service.remove(null, {
        route: { sourceLinkId: source.link_id },
        query: {
          target: LINK_PROMOTION_TARGET.teammate,
          teammate_branch_id: teammate.branch_id,
        },
      })
    ).resolves.toMatchObject({ link_id: legacyPlacement.link_id });
    await expect(repository.findById(source.link_id)).resolves.not.toBeNull();
    await expect(repository.findById(legacyPlacement.link_id)).resolves.toBeNull();
  });

  dbTest('preserves promotion lineage from session through branch to teammate', async ({ db }) => {
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id);
    const teammate = await seedBranch(db, { teammate: true });
    const repository = new LinksRepository(db);
    const sessionSource = await repository.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/promotion-lineage',
    });
    const { service } = promotionService(db);
    const branchPlacement = await promoteToBranch(service, sessionSource, branch.branch_id);
    const teammatePlacement = await promote(service, branchPlacement, teammate.branch_id);

    expect(teammatePlacement.metadata).toMatchObject({
      promoted_from_owner: {
        link_id: sessionSource.link_id,
        session_id: session.session_id,
      },
    });
    await expect(
      service.remove(null, {
        route: { sourceLinkId: branchPlacement.link_id },
        query: {
          target: LINK_PROMOTION_TARGET.teammate,
          teammate_branch_id: teammate.branch_id,
        },
      })
    ).resolves.toMatchObject({ link_id: teammatePlacement.link_id });
    await expect(repository.findById(sessionSource.link_id)).resolves.not.toBeNull();
    await expect(repository.findById(branchPlacement.link_id)).resolves.not.toBeNull();
  });

  dbTest('promotes uploaded files while preserving content metadata and source', async ({ db }) => {
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
      metadata: { filename: 'stored.png', originalName: 'image.png', size: 123, private: true },
    });

    const { service } = promotionService(db);
    const promoted = await promote(service, source, teammate.branch_id);

    expect(promoted).toMatchObject({
      branch_id: teammate.branch_id,
      session_id: null,
      kind: 'image',
      source: 'upload',
      file_path: source.file_path,
      title: source.title,
      mime_type: source.mime_type,
      metadata: {
        filename: 'stored.png',
        originalName: 'image.png',
        size: 123,
        teammate_promotion: true,
        promoted_from_owner: { session_id: session.session_id, link_id: source.link_id },
      },
    });
    expect(promoted.metadata).not.toHaveProperty('private');
    await expect(new LinksRepository(db).findById(source.link_id)).resolves.toMatchObject({
      session_id: session.session_id,
      file_path: source.file_path,
    });
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

  dbTest('rejects branch promotion when the destination is actually a teammate', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const source = await createUrl(db, branch.branch_id, 'https://example.com/wrong-target-kind');

    const { service } = promotionService(db);
    await expect(promoteToBranch(service, source, teammate.branch_id)).rejects.toThrow(
      'Target branch cannot be a teammate'
    );
  });

  dbTest('does not remove an independently curated matching teammate link', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const source = await createUrl(db, branch.branch_id, 'https://example.com/curated-target');
    const curated = await createUrl(db, teammate.branch_id, 'https://example.com/curated-target', {
      metadata: { teammate_owned: true },
    });
    const { service } = promotionService(db);

    await expect(
      service.remove(null, {
        route: { sourceLinkId: source.link_id },
        query: {
          target: LINK_PROMOTION_TARGET.teammate,
          teammate_branch_id: teammate.branch_id,
        },
      })
    ).rejects.toThrow('Destination link is not managed by this promotion');
    await expect(new LinksRepository(db).findById(curated.link_id)).resolves.toMatchObject({
      link_id: curated.link_id,
    });
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
      service.create(
        { target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: teammate.branch_id },
        params
      )
    ).rejects.toThrow(Forbidden);

    await new BranchRepository(db).addOwner(teammate.branch_id, userId);
    const promoted = await service.create(
      { target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: teammate.branch_id },
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

  dbTest('removing the teammate association leaves the source link intact', async ({ db }) => {
    const branch = await seedBranch(db);
    const teammate = await seedBranch(db, { teammate: true });
    const repo = new LinksRepository(db);
    const source = await createUrl(db, branch.branch_id, 'https://example.com/remove-association');

    const { service, linksService } = promotionService(db);
    const promoted = await promote(service, source, teammate.branch_id);

    await linksService.remove(promoted.link_id);
    expect(await repo.findById(promoted.link_id)).toBeNull();
    expect(await repo.findById(source.link_id)).toMatchObject({ link_id: source.link_id });
  });

  dbTest(
    'uses caller params for source get but internal params for trusted create',
    async ({ db }) => {
      const sourceBranch = await seedBranch(db);
      const teammate = await seedBranch(db, { teammate: true });
      const source = {
        link_id: generateId(),
        branch_id: sourceBranch.branch_id,
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
      const service = new LinkPlacementService({
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
        { target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: teammate.branch_id },
        params
      );

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
