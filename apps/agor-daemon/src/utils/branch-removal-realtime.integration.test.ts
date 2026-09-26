import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import type { BranchRepository, SessionRepository } from '@agor/core/db';
import { feathers, feathersExpress, rest, socketio } from '@agor/core/feathers';
import type { Branch, HookContext, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tenantChannelName } from '../realtime/routing.js';
import { configureRealtimePublish, setBranchRemovalRealtimeVisibility } from './realtime-publish';

const BRANCH_ID = '018f0000-0000-7000-8000-000000000001';

function waitForSocketConnect(client: AgorClient): Promise<void> {
  if (client.io.connected) return Promise.resolve();
  return new Promise((resolve) => client.io.once('connect', resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('branch hard-delete realtime integration', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
    client = undefined;
    server = undefined;
  });

  it('emits no REST ghost on rollback, then removes a subscribed browser card exactly once after a Socket commit', async () => {
    const app = feathersExpress(feathers());
    const browserUser = { user_id: 'allowed', role: ROLES.MEMBER } as User;
    const branch = { branch_id: BRANCH_ID, others_can: 'none' } as Branch;
    let storedBranch: Branch | null = branch;
    let committed = false;

    app.configure(rest());
    app.configure(socketio());
    app.on('connection', (connection: Record<string, unknown>) => {
      connection.user = browserUser;
      app.channel('authenticated').join(connection as never);
      app.channel(tenantChannelName('tenant-a')).join(connection as never);
    });

    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => storedBranch),
      findRealtimeViewUserIds: vi.fn(async () => ['allowed']),
    } as unknown as BranchRepository;
    configureRealtimePublish({
      app: app as never,
      branchRepository,
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(async () => null),
        findCreatedByBySessionId: vi.fn(async () => null),
      } as unknown as SessionRepository,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });

    app.use('branches', {
      async remove(id: string) {
        if (!storedBranch || id !== storedBranch.branch_id) throw new Error('Branch not found');
        const removed = storedBranch;
        storedBranch = null;
        return removed;
      },
    });
    app.service('branches').hooks({
      around: {
        remove: [
          async (_context: HookContext, next: () => Promise<void>) => {
            const branchBeforeMutation = storedBranch;
            await next();
            if (_context.params.query?.rollback === 'true') {
              storedBranch = branchBeforeMutation;
              throw new Error('Forced transaction rollback');
            }
            committed = true;
          },
        ],
      },
      before: {
        remove: [
          async (context: HookContext) => {
            // Production captures this authorization fact while the branch and
            // its ACL rows still exist. The publisher must consume it after the
            // delete commits instead of trying to authorize against a gone row.
            setBranchRemovalRealtimeVisibility(context.params, BRANCH_ID as never, {
              mode: 'explicitUsers',
              userIds: new Set(['allowed' as never]),
            });
            return context;
          },
        ],
      },
    });

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      reconnectionAttempts: 0,
    });
    await waitForSocketConnect(client);

    const deliveries: Array<{ branch: Branch; committed: boolean }> = [];
    client.service('branches').on('removed', (removed) => {
      deliveries.push({ branch: removed, committed });
    });

    const rollbackResponse = await fetch(
      `http://127.0.0.1:${address.port}/branches/${BRANCH_ID}?rollback=true`,
      { method: 'DELETE' }
    );
    expect(rollbackResponse.status).toBe(500);
    await delay(50);
    expect(storedBranch).toEqual(branch);
    expect(deliveries).toEqual([]);

    await expect(client.service('branches').remove(BRANCH_ID as never)).resolves.toEqual(branch);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    await delay(25);

    expect(storedBranch).toBeNull();
    expect(deliveries).toEqual([{ branch, committed: true }]);
    expect(branchRepository.findRealtimeVisibilityBranch).not.toHaveBeenCalled();
  });
});
