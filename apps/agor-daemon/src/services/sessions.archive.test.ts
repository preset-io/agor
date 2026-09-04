import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantContext,
  SessionRelationshipRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, BranchID, Session, SessionID, UUID } from '@agor/core/types';
import { ROLES, SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ARCHIVE_PATCH_REJECTED_MESSAGE, type SessionParams, SessionsService } from './sessions';

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

function makeEmittingApp(): { app: Application; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  const service = { emit };
  return { app: { service: () => service } as unknown as Application, emit };
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
  const createdBy = overrides.created_by ?? TEST_USER_ID;
  const primaryOwner = overrides.primary_owner_user_id ?? createdBy;
  const users = new UsersRepository(db);
  const existingUserIds = new Set((await users.findAll()).map((user) => user.user_id));
  for (const userId of new Set([createdBy, primaryOwner])) {
    if (!existingUserIds.has(userId)) {
      await users.create({
        user_id: userId,
        email: `${userId}@sessions-archive.test`,
        role: ROLES.MEMBER,
      });
    }
  }
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
    created_by: createdBy,
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
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
}

function childOf(parent: Session): Partial<Session> {
  return { genealogy: { parent_session_id: parent.session_id, children: [] } };
}

async function linkRemote(db: any, source: Session, target: Session): Promise<void> {
  await new SessionRelationshipRepository(db).create({
    source_session_id: source.session_id,
    target_session_id: target.session_id,
    relationship_type: 'remote_create',
    created_by: TEST_USER_ID,
  });
}

function changeArchiveStateBeforeCurrentRead(
  matchIds: SessionID[],
  update: {
    id: SessionID;
    archived: boolean;
    archivedReason: NonNullable<Session['archived_reason']> | null;
  }
) {
  const originalFindByIds = SessionRepository.prototype.findByIds;
  let injected = false;
  return vi
    .spyOn(SessionRepository.prototype, 'findByIds')
    .mockImplementation(async function (ids) {
      if (!injected && matchIds.every((id) => ids.includes(id))) {
        injected = true;
        await this.updateArchiveStateForTargets([update]);
      }
      return originalFindByIds.call(this, ids);
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

const ARCHIVED = (reason: NonNullable<Session['archived_reason']>) => ({
  archived: true,
  archived_reason: reason,
});
const ACTIVE = { archived: false, archived_reason: undefined };

describe('SessionsService archive engine', () => {
  dbTest(
    'archives and unarchives branch-local spawned, forked, and nested descendants',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const spawnedChild = await createSession(db, branchId, childOf(parent));
      const nestedChild = await createSession(db, branchId, childOf(spawnedChild));
      const forkedChild = await createSession(db, branchId, {
        genealogy: { forked_from_session_id: parent.session_id, children: [] },
      });

      const archiveResult = await service.archive(parent.session_id);

      expect(archiveResult.count).toBe(4);
      expect(archiveResult).toMatchObject({
        dryRun: false,
        wouldChangeCount: 4,
        archivedCount: 4,
        unarchivedCount: 0,
        localCount: 4,
        remoteCount: 0,
        skippedCount: 0,
        runningCount: 0,
        remainingArchived: [],
      });
      expect(archiveResult.units).toEqual([
        {
          rootSessionId: parent.session_id,
          kind: 'local',
          status: 'changed',
          changedCount: 4,
          branchId,
        },
      ]);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
      for (const child of [spawnedChild, nestedChild, forkedChild]) {
        await expect(getArchivedState(db, child.session_id)).resolves.toEqual(
          ARCHIVED('parent_archived')
        );
      }

      const unarchiveResult = await service.unarchive(parent.session_id);

      expect(unarchiveResult.count).toBe(4);
      expect(unarchiveResult.unarchivedCount).toBe(4);
      for (const session of [parent, spawnedChild, nestedChild, forkedChild]) {
        await expect(getArchivedState(db, session.session_id)).resolves.toEqual(ACTIVE);
      }
    }
  );

  dbTest('dry-run plans and authorizes without changing anything', async ({ db }) => {
    const { app, emit } = makeEmittingApp();
    const service = new SessionsService(db, app);
    const branchId = await createBranch(db);
    const parent = await createSession(db, branchId);
    const runningChild = await createSession(db, branchId, {
      ...childOf(parent),
      status: SessionStatus.RUNNING,
    });

    const preview = await service.archive(parent.session_id, { dryRun: true });

    expect(preview).toMatchObject({
      dryRun: true,
      wouldChangeCount: 2,
      archivedCount: 2,
      localCount: 2,
      remoteCount: 0,
      runningCount: 1,
      count: 0,
      affectedSessions: [],
    });
    expect(preview.units).toEqual([
      {
        rootSessionId: parent.session_id,
        kind: 'local',
        status: 'changed',
        changedCount: 2,
        branchId,
      },
    ]);
    expect(emit).not.toHaveBeenCalled();
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, runningChild.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest('preserves descendants that were already archived for other reasons', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const parent = await createSession(db, branchId);
    const activeChild = await createSession(db, branchId, childOf(parent));
    const btwCompletedChild = await createSession(db, branchId, {
      ...ARCHIVED('btw_completed'),
      fork_origin: 'btw',
      genealogy: { forked_from_session_id: parent.session_id, children: [] },
    });
    const manualChild = await createSession(db, branchId, {
      ...ARCHIVED('manual'),
      ...childOf(parent),
    });

    const archiveResult = await service.archive(parent.session_id);

    expect(archiveResult.count).toBe(2);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, activeChild.session_id)).resolves.toEqual(
      ARCHIVED('parent_archived')
    );
    await expect(getArchivedState(db, btwCompletedChild.session_id)).resolves.toEqual(
      ARCHIVED('btw_completed')
    );
    await expect(getArchivedState(db, manualChild.session_id)).resolves.toEqual(ARCHIVED('manual'));

    const unarchiveResult = await service.unarchive(parent.session_id);

    expect(unarchiveResult.count).toBe(2);
    expect(unarchiveResult.remainingArchived).toEqual(
      expect.arrayContaining([
        { sessionId: btwCompletedChild.session_id, reason: 'independent_reason' },
        { sessionId: manualChild.session_id, reason: 'independent_reason' },
      ])
    );
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, activeChild.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, btwCompletedChild.session_id)).resolves.toEqual(
      ARCHIVED('btw_completed')
    );
    await expect(getArchivedState(db, manualChild.session_id)).resolves.toEqual(ARCHIVED('manual'));
  });

  dbTest(
    'preserves an implied descendant manually archived after cascade planning',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db, 'stale-archive-child');
      const parent = await createSession(db, branchId);
      const child = await createSession(db, branchId, childOf(parent));
      const findByIds = changeArchiveStateBeforeCurrentRead([parent.session_id, child.session_id], {
        id: child.session_id,
        archived: true,
        archivedReason: 'manual',
      });

      const result = await service.archive(parent.session_id, {
        includeRemoteChildren: false,
      });

      findByIds.mockRestore();
      expect(result).toMatchObject({
        count: 1,
        wouldChangeCount: 1,
        archivedCount: 1,
        localCount: 1,
        remoteCount: 0,
        runningCount: 0,
      });
      expect(result.affectedSessions.map((session) => session.session_id)).toEqual([
        parent.session_id,
      ]);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ARCHIVED('manual'));
    }
  );

  dbTest('does not recount or re-emit a root archived after planning', async ({ db }) => {
    const { app, emit } = makeEmittingApp();
    const service = new SessionsService(db, app);
    const branchId = await createBranch(db, 'concurrent-root-archive');
    const root = await createSession(db, branchId);
    const findByIds = changeArchiveStateBeforeCurrentRead([root.session_id], {
      id: root.session_id,
      archived: true,
      archivedReason: 'manual',
    });

    const result = await service.archive(root.session_id, { includeRemoteChildren: false });

    findByIds.mockRestore();
    expect(result).toMatchObject({
      count: 0,
      wouldChangeCount: 0,
      archivedCount: 0,
      session: ARCHIVED('manual'),
    });
    expect(result.affectedSessions).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    await expect(getArchivedState(db, root.session_id)).resolves.toEqual(ARCHIVED('manual'));
  });

  dbTest('does not recount or re-emit a root restored after planning', async ({ db }) => {
    const { app, emit } = makeEmittingApp();
    const service = new SessionsService(db, app);
    const branchId = await createBranch(db, 'concurrent-root-restore');
    const root = await createSession(db, branchId);
    await service.archive(root.session_id, { includeRemoteChildren: false });
    emit.mockClear();
    const findByIds = changeArchiveStateBeforeCurrentRead([root.session_id], {
      id: root.session_id,
      archived: false,
      archivedReason: null,
    });

    const result = await service.unarchive(root.session_id, { includeRemoteChildren: false });

    findByIds.mockRestore();
    expect(result).toMatchObject({
      count: 0,
      wouldChangeCount: 0,
      unarchivedCount: 0,
      session: ACTIVE,
    });
    expect(result.affectedSessions).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    await expect(getArchivedState(db, root.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest('honors includeChildren false and rejects generic archive patches', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const parent = await createSession(db, branchId);
    const child = await createSession(db, branchId, childOf(parent));

    await expect(
      service.patch(parent.session_id, { archived: true, archived_reason: 'manual' })
    ).rejects.toThrow(ARCHIVE_PATCH_REJECTED_MESSAGE);
    await expect(
      service.patch(parent.session_id, { archived_reason: 'manual' } as never)
    ).rejects.toThrow(ARCHIVE_PATCH_REJECTED_MESSAGE);
    await expect(
      service.patch(
        null,
        { archived: true } as never,
        {
          query: { branch_id: branchId },
        } as SessionParams
      )
    ).rejects.toThrow(ARCHIVE_PATCH_REJECTED_MESSAGE);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);

    const archiveResult = await service.archive(parent.session_id, { includeChildren: false });

    expect(archiveResult.count).toBe(1);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ACTIVE);

    await service.unarchive(parent.session_id, { includeChildren: false });
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest(
    'follows remote-created sessions by default and honors includeRemoteChildren false',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const sourceBranchId = await createBranch(db, 'source');
      const targetBranchId = await createBranch(db, 'target');
      const parent = await createSession(db, sourceBranchId);
      const remoteChild = await createSession(db, targetBranchId);
      const remoteGrandchild = await createSession(db, targetBranchId, childOf(remoteChild));
      await linkRemote(db, parent, remoteChild);

      const localOnly = await service.archive(parent.session_id, {
        includeRemoteChildren: false,
      });
      expect(localOnly.count).toBe(1);
      expect(localOnly.remoteCount).toBe(0);
      await expect(getArchivedState(db, remoteChild.session_id)).resolves.toEqual(ACTIVE);
      await service.unarchive(parent.session_id, { includeRemoteChildren: false });

      const result = await service.archive(parent.session_id);

      expect(result.count).toBe(3);
      expect(result).toMatchObject({ localCount: 1, remoteCount: 2, skippedCount: 0 });
      expect(result.units).toEqual([
        {
          rootSessionId: parent.session_id,
          kind: 'local',
          status: 'changed',
          changedCount: 1,
          branchId: sourceBranchId,
        },
        {
          rootSessionId: remoteChild.session_id,
          kind: 'remote',
          status: 'changed',
          changedCount: 2,
          branchId: targetBranchId,
        },
      ]);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, remoteChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
      await expect(getArchivedState(db, remoteGrandchild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      const restored = await service.unarchive(parent.session_id);

      expect(restored.count).toBe(3);
      for (const session of [parent, remoteChild, remoteGrandchild]) {
        await expect(getArchivedState(db, session.session_id)).resolves.toEqual(ACTIVE);
      }
    }
  );

  dbTest(
    'skips an unauthorized remote branch without disclosing it and still commits the local unit',
    async ({ db }) => {
      const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
      const sourceBranchId = await createBranch(db, 'source-owned');
      const targetBranchId = await createBranch(db, 'target-view-only', {
        created_by: OTHER_USER_ID,
        primary_owner_user_id: OTHER_USER_ID,
        others_can: 'view',
      });
      const parent = await createSession(db, sourceBranchId);
      const localChild = await createSession(db, sourceBranchId, childOf(parent));
      const remoteChild = await createSession(db, targetBranchId, { created_by: OTHER_USER_ID });
      const remoteGrandchild = await createSession(db, targetBranchId, {
        created_by: OTHER_USER_ID,
        ...childOf(remoteChild),
      });
      await linkRemote(db, parent, remoteChild);
      const findAll = vi.spyOn(SessionRepository.prototype, 'findAll');

      const result = await service.archive(
        parent.session_id,
        undefined,
        externalParams(TEST_USER_ID)
      );

      expect(result.count).toBe(2);
      expect(result.skippedCount).toBe(1);
      expect(result.units).toEqual([
        {
          rootSessionId: remoteChild.session_id,
          kind: 'remote',
          status: 'skipped',
          changedCount: 0,
          reason: 'insufficient_permission',
        },
        {
          rootSessionId: parent.session_id,
          kind: 'local',
          status: 'changed',
          changedCount: 2,
          branchId: sourceBranchId,
        },
      ]);
      expect(JSON.stringify(result.units)).not.toContain(targetBranchId);
      expect(findAll.mock.calls.some(([filter]) => filter?.branchId === targetBranchId)).toBe(
        false
      );
      findAll.mockRestore();
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, localChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
      await expect(getArchivedState(db, remoteChild.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, remoteGrandchild.session_id)).resolves.toEqual(ACTIVE);
    }
  );

  dbTest(
    'rejects external archive and unarchive before mutating when RBAC prompt permission is missing',
    async ({ db }) => {
      const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
      const branchId = await createBranch(db, 'rbac-session-only', {
        primary_owner_user_id: OTHER_USER_ID,
        others_can: 'session',
      });
      const parent = await createSession(db, branchId, { created_by: TEST_USER_ID });
      const child = await createSession(db, branchId, {
        created_by: OTHER_USER_ID,
        ...childOf(parent),
      });

      await expect(
        service.archive(parent.session_id, undefined, externalParams(TEST_USER_ID))
      ).rejects.toThrow(/prompt/);

      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ACTIVE);

      // A session-tier caller can still archive only the root they own.
      const ownRoot = await service.archive(
        parent.session_id,
        { includeChildren: false },
        externalParams(TEST_USER_ID)
      );
      expect(ownRoot.count).toBe(1);
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ACTIVE);

      await new SessionRepository(db).updateArchiveStateForTargets([
        { id: child.session_id, archived: true, archivedReason: 'parent_archived' },
      ]);
      await expect(
        service.unarchive(parent.session_id, undefined, externalParams(TEST_USER_ID))
      ).rejects.toThrow(/prompt/);

      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest('allows external archive when RBAC prompt permission is present', async ({ db }) => {
    const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
    const branchId = await createBranch(db, 'rbac-prompt', { others_can: 'prompt' });
    const parent = await createSession(db, branchId, { created_by: OTHER_USER_ID });
    const child = await createSession(db, branchId, {
      created_by: OTHER_USER_ID,
      ...childOf(parent),
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

  dbTest(
    'revalidates current branch permission immediately before archive mutation',
    async ({ db }) => {
      const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
      const branchId = await createBranch(db, 'rbac-revalidation', {
        primary_owner_user_id: OTHER_USER_ID,
        others_can: 'prompt',
      });
      const session = await createSession(db, branchId, { created_by: OTHER_USER_ID });
      const originalResolveUserAccess = BranchRepository.prototype.resolveUserAccess;
      let checks = 0;
      const resolveUserAccess = vi
        .spyOn(BranchRepository.prototype, 'resolveUserAccess')
        .mockImplementation(async function (branch, userId) {
          if (branch.branch_id === branchId) {
            checks += 1;
            return {
              can: checks === 1 ? 'prompt' : 'view',
              is_owner: false,
              source: 'others',
            };
          }
          return originalResolveUserAccess.call(this, branch, userId);
        });

      await expect(
        service.archive(session.session_id, undefined, externalParams(TEST_USER_ID))
      ).rejects.toThrow(/prompt/);

      expect(checks).toBe(2);
      resolveUserAccess.mockRestore();
      await expect(getArchivedState(db, session.session_id)).resolves.toEqual(ACTIVE);
    }
  );

  dbTest('skips a remote unit whose permission is revoked before mutation', async ({ db }) => {
    const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
    const sourceBranchId = await createBranch(db, 'revoked-remote-source');
    const targetBranchId = await createBranch(db, 'revoked-remote-target', {
      primary_owner_user_id: OTHER_USER_ID,
      others_can: 'prompt',
    });
    const source = await createSession(db, sourceBranchId);
    const target = await createSession(db, targetBranchId, { created_by: OTHER_USER_ID });
    await linkRemote(db, source, target);

    const originalResolveUserAccess = BranchRepository.prototype.resolveUserAccess;
    let targetChecks = 0;
    const resolveUserAccess = vi
      .spyOn(BranchRepository.prototype, 'resolveUserAccess')
      .mockImplementation(async function (branch, userId) {
        if (branch.branch_id === targetBranchId) {
          targetChecks += 1;
          return {
            can: targetChecks < 3 ? 'prompt' : 'view',
            is_owner: false,
            source: 'others',
          };
        }
        return originalResolveUserAccess.call(this, branch, userId);
      });

    const result = await service.archive(
      source.session_id,
      undefined,
      externalParams(TEST_USER_ID)
    );

    resolveUserAccess.mockRestore();
    expect(targetChecks).toBe(3);
    expect(result.count).toBe(1);
    expect(result.units).toEqual([
      {
        rootSessionId: target.session_id,
        kind: 'remote',
        status: 'skipped',
        changedCount: 0,
        reason: 'insufficient_permission',
      },
      {
        rootSessionId: source.session_id,
        kind: 'local',
        status: 'changed',
        changedCount: 1,
        branchId: sourceBranchId,
      },
    ]);
    await expect(getArchivedState(db, source.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, target.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest(
    'gives an explicitly archived descendant its own reason so a parent unarchive leaves it archived',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const child = await createSession(db, branchId, childOf(parent));

      await service.archive(parent.session_id);
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      const upgraded = await service.archive(child.session_id);
      expect(upgraded.count).toBe(1);
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ARCHIVED('manual'));

      const restored = await service.unarchive(parent.session_id);
      expect(restored.count).toBe(1);
      expect(restored.remainingArchived).toEqual([
        { sessionId: child.session_id, reason: 'independent_reason' },
      ]);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ARCHIVED('manual'));
    }
  );

  dbTest(
    'keeps a descendant archived while another archived ancestor covers it',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const root = await createSession(db, branchId);
      const middle = await createSession(db, branchId, childOf(root));
      const leaf = await createSession(db, branchId, childOf(middle));

      await service.archive(middle.session_id);
      const rootArchive = await service.archive(root.session_id);
      expect(rootArchive.count).toBe(1);

      const restored = await service.unarchive(root.session_id);

      expect(restored.count).toBe(1);
      expect(restored.remainingArchived).toEqual(
        expect.arrayContaining([
          { sessionId: middle.session_id, reason: 'independent_reason' },
          { sessionId: leaf.session_id, reason: 'archived_ancestor' },
        ])
      );
      await expect(getArchivedState(db, root.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, middle.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, leaf.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      const middleRestored = await service.unarchive(middle.session_id);
      expect(middleRestored.count).toBe(2);
      await expect(getArchivedState(db, leaf.session_id)).resolves.toEqual(ACTIVE);
    }
  );

  dbTest(
    'keeps a remote-created session archived while its creator is archived even after its local parent is restored',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const creatorBranchId = await createBranch(db, 'creator');
      const targetBranchId = await createBranch(db, 'target');
      const creator = await createSession(db, creatorBranchId);
      const localParent = await createSession(db, targetBranchId);
      const target = await createSession(db, targetBranchId, childOf(localParent));
      await linkRemote(db, creator, target);

      const creatorArchive = await service.archive(creator.session_id);
      expect(creatorArchive.count).toBe(2);
      await expect(getArchivedState(db, target.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      expect((await service.archive(localParent.session_id)).count).toBe(1);

      const parentRestored = await service.unarchive(localParent.session_id);
      expect(parentRestored.count).toBe(1);
      expect(parentRestored.remainingArchived).toEqual([
        { sessionId: target.session_id, reason: 'archived_ancestor' },
      ]);
      await expect(getArchivedState(db, target.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      const creatorRestored = await service.unarchive(creator.session_id);
      expect(creatorRestored.count).toBe(2);
      await expect(getArchivedState(db, target.session_id)).resolves.toEqual(ACTIVE);
    }
  );

  dbTest(
    'restores a remote parent before its child when repository rows are returned in reverse order',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const sourceBranchId = await createBranch(db, 'reverse-restore-source');
      const targetBranchId = await createBranch(db, 'reverse-restore-target');
      const source = await createSession(db, sourceBranchId);
      const remoteParent = await createSession(db, targetBranchId);
      const child = await createSession(db, targetBranchId, childOf(remoteParent));
      await linkRemote(db, source, remoteParent);
      expect((await service.archive(source.session_id)).count).toBe(3);

      const originalFindByIds = SessionRepository.prototype.findByIds;
      const findByIds = vi
        .spyOn(SessionRepository.prototype, 'findByIds')
        .mockImplementation(async function (ids) {
          const rows = await originalFindByIds.call(this, ids);
          return ids.includes(remoteParent.session_id) && ids.includes(child.session_id)
            ? rows.reverse()
            : rows;
        });

      const restored = await service.unarchive(source.session_id);

      findByIds.mockRestore();
      expect(restored.count).toBe(3);
      for (const session of [source, remoteParent, child]) {
        await expect(getArchivedState(db, session.session_id)).resolves.toEqual(ACTIVE);
      }
    }
  );

  dbTest(
    'keeps an implied restore archived when an incoming remote source is invisible',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const creatorBranchId = await createBranch(db, 'invisible-creator');
      const targetBranchId = await createBranch(db, 'invisible-source-target');
      const creator = await createSession(db, creatorBranchId);
      const localParent = await createSession(db, targetBranchId);
      const target = await createSession(db, targetBranchId, childOf(localParent));
      await linkRemote(db, creator, target);
      await service.archive(localParent.session_id, { includeRemoteChildren: false });

      const originalFindByIds = SessionRepository.prototype.findByIds;
      const findByIds = vi
        .spyOn(SessionRepository.prototype, 'findByIds')
        .mockImplementation(function (ids) {
          if (ids.length === 1 && ids[0] === creator.session_id) return Promise.resolve([]);
          return originalFindByIds.call(this, ids);
        });

      const restored = await service.unarchive(localParent.session_id, {
        includeRemoteChildren: false,
      });

      findByIds.mockRestore();
      expect(restored.count).toBe(1);
      expect(restored.remainingArchived).toEqual([
        { sessionId: target.session_id, reason: 'archived_ancestor' },
      ]);
      await expect(getArchivedState(db, localParent.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, target.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest(
    'replans a restore after an intermediate descendant gains an independent reason',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db, 'stale-restore-reason');
      const root = await createSession(db, branchId);
      const intermediate = await createSession(db, branchId, childOf(root));
      const leaf = await createSession(db, branchId, childOf(intermediate));
      await service.archive(root.session_id, { includeRemoteChildren: false });

      const findByIds = changeArchiveStateBeforeCurrentRead(
        [root.session_id, intermediate.session_id, leaf.session_id],
        {
          id: intermediate.session_id,
          archived: true,
          archivedReason: 'manual',
        }
      );

      const result = await service.unarchive(root.session_id, {
        includeRemoteChildren: false,
      });
      findByIds.mockRestore();

      expect(result).toMatchObject({ count: 1, wouldChangeCount: 1, unarchivedCount: 1 });
      expect(result.remainingArchived).toEqual([
        { sessionId: intermediate.session_id, reason: 'independent_reason' },
        { sessionId: leaf.session_id, reason: 'archived_ancestor' },
      ]);
      await expect(getArchivedState(db, root.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, intermediate.session_id)).resolves.toEqual(
        ARCHIVED('manual')
      );
      await expect(getArchivedState(db, leaf.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest(
    'does not restore beneath an implied descendant archived after restore planning',
    async ({ db }) => {
      const { app, emit } = makeEmittingApp();
      const service = new SessionsService(db, app);
      const branchId = await createBranch(db, 'stale-restore-implied-cascade');
      const root = await createSession(db, branchId, ARCHIVED('manual'));
      const intermediate = await createSession(db, branchId, childOf(root));
      const leaf = await createSession(db, branchId, {
        ...ARCHIVED('parent_archived'),
        ...childOf(intermediate),
      });
      const findByIds = changeArchiveStateBeforeCurrentRead(
        [root.session_id, intermediate.session_id, leaf.session_id],
        {
          id: intermediate.session_id,
          archived: true,
          archivedReason: 'parent_archived',
        }
      );

      const result = await service.unarchive(root.session_id, {
        includeRemoteChildren: false,
      });
      findByIds.mockRestore();

      expect(result).toMatchObject({
        count: 1,
        wouldChangeCount: 1,
        unarchivedCount: 1,
        localCount: 1,
        remoteCount: 0,
      });
      expect(result.affectedSessions.map((session) => session.session_id)).toEqual([
        root.session_id,
      ]);
      expect(result.remainingArchived).toEqual([
        { sessionId: intermediate.session_id, reason: 'archived_ancestor' },
        { sessionId: leaf.session_id, reason: 'archived_ancestor' },
      ]);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.map((call) => (call[1] as Session).session_id)).toEqual([
        root.session_id,
      ]);
      await expect(getArchivedState(db, root.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, intermediate.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
      await expect(getArchivedState(db, leaf.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest(
    'does not restore a remote unit beneath its target archived after restore planning',
    async ({ db }) => {
      const { app, emit } = makeEmittingApp();
      const service = new SessionsService(db, app);
      const sourceBranchId = await createBranch(db, 'stale-remote-restore-source');
      const targetBranchId = await createBranch(db, 'stale-remote-restore-target');
      const root = await createSession(db, sourceBranchId, ARCHIVED('manual'));
      const remoteTarget = await createSession(db, targetBranchId);
      const leaf = await createSession(db, targetBranchId, {
        ...ARCHIVED('parent_archived'),
        ...childOf(remoteTarget),
      });
      await linkRemote(db, root, remoteTarget);
      const findByIds = changeArchiveStateBeforeCurrentRead(
        [remoteTarget.session_id, leaf.session_id],
        {
          id: remoteTarget.session_id,
          archived: true,
          archivedReason: 'parent_archived',
        }
      );

      const result = await service.unarchive(root.session_id);
      findByIds.mockRestore();

      expect(result).toMatchObject({
        count: 1,
        wouldChangeCount: 1,
        unarchivedCount: 1,
        localCount: 1,
        remoteCount: 0,
      });
      expect(result.affectedSessions.map((session) => session.session_id)).toEqual([
        root.session_id,
      ]);
      expect(result.remainingArchived).toEqual([
        { sessionId: remoteTarget.session_id, reason: 'archived_ancestor' },
        { sessionId: leaf.session_id, reason: 'archived_ancestor' },
      ]);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.map((call) => (call[1] as Session).session_id)).toEqual([
        root.session_id,
      ]);
      await expect(getArchivedState(db, root.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, remoteTarget.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
      await expect(getArchivedState(db, leaf.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest(
    'keeps descendants archived when an explicit restore root gains an independent reason',
    async ({ db }) => {
      const { app, emit } = makeEmittingApp();
      const service = new SessionsService(db, app);
      const branchId = await createBranch(db, 'stale-restore-root-reason');
      const root = await createSession(db, branchId);
      const child = await createSession(db, branchId, childOf(root));
      await service.archive(root.session_id, { includeRemoteChildren: false });
      emit.mockClear();

      const findByIds = changeArchiveStateBeforeCurrentRead([root.session_id, child.session_id], {
        id: root.session_id,
        archived: true,
        archivedReason: 'btw_completed',
      });

      const result = await service.unarchive(root.session_id, {
        includeRemoteChildren: false,
      });
      findByIds.mockRestore();

      expect(result).toMatchObject({
        count: 0,
        wouldChangeCount: 0,
        unarchivedCount: 0,
        session: ARCHIVED('btw_completed'),
      });
      expect(result.affectedSessions).toEqual([]);
      expect(result.remainingArchived).toEqual([
        { sessionId: root.session_id, reason: 'independent_reason' },
        { sessionId: child.session_id, reason: 'archived_ancestor' },
      ]);
      expect(emit).not.toHaveBeenCalled();
      await expect(getArchivedState(db, root.session_id)).resolves.toEqual(
        ARCHIVED('btw_completed')
      );
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest('rejects a restore when its branch becomes archived after planning', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db, 'stale-restore-branch');
    const parent = await createSession(db, branchId);
    const child = await createSession(db, branchId, childOf(parent));
    await service.archive(parent.session_id, { includeRemoteChildren: false });

    const originalFindById = BranchRepository.prototype.findById;
    let branchReads = 0;
    const findById = vi
      .spyOn(BranchRepository.prototype, 'findById')
      .mockImplementation(async function (id) {
        const branch = await originalFindById.call(this, id);
        if (id !== branchId || !branch) return branch;
        branchReads += 1;
        return branchReads === 1 ? branch : { ...branch, archived: true };
      });

    await expect(
      service.unarchive(parent.session_id, { includeRemoteChildren: false })
    ).rejects.toThrow(/archived branch/i);
    findById.mockRestore();

    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, child.session_id)).resolves.toEqual(
      ARCHIVED('parent_archived')
    );
  });

  dbTest(
    'replans a restore when an incoming remote source becomes archived after planning',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const creatorBranchId = await createBranch(db, 'stale-restore-creator');
      const targetBranchId = await createBranch(db, 'stale-restore-target');
      const creator = await createSession(db, creatorBranchId);
      const parent = await createSession(db, targetBranchId);
      const child = await createSession(db, targetBranchId, childOf(parent));
      await linkRemote(db, creator, child);
      await service.archive(parent.session_id, { includeRemoteChildren: false });

      const originalFindByIds = SessionRepository.prototype.findByIds;
      let sourceReads = 0;
      const findByIds = vi
        .spyOn(SessionRepository.prototype, 'findByIds')
        .mockImplementation(async function (ids) {
          const rows = await originalFindByIds.call(this, ids);
          if (ids.length === 1 && ids[0] === creator.session_id) {
            sourceReads += 1;
            return sourceReads === 1
              ? rows
              : rows.map((row) => ({ ...row, archived: true, archived_reason: 'manual' }));
          }
          return rows;
        });

      const result = await service.unarchive(parent.session_id, {
        includeRemoteChildren: false,
      });
      findByIds.mockRestore();

      expect(result).toMatchObject({ count: 1, wouldChangeCount: 1, unarchivedCount: 1 });
      expect(result.remainingArchived).toEqual([
        { sessionId: child.session_id, reason: 'archived_ancestor' },
      ]);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest(
    'keeps implied descendants archived inside an archived branch and refuses explicit restores there',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const creatorBranchId = await createBranch(db, 'creator');
      const targetBranchId = await createBranch(db, 'target');
      const creator = await createSession(db, creatorBranchId);
      const target = await createSession(db, targetBranchId);
      await linkRemote(db, creator, target);

      await service.archive(creator.session_id);
      await new BranchRepository(db).update(targetBranchId, { archived: true });

      const restored = await service.unarchive(creator.session_id);
      expect(restored.count).toBe(1);
      expect(restored.remainingArchived).toEqual([
        { sessionId: target.session_id, reason: 'archived_branch' },
      ]);
      await expect(getArchivedState(db, creator.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, target.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      await expect(service.unarchive(target.session_id)).rejects.toThrow(/archived branch/);
      await expect(service.restorePromptedSession(target.session_id)).rejects.toThrow(
        /archived branch/
      );
      await expect(getArchivedState(db, target.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest('archiveBtwSession archives the btw fork with local descendants only', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const remoteBranchId = await createBranch(db, 'remote');
    const parent = await createSession(db, branchId);
    const btw = await createSession(db, branchId, {
      fork_origin: 'btw',
      genealogy: { forked_from_session_id: parent.session_id, children: [] },
    });
    const btwChild = await createSession(db, branchId, childOf(btw));
    const remoteTarget = await createSession(db, remoteBranchId);
    await linkRemote(db, btw, remoteTarget);

    const result = await service.archiveBtwSession(btw.session_id);

    expect(result.count).toBe(2);
    await expect(getArchivedState(db, btw.session_id)).resolves.toEqual(ARCHIVED('btw_completed'));
    await expect(getArchivedState(db, btwChild.session_id)).resolves.toEqual(
      ARCHIVED('parent_archived')
    );
    await expect(getArchivedState(db, remoteTarget.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest('restorePromptedSession restores only the prompted session', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const parent = await createSession(db, branchId);
    const prompted = await createSession(db, branchId, childOf(parent));
    const sibling = await createSession(db, branchId, childOf(parent));
    const grandchild = await createSession(db, branchId, childOf(prompted));

    await service.archive(parent.session_id);

    const result = await service.restorePromptedSession(
      prompted.session_id,
      externalParams(TEST_USER_ID)
    );

    expect(result.count).toBe(1);
    await expect(getArchivedState(db, prompted.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, sibling.session_id)).resolves.toEqual(
      ARCHIVED('parent_archived')
    );
    await expect(getArchivedState(db, grandchild.session_id)).resolves.toEqual(
      ARCHIVED('parent_archived')
    );
  });

  dbTest(
    'branch archive covers more than 1,000 sessions, preserves independent reasons, and branch unarchive restores only branch-caused rows',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionRepo = new SessionRepository(db);
      const activeCount = 1_002;
      for (let index = 0; index < activeCount; index += 1) {
        await createSession(db, branchId);
      }
      const manual = await createSession(db, branchId, ARCHIVED('manual'));
      const btw = await createSession(db, branchId, {
        ...ARCHIVED('btw_completed'),
        fork_origin: 'btw',
      });
      const archivedParent = await createSession(db, branchId, ARCHIVED('manual'));
      const parentArchivedChild = await createSession(db, branchId, {
        ...ARCHIVED('parent_archived'),
        ...childOf(archivedParent),
      });

      const archived = await service.archiveBranchSessions(branchId as BranchID);

      expect(archived.count).toBe(activeCount);
      const afterArchive = await sessionRepo.findAll({ branchId });
      expect(afterArchive.filter((session) => !session.archived)).toHaveLength(0);
      expect(
        afterArchive.filter((session) => session.archived_reason === 'branch_archived')
      ).toHaveLength(activeCount);
      await expect(getArchivedState(db, manual.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, btw.session_id)).resolves.toEqual(
        ARCHIVED('btw_completed')
      );
      await expect(getArchivedState(db, parentArchivedChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      const restored = await service.unarchiveBranchSessions(branchId as BranchID);

      expect(restored.count).toBe(activeCount);
      const afterRestore = await sessionRepo.findAll({ branchId });
      expect(afterRestore.filter((session) => !session.archived)).toHaveLength(activeCount);
      await expect(getArchivedState(db, manual.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, archivedParent.session_id)).resolves.toEqual(
        ARCHIVED('manual')
      );
      await expect(getArchivedState(db, parentArchivedChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      expect((await service.unarchiveBranchSessions(branchId as BranchID)).count).toBe(0);
    },
    120_000
  );

  dbTest('preserves a branch session manually archived after restore selection', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db, 'stale-branch-restore');
    const session = await createSession(db, branchId);
    expect((await service.archiveBranchSessions(branchId as BranchID)).count).toBe(1);

    const findByIds = changeArchiveStateBeforeCurrentRead([session.session_id], {
      id: session.session_id,
      archived: true,
      archivedReason: 'manual',
    });

    const result = await service.unarchiveBranchSessions(branchId as BranchID);

    findByIds.mockRestore();
    expect(result).toEqual({ affectedSessions: [], count: 0 });
    await expect(getArchivedState(db, session.session_id)).resolves.toEqual(ARCHIVED('manual'));
  });

  dbTest(
    'ignores a stale reason on an active row and clears reasons on restore',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const sessionRepo = new SessionRepository(db);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const staleChild = await createSession(db, branchId, {
        archived: false,
        archived_reason: 'parent_archived',
        ...childOf(parent),
      });

      // Nothing to restore: an active row with a legacy reason is not a blocker
      // and is not counted.
      expect((await service.unarchive(parent.session_id)).count).toBe(0);

      const archived = await service.archive(parent.session_id);
      expect(archived.count).toBe(2);
      await expect(getArchivedState(db, staleChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );

      const restored = await service.unarchive(parent.session_id);
      expect(restored.count).toBe(2);
      await expect(getArchivedState(db, staleChild.session_id)).resolves.toEqual(ACTIVE);

      // Generic repository restoration also normalizes the invariant.
      const manual = await createSession(db, branchId, ARCHIVED('manual'));
      await sessionRepo.update(manual.session_id, { archived: false });
      await expect(getArchivedState(db, manual.session_id)).resolves.toEqual(ACTIVE);
    }
  );

  dbTest(
    'emits exactly one patched event per changed row and none on a no-op repeat',
    async ({ db }) => {
      const { app, emit } = makeEmittingApp();
      const service = new SessionsService(db, app);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const child = await createSession(db, branchId, childOf(parent));

      const first = await service.archive(parent.session_id);
      expect(first.count).toBe(2);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls.map((call) => call[0])).toEqual(['patched', 'patched']);
      expect(new Set(emit.mock.calls.map((call) => (call[1] as Session).session_id))).toEqual(
        new Set([parent.session_id, child.session_id])
      );

      emit.mockClear();
      const repeat = await service.archive(parent.session_id);
      expect(repeat.count).toBe(0);
      expect(repeat.units).toEqual([
        {
          rootSessionId: parent.session_id,
          kind: 'local',
          status: 'unchanged',
          changedCount: 0,
          branchId,
        },
      ]);
      expect(emit).not.toHaveBeenCalled();
    }
  );

  dbTest(
    'bulk archive merges overlapping root trees, lets direct roots win, and honors the descendant policy',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const child = await createSession(db, branchId, childOf(parent));
      const grandchild = await createSession(db, branchId, childOf(child));
      const other = await createSession(db, branchId);
      const otherChild = await createSession(db, branchId, childOf(other));

      const preview = await service.previewBulkArchive([parent, child, other], { policy: 'all' });
      expect(preview.policy).toBe('all');
      expect(preview.wouldArchive).toBe(5);
      expect(preview.directRoots.map((session) => session.session_id).sort()).toEqual(
        [parent.session_id, child.session_id, other.session_id].sort()
      );
      expect(preview.impliedDescendants.map((session) => session.session_id).sort()).toEqual(
        [grandchild.session_id, otherChild.session_id].sort()
      );
      expect(preview.excludedDescendants).toEqual([]);
      expect(preview.units.map((unit) => unit.changedCount).sort()).toEqual([2, 3]);

      const noChildren = await service.previewBulkArchive([parent, child, other], {
        policy: 'none',
      });
      expect(noChildren.wouldArchive).toBe(3);
      expect(noChildren.impliedDescendants).toEqual([]);

      const result = await service.bulkArchive([parent, child, other], { policy: 'all' });

      expect(result.count).toBe(5);
      expect(result.preview.wouldArchive).toBe(5);
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, child.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, grandchild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
      await expect(getArchivedState(db, other.session_id)).resolves.toEqual(ARCHIVED('manual'));
      await expect(getArchivedState(db, otherChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
    }
  );

  dbTest(
    'bulk eligible policy keeps descendants that are old enough and have no unfinished task',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const parent = await createSession(db, branchId, { last_updated: old });
      const oldIdleChild = await createSession(db, branchId, {
        ...childOf(parent),
        last_updated: old,
      });
      const recentChild = await createSession(db, branchId, childOf(parent));
      const oldBusyChild = await createSession(db, branchId, {
        ...childOf(parent),
        last_updated: old,
      });
      await new TaskRepository(db).create({
        session_id: oldBusyChild.session_id,
        full_prompt: 'still running',
        created_by: TEST_USER_ID,
        status: TaskStatus.RUNNING,
      });

      const preview = await service.previewBulkArchive([parent], {
        policy: 'eligible',
        cutoffDate,
      });
      expect(preview.wouldArchive).toBe(2);
      expect(preview.impliedDescendants.map((session) => session.session_id)).toEqual([
        oldIdleChild.session_id,
      ]);
      expect(preview.excludedDescendants.map((session) => session.session_id).sort()).toEqual(
        [recentChild.session_id, oldBusyChild.session_id].sort()
      );
      expect(preview.descendantsNewerThanCutoff.map((session) => session.session_id)).toEqual([
        recentChild.session_id,
      ]);
      expect(preview.descendantsWithUnfinishedTasks.map((session) => session.session_id)).toEqual([
        oldBusyChild.session_id,
      ]);

      const all = await service.previewBulkArchive([parent], { policy: 'all', cutoffDate });
      expect(all.wouldArchive).toBe(4);
      expect(all.descendantsNewerThanCutoff.map((session) => session.session_id)).toEqual([
        recentChild.session_id,
      ]);
      expect(all.descendantsWithUnfinishedTasks.map((session) => session.session_id)).toEqual([
        oldBusyChild.session_id,
      ]);

      const result = await service.bulkArchive([parent], { policy: 'eligible', cutoffDate });
      expect(result.count).toBe(2);
      await expect(getArchivedState(db, oldIdleChild.session_id)).resolves.toEqual(
        ARCHIVED('parent_archived')
      );
      await expect(getArchivedState(db, recentChild.session_id)).resolves.toEqual(ACTIVE);
      await expect(getArchivedState(db, oldBusyChild.session_id)).resolves.toEqual(ACTIVE);
    }
  );

  dbTest('bulk archive skips unauthorized units and archives the rest', async ({ db }) => {
    const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
    const ownedBranchId = await createBranch(db, 'owned');
    const foreignBranchId = await createBranch(db, 'foreign', {
      created_by: OTHER_USER_ID,
      primary_owner_user_id: OTHER_USER_ID,
      others_can: 'view',
    });
    const owned = await createSession(db, ownedBranchId);
    const foreign = await createSession(db, foreignBranchId, { created_by: OTHER_USER_ID });
    const foreignChild = await createSession(db, foreignBranchId, {
      created_by: OTHER_USER_ID,
      ...childOf(foreign),
    });

    const result = await service.bulkArchive(
      [owned, foreign],
      { policy: 'all' },
      externalParams(TEST_USER_ID)
    );

    expect(result.count).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.units).toEqual(
      expect.arrayContaining([
        {
          rootSessionId: foreign.session_id,
          kind: 'local',
          status: 'skipped',
          changedCount: 0,
          reason: 'insufficient_permission',
        },
      ])
    );
    await expect(getArchivedState(db, owned.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, foreign.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, foreignChild.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest('bulk archive removes a newly denied unit from its execution preview', async ({ db }) => {
    const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
    const ownedBranchId = await createBranch(db, 'bulk-revalidation-owned');
    const deniedBranchId = await createBranch(db, 'bulk-revalidation-denied', {
      primary_owner_user_id: OTHER_USER_ID,
      others_can: 'prompt',
    });
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const owned = await createSession(db, ownedBranchId, { last_updated: old });
    const ownedChild = await createSession(db, ownedBranchId, {
      ...childOf(owned),
      last_updated: old,
    });
    const ownedRecentChild = await createSession(db, ownedBranchId, childOf(owned));
    const ownedBusyChild = await createSession(db, ownedBranchId, {
      ...childOf(owned),
      last_updated: old,
    });
    const denied = await createSession(db, deniedBranchId, {
      created_by: OTHER_USER_ID,
      last_updated: old,
    });
    const deniedChild = await createSession(db, deniedBranchId, {
      created_by: OTHER_USER_ID,
      ...childOf(denied),
      last_updated: old,
    });
    const deniedRecentChild = await createSession(db, deniedBranchId, {
      created_by: OTHER_USER_ID,
      ...childOf(denied),
    });
    const deniedBusyChild = await createSession(db, deniedBranchId, {
      created_by: OTHER_USER_ID,
      ...childOf(denied),
      last_updated: old,
    });
    const taskRepo = new TaskRepository(db);
    await taskRepo.create({
      session_id: ownedBusyChild.session_id,
      full_prompt: 'owned still running',
      created_by: TEST_USER_ID,
      status: TaskStatus.RUNNING,
    });
    await taskRepo.create({
      session_id: deniedBusyChild.session_id,
      full_prompt: 'denied still running',
      created_by: OTHER_USER_ID,
      status: TaskStatus.RUNNING,
    });

    const originalResolveUserAccess = BranchRepository.prototype.resolveUserAccess;
    let deniedChecks = 0;
    const resolveUserAccess = vi
      .spyOn(BranchRepository.prototype, 'resolveUserAccess')
      .mockImplementation(async function (branch, userId) {
        if (branch.branch_id === deniedBranchId) {
          deniedChecks += 1;
          return {
            can: deniedChecks <= 2 ? 'prompt' : 'view',
            is_owner: false,
            source: 'others',
          };
        }
        return originalResolveUserAccess.call(this, branch, userId);
      });

    const result = await service.bulkArchive(
      [owned, denied],
      { policy: 'eligible', cutoffDate },
      externalParams(TEST_USER_ID)
    );

    resolveUserAccess.mockRestore();
    expect(deniedChecks).toBe(3);
    expect(result).toMatchObject({
      count: 2,
      wouldChangeCount: 2,
      archivedCount: 2,
      skippedCount: 1,
      preview: { wouldArchive: 2 },
    });
    expect(result.preview.directRoots.map((session) => session.session_id)).toEqual([
      owned.session_id,
    ]);
    expect(result.preview.impliedDescendants.map((session) => session.session_id)).toEqual([
      ownedChild.session_id,
    ]);
    expect(result.preview.excludedDescendants.map((session) => session.session_id).sort()).toEqual(
      [ownedRecentChild.session_id, ownedBusyChild.session_id].sort()
    );
    expect(result.preview.descendantsNewerThanCutoff.map((session) => session.session_id)).toEqual([
      ownedRecentChild.session_id,
    ]);
    expect(
      result.preview.descendantsWithUnfinishedTasks.map((session) => session.session_id)
    ).toEqual([ownedBusyChild.session_id]);
    expect(result.preview.units).toEqual(
      expect.arrayContaining([
        {
          rootSessionId: denied.session_id,
          kind: 'local',
          status: 'skipped',
          changedCount: 0,
          reason: 'insufficient_permission',
        },
        {
          rootSessionId: owned.session_id,
          kind: 'local',
          status: 'changed',
          changedCount: 2,
          branchId: ownedBranchId,
        },
      ])
    );
    await expect(getArchivedState(db, owned.session_id)).resolves.toEqual(ARCHIVED('manual'));
    await expect(getArchivedState(db, ownedChild.session_id)).resolves.toEqual(
      ARCHIVED('parent_archived')
    );
    await expect(getArchivedState(db, denied.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, deniedChild.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, deniedRecentChild.session_id)).resolves.toEqual(ACTIVE);
    await expect(getArchivedState(db, deniedBusyChild.session_id)).resolves.toEqual(ACTIVE);
  });

  dbTest(
    'reports a bounded limit on dry-run and fails closed on execution when remote fan-out is too wide',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const sourceBranchId = await createBranch(db, 'fan-out-source');
      const parent = await createSession(db, sourceBranchId);
      for (let index = 0; index < 33; index += 1) {
        const remoteBranchId = await createBranch(db, `fan-out-${index}`);
        const remote = await createSession(db, remoteBranchId);
        await linkRemote(db, parent, remote);
      }

      const preview = await service.archive(parent.session_id, { dryRun: true });
      expect(preview.limitExceeded).toBe('remote_branch_units');
      expect(preview.remoteCount).toBe(0);
      expect(preview.wouldChangeCount).toBe(1);

      await expect(service.archive(parent.session_id)).rejects.toThrow(
        /more than 32 other branches/
      );
      await expect(getArchivedState(db, parent.session_id)).resolves.toEqual(ACTIVE);

      const localOnly = await service.archive(parent.session_id, { includeRemoteChildren: false });
      expect(localOnly.count).toBe(1);
    },
    60_000
  );

  dbTest(
    'rejects an authorized remote chain beyond the depth bound without changing any session',
    async ({ db }) => {
      const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
      const sourceBranchId = await createBranch(db, 'authorized-depth-source');
      const source = await createSession(db, sourceBranchId);
      const chain = [source];
      let previous = source;
      for (let depth = 1; depth <= 9; depth += 1) {
        const branchId = await createBranch(db, `authorized-depth-${depth}`);
        const target = await createSession(db, branchId);
        await linkRemote(db, previous, target);
        chain.push(target);
        previous = target;
      }

      await expect(
        service.archive(source.session_id, { includeChildren: false }, externalParams(TEST_USER_ID))
      ).rejects.toThrow(/deeper than 8 hops/);

      for (const session of chain) {
        await expect(getArchivedState(db, session.session_id)).resolves.toEqual(ACTIVE);
      }
    },
    60_000
  );

  dbTest(
    'skips a denied remote target beyond the depth bound without disclosing the bound',
    async ({ db }) => {
      const service = new SessionsService(db, makeAppWithConfig({ branchRbac: true }));
      const sourceBranchId = await createBranch(db, 'depth-source');
      const source = await createSession(db, sourceBranchId);
      const authorized: Session[] = [];
      let previous = source;
      for (let depth = 1; depth <= 8; depth += 1) {
        const branchId = await createBranch(db, `depth-${depth}`);
        const target = await createSession(db, branchId);
        await linkRemote(db, previous, target);
        authorized.push(target);
        previous = target;
      }
      const deniedBranchId = await createBranch(db, 'depth-denied', {
        created_by: OTHER_USER_ID,
        primary_owner_user_id: OTHER_USER_ID,
        others_can: 'view',
      });
      const denied = await createSession(db, deniedBranchId, { created_by: OTHER_USER_ID });
      await linkRemote(db, previous, denied);

      const result = await service.archive(
        source.session_id,
        { includeChildren: false },
        externalParams(TEST_USER_ID)
      );

      expect(result.count).toBe(9);
      expect(result.limitExceeded).toBeUndefined();
      expect(result.skippedCount).toBe(1);
      expect(result.units).toContainEqual({
        rootSessionId: denied.session_id,
        kind: 'remote',
        status: 'skipped',
        changedCount: 0,
        reason: 'insufficient_permission',
      });
      for (const session of [source, ...authorized]) {
        await expect(getArchivedState(db, session.session_id)).resolves.toMatchObject({
          archived: true,
        });
      }
      await expect(getArchivedState(db, denied.session_id)).resolves.toEqual(ACTIVE);
    },
    60_000
  );

  dbTest(
    'archive entry points satisfy the armed tenant database-scope guard on their own',
    async ({ db }) => {
      const guardedDb = createTenantScopedDatabaseProxy(db, { label: 'guarded archive test' });
      const service = new SessionsService(guardedDb, STUB_APP);
      const branchId = await createBranch(db);
      const parent = await createSession(db, branchId);
      const btw = await createSession(db, branchId, {
        fork_origin: 'btw',
        genealogy: { forked_from_session_id: parent.session_id, children: [] },
      });

      await runWithTenantContext('tenant-a', async () => {
        expect((await service.archive(parent.session_id, { includeChildren: false })).count).toBe(
          1
        );
        expect((await service.unarchive(parent.session_id, { includeChildren: false })).count).toBe(
          1
        );
        expect((await service.archiveBtwSession(btw.session_id)).count).toBe(1);
        expect((await service.restorePromptedSession(btw.session_id)).count).toBe(1);
        expect((await service.archiveBranchSessions(branchId as BranchID)).count).toBe(2);
        expect((await service.unarchiveBranchSessions(branchId as BranchID)).count).toBe(2);
        expect((await service.previewBulkArchive([parent], { policy: 'all' })).wouldArchive).toBe(
          2
        );
        expect((await service.bulkArchive([parent], { policy: 'none' })).count).toBe(1);
      });
    }
  );
});
