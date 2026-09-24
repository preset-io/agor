import { createClient } from '@agor/core/api';
import {
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runWithTenantDatabaseTransaction,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { authenticate } from '@agor/core/feathers';
import type { BoardID, Branch, BranchID, Params, TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import type { RegisterHooksContext } from '../register-hooks';
import { configureRealtimePublish } from '../utils/realtime-publish';
import {
  requestExecutor,
  spawnExecutor,
  spawnExecutorFireAndForget,
} from '../utils/spawn-executor';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteAdmissionAroundHook,
} from '../utils/tenant-db-scope';
import type { BranchesService } from './branches';
import { ReposService } from './repos';

vi.mock('../utils/spawn-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/spawn-executor')>()),
  requestExecutor: vi.fn(async () => ({ success: true, data: { exists: false } })),
  spawnExecutor: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(() => {
    throw new Error('Fictional launcher unavailable');
  }),
}));

dbTest(
  'restore launch failure commits failed and delivers retry failure over authenticated sockets',
  async ({ db: raw }) => {
    const owner = await new UsersRepository(raw).create({
      email: 'owner@example.test',
      role: 'member',
    });
    const outsider = await new UsersRepository(raw).create({
      email: 'outsider@example.test',
      role: 'member',
    });
    const board = await new BoardRepository(raw).create({
      name: 'Fictional board',
      created_by: owner.user_id,
    });
    const repo = await new RepoRepository(raw).create({
      name: 'Fictional template',
      slug: 'fictional/template',
      repo_type: 'local',
      local_path: '/fictional/template',
      default_branch: 'main',
      remote_url: 'https://example.test/template.git',
    });
    const rows = new BranchRepository(raw);
    const branch = await rows.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      board_id: board.board_id,
      name: 'Fictional home',
      ref: 'home',
      path: '/fictional/missing-home',
      branch_unique_id: 1,
      created_by: owner.user_id,
      archived: true,
      storage_mode: 'clone',
      filesystem_status: 'preserved',
      provisioning_attempt_id: 'prior-attempt',
      custom_context: {
        teammate: { kind: 'teammate', displayName: 'Fictional teammate', localHome: true },
      },
    });
    const db = createTenantScopedDatabaseProxy(raw, { label: 'provisioning-integration' });
    const config = {
      database: { dialect: 'sqlite' },
      execution: {},
      multi_tenancy: { mode: 'static', static_tenant_id: 'provisioning-test' },
    } as RegisterHooksContext['config'];
    const server = await boardMetadataTestApp(db, config, true);
    Object.assign(server.app.service('sessions'), {
      unarchiveBranchSessions: async () => ({ count: 0 }),
    });
    await server.app.unuse('repos');
    const repos = new ReposService(db, server.app);
    server.app.use('repos', repos);
    Object.assign(server.app, {
      sessionTokenService: {
        generateCommandToken: vi.fn(async () => 'fictional-command-token'),
      },
    });
    configureRealtimePublish({
      db,
      app: server.app,
      branchRepository: new BranchRepository(db),
      sessionsRepository: new SessionRepository(db),
      multiTenancy: { mode: 'static', static_tenant_id: 'provisioning-test' as never },
    });
    const client = createClient(server.url, true, {
      reconnectionAttempts: 0,
      socketAuthentication: { accessToken: server.headers(owner.user_id).authorization.slice(7) },
    });
    const foreign = createClient(server.url, true, {
      reconnectionAttempts: 0,
      socketAuthentication: {
        accessToken: server.headers(outsider.user_id).authorization.slice(7),
      },
    });
    const deliveries: Branch[] = [];
    const forbiddenDeliveries: Branch[] = [];
    try {
      await vi.waitFor(() => {
        expect(client.io.connected).toBe(true);
        expect(foreign.io.connected).toBe(true);
      });
      client.service('branches').on('patched', (row) => deliveries.push(row));
      foreign.service('branches').on('patched', (row) => forbiddenDeliveries.push(row));
      const params = {
        user: owner,
        tenant: { tenant_id: 'provisioning-test' as TenantID, source: 'explicit' as const },
      };
      const result = await (server.app.service('branches') as unknown as BranchesService).unarchive(
        branch.branch_id,
        undefined,
        params
      );
      expect(result.filesystem_status).toBe('failed');
      expect(result.error_message).toContain('launcher unavailable');
      expect((await rows.findById(branch.branch_id))?.provisioning_operation).toBe('restore');
      expect(result.provisioning_attempt_id).not.toBe('prior-attempt');
      expect(requestExecutor).not.toHaveBeenCalled();
      expect(spawnExecutor).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(deliveries.some((row) => row.filesystem_status === 'failed')).toBe(true)
      );
      deliveries.length = 0;
      const retried = await repos.retryBranchProvisioning(branch.branch_id, params);
      // Dispatch waits for command credential commit; realtime carries failure.
      expect(['creating', 'failed']).toContain(retried.filesystem_status);
      expect(spawnExecutorFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({ params: expect.objectContaining({ restoreMode: true }) }),
        expect.anything()
      );
      await vi.waitFor(() =>
        expect(deliveries.map((row) => row.filesystem_status)).toEqual(['creating', 'failed'])
      );
      expect((await rows.findById(branch.branch_id))?.filesystem_status).toBe('failed');
      // The production HTTP hooks reject mixed terminal metadata rather than bypassing board placement.
      const response = await fetch(`${server.url}/branches/${branch.branch_id}`, {
        method: 'PATCH',
        headers: server.headers(owner.user_id),
        body: JSON.stringify({
          filesystem_status: 'ready',
          provisioning_attempt_id: retried.provisioning_attempt_id,
          name: 'Injected',
        }),
      });
      expect(response.ok).toBe(false);
      expect((await rows.findById(branch.branch_id))?.name).toBe('Fictional home');
      expect(forbiddenDeliveries).toEqual([]);
    } finally {
      client.io.close();
      foreign.io.close();
      await server.close();
    }
  }
);

for (const scenario of [
  'same-board',
  'different-board',
  'denied-board',
  'blocked-recovery',
] as const) {
  dbTest(`authenticated socket unarchive acknowledgement: ${scenario}`, async ({ db: raw }) => {
    const owner = await new UsersRepository(raw).create({
      email: 'owner@ack.test',
      role: 'member',
    });
    const outsider = await new UsersRepository(raw).create({
      email: 'other@ack.test',
      role: 'member',
    });
    const boards = new BoardRepository(raw);
    const source = await boards.create({ name: 'Source', created_by: owner.user_id });
    const destination = ['same-board', 'blocked-recovery'].includes(scenario)
      ? source
      : await boards.create({
          name: 'Destination',
          created_by: scenario === 'denied-board' ? outsider.user_id : owner.user_id,
        });
    const repo = await new RepoRepository(raw).create({
      name: 'Fixture',
      slug: 'ack/fixture',
      repo_type: 'local',
      local_path: '/fictional/ack',
      default_branch: 'main',
    });
    const rows = new BranchRepository(raw);
    const branch = await rows.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      board_id: source.board_id,
      name: 'Archived',
      ref: 'main',
      path: '/fictional/ack/home',
      branch_unique_id: 1,
      created_by: owner.user_id,
      archived: true,
      filesystem_status: 'preserved',
      storage_mode: 'clone',
      custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture', localHome: true } },
    });
    if (scenario === 'blocked-recovery') {
      const session = await new SessionRepository(raw).create({
        branch_id: branch.branch_id,
        created_by: owner.user_id,
        agentic_tool: 'codex',
      });
      await new TaskRepository(raw).create({
        session_id: session.session_id,
        created_by: owner.user_id,
        status: 'queued',
      });
    }
    const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    const config = {
      database: { dialect: 'sqlite' },
      execution: {},
      multi_tenancy: { mode: 'static', static_tenant_id: 'ack-test' },
    } as RegisterHooksContext['config'];
    const completed = vi.fn();
    const server = await boardMetadataTestApp(db, config, true, false, false, async (app) => {
      await app.unuse('repos');
      app.use('repos', new ReposService(db, app));
      Object.assign(app.service('sessions'), {
        unarchiveBranchSessions: async () => {
          // Model the outer handler's asynchronous tail after admission commits.
          // An ACL eviction here must not strand a same-board request's ack.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { count: 0 };
        },
      });
      Object.assign(app, {
        sessionTokenService: {
          generateCommandToken: vi.fn(async () => 'fictional-command-token'),
        },
      });
      // Same identity-only transport boundary as register-routes; production
      // BranchesService, recovery validation, auth hooks and eviction run below.
      app.use('branches/:id/unarchive', {
        async create(data: { boardId?: BoardID }, params: Params) {
          const result = await (app.service('branches') as unknown as BranchesService).unarchive(
            params.route!.id as BranchID,
            data,
            params
          );
          completed(result);
          return result;
        },
      });
      app.service('branches/:id/unarchive').hooks({
        around: {
          all: [
            createTenantDatabaseScopeAroundHook({
              db,
              config,
              jwtSecret: 'board-metadata-disposable-test-secret',
              transaction: false,
            }),
            createTenantWriteAdmissionAroundHook(db),
          ],
        },
        before: { create: [authenticate({ strategies: ['jwt'] })] },
      });
    });
    const client = createClient(server.url, true, {
      ackTimeout: 1500,
      reconnectionAttempts: 0,
      socketAuthentication: { accessToken: server.headers(owner.user_id).authorization.slice(7) },
    });
    const disconnected = vi.fn();
    try {
      await vi.waitFor(() => expect(client.io.connected).toBe(true));
      client.io.on('disconnect', disconnected);
      // A mismatched caller tenant cannot borrow a live transaction, including
      // the new same-board path. No admission/placement side effect may escape.
      await expect(
        runWithTenantDatabaseTransaction(db, 'foreign', () =>
          (server.app.service('branches') as unknown as BranchesService).unarchive(
            branch.branch_id,
            { boardId: source.board_id },
            { user: owner, tenant: { tenant_id: 'ack-test' as TenantID, source: 'explicit' } }
          )
        )
      ).rejects.toThrow(/tenant/i);
      expect((await rows.findById(branch.branch_id))?.archived).toBe(true);
      const response = client.service(`branches/${branch.branch_id}/unarchive`).create({
        boardId: destination.board_id,
      });
      if (scenario === 'same-board') {
        const result = await response;
        expect(result).toMatchObject({ branch_id: branch.branch_id, archived: false });
        expect(completed).toHaveBeenCalledTimes(1);
        expect(disconnected).not.toHaveBeenCalled();
        expect(client.io.connected).toBe(true);
      } else if (scenario === 'different-board') {
        // Real moves still evict. The socket can lose its ack even though the
        // transaction commits: this is why the UI needs an unknown-outcome path.
        await response.catch(() => undefined);
        await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
        expect(disconnected).toHaveBeenCalledWith('io server disconnect', undefined);
      } else {
        await expect(response).rejects.toThrow(
          scenario === 'denied-board' ? /Board Editor or Manager/ : /unfinished tasks/
        );
        expect(completed).not.toHaveBeenCalled();
        expect(disconnected).not.toHaveBeenCalled();
      }
      expect(await rows.findById(branch.branch_id)).toMatchObject({
        board_id: scenario === 'denied-board' ? source.board_id : destination.board_id,
        archived: scenario === 'denied-board' || scenario === 'blocked-recovery',
      });
    } finally {
      client.io.close();
      await server.close();
    }
  });
}
