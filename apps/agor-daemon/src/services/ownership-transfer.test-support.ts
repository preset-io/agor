import {
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  generateId,
  RepoRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import { setupOwnershipTransferServices } from './ownership-transfer';

export async function ownershipFixture(
  db: TenantScopeAwareDatabase,
  binding: 'inherit' | 'override' = 'inherit'
) {
  const users = new UsersRepository(db);
  const makeUser = (role: 'member' | 'admin' | 'viewer') =>
    users.create({ email: `${generateId()}@example.test`, role });
  const owner = await makeUser('member');
  const successor = await makeUser('member');
  const admin = await makeUser('admin');
  const viewer = await makeUser('viewer');
  const board = await new BoardRepository(db).create({
    name: 'Ownership test',
    created_by: owner.user_id,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    name: 'Ownership test',
    slug: `ownership-${generateId()}`,
    repo_type: 'remote',
    remote_url: 'https://example.invalid/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    board_id: board.board_id,
    name: 'ownership-test',
    ref: 'main',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    created_by: owner.user_id,
    permission_binding: binding,
  });
  return {
    owner,
    successor,
    admin,
    viewer,
    board,
    branch,
    policies: new CapabilityPolicyRepository(db),
  };
}

export function ownershipApp(db: TenantScopeAwareDatabase) {
  const app = feathers();
  // Real service event emitters without unrelated resource CRUD hooks.
  app.use('boards', {
    async get() {
      return null;
    },
  });
  app.use('branches', {
    async get() {
      return null;
    },
  });
  setupOwnershipTransferServices(app, db);
  return app;
}

export function ownershipParams(userId: UserID, resourceId: string, tenantId?: string) {
  return {
    provider: 'rest',
    authenticated: true,
    route: { id: resourceId },
    user: { user_id: userId, role: 'member' },
    ...(tenantId ? { tenant: { tenant_id: tenantId, source: 'explicit' } } : {}),
  };
}
