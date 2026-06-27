import {
  BranchRepository,
  LinksRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, Message, MessageID, SessionID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { ingestParsedLinksAfterMessageCreate, LinksService } from './links';

async function seedUser(db: Database, userId: UUID, email: string) {
  await new UsersRepository(db).create({ user_id: userId, email, name: email });
}

async function seedBranch(db: Database, othersCan: 'none' | 'view' = 'none') {
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
    created_by: 'owner' as UUID,
    permission_source: 'override',
    others_can: othersCan,
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
});
