import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { sessionQueryValidator, typedValidateQuery } from '@agor/core/lib/feathers-validation';
import type { Application, Database, Session, UserID } from '@agor/core/types';
import { ROLES, SessionStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  ensureCanView,
  loadSessionBranch,
  scopeFindToAccessibleSessionsSql,
} from '../utils/branch-authorization.js';
import { SessionsService } from './sessions.js';

async function privateBranchSession(
  db: Database,
  owner: UserID,
  parentSessionId?: Session['session_id']
): Promise<{ branchId: string; session: Session }> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `genealogy-auth-${generateId()}`,
    name: 'Genealogy authorization',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/genealogy-auth.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: `genealogy-auth-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
    path: `/tmp/${generateId()}`,
    created_by: owner,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: owner,
    ...(parentSessionId ? { genealogy: { parent_session_id: parentSessionId, children: [] } } : {}),
  });
  return { branchId: branch.branch_id, session };
}

describe('sessions.getGenealogy authorization', () => {
  beforeEach(() => vi.stubEnv('AGOR_BASE_URL', 'http://agor.test'));
  afterEach(() => vi.unstubAllEnvs());

  dbTest('requires Session view and returns only relatives the caller can view', async ({ db }) => {
    const users = new UsersRepository(db);
    const owner = await users.create({
      email: `owner-${generateId()}@example.invalid`,
      role: ROLES.ADMIN,
    });
    const member = await users.create({
      email: `member-${generateId()}@example.invalid`,
      role: ROLES.MEMBER,
    });
    const root = await privateBranchSession(db, owner.user_id);
    const ownerChild = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: root.branchId,
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: owner.user_id,
      genealogy: { parent_session_id: root.session.session_id, children: [] },
    });
    const memberChild = await privateBranchSession(db, member.user_id, root.session.session_id);

    const app = feathers();
    const sessionRepository = new SessionRepository(db);
    const branchRepository = new BranchRepository(db);
    const service = new SessionsService(db, app as unknown as Application);
    app.use('sessions', service as never, { methods: ['get', 'find'] });
    app.service('sessions').hooks({
      before: {
        all: [typedValidateQuery(sessionQueryValidator)],
        get: [loadSessionBranch(sessionRepository, branchRepository), ensureCanView()],
        find: [scopeFindToAccessibleSessionsSql()],
      },
    });
    const as = (user: { user_id: UserID; role: string }) =>
      ({ provider: 'rest', user: { user_id: user.user_id, role: user.role } }) as never;

    // The route calls the raw service instance, whose own `this.get` has no hooks.
    await expect(service.getGenealogy(root.session.session_id, as(member))).rejects.toThrow();

    const memberView = await service.getGenealogy(memberChild.session.session_id, as(member));
    expect(memberView.session.session_id).toBe(memberChild.session.session_id);
    expect(memberView.ancestors).toEqual([]);

    const ownerView = await service.getGenealogy(root.session.session_id, as(owner));
    expect(ownerView.children.map((child) => child.session_id)).toEqual([ownerChild.session_id]);

    const internal = await service.getGenealogy(root.session.session_id);
    expect(internal.children.map((child) => child.session_id).sort()).toEqual(
      [ownerChild.session_id, memberChild.session.session_id].sort()
    );
  });
});
