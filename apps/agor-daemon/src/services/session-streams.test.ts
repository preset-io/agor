import type { Application } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStreamsService } from './session-streams.js';

function makeApp(
  sessionsGet: (id: string, params: unknown) => Promise<unknown>,
  existingChannels: string[] = []
) {
  const join = vi.fn();
  const leave = vi.fn();
  // Names that already exist plus any materialized by a channel lookup; the
  // leave path is existence-gated, so an absent room must not be created.
  const created = new Set<string>(existingChannels);
  const channel = vi.fn((name: string) => {
    created.add(name);
    return { join, leave };
  });
  const get = vi.fn(sessionsGet);
  const app = {
    get channels() {
      return [...created];
    },
    channel,
    service: vi.fn((path: string) => {
      if (path === 'sessions') return { get };
      throw new Error(`Unexpected service: ${path}`);
    }),
  } as unknown as Application;
  return { app, join, leave, channel, get };
}

const connection = { id: 'socket-1' };

describe('session-streams service', () => {
  it('joins the per-session channel after an access check passes', async () => {
    const { app, join, channel, get } = makeApp(async () => ({ session_id: 's1' }));
    const service = createSessionStreamsService(app);

    const result = await service.create({ session_id: 's1' }, {
      connection,
      provider: 'socketio',
    } as never);

    expect(get).toHaveBeenCalledWith('s1', expect.objectContaining({ query: {} }));
    expect(channel).toHaveBeenCalledWith('session-stream:s1');
    expect(join).toHaveBeenCalledWith(connection);
    expect(result).toEqual({ session_id: 's1', subscribed: true });
  });

  it('joins the canonical room id when the caller passes a short id', async () => {
    // The resolved row carries the full UUID; publishers emit to that room, so
    // a short-id subscriber must be joined under the canonical id, not the
    // short id it supplied.
    const { app, join, channel, get } = makeApp(async () => ({
      session_id: 'ffffffff-1111-2222-3333-444444444444',
    }));
    const service = createSessionStreamsService(app);

    const result = await service.create({ session_id: 'ffffffff' }, {
      connection,
      provider: 'socketio',
    } as never);

    expect(get).toHaveBeenCalledWith('ffffffff', expect.objectContaining({ query: {} }));
    expect(channel).toHaveBeenCalledWith('session-stream:ffffffff-1111-2222-3333-444444444444');
    expect(join).toHaveBeenCalledWith(connection);
    expect(result).toEqual({
      session_id: 'ffffffff-1111-2222-3333-444444444444',
      subscribed: true,
    });
  });

  it('rejects a subscription to an inaccessible session and does not join', async () => {
    const { app, join, get } = makeApp(async () => {
      throw new Error('Forbidden');
    });
    const service = createSessionStreamsService(app);

    await expect(
      service.create({ session_id: 's1' }, { connection, provider: 'socketio' } as never)
    ).rejects.toThrow('Forbidden');
    expect(get).toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('requires a realtime connection', async () => {
    const { app, get } = makeApp(async () => ({ session_id: 's1' }));
    const service = createSessionStreamsService(app);

    await expect(
      service.create({ session_id: 's1' }, { provider: 'rest' } as never)
    ).rejects.toThrow(/realtime connection/);
    expect(get).not.toHaveBeenCalled();
  });

  it('requires a session_id', async () => {
    const { app } = makeApp(async () => ({ session_id: 's1' }));
    const service = createSessionStreamsService(app);

    await expect(service.create({}, { connection, provider: 'socketio' } as never)).rejects.toThrow(
      /session_id/
    );
  });

  it('leaves the per-session channel on unsubscribe', async () => {
    const { app, leave, channel } = makeApp(
      async () => ({ session_id: 's1' }),
      ['session-stream:s1']
    );
    const service = createSessionStreamsService(app);

    const result = await service.remove('s1', { connection, provider: 'socketio' } as never);

    expect(channel).toHaveBeenCalledWith('session-stream:s1');
    expect(leave).toHaveBeenCalledWith(connection);
    expect(result).toEqual({ session_id: 's1', subscribed: false });
  });

  it('unsubscribe skips the resolve round-trip when given a full UUID', async () => {
    const fullId = 'ffffffff-1111-2222-3333-444444444444';
    const { app, leave, channel, get } = makeApp(
      async () => ({ session_id: 's1' }),
      [`session-stream:${fullId}`]
    );
    const service = createSessionStreamsService(app);

    const result = await service.remove(fullId, { connection, provider: 'socketio' } as never);

    // The client already sends the canonical id, so no sessions.get lookup.
    expect(get).not.toHaveBeenCalled();
    expect(channel).toHaveBeenCalledWith(`session-stream:${fullId}`);
    expect(leave).toHaveBeenCalledWith(connection);
    expect(result).toEqual({ session_id: fullId, subscribed: false });
  });

  it('unsubscribe from an absent room does not materialize it', async () => {
    // No existing channels — the room was never joined (or already pruned).
    const fullId = 'ffffffff-1111-2222-3333-444444444444';
    const { app, leave } = makeApp(async () => ({ session_id: fullId }));
    const service = createSessionStreamsService(app);

    const result = await service.remove(fullId, { connection, provider: 'socketio' } as never);

    // The leave path is existence-gated: no channel created, no leave issued.
    expect(leave).not.toHaveBeenCalled();
    expect(app.channels).not.toContain(`session-stream:${fullId}`);
    expect(result).toEqual({ session_id: fullId, subscribed: false });
  });
});
