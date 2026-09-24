import { EventEmitter } from 'node:events';
import type { AgorClient } from '@agor/core/client';
import { feathers } from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio-client';
import { expect, it, vi } from 'vitest';
import { releaseReactiveSession, retainReactiveSession } from './reactive-session.js';

it('500 unique open/release cycles keep one parameterized queue service and no handle listeners', async () => {
  const paths: string[] = [];
  class Socket extends EventEmitter {
    connected = true;
    override emit(event: string, ...args: unknown[]): boolean {
      if (!['find', 'get', 'create', 'remove'].includes(event)) return super.emit(event, ...args);
      const [route, data] = args;
      const ack = args.at(-1) as (error: unknown, value: unknown) => void;
      if (String(route).endsWith('/tasks/queue')) paths.push(String(route));
      ack(
        null,
        event === 'find'
          ? { data: [] }
          : {
              session_id:
                typeof data === 'string' ? data : (data as { session_id: string }).session_id,
              tasks: [],
            }
      );
      return true;
    }
  }
  const socket = new Socket();
  const app = feathers().configure(socketio(socket as never));
  const client = app as unknown as AgorClient;
  client.service('tasks').findAll = async () => [];
  client.service('messages').findAll = async () => [];
  const options = { taskHydration: 'lean' as const };
  for (let i = 0; i < 500; i++) {
    const id = `session-${i}`;
    const first = retainReactiveSession(client, id, options);
    const second = retainReactiveSession(client, id, options);
    expect(second).toBe(first);
    await first.ready();
    expect(first.state.error).toBeNull();
    releaseReactiveSession(client, id, options);
    expect(socket.listenerCount('messages created')).toBeGreaterThan(0);
    releaseReactiveSession(client, id, options);
    await Promise.resolve();
  }
  expect(paths).toHaveLength(500);
  expect(paths[499]).toBe('sessions/session-499/tasks/queue');
  expect(Object.keys(app.services).filter((name) => name.endsWith('/tasks/queue'))).toEqual([
    'sessions/:id/tasks/queue',
  ]);
  await vi.waitFor(() =>
    expect(socket.eventNames().flatMap((name) => socket.listeners(name))).toHaveLength(0)
  );
});
