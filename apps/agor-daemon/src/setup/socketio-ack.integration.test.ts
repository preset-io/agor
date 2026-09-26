import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { type Session, SessionStatus, type Task, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BaseTool,
  executeToolTask,
} from '../../../../packages/executor/src/handlers/sdk/base-executor.js';
import { createExecutorClient } from '../../../../packages/executor/src/services/feathers-client.js';
import { TasksService } from '../services/tasks.js';

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const SESSION_ID = '018f0000-0000-7000-8000-000000000002';
const SESSION_TOKEN = 'executor-session-token';

interface SocketParams {
  provider?: string;
  connection?: Record<string, unknown>;
}

function requireSocketAuthentication(params?: SocketParams): void {
  if (params?.provider && params.connection?.testAuthenticated !== true) {
    throw new Error('Socket request arrived without handshake authentication');
  }
}

function waitForSocketConnect(socketClient: AgorClient): Promise<void> {
  if (socketClient.io.connected) return Promise.resolve();
  return new Promise((resolve) => socketClient.io.once('connect', resolve));
}

describe('executor acknowledgement failure convergence', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('rejects a lost acknowledgement after the native deadline without retrying', async () => {
    const app = feathersExpress(feathers());
    let mutationCount = 0;
    app.use('lost-ack', {
      async create(data: { value: string }) {
        mutationCount += 1;
        return data;
      },
    });
    app.configure(
      socketio({}, (io) => {
        io.on('connection', (socket) => {
          socket.use((packet, next) => {
            const [event, path] = packet;
            if (event === 'create' && path === 'lost-ack') {
              packet[packet.length - 1] = () => {};
            }
            next();
          });
        });
      })
    );

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      ackTimeout: 50,
      reconnectionAttempts: 0,
    });
    await waitForSocketConnect(client);

    const lostAckService = (
      client as AgorClient & {
        service(path: 'lost-ack'): {
          create(data: { value: string }): Promise<unknown>;
        };
      }
    ).service('lost-ack');
    await expect(lostAckService.create({ value: 'sub-limit' })).rejects.toThrow(/timed out/i);
    expect(mutationCount).toBe(1);
  });

  it('does not reconnect a credential revoked after its terminal Task acknowledgement', async () => {
    const app = feathersExpress(feathers());
    let handshakeAuthenticationCount = 0;
    app.use('tasks', {
      async patch(id: string, data: Partial<Task>) {
        return { task_id: id, session_id: SESSION_ID, ...data };
      },
    });
    app.configure(
      socketio({}, (io) => {
        io.use((socket, next) => {
          if (socket.handshake.auth?.token !== SESSION_TOKEN) {
            next(new Error('Invalid executor handshake token'));
            return;
          }
          handshakeAuthenticationCount += 1;
          next();
        });
        io.on('connection', (socket) => {
          socket.use((packet, next) => {
            const [event, path] = packet;
            if (event === 'patch' && path === 'tasks') {
              const acknowledge = packet[packet.length - 1];
              if (typeof acknowledge === 'function') {
                packet[packet.length - 1] = (...args: unknown[]) => {
                  acknowledge(...args);
                  socket.disconnect(true);
                };
              }
            }
            next();
          });
        });
      })
    );

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = await createExecutorClient(`http://127.0.0.1:${address.port}`, SESSION_TOKEN);
    const disconnected = new Promise<void>((resolve) => client?.io.once('disconnect', resolve));
    await expect(
      client.service('tasks').patch(TASK_ID, {
        status: TaskStatus.COMPLETED,
        completed_at: '2026-08-24T00:00:00.000Z',
      })
    ).resolves.toMatchObject({ status: TaskStatus.COMPLETED });
    await disconnected;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handshakeAuthenticationCount).toBe(1);
    expect(client.io.connected).toBe(false);
  });

  it('rejects a stranded mutation once and converges through the executor terminal boundary', async () => {
    const app = feathersExpress(feathers());
    let mutationCount = 0;
    let handshakeAuthenticationCount = 0;
    let reconnectCount = 0;
    let shouldStrandAcknowledgement = true;
    const terminalBoundaryOrder: string[] = [];
    let resolveReconnected!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      resolveReconnected = resolve;
    });
    let session = {
      session_id: SESSION_ID,
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
      tasks: [TASK_ID],
    } as Session;
    let task = {
      task_id: TASK_ID,
      session_id: SESSION_ID,
      status: TaskStatus.RUNNING,
      created_at: '2026-07-13T12:00:00.000Z',
      full_prompt: 'Exercise a stranded acknowledgement',
    } as Task;

    app.use('lost-ack', {
      async create(data: { value: string }, params?: SocketParams) {
        requireSocketAuthentication(params);
        mutationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return data;
      },
    });
    const taskService = Object.create(TasksService.prototype) as TasksService & {
      app: typeof app;
      get: (id: string) => Promise<Task>;
      taskRepo: { updateFromExecutor: (id: string, data: Partial<Task>) => Promise<Task> };
      id: string;
      emit: () => boolean;
    };
    taskService.app = app;
    taskService.get = async () => task;
    taskService.taskRepo = {
      async updateFromExecutor(_id, data) {
        task = { ...task, ...data };
        if (data.status === TaskStatus.FAILED) {
          // Production commits the terminal Task and its Session projection in
          // one repository transaction. Keep this boundary fake faithful: the
          // service may publish the Session immediately after the repo resolves.
          session = {
            ...session,
            status: SessionStatus.FAILED,
            ready_for_prompt: true,
          };
          terminalBoundaryOrder.push('repository-terminal-commit');
        }
        return task;
      },
    };
    taskService.id = 'task_id';
    taskService.emit = () => false;
    app.use('tasks', taskService);
    app.service('tasks').hooks({
      before: {
        all: [
          async (context) => {
            requireSocketAuthentication(context.params as SocketParams);
            return context;
          },
        ],
      },
    });
    app.use('sessions', {
      async get(_id: string, params?: SocketParams) {
        requireSocketAuthentication(params);
        if (task.status === TaskStatus.FAILED) {
          terminalBoundaryOrder.push('service-terminal-session-read');
        }
        return session;
      },
      async patch(_id: string, data: Partial<Session>, params?: SocketParams) {
        requireSocketAuthentication(params);
        session = { ...session, ...data };
        return session;
      },
      async triggerQueueProcessing() {},
    });
    app.use('config/resolve-api-key', {
      async create(_data: unknown, params?: SocketParams) {
        requireSocketAuthentication(params);
        return { apiKey: 'test-key', source: 'global', useNativeAuth: false };
      },
    });
    app.use('messages', {
      async find(params?: SocketParams) {
        requireSocketAuthentication(params);
        return { total: 0, limit: 10, skip: 0, data: [] };
      },
      async create(data: unknown, params?: SocketParams) {
        requireSocketAuthentication(params);
        return data;
      },
    });
    app.configure(
      socketio({}, (io) => {
        io.use((socket, next) => {
          if (socket.handshake.auth?.token !== SESSION_TOKEN) {
            next(new Error('Invalid executor handshake token'));
            return;
          }
          const connection = (socket as unknown as { feathers?: Record<string, unknown> }).feathers;
          if (!connection) {
            next(new Error('Missing Feathers connection'));
            return;
          }
          handshakeAuthenticationCount += 1;
          connection.testAuthenticated = true;
          next();
        });
        io.on('connection', (socket) => {
          socket.use((packet, next) => {
            const [event, path] = packet;
            if (event !== 'create' || path !== 'lost-ack' || !shouldStrandAcknowledgement) {
              next();
              return;
            }
            shouldStrandAcknowledgement = false;
            packet[packet.length - 1] = () => {
              socket.disconnect(true);
            };
            next();
          });
        });
      })
    );

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = await createExecutorClient(`http://127.0.0.1:${address.port}`, SESSION_TOKEN, {
      onReconnected: () => {
        reconnectCount += 1;
        resolveReconnected();
      },
    });

    let rejection: unknown;
    const startedAt = Date.now();
    try {
      await executeToolTask({
        client,
        sessionId: SESSION_ID as never,
        taskId: TASK_ID as never,
        prompt: 'Exercise a stranded acknowledgement',
        abortController: new AbortController(),
        apiKeyEnvVar: 'OPENAI_API_KEY',
        toolName: 'codex',
        createTool: () =>
          ({
            async executePromptWithStreaming() {
              await (
                client as AgorClient & {
                  service(path: 'lost-ack'): {
                    create(data: { value: string }): Promise<unknown>;
                  };
                }
              )
                .service('lost-ack')
                .create({ value: 'sub-limit' });
              throw new Error('Unreachable after the stranded acknowledgement');
            },
          }) satisfies BaseTool,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await reconnected;
    expect(mutationCount).toBe(1);
    expect(handshakeAuthenticationCount).toBeGreaterThanOrEqual(2);
    expect(reconnectCount).toBe(1);

    expect(task).toMatchObject({
      status: TaskStatus.FAILED,
      error_message: expect.any(String),
    });
    expect(task.error_message).toBe((rejection as Error).message);
    expect(task.error_message).toMatch(/disconnected|timed out/i);
    expect(session).toMatchObject({ status: SessionStatus.FAILED, ready_for_prompt: true });
    expect(terminalBoundaryOrder).toEqual([
      'repository-terminal-commit',
      'service-terminal-session-read',
    ]);
  });
});
