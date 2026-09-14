import type { Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

async function createBranch(db: ConstructorParameters<typeof SessionRepository>[0]) {
  await new UsersRepository(db).create({
    user_id: 'archive-user' as UUID,
    email: `archive-user-${generateId()}@example.test`,
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `session-archive-${generateId()}`,
    name: 'Session archive repository test',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/archive.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'archive-tree',
    ref: 'archive-tree',
    branch_unique_id: 811_001,
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: 'archive-user' as UUID,
  });
}

function sessionData(branchId: UUID, overrides: Partial<Session> = {}): Partial<Session> {
  return {
    session_id: generateId(),
    branch_id: branchId,
    created_by: 'archive-user',
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  };
}

dbTest('loads overlapping descendant closures with one branch-local graph', async ({ db }) => {
  const branch = await createBranch(db);
  const repository = new SessionRepository(db);
  const root = await repository.create(sessionData(branch.branch_id));
  const child = await repository.create(
    sessionData(branch.branch_id, {
      genealogy: { parent_session_id: root.session_id, children: [] },
    })
  );
  const grandchild = await repository.create(
    sessionData(branch.branch_id, {
      genealogy: { forked_from_session_id: child.session_id, children: [] },
    })
  );

  const closures = await repository.findBranchLocalDescendantsForRoots(
    [root.session_id, child.session_id],
    branch.branch_id
  );

  expect(closures.get(root.session_id)?.map((session) => session.session_id)).toEqual([
    child.session_id,
    grandchild.session_id,
  ]);
  expect(closures.get(child.session_id)?.map((session) => session.session_id)).toEqual([
    grandchild.session_id,
  ]);
});

dbTest('ignores stale archive reasons on active rows', async ({ db }) => {
  const branch = await createBranch(db);
  const repository = new SessionRepository(db);
  const active = await repository.create(
    sessionData(branch.branch_id, {
      archived: false,
      archived_reason: 'parent_archived',
    })
  );

  expect(active).toMatchObject({ archived: false, archived_reason: undefined });
  await expect(repository.findById(active.session_id)).resolves.toMatchObject({
    archived: false,
    archived_reason: undefined,
  });
});
