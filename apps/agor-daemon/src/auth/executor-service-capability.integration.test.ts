import type { Server } from 'node:http';
import { type AgorClient, type BranchesExecutorService, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import type { BranchID, HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  protectExternalBranchManagedWrites,
  protectServerManagedUnixGroupWrites,
} from '../register-hooks';
import { requireMinimumRole } from '../utils/authorization';
import { executorServiceCapabilityGuard } from './executor-runtime-scope';

function waitForSocketConnect(client: AgorClient): Promise<void> {
  if (client.io.connected) return Promise.resolve();
  return new Promise((resolve) => client.io.once('connect', resolve));
}

describe('executor service capability Socket transport', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    client = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
    server = undefined;
  });

  it('lets branch deletion inventory rows but denies cross-resource and credential access', async () => {
    const app = feathersExpress(feathers());
    app.configure(socketio());
    app.on('connection', (connection: Record<string, unknown>) => {
      connection.user = {
        user_id: 'executor-service',
        role: 'service',
        _isServiceAccount: true,
      };
      connection.authentication = {
        payload: {
          type: 'service',
          sub: 'executor-service',
          purpose: 'executor-service',
          role: 'service',
          command: 'git.branch.remove',
          branch_id: 'branch-1',
          repo_id: 'repo-1',
          filesystem_operation_id: 'operation-1',
        },
      };
    });

    app.use('branches', {
      async find() {
        return [{ branch_id: 'branch-1' }, { branch_id: 'branch-2' }];
      },
      async get(id: string) {
        return { branch_id: id, repo_id: 'repo-1' };
      },
      async patch(id: string, data: Record<string, unknown>) {
        return { branch_id: id, repo_id: 'repo-1', ...data };
      },
    });
    app.use('repos', {
      async find() {
        return [{ repo_id: 'repo-1' }, { repo_id: 'repo-2' }];
      },
      async get(id: string) {
        return { repo_id: id };
      },
    });
    app.use('boards', {
      async find() {
        return [];
      },
    });
    for (const path of ['branches', 'repos', 'boards'] as const) {
      app.service(path).hooks({
        before: {
          find: [requireMinimumRole(ROLES.MEMBER, `read ${path}`)],
          get: [requireMinimumRole(ROLES.MEMBER, `read ${path}`)],
          patch: [requireMinimumRole(ROLES.MEMBER, `patch ${path}`)],
          all: [executorServiceCapabilityGuard() as (context: HookContext) => Promise<HookContext>],
        },
      } as never);
    }

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      reconnectionAttempts: 0,
    });
    await waitForSocketConnect(client);

    await expect(client.service('branches').find()).resolves.toHaveLength(2);
    await expect(client.service('repos').find()).resolves.toHaveLength(2);
    await expect(client.service('repos').get('repo-1')).resolves.toMatchObject({
      repo_id: 'repo-1',
    });
    await expect(client.service('repos').get('repo-2')).rejects.toThrow(/not valid/i);
    await expect(client.service('boards').find()).rejects.toThrow(/not valid/i);

    const executorBranches = client.service('branches') as unknown as BranchesExecutorService;
    await expect(
      executorBranches.patch('branch-1', { filesystem_status: 'deleted' })
    ).resolves.toMatchObject({ branch_id: 'branch-1', filesystem_status: 'deleted' });
    await expect(
      executorBranches.patch('branch-2', { filesystem_status: 'deleted' })
    ).rejects.toThrow(/not valid/i);
    await expect(
      executorBranches.patch('branch-1', {
        filesystem_status: 'deleted',
        notes: 'forged',
      } as never)
    ).rejects.toThrow(/not valid/i);
  });

  it('binds credential RPC over Socket transport to the signed clone user', async () => {
    const app = feathersExpress(feathers());
    app.configure(socketio());
    app.on('connection', (connection: Record<string, unknown>) => {
      connection.user = {
        user_id: 'executor-service',
        role: 'service',
        _isServiceAccount: true,
      };
      connection.authentication = {
        payload: {
          type: 'service',
          sub: 'executor-service',
          purpose: 'executor-service',
          role: 'service',
          command: 'git.clone',
          repo_id: 'repo-1',
          user_id: 'user-1',
        },
      };
    });

    app.use(
      '/users',
      {
        async get(id: string) {
          return { user_id: id };
        },
        async getGitEnvironment(data: { userId: string }) {
          return { requestedUserId: data.userId };
        },
      },
      { methods: ['getGitEnvironment'] }
    );
    app.service('users').hooks({
      before: {
        all: [executorServiceCapabilityGuard() as (context: HookContext) => Promise<HookContext>],
      },
    } as never);

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      reconnectionAttempts: 0,
    });
    await waitForSocketConnect(client);

    await expect(client.service('users').getGitEnvironment({ userId: 'user-1' })).resolves.toEqual({
      requestedUserId: 'user-1',
    });
    await expect(client.service('users').getGitEnvironment({ userId: 'user-2' })).rejects.toThrow(
      /not valid/i
    );
  });

  it('accepts only the exact branch canonical Unix-group stamp over Socket transport', async () => {
    const branchId = '019ffe00-0000-7000-8000-000000000001' as BranchID;
    const otherBranchId = '019ffe00-0000-7000-9000-000000000002' as BranchID;
    const branchGroup = 'agor_wt_019ffe000000700080000000';
    const otherBranchGroup = 'agor_wt_019ffe000000700090000000';
    const legacyBranchGroup = 'agor_wt_019ffe00';
    let unixGroup: string | null = null;
    const app = feathersExpress(feathers());
    app.configure(socketio());
    app.on('connection', (connection: Record<string, unknown>) => {
      connection.user = {
        user_id: 'executor-service',
        role: 'service',
        _isServiceAccount: true,
      };
      connection.authentication = {
        payload: {
          type: 'service',
          sub: 'executor-service',
          purpose: 'executor-service',
          role: 'service',
          command: 'unix.sync-branch',
          branch_id: branchId,
        },
      };
    });

    app.use('branches', {
      async get(id: string) {
        return { branch_id: id, unix_group: id === branchId ? unixGroup : null };
      },
      async patch(id: string, data: { unix_group?: string }) {
        if (id === branchId && data.unix_group) unixGroup = data.unix_group;
        return { branch_id: id, unix_group: data.unix_group };
      },
    });
    app.service('branches').hooks({
      before: {
        all: [executorServiceCapabilityGuard() as (context: HookContext) => Promise<HookContext>],
        patch: [
          requireMinimumRole(ROLES.MEMBER, 'patch branches'),
          protectExternalBranchManagedWrites,
          protectServerManagedUnixGroupWrites('branch'),
        ],
      },
    } as never);

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      reconnectionAttempts: 0,
    });
    await waitForSocketConnect(client);
    const executorBranches = client.service('branches') as unknown as BranchesExecutorService;

    await expect(
      executorBranches.patch(branchId, {
        unix_group: legacyBranchGroup,
      })
    ).rejects.toThrow(/canonical group/i);
    await expect(
      executorBranches.patch(branchId, {
        unix_group: otherBranchGroup,
      })
    ).rejects.toThrow(/canonical group|invalid persisted unix group/i);
    await expect(
      executorBranches.patch(otherBranchId, {
        unix_group: otherBranchGroup,
      })
    ).rejects.toThrow(/not valid/i);
    await expect(
      executorBranches.patch(branchId, {
        unix_group: branchGroup,
      })
    ).resolves.toMatchObject({
      branch_id: branchId,
      unix_group: branchGroup,
    });
  });
});
