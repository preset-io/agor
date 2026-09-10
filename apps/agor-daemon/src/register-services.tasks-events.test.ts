import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { TASKS_SERVICE_CUSTOM_EVENTS } from './services/tasks-events.js';

describe('Tasks service transport events', () => {
  it('registers executor control events at the Feathers transport boundary', () => {
    const app = feathers();
    app.use(
      'tasks',
      {
        async get() {
          return {};
        },
      },
      {
        methods: ['get'],
        events: [...TASKS_SERVICE_CUSTOM_EVENTS],
      }
    );

    const service = app.service('tasks') as unknown as Record<PropertyKey, unknown>;
    const options = Object.getOwnPropertySymbols(service)
      .map((symbol) => service[symbol])
      .find(
        (value): value is { events: string[]; serviceEvents: string[] } =>
          !!value && typeof value === 'object' && 'events' in value && 'serviceEvents' in value
      );
    if (!options) throw new Error('Feathers service registration options were not installed');
    expect(options.events).toContain('termination_requested');
    expect(options.serviceEvents).toContain('termination_requested');
    expect(options.events).toContain('mcp_refresh_requested');
    expect(options.serviceEvents).toContain('mcp_refresh_requested');
  });

  it('delivers user_reconnect over the real Socket.IO service transport', async () => {
    const app = feathersExpress(feathers());
    app.configure(socketio());
    app.on('connection', (connection: Record<string, unknown>) => {
      app.channel('authenticated').join(connection as never);
    });
    app.publish(() => app.channel('authenticated'));
    app.use(
      'tasks',
      {
        async get() {
          return {};
        },
      },
      { methods: ['get'], events: [...TASKS_SERVICE_CUSTOM_EVENTS] }
    );

    let server: Server | undefined;
    let client: AgorClient | undefined;
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
      client = createClient(`http://127.0.0.1:${address.port}`);
      if (!client.io.connected) {
        await new Promise<void>((resolve, reject) => {
          client!.io.once('connect', resolve);
          client!.io.once('connect_error', reject);
        });
      }
      const received = new Promise<unknown>((resolve) => {
        client!.service('tasks').once('mcp_refresh_requested', resolve);
      });
      const event = {
        task_id: 'task-1',
        session_id: 'session-1',
        request_id: 'request-1',
        generation: 2,
        reason: 'user_reconnect',
      };
      app.service('tasks').emit('mcp_refresh_requested', event);
      await expect(received).resolves.toEqual(event);
    } finally {
      client?.io.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
