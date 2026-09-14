import { generateId } from '../../lib/ids';
import type { BranchID } from '../../types';
import type { Database } from '../client';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

let unique = 9500000;
export async function seedEnvironmentCommandBranch(db: Database) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}@example.test`,
    name: 'Environment test',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    name: 'Environment test',
    slug: `test/${generateId()}`,
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/environment-test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `env-${generateId()}`,
    ref: 'main',
    branch_unique_id: unique++,
    path: '/tmp/environment-test',
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
