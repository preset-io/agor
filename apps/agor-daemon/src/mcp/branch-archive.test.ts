import {
  BoardRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantDatabaseScope,
  UserApiKeysRepository,
  UsersRepository,
} from '@agor/core/db';
import type { AuthenticatedParams, BranchFilesystemAction } from '@agor/core/types';
import { afterEach, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { archiveMcpFixture } from '../../test/branch-archive-fixture';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token';
import { requestExecutor, spawnExecutor } from '../utils/spawn-executor';

vi.mock('../utils/spawn-executor', () => ({
  requestExecutor: vi.fn(),
  spawnExecutor: vi.fn(),
  getDaemonUrl: () => 'http://fixture.invalid',
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

for (const facade of [false, true]) {
  for (const [filesystemAction, policyEnabled] of [
    [undefined, false],
    [undefined, true],
    ['preserved', true],
    ['cleaned', true],
    ['deleted', true],
  ] as const) {
    dbTest(
      `authenticated MCP archive ${filesystemAction ?? 'default'} (facade=${facade}, policy=${policyEnabled}) uses owned writes, not public patches`,
      async ({ db }) => {
        const { branch, user } = await seedEnvironmentCommandBranch(db);
        const { rawKey } = await new UserApiKeysRepository(db).create(
          user.user_id,
          'archive fixture'
        );
        await new RepoRepository(db).update(branch.repo_id, {
          cleanup_policy: {
            enabled: policyEnabled,
            command: 'git clean -fdX',
            allow_branch_protection: true,
          },
        });
        const fixture = await archiveMcpFixture(db);
        try {
          vi.mocked(requestExecutor).mockResolvedValue({
            success: true,
            data: { branchId: branch.branch_id, exists: true, kind: 'directory' },
          });
          // No command token is used against a daemon: both executor boundaries are stubbed.
          Object.assign(fixture.app, {
            sessionTokenService: {
              generateCommandToken: vi.fn().mockResolvedValue('disposable-unused-token'),
            },
          });
          vi.spyOn(
            fixture.service as unknown as {
              resolveEnvironmentExecutorContext: (typeof fixture.service)['resolveEnvironmentExecutorContext'];
            },
            'resolveEnvironmentExecutorContext'
          ).mockResolvedValue({
            env: {},
            sandboxMounts: {},
            executionUserId: user.user_id,
            branchFsAccess: 'write',
          });
          const patch = vi.spyOn(fixture.service, 'patch');
          const begin = vi.spyOn(BranchMaintenanceRepository.prototype, 'beginExecution');
          const archive = vi.spyOn(fixture.service, 'archiveOrDelete');
          const response = await fixture.call(
            rawKey,
            'agor_branches_archive',
            { branchId: branch.branch_id, ...(filesystemAction ? { filesystemAction } : {}) },
            facade
          );
          expect(response.status).toBe(200);
          expect(response.error).toBeUndefined();
          expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
          expect(archive).toHaveBeenCalledWith(
            branch.branch_id,
            expect.anything(),
            expect.objectContaining({
              provider: 'mcp',
              authenticated: true,
              user: expect.objectContaining({ user_id: user.user_id }),
            })
          );
          expect(patch).not.toHaveBeenCalled();
          const effectiveAction = filesystemAction ?? (policyEnabled ? 'cleaned' : 'preserved');
          const files = effectiveAction !== 'preserved';
          expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
            archived: true,
            filesystem_status: 'ready',
            workspace_operation: { status: files ? 'accepted' : 'succeeded' },
          });
          expect(spawnExecutor).toHaveBeenCalledTimes(files ? 1 : 0);
          expect(requestExecutor).toHaveBeenCalledTimes(effectiveAction === 'cleaned' ? 1 : 0);
          if (files)
            expect(spawnExecutor).toHaveBeenCalledWith(
              expect.objectContaining({
                command: 'branch.archive',
                params: expect.objectContaining({
                  branchId: branch.branch_id,
                  filesystemAction: effectiveAction,
                }),
              }),
              expect.anything()
            );
          if (files) {
            // Settle only this disposable claim; executor/report authentication and
            // actual storage removal have separate boundary fixtures.
            const claim = begin.mock.calls[0]![0];
            const execution = await begin.mock.results[0]!.value;
            const operations = new BranchWorkspaceOperationRepository(db);
            await new BranchMaintenanceRepository(db).claimExecution(claim, execution, (tx) =>
              operations.validateLaunch(tx, claim)
            );
            await operations.finish(claim, execution, 'succeeded');
            expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
              archived: true,
              filesystem_status: effectiveAction,
              workspace_operation: { status: 'succeeded' },
            });
            expect(patch).not.toHaveBeenCalled();
          }
        } finally {
          await fixture.close();
        }
      }
    );
  }
}

dbTest(
  'authenticated archive requires Manager and writable files; external status writes remain rejected',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const member = await new UsersRepository(db).create({
      email: 'archive-member@example.test',
      role: 'member',
    });
    const { rawKey } = await new UserApiKeysRepository(db).create(
      member.user_id,
      'archive fixture'
    );
    const fixture = await archiveMcpFixture(db);
    try {
      for (const action of ['preserved', 'cleaned', 'deleted'] as BranchFilesystemAction[]) {
        await setTestBranchUserRole(
          db,
          branch.branch_id,
          member.user_id,
          'collaborator',
          'write',
          user.user_id
        );
        const denied = await fixture.call(
          rawKey,
          'agor_branches_archive',
          { branchId: branch.branch_id, filesystemAction: action },
          true
        );
        expect(denied.result?.isError).toBe(true);
      }
      await setTestBranchUserRole(
        db,
        branch.branch_id,
        member.user_id,
        'manager',
        'read',
        user.user_id
      );
      for (const action of ['cleaned', 'deleted']) {
        const denied = await fixture.call(rawKey, 'agor_branches_archive', {
          branchId: branch.branch_id,
          filesystemAction: action,
        });
        expect(denied.result?.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain('filesystem write');
      }
      for (const filesystem_status of [
        'ready',
        'failed',
        'preserved',
        'cleaned',
        'deleted',
      ] as const) {
        await expect(
          fixture.service.patch(branch.branch_id, { filesystem_status }, { provider: 'mcp', user })
        ).rejects.toThrow('filesystem_status is managed by branch materialization.');
      }
      expect((await new BranchRepository(db).findById(branch.branch_id))?.archived).toBe(false);
      expect(spawnExecutor).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  }
);

dbTest(
  'materialization status exception remains bound to the exact executor command and branch',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const fixture = await archiveMcpFixture(db);
    try {
      const payload = {
        type: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose: EXECUTOR_COMMAND_TOKEN_PURPOSE,
        session_id: 'git.branch.add',
        branch_id: branch.branch_id,
      };
      const params = (token: typeof payload): AuthenticatedParams => ({
        provider: 'rest',
        user,
        authentication: { strategy: 'jwt', payload: token },
      });
      // Service-level payload fixtures, not minted credentials or live executor identities.
      for (const token of [
        { ...payload, purpose: EXECUTOR_SESSION_TOKEN_PURPOSE },
        { ...payload, session_id: 'branch.archive' },
        { ...payload, branch_id: generateId() },
      ]) {
        await expect(
          fixture.service.patch(branch.branch_id, { filesystem_status: 'ready' }, params(token))
        ).rejects.toThrow('filesystem_status is managed');
      }
      for (const filesystem_status of ['preserved', 'cleaned', 'deleted'] as const) {
        await expect(
          fixture.service.patch(branch.branch_id, { filesystem_status }, params(payload))
        ).rejects.toThrow('filesystem_status is managed');
      }
      await runWithTenantDatabaseScope(db, 'default', async () => {
        const branches = new BranchRepository(db);
        // A valid command token cannot overwrite an already-terminal branch.
        await expect(
          fixture.service.patch(branch.branch_id, { filesystem_status: 'failed' }, params(payload))
        ).resolves.toMatchObject({ filesystem_status: 'ready' });
        await branches.update(branch.branch_id, { filesystem_status: 'failed' });
        for (const filesystem_status of ['failed', 'ready'] as const) {
          // Each terminal acknowledgement must belong to its own active attempt.
          const attemptId = generateId();
          expect((await branches.claimForProvisioning(branch.branch_id, attemptId)).claimed).toBe(
            true
          );
          await expect(
            fixture.service.patch(
              branch.branch_id,
              { filesystem_status, provisioning_attempt_id: attemptId },
              params(payload)
            )
          ).resolves.toMatchObject({ filesystem_status });
          const staleOutcome = filesystem_status === 'ready' ? 'failed' : 'ready';
          await expect(
            fixture.service.patch(
              branch.branch_id,
              { filesystem_status: staleOutcome, provisioning_attempt_id: attemptId },
              params(payload)
            )
          ).resolves.toMatchObject({ filesystem_status });
        }
      });
    } finally {
      await fixture.close();
    }
  }
);

dbTest('archive cannot bypass active-work admission even when preserving files', async ({ db }) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const { rawKey } = await new UserApiKeysRepository(db).create(user.user_id, 'archive fixture');
  await new BranchRepository(db).update(branch.branch_id, {
    environment_instance: { status: 'running' },
  });
  const fixture = await archiveMcpFixture(db);
  try {
    const response = await fixture.call(rawKey, 'agor_branches_archive', {
      branchId: branch.branch_id,
      filesystemAction: 'preserved',
    });
    expect(response.result?.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('environment is active');
    expect((await new BranchRepository(db).findById(branch.branch_id))?.archived).toBe(false);
    expect(spawnExecutor).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

for (const filesystemAction of ['preserved', 'deleted'] as const) {
  dbTest(
    `MCP ${filesystemAction} archive publishes and returns the archived branch`,
    async ({ db }) => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const { rawKey } = await new UserApiKeysRepository(db).create(
        user.user_id,
        'archive fixture'
      );
      const fixture = await archiveMcpFixture(db);
      try {
        Object.assign(fixture.app, {
          sessionTokenService: {
            generateCommandToken: vi.fn().mockResolvedValue('disposable-unused-token'),
          },
        });
        vi.spyOn(
          fixture.service as unknown as {
            resolveEnvironmentExecutorContext: (typeof fixture.service)['resolveEnvironmentExecutorContext'];
          },
          'resolveEnvironmentExecutorContext'
        ).mockResolvedValue({
          env: {},
          sandboxMounts: {},
          executionUserId: user.user_id,
          branchFsAccess: 'write',
        });
        const patched = vi.fn();
        fixture.app.service('branches').on('patched', patched);
        const response = await fixture.call(rawKey, 'agor_branches_archive', {
          branchId: branch.branch_id,
          filesystemAction,
        });
        expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
        expect((await new BranchRepository(db).findById(branch.branch_id))?.archived).toBe(true);
        // Clients evict a branch only when the realtime patch says it is archived.
        expect(patched).toHaveBeenCalledOnce();
        expect(patched).toHaveBeenCalledWith(
          expect.objectContaining({ branch_id: branch.branch_id, archived: true }),
          expect.anything()
        );
        expect(JSON.parse(response.result!.content[0]!.text).branch).toMatchObject({
          archived: true,
        });
      } finally {
        await fixture.close();
      }
    }
  );
}

dbTest(
  'MCP unarchive returns the restored branch, not the prefetched archived row',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const branches = new BranchRepository(db);
    await branches.update(branch.branch_id, { archived: true, filesystem_status: 'preserved' });
    const { rawKey } = await new UserApiKeysRepository(db).create(user.user_id, 'archive fixture');
    const fixture = await archiveMcpFixture(db);
    try {
      // Restoration's executor owner is out of scope; commit only its archived flip.
      fixture.app.use(
        'repos',
        {
          async get() {
            throw new Error('unused');
          },
          retryBranchProvisioning: (id: string) => branches.update(id, { archived: false }),
        },
        { methods: ['get', 'retryBranchProvisioning'] }
      );
      const response = await fixture.call(rawKey, 'agor_branches_unarchive', {
        branchId: branch.branch_id,
      });
      expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
      expect((await branches.findById(branch.branch_id))?.archived).toBe(false);
      expect(JSON.parse(response.result!.content[0]!.text).branch).toMatchObject({
        archived: false,
      });
    } finally {
      await fixture.close();
    }
  }
);

dbTest(
  'explicit-board unarchive compares the committed board, not the cached row',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const branches = new BranchRepository(db);
    const boards = new BoardRepository(db);
    const requested = await boards.create({ name: 'Requested', created_by: user.user_id });
    const other = await boards.create({ name: 'Other', created_by: user.user_id });
    const archived = await branches.update(branch.branch_id, {
      archived: true,
      filesystem_status: 'preserved',
      board_id: requested.board_id,
    });
    const fixture = await archiveMcpFixture(db);
    try {
      fixture.app.use(
        'repos',
        {
          async get() {
            throw new Error('unused');
          },
          // Joins the unarchive admission transaction, as the real admission does.
          retryBranchProvisioning: (id: string) =>
            new BranchRepository(createTenantScopedDatabaseProxy(db)).update(id, {
              archived: false,
            }),
        },
        { methods: ['get', 'retryBranchProvisioning'] }
      );
      // Placement is already present; board-object restoration is not under test.
      Object.assign(fixture.service, {
        boardObjectsService: { findByBranchId: async () => ({ object_id: 'existing' }) },
      });
      const service = fixture.app.service('branches') as unknown as typeof fixture.service;
      const move = vi.spyOn(service, 'patch').mockResolvedValue(archived as never);
      // The route's authorization hook cached the request-start row (on Requested);
      // a concurrent move to Other commits before the unarchive admission lock.
      await branches.update(branch.branch_id, { board_id: other.board_id });
      await service.unarchive(branch.branch_id, { boardId: requested.board_id }, {
        provider: 'rest',
        user,
        tenant: { tenant_id: 'default', source: 'explicit' },
        branch: archived,
      } as never);
      expect(move).toHaveBeenCalledWith(
        branch.branch_id,
        { board_id: requested.board_id },
        expect.anything()
      );
    } finally {
      await fixture.close();
    }
  }
);
