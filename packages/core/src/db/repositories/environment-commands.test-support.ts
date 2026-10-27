import { eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { BranchID } from '../../types';
import type { Database } from '../client';
import { select, update } from '../database-wrapper';
import { branches } from '../schema';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

let unique = 9500000;
export async function seedEnvironmentCommandBranch(db: Database, options: { path?: string } = {}) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}@example.test`,
    name: 'Environment test',
  });
  const slug = `test/${generateId()}`;
  const name = `env-${generateId()}`;
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    name: 'Environment test',
    slug,
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/environment-test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name,
    ref: 'main',
    branch_unique_id: unique++,
    path: options.path ?? `/tmp/environment-test/worktrees/${slug}/${name}`,
    created_by: user.user_id,
    start_command: 'true',
    stop_command: 'true',
    nuke_command: 'true',
    logs_command: 'printf diagnostic',
    filesystem_status: 'ready',
    environment_instance: { status: 'stopped' },
  });
  return { branch, user };
}

/** Create a branch, then plant a path the create-time overlap fence would refuse (legacy rows). */
export async function createBranchAtPathForTest(
  db: Database,
  data: Parameters<BranchRepository['create']>[0] & { path: string }
) {
  const branch = await new BranchRepository(db).create({
    ...data,
    path: `/tmp/overlap-fixture/${generateId()}`,
  });
  await setBranchPathForTest(db, branch.branch_id, data.path);
  return { ...branch, path: data.path };
}

/** Rewrite a stored branch path directly; BranchRepository keeps `path` immutable. */
export async function setBranchPathForTest(db: Database, branchId: string, path: string) {
  const row = await select(db).from(branches).where(eq(branches.branch_id, branchId)).one();
  if (!row) throw new Error(`Branch not found: ${branchId}`);
  await update(db, branches)
    .set({ data: { ...row.data, path } })
    .where(eq(branches.branch_id, branchId))
    .run();
}
