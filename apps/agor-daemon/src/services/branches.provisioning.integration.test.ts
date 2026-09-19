import { createClient } from '@agor/core/api';
import {
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Branch, BranchID } from '@agor/core/types';
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
  'missing local home commits failed restore and delivers retry failure over authenticated sockets',
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
    await server.app.unuse('repos');
    const repos = new ReposService(db, server.app);
    server.app.use('repos', repos);
    server.app.sessionTokenService = {
      generateCommandToken: vi.fn(async () => 'fictional-command-token'),
    } as never;
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
        tenant: { tenant_id: 'provisioning-test', source: 'explicit' as const },
      };
      const result = await (server.app.service('branches') as unknown as BranchesService).unarchive(
        branch.branch_id,
        undefined,
        params
      );
      expect(result.filesystem_status).toBe('failed');
      expect(result.error_message).toContain('cannot recover personal state');
      expect((await rows.findById(branch.branch_id))?.provisioning_operation).toBe('restore');
      expect(result.provisioning_attempt_id).not.toBe('prior-attempt');
      expect(requestExecutor).toHaveBeenCalled();
      expect(spawnExecutor).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(deliveries.some((row) => row.filesystem_status === 'failed')).toBe(true)
      );
      deliveries.length = 0;
      const retried = await repos.retryBranchProvisioning(branch.branch_id, params);
      expect(retried.filesystem_status).toBe('failed');
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
