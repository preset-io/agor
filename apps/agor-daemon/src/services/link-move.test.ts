import { LinksRepository, SessionRepository } from '@agor/core/db';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type { BranchID, Link, SessionID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import {
  seedLinkBranch,
  seedLinkSession,
} from '../../../../packages/core/src/db/repositories/links.test-helpers';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { LinkMoveService } from './link-move';

function moveService(db: Database) {
  const linksRepository = new LinksRepository(db);
  const sessionsRepository = new SessionRepository(db);
  const emit = vi.fn();
  const app = {
    service(path: string) {
      if (path !== 'links') throw new Error(`Unexpected service: ${path}`);
      return {
        get: async (id: string) => {
          const link = await linksRepository.findById(id);
          if (!link) throw new NotFound(`Link not found: ${id}`);
          return link;
        },
        emit,
      };
    },
  };
  const sessionsService = {
    get: async (id: string) => {
      const session = await sessionsRepository.findById(id);
      if (!session) throw new NotFound(`Session not found: ${id}`);
      return session;
    },
  };
  return {
    emit,
    linksRepository,
    service: new LinkMoveService({
      app: app as never,
      db,
      branchRbacEnabled: false,
      sessionsService,
      superadminOpts: { allowSuperadmin: true },
    }),
  };
}

function moveToBranch(service: LinkMoveService, link: Link, branchId: BranchID) {
  return service.create(
    { target: 'branch', branch_id: branchId },
    { route: { linkId: link.link_id } }
  );
}

describe('LinkMoveService', () => {
  dbTest('moves a session link to a branch and publishes owner-scoped events', async ({ db }) => {
    const branch = await seedLinkBranch(db);
    const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
    const { emit, linksRepository, service } = moveService(db);
    const source = await linksRepository.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/move',
      title: 'Move',
      is_pinned: true,
    });

    const result = await moveToBranch(service, source, branch.branch_id);

    expect(result).toMatchObject({
      merged: false,
      link: {
        link_id: source.link_id,
        branch_id: branch.branch_id,
        session_id: null,
        title: 'Move',
        is_pinned: true,
      },
      previous_link: { session_id: session.session_id },
    });
    expect(emit.mock.calls.map(([event]) => event)).toEqual(['removed', 'created']);
  });

  dbTest(
    'coalesces an earlier copied destination and publishes both affected records',
    async ({ db }) => {
      const branch = await seedLinkBranch(db);
      const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
      const { emit, linksRepository, service } = moveService(db);
      const source = await linksRepository.create({
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/copied#session',
      });
      const destination = await linksRepository.create({
        branch_id: branch.branch_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/copied#branch',
        title: 'Existing branch label',
      });

      const result = await moveToBranch(service, source, branch.branch_id);

      expect(result).toMatchObject({
        merged: true,
        link: { link_id: destination.link_id, title: 'Existing branch label' },
        previous_link: { link_id: source.link_id },
      });
      expect(emit.mock.calls.map(([event]) => event)).toEqual(['removed', 'patched']);
    }
  );

  dbTest('moves a branch link into a concrete session owner', async ({ db }) => {
    const branch = await seedLinkBranch(db);
    const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
    const { linksRepository, service } = moveService(db);
    const source = await linksRepository.create({
      branch_id: branch.branch_id,
      kind: 'kb_ref',
      source: 'manual',
      ref_uri: 'agor://kb/team/runbook.md',
    });

    const result = await service.create(
      { target: 'session', session_id: session.session_id as SessionID },
      { route: { linkId: source.link_id } }
    );

    expect(result.link).toMatchObject({
      link_id: source.link_id,
      branch_id: null,
      session_id: session.session_id,
    });
  });

  dbTest('rejects unsafe file-backed moves and no-op destinations', async ({ db }) => {
    const branch = await seedLinkBranch(db);
    const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
    const { linksRepository, service } = moveService(db);
    const upload = await linksRepository.create({
      session_id: session.session_id,
      kind: 'image',
      source: 'upload',
      file_path: 'image.png',
    });
    const branchLink = await linksRepository.create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/already-there',
    });

    await expect(moveToBranch(service, upload, branch.branch_id)).rejects.toThrow(
      'File-backed links cannot move'
    );
    await expect(moveToBranch(service, branchLink, branch.branch_id)).rejects.toThrow(BadRequest);
  });
});
