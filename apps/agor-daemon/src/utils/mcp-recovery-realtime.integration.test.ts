import type { Server } from 'node:http';
import type { BranchRepository, SessionRepository } from '@agor/core/db';
import { feathers, feathersExpress, socketio, socketioClient } from '@agor/core/feathers';
import type { HookContext, Task, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { redactMcpRecoveryTopology } from './mcp-recovery-redaction.js';
import { configureRealtimePublish } from './realtime-publish.js';

function waitForSocket(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

describe('MCP recovery multi-principal realtime transport', () => {
  it('returns a redacted caller response while the session owner receives full topology', async () => {
    const owner = { user_id: 'owner', role: ROLES.MEMBER } as User;
    const collaborator = { user_id: 'collaborator', role: ROLES.MEMBER } as User;
    const task = {
      task_id: 'task-1',
      session_id: 'session-1',
      created_by: collaborator.user_id,
      metadata: {
        mcp_recovery: {
          generation: 2,
          code: 'oauth_reauth_required',
          status: 'action_required',
          task_id: 'task-1',
          session_id: 'session-1',
          mcp_server_id: 'private-server-id',
          mcp_server_name: 'Private CRM',
          provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
          action: 'reauthenticate',
          message: 'Sign in again.',
          observed_at: '2026-08-26T00:00:00.000Z',
          provider_dispatch: 'not_started',
        },
      },
    } as Task;
    const app = feathersExpress(feathers());
    app.configure(
      socketio({}, (io) => {
        io.on('connection', (socket) => {
          const user = socket.handshake.auth.userId === owner.user_id ? owner : collaborator;
          socket.feathers.user = user;
          app.channel('authenticated').join(socket.feathers as never);
        });
      })
    );
    configureRealtimePublish({
      app: app as never,
      branchRbacEnabled: false,
      branchRepository: {} as BranchRepository,
      sessionsRepository: {
        findCreatedByBySessionId: async () => owner.user_id,
      } as SessionRepository,
    });
    app.use(
      'tasks',
      {
        async patch() {
          return task;
        },
      },
      { methods: ['patch'] }
    );
    app.service('tasks').hooks({
      after: {
        patch: [
          async (context: HookContext) => {
            if (context.params.user?.user_id === collaborator.user_id) {
              context.dispatch = redactMcpRecoveryTopology(context.result as Task);
            }
            return context;
          },
        ],
      },
    });

    let server: Server | undefined;
    const sockets: Socket[] = [];
    try {
      server = await app.listen(0, '127.0.0.1');
      if (!server.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.once('listening', resolve);
          server!.once('error', reject);
        });
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected test listener');
      const makeClient = (userId: string) => {
        const socket = createSocketClient(`http://127.0.0.1:${address.port}`, {
          auth: { userId },
          transports: ['websocket'],
          reconnection: false,
        });
        sockets.push(socket);
        const client = feathers();
        client.configure(socketioClient(socket));
        return { client, socket };
      };
      const ownerClient = makeClient(owner.user_id);
      const collaboratorClient = makeClient(collaborator.user_id);
      await Promise.all([
        waitForSocket(ownerClient.socket),
        waitForSocket(collaboratorClient.socket),
      ]);

      const ownerEvent = new Promise<Task>((resolve) => {
        ownerClient.client
          .service('tasks')
          .once('patched', (value: unknown) => resolve(value as Task));
      });
      const collaboratorEvent = new Promise<Task>((resolve) => {
        collaboratorClient.client
          .service('tasks')
          .once('patched', (value: unknown) => resolve(value as Task));
      });
      const callerResult = (await collaboratorClient.client
        .service('tasks')
        .patch(task.task_id, {})) as Task;

      expect(JSON.stringify(callerResult)).not.toContain('Private CRM');
      await expect(ownerEvent).resolves.toMatchObject({
        metadata: { mcp_recovery: { mcp_server_name: 'Private CRM' } },
      });
      expect(JSON.stringify(await collaboratorEvent)).not.toContain('Private CRM');
    } finally {
      for (const socket of sockets) socket.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
