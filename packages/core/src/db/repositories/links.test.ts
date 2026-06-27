import type { BranchID, SessionID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { LinksRepository } from './links';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

async function seedUser(db: Database, userId: UUID, email: string) {
  await new UsersRepository(db).create({ user_id: userId, email, name: email });
}

async function seedBranch(
  db: Database,
  options?: { createdBy?: UUID; othersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all' }
) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `links-repo-${generateId()}`,
    name: 'Links Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/example/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `links-branch-${generateId()}`,
    ref: 'refs/heads/test',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    created_by: options?.createdBy ?? ('owner' as UUID),
    permission_source: 'override',
    others_can: options?.othersCan ?? 'view',
  });
}

async function seedSession(db: Database, branchId: BranchID, createdBy: UUID) {
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branchId,
    created_by: createdBy,
    tasks: [],
    genealogy: { children: [] },
  });
}

describe('LinksRepository', () => {
  dbTest('creates branch-owned and session-owned links with exactly one owner', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id, 'owner' as UUID);

    const branchLink = await repo.create({
      branch_id: branch.branch_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/branch',
    });
    const sessionLink = await repo.create({
      session_id: session.session_id,
      kind: 'url',
      source: 'manual',
      url: 'https://example.com/session',
    });

    expect(branchLink.branch_id).toBe(branch.branch_id);
    expect(branchLink.session_id).toBeNull();
    expect(sessionLink.session_id).toBe(session.session_id);
    expect(sessionLink.branch_id).toBeNull();

    await expect(
      repo.create({
        branch_id: branch.branch_id,
        session_id: session.session_id,
        kind: 'url',
        source: 'manual',
        url: 'https://example.com/both',
      } as never)
    ).rejects.toThrow(/exactly one owner/);
  });

  dbTest('upserts by owner and target_key without piling up duplicates', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedBranch(db);
    const sessionA = await seedSession(db, branch.branch_id, 'owner' as UUID);
    const sessionB = await seedSession(db, branch.branch_id, 'owner' as UUID);

    await repo.upsert({
      session_id: sessionA.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/repeat',
    });
    const second = await repo.upsert({
      session_id: sessionA.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/repeat',
      title: 'updated',
    });
    await repo.upsert({
      session_id: sessionB.session_id,
      kind: 'url',
      source: 'parsed',
      url: 'https://example.com/repeat',
    });

    expect(second.title).toBe('updated');
    expect(await repo.findAll({ sessionId: sessionA.session_id })).toHaveLength(1);
    expect(await repo.findAll({ sessionId: sessionB.session_id })).toHaveLength(1);
  });

  dbTest('filters by session and branch owner scopes', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branchA = await seedBranch(db);
    const branchB = await seedBranch(db);
    const sessionA = await seedSession(db, branchA.branch_id, 'owner' as UUID);
    const sessionB = await seedSession(db, branchB.branch_id, 'owner' as UUID);

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

  dbTest('stores uploaded image and document metadata', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branch = await seedBranch(db);
    const session = await seedSession(db, branch.branch_id, 'owner' as UUID);

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

  dbTest('pushes branch/session visibility into findAll SQL', async ({ db }) => {
    const repo = new LinksRepository(db);
    const branchRepo = new BranchRepository(db);
    const viewer = generateId() as UUID;
    await seedUser(db, viewer, 'links-viewer@example.com');
    const visibleBranch = await seedBranch(db, { othersCan: 'none' });
    const hiddenBranch = await seedBranch(db, { othersCan: 'none' });
    await branchRepo.addOwner(visibleBranch.branch_id, viewer);
    const visibleSession = await seedSession(db, visibleBranch.branch_id, 'owner' as UUID);
    const hiddenSession = await seedSession(db, hiddenBranch.branch_id, 'owner' as UUID);

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
