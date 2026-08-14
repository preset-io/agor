import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
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
        return { branch_id: id, repo_id: id === 'branch-1' ? 'repo-1' : 'repo-2' };
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
});
