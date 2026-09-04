import {
  BranchRepository,
  type Database,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { UUID } from '@agor/core/types';
import { ROLES, SessionStatus } from '@agor/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions.js';

const USER_ID = 'branch-archive-user' as UUID;
const APP = { service: () => ({ emit: () => undefined }) } as unknown as Application;

async function createBranch(db: Database) {
  const users = new UsersRepository(db);
  await users.create({
    user_id: USER_ID,
    email: 'branch-archive@example.com',
    role: ROLES.MEMBER,
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `branch-archive-${generateId()}`,
    name: 'Branch archive test',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/archive.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'archive-many',
    ref: 'archive-many',
    branch_unique_id: 991_001,
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: USER_ID,
  });
}

dbTest('branch archive is complete beyond the former 1,000-session cap', async ({ db }) => {
  const branch = await createBranch(db);
  const repository = new SessionRepository(db);
  for (let index = 0; index < 1_001; index++) {
    await repository.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      created_by: USER_ID,
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
    });
  }
  const manual = await repository.create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    created_by: USER_ID,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    archived: true,
    archived_reason: 'manual',
  });

  const service = new SessionsService(db, APP);
  expect((await service.archiveBranchSessions(branch.branch_id)).count).toBe(1_001);
  expect(await repository.findAll({ branchId: branch.branch_id, archived: false })).toHaveLength(0);
  await expect(repository.findById(manual.session_id)).resolves.toMatchObject({
    archived: true,
    archived_reason: 'manual',
  });

  expect((await service.unarchiveBranchSessions(branch.branch_id)).count).toBe(1_001);
  expect(await repository.findAll({ branchId: branch.branch_id, archived: false })).toHaveLength(
    1_001
  );
  await expect(repository.findById(manual.session_id)).resolves.toMatchObject({
    archived: true,
    archived_reason: 'manual',
  });
});
