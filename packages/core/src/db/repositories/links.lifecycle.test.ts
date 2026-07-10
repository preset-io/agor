import type { BoardID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { LinksRepository } from './links';
import { seedLinkBoard, seedLinkBranch, seedLinkSession, seedLinkUser } from './links.test-helpers';
import { SessionRepository } from './sessions';

describe('LinksRepository lifecycle and visibility', () => {
  dbTest('filters by session and branch owner scopes', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branchA = await seedLinkBranch(db);
    const branchB = await seedLinkBranch(db);
    const sessionA = await seedLinkSession(db, branchA.branch_id, 'owner' as UUID);
    const sessionB = await seedLinkSession(db, branchB.branch_id, 'owner' as UUID);

    await repo.create({
      session_id: sessionA.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/a',
    });
    await repo.create({
      session_id: sessionB.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/b',
    });
    await repo.create({
      branch_id: branchA.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/branch-a',
    });

    expect(
      (await repo.findAll({ sessionId: sessionA.session_id })).map((link) => link.url)
    ).toEqual(['https://example.com/a']);
    expect((await repo.findAll({ branchId: branchA.branch_id })).map((link) => link.url)).toEqual([
      'https://example.com/branch-a',
    ]);
  });

  dbTest(
    'filters pinned links by board-derived owner scope without links.board_id',
    async ({ db }) => {
      const repo = new LinksRepository(db);
      const boardA = generateId() as BoardID;
      const boardB = generateId() as BoardID;
      await seedLinkBoard(db, boardA);
      await seedLinkBoard(db, boardB);
      const branchA = await seedLinkBranch(db, { boardId: boardA });
      const branchB = await seedLinkBranch(db, { boardId: boardB });
      const archivedBranch = await seedLinkBranch(db, { boardId: boardA, archived: true });
      const sessionA = await seedLinkSession(db, branchA.branch_id, 'owner' as UUID);
      const sessionB = await seedLinkSession(db, branchB.branch_id, 'owner' as UUID);
      const archivedSession = await seedLinkSession(db, branchA.branch_id, 'owner' as UUID);
      await new SessionRepository(db).update(archivedSession.session_id, { archived: true });

      const boardBranchPinned = await repo.create({
        branch_id: branchA.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/board-branch-pinned',
        is_pinned: true,
      });
      await repo.create({
        branch_id: branchA.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/board-branch-unpinned',
        is_pinned: false,
      });
      await repo.create({
        branch_id: branchB.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/other-board',
        is_pinned: true,
      });
      await repo.create({
        branch_id: archivedBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/archived-branch',
        is_pinned: true,
      });
      const boardSessionPinned = await repo.create({
        session_id: sessionA.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/board-session-pinned',
        is_pinned: true,
      });
      await repo.create({
        session_id: sessionB.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/other-board-session',
        is_pinned: true,
      });
      await repo.create({
        session_id: archivedSession.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/archived-session',
        is_pinned: true,
      });

      expect(
        (await repo.findAll({ boardId: boardA, ownerScope: 'branch', isPinned: true })).map(
          (link) => link.link_id
        )
      ).toEqual([boardBranchPinned.link_id]);
      expect(
        (await repo.findAll({ boardId: boardA, ownerScope: 'session', isPinned: true })).map(
          (link) => link.link_id
        )
      ).toEqual([boardSessionPinned.link_id]);
      expect(
        (await repo.findAll({ boardId: boardA, ownerScope: 'all', isPinned: true }))
          .map((link) => link.link_id)
          .sort()
      ).toEqual([boardBranchPinned.link_id, boardSessionPinned.link_id].sort());
    }
  );

  dbTest(
    'filters archived branch owners from global pinned branch lifecycle queries',
    async ({ db }) => {
      const repo = new LinksRepository(db);
      const activeBranch = await seedLinkBranch(db);
      const archivedBranch = await seedLinkBranch(db, { archived: true });
      const session = await seedLinkSession(db, activeBranch.branch_id, 'owner' as UUID);

      const activePinned = await repo.create({
        branch_id: activeBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/active-branch-pinned',
        is_pinned: true,
      });
      const archivedPinned = await repo.create({
        branch_id: archivedBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/archived-branch-pinned',
        is_pinned: true,
      });
      await repo.create({
        branch_id: activeBranch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/active-branch-unpinned',
        is_pinned: false,
      });
      await repo.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/session-pinned',
        is_pinned: true,
      });

      expect(
        (await repo.findAll({ ownerScope: 'branch', isPinned: true })).map((link) => link.link_id)
      ).toEqual([activePinned.link_id]);
      expect(
        (
          await repo.findAll({
            branchId: archivedBranch.branch_id,
            ownerScope: 'branch',
            isPinned: true,
          })
        ).map((link) => link.link_id)
      ).toEqual([archivedPinned.link_id]);
    }
  );

  dbTest('stores uploaded image and document metadata', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedLinkBranch(db);
    const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);

    const image = await repo.create({
      session_id: session.session_id,
      kind: 'image',
      source: 'upload',
      file_path: '/uploads/image.png',
      title: 'image.png',
      mime_type: 'image/png',
      metadata: { size: 123 },
    });
    const document = await repo.create({
      session_id: session.session_id,
      kind: 'document',
      source: 'upload',
      file_path: '/uploads/report.pdf',
      title: 'report.pdf',
      mime_type: 'application/pdf',
      metadata: { size: 456 },
    });

    expect(image).toMatchObject({
      kind: 'image',
      source: 'upload',
      file_path: '/uploads/image.png',
      mime_type: 'image/png',
      title: 'image.png',
      metadata: { size: 123 },
    });
    expect(document).toMatchObject({
      kind: 'document',
      source: 'upload',
      file_path: '/uploads/report.pdf',
      mime_type: 'application/pdf',
      title: 'report.pdf',
      metadata: { size: 456 },
    });
  });

  dbTest('stores pinned internal object refs and dedupes by object identity', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedLinkBranch(db);
    const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
    const targetSessionId = generateId() as UUID;

    const first = await repo.create({
      session_id: session.session_id,
      kind: 'internal',
      source: 'manual',
      ref_uri: `agor://session/${targetSessionId}`,
      target_object_type: 'session',
      target_object_id: targetSessionId,
      is_pinned: true,
      title: 'Related session',
    });
    const second = await repo.upsert({
      session_id: session.session_id,
      kind: 'internal',
      source: 'manual',
      ref_uri: `agor://session/${targetSessionId}?via=alias`,
      target_object_type: 'session',
      target_object_id: targetSessionId,
      is_pinned: false,
      title: 'Updated related session',
    });

    expect(second.link_id).toBe(first.link_id);
    expect(second).toMatchObject({
      kind: 'internal',
      ref_uri: `agor://session/${targetSessionId}?via=alias`,
      target_object_type: 'session',
      target_object_id: targetSessionId,
      target_key: `object:session:${targetSessionId}`,
      is_pinned: false,
      title: 'Updated related session',
    });

    const pinned = await repo.update(second.link_id, { is_pinned: true });
    expect(pinned.is_pinned).toBe(true);
    expect(await repo.findAll({ sessionId: session.session_id, isPinned: true })).toHaveLength(1);
    expect(
      await repo.findAll({ targetObjectType: 'session', targetObjectId: targetSessionId })
    ).toHaveLength(1);
  });

  dbTest('rejects malformed internal object refs', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedLinkBranch(db);
    const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);

    await expect(
      repo.create({
        session_id: session.session_id,
        kind: 'internal',
        source: 'manual',
        ref_uri: 'agor://session/missing-id',
        target_object_type: 'session',
      } as never)
    ).rejects.toThrow(/provided together/);

    await expect(
      repo.create({
        session_id: session.session_id,
        kind: 'internal',
        source: 'manual',
        ref_uri: 'https://example.com/session',
        target_object_type: 'session',
        target_object_id: generateId() as UUID,
      })
    ).rejects.toThrow('agor://');
  });

  dbTest('pushes branch/session visibility into findAll SQL', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branchRepo = new BranchRepository(db);
    const viewer = generateId() as UUID;
    await seedLinkUser(db, viewer, 'links-viewer@example.com');
    const visibleBranch = await seedLinkBranch(db, { othersCan: 'none' });
    const hiddenBranch = await seedLinkBranch(db, { othersCan: 'none' });
    await branchRepo.addOwner(visibleBranch.branch_id, viewer);
    const visibleSession = await seedLinkSession(db, visibleBranch.branch_id, 'owner' as UUID);
    const hiddenSession = await seedLinkSession(db, hiddenBranch.branch_id, 'owner' as UUID);

    const visibleBranchLink = await repo.create({
      branch_id: visibleBranch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/visible-branch',
    });
    const visibleSessionLink = await repo.create({
      session_id: visibleSession.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/visible-session',
    });
    await repo.create({
      branch_id: hiddenBranch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/hidden-branch',
    });
    await repo.create({
      session_id: hiddenSession.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/hidden-session',
    });

    const visible = await repo.findAll({ visibleToUserId: viewer });
    expect(visible.map((link) => link.link_id).sort()).toEqual(
      [visibleBranchLink.link_id, visibleSessionLink.link_id].sort()
    );
  });
});
