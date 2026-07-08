import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRelationshipRepository,
  SessionRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, Session, SessionID, UUID } from '@agor/core/types';
import { ROLES, SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type SessionParams, SessionsService } from './sessions';

const STUB_APP = {
  service: () => ({
    emit: () => {},
  }),
} as unknown as Application;
const TEST_USER_ID = 'test-user' as UUID;
const OTHER_USER_ID = 'other-user' as UUID;

function makeAppWithConfig(config: {
  branchRbac: boolean;
  allowSuperadmin?: boolean;
}): Application {
  return {
    get(key: string) {
      if (key !== 'config') return undefined;
      return {
        execution: {
          branch_rbac: config.branchRbac,
          allow_superadmin: config.allowSuperadmin ?? false,
        },
      };
    },
    service: STUB_APP.service,
  } as unknown as Application;
}

function externalParams(userId: UUID): SessionParams {
  return {
    provider: 'rest',
    user: {
      user_id: userId,
      email: `${userId}@example.com`,
      role: ROLES.MEMBER,
    },
  } as SessionParams;
}

async function createBranch(
  db: any,
  name = `feature-${generateId()}`,
  overrides: Partial<Branch> = {}
): Promise<UUID> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/test-repo-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name,
    ref: name,
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/test-repo-${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: TEST_USER_ID,
    ...overrides,
  });
  return branch.branch_id as UUID;
}

async function createSession(
  db: any,
  branchId: UUID,
  overrides: Partial<Session> = {}
): Promise<Session> {
  const sessionRepo = new SessionRepository(db);
  return sessionRepo.create({
    session_id: generateId(),
    branch_id: branchId,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: TEST_USER_ID,
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
}

async function getArchivedState(
  db: any,
  sessionId: SessionID
): Promise<Pick<Session, 'archived' | 'archived_reason'>> {
  const session = await new SessionRepository(db).findById(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  return { archived: session.archived, archived_reason: session.archived_reason };
}

describe('SessionsService archive routes', () => {
  dbTest(
    'archives and unarchives branch-local spawned, forked, and nested descendants',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const spawnedChild = await createSession(db, branchId, {
        genealogy: { parent_session_id: parent.session_id, children: [] },
      });
      const nestedChild = await createSession(db, branchId, {
        genealogy: { parent_session_id: spawnedChild.session_id, children: [] },
      });
      const forkedChild = await createSession(db, branchId, {
        genealogy: { forked_from_session_id: parent.session_id, children: [] },
      });

      const archiveResult = await service.archive(parent.session_id);

      expect(archiveResult.count).toBe(4);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual({
        archived: true,
        archived_reason: 'manual',
      });
      await expect(getArchivedState(db, spawnedChild.session_id)).resolves.toEqual({
        archived: true,
        archived_reason: 'parent_archived',
      });
      await expect(getArchivedState(db, nestedChild.session_id)).resolves.toEqual({
        archived: true,
        archived_reason: 'parent_archived',
      });
      await expect(getArchivedState(db, forkedChild.session_id)).resolves.toEqual({
        archived: true,
        archived_reason: 'parent_archived',
      });

      const unarchiveResult = await service.unarchive(parent.session_id);

      expect(unarchiveResult.count).toBe(4);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual({
        archived: false,
        archived_reason: undefined,
      });
      await expect(getArchivedState(db, spawnedChild.session_id)).resolves.toEqual({
        archived: false,
        archived_reason: undefined,
      });
      await expect(getArchivedState(db, nestedChild.session_id)).resolves.toEqual({
        archived: false,
        archived_reason: undefined,
      });
      await expect(getArchivedState(db, forkedChild.session_id)).resolves.toEqual({
        archived: false,
        archived_reason: undefined,
      });
    }
  );

  dbTest('preserves descendants that were already archived for other reasons', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const parent = await createSession(db, branchId);
    const activeChild = await createSession(db, branchId, {
      genealogy: { parent_session_id: parent.session_id, children: [] },
    });
    const btwCompletedChild = await createSession(db, branchId, {
      archived: true,
      archived_reason: 'btw_completed',
      fork_origin: 'btw',
      genealogy: { forked_from_session_id: parent.session_id, children: [] },
    });
    const manualChild = await createSession(db, branchId, {
      archived: true,
      archived_reason: 'manual',
      genealogy: { parent_session_id: parent.session_id, children: [] },
    });

    const archiveResult = await service.archive(parent.session_id);

    expect(archiveResult.count).toBe(2);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual({
      archived: true,
      archived_reason: 'manual',
    });
    await expect(getArchivedState(db, activeChild.session_id)).resolves.toEqual({
      archived: true,
      archived_reason: 'parent_archived',
    });
    await expect(getArchivedState(db, btwCompletedChild.session_id)).resolves.toEqual({
      archived: true,
      archived_reason: 'btw_completed',
    });
    await expect(getArchivedState(db, manualChild.session_id)).resolves.toEqual({
      archived: true,
      archived_reason: 'manual',
    });

    const unarchiveResult = await service.unarchive(parent.session_id);

    expect(unarchiveResult.count).toBe(2);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual({
      archived: false,
      archived_reason: undefined,
    });
    await expect(getArchivedState(db, activeChild.session_id)).resolves.toEqual({
      archived: false,
      archived_reason: undefined,
    });
    await expect(getArchivedState(db, btwCompletedChild.session_id)).resolves.toEqual({
      archived: true,
      archived_reason: 'btw_completed',
    });
    await expect(getArchivedState(db, manualChild.session_id)).resolves.toEqual({
      archived: true,
      archived_reason: 'manual',
    });
  });

  dbTest(
    'honors includeChildren false while generic patch remains single-session',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const child = await createSession(db, branchId, {
        genealogy: { parent_session_id: parent.session_id, children: [] },
      });

      await service.patch(parent.session_id, { archived: true, archived_reason: 'manual' });
      await expect(getArchivedState(db, parent.session_id)).resolves.toMatchObject({
        archived: true,
      });
      await expect(getArchivedState(db, child.session_id)).resolves.toMatchObject({
        archived: false,
      });

      await service.unarchive(parent.session_id, { includeChildren: false });
      const archiveResult = await service.archive(parent.session_id, { includeChildren: false });

      expect(archiveResult.count).toBe(1);
      await expect(getArchivedState(db, parent.session_id)).resolves.toMatchObject({
        archived: true,
      });
      await expect(getArchivedState(db, child.session_id)).resolves.toMatchObject({
        archived: false,
      });
    }
  );

  dbTest('does not cascade through remote session relationships', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const sourceBranchId = await createBranch(db, 'source');
    const targetBranchId = await createBranch(db, 'target');
    const parent = await createSession(db, sourceBranchId);
    const remoteChild = await createSession(db, targetBranchId);

    await new SessionRelationshipRepository(db).create({
      source_session_id: parent.session_id,
      target_session_id: remoteChild.session_id,
      relationship_type: 'remote_create',
      created_by: TEST_USER_ID,
    });

    const archiveResult = await service.archive(parent.session_id);

    expect(archiveResult.count).toBe(1);
    await expect(getArchivedState(db, parent.session_id)).resolves.toMatchObject({
      archived: true,
    });
    await expect(getArchivedState(db, remoteChild.session_id)).resolves.toMatchObject({
      archived: false,
    });
  });

  dbTest(
    'rejects external archive and unarchive before mutating when RBAC prompt permission is missing',
    async ({ db }) => {
      const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
      const branchId = await createBranch(db, 'rbac-session-only', { others_can: 'session' });
      const parent = await createSession(db, branchId, { created_by: TEST_USER_ID });
      const child = await createSession(db, branchId, {
        created_by: OTHER_USER_ID,
        genealogy: { parent_session_id: parent.session_id, children: [] },
      });

      await expect(
        service.archive(parent.session_id, undefined, externalParams(TEST_USER_ID))
      ).rejects.toThrow(/prompt/);

      await expect(getArchivedState(db, parent.session_id)).resolves.toMatchObject({
        archived: false,
      });
      await expect(getArchivedState(db, child.session_id)).resolves.toMatchObject({
        archived: false,
      });

      await service.patch(parent.session_id, { archived: true, archived_reason: 'manual' });
      await service.patch(child.session_id, { archived: true, archived_reason: 'parent_archived' });

      await expect(
        service.unarchive(parent.session_id, undefined, externalParams(TEST_USER_ID))
      ).rejects.toThrow(/prompt/);

      await expect(getArchivedState(db, parent.session_id)).resolves.toMatchObject({
        archived: true,
      });
      await expect(getArchivedState(db, child.session_id)).resolves.toMatchObject({
        archived: true,
      });
    }
  );

  dbTest('allows external archive when RBAC prompt permission is present', async ({ db }) => {
    const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
    const branchId = await createBranch(db, 'rbac-prompt', { others_can: 'prompt' });
    const parent = await createSession(db, branchId, { created_by: OTHER_USER_ID });
    const child = await createSession(db, branchId, {
      created_by: OTHER_USER_ID,
      genealogy: { parent_session_id: parent.session_id, children: [] },
    });

    const result = await service.archive(
      parent.session_id,
      undefined,
      externalParams(TEST_USER_ID)
    );

    expect(result.count).toBe(2);
    await expect(getArchivedState(db, parent.session_id)).resolves.toMatchObject({
      archived: true,
    });
    await expect(getArchivedState(db, child.session_id)).resolves.toMatchObject({
      archived: true,
    });
  });
});
