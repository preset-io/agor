import type { Session } from '@agor-live/client';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { deferred, fakeFeathersClient, makeSession, withTestAuthority } from '../test/harness';
import { updateSessionMcpServers } from '../utils/sessionMcpServers';
import { cancelAllHydrations } from './agorHydration';
import {
  branchRemoved,
  mcpServerRemoved,
  sessionCreated,
  sessionRemoved,
} from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { pinRows } from './retention';
import { sessionMcpCreated, sessionMcpPatched, sessionMcpRemoved } from './sessionMcpActions';
import {
  loadSessionMcpServerIds,
  mergeSessionMcpSnapshot,
  resetSessionMcpLinks,
  sessionMcpPairKey,
} from './sessionMcpLinks';

withTestAuthority('user-a:member:1');

type Row = { session_id: string; mcp_server_id: string };

/** A client whose `session-mcp-servers.find` answers from a held promise. */
function makeClient() {
  const responses: Array<ReturnType<typeof deferred<Row[]>>> = [];
  const fake = fakeFeathersClient(
    {
      'session-mcp-servers': {
        find: () => {
          const response = deferred<Row[]>();
          responses.push(response);
          return response.promise;
        },
      },
    },
    { fallback: () => ({}) }
  );
  return {
    client: fake.client,
    calls: () => fake.callsTo('session-mcp-servers', 'find').map((c) => c.args[0]),
    responses,
    nested: fake.client.service('sessions/s-1/mcp-servers') as Record<'create' | 'remove', Mock>,
  };
}

const never = () => false;

/** Seed `s-1` in the store: only a session something holds takes links. */
function holdSession() {
  agorStore
    .getState()
    .setMap(
      'sessionById',
      new Map([['s-1', { session_id: 's-1', branch_id: 'b-1', archived: false } as never]])
    );
}

describe('mergeSessionMcpSnapshot', () => {
  it('takes untouched links from the snapshot and keeps other sessions', () => {
    const prev = new Map([
      ['s-1', ['stale']],
      ['s-2', ['other']],
    ]);
    const next = mergeSessionMcpSnapshot(prev, 's-1', ['a', 'b'], {
      deletedMcpServerIds: new Set(),
      touched: never,
    });
    expect(next.get('s-1')).toEqual(['a', 'b']);
    expect(next.get('s-2')).toEqual(['other']);
  });

  it('keeps a link created or removed live during the read (per-pair fence)', () => {
    // Live: `created` added c, `removed` dropped a; the snapshot predates both.
    const prev = new Map([['s-1', ['c']]]);
    const touched = new Set([sessionMcpPairKey('s-1', 'c'), sessionMcpPairKey('s-1', 'a')]);
    const next = mergeSessionMcpSnapshot(prev, 's-1', ['a', 'b'], {
      deletedMcpServerIds: new Set(),
      touched: (id) => touched.has(id),
    });
    expect(next.get('s-1')).toEqual(['b', 'c']);
  });

  it('keeps a complete selection published live during the read', () => {
    const prev = new Map([['s-1', ['x']]]);
    const next = mergeSessionMcpSnapshot(prev, 's-1', ['a', 'b'], {
      deletedMcpServerIds: new Set(),
      touched: (id) => id === 's-1',
    });
    expect(next).toBe(prev);
  });

  it('drops deleted servers and returns prev when nothing changes', () => {
    const prev = new Map([['s-1', ['a']]]);
    const options = { deletedMcpServerIds: new Set(['gone']), touched: never };
    expect(mergeSessionMcpSnapshot(prev, 's-1', ['a', 'gone'], options)).toBe(prev);
    const cleared = mergeSessionMcpSnapshot(prev, 's-1', ['gone'], options);
    expect(cleared.has('s-1')).toBe(false);
  });
});

describe('loadSessionMcpServerIds', () => {
  beforeEach(holdSession);

  it('reads one session, marks it loaded, and deduplicates concurrent reads', async () => {
    const { client, calls, responses } = makeClient();
    const first = loadSessionMcpServerIds(client, 's-1');
    const second = loadSessionMcpServerIds(client, 's-1');
    expect(second).toBe(first);
    expect(calls()).toEqual([{ query: { session_id: 's-1' } }]);
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(false);

    responses[0].resolve([{ session_id: 's-1', mcp_server_id: 'a' }]);
    await first;
    expect(agorStore.getState().sessionMcpServerIds.get('s-1')).toEqual(['a']);
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(true);
  });

  it('publishes the links and their loaded mark in one update', async () => {
    const { client, responses } = makeClient();
    const split: string[] = [];
    const off = agorStore.subscribe((s) => {
      if (s.sessionMcpServerIds.has('s-1') !== s.sessionMcpLoaded.has('s-1')) split.push('s-1');
    });
    const load = loadSessionMcpServerIds(client, 's-1');
    responses[0].resolve([{ session_id: 's-1', mcp_server_id: 'a' }]);
    await load;
    off();
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(true);
    expect(split).toEqual([]);
  });

  it('applies realtime link events that race the read instead of the older snapshot', async () => {
    const { client, responses } = makeClient();
    const load = loadSessionMcpServerIds(client, 's-1');
    // While the read is in flight: b attached, a detached, a server deleted.
    sessionMcpCreated({ session_id: 's-1', mcp_server_id: 'b' });
    sessionMcpRemoved({ session_id: 's-1', mcp_server_id: 'a' });
    mcpServerRemoved({ mcp_server_id: 'deleted' });
    responses[0].resolve([
      { session_id: 's-1', mcp_server_id: 'a' },
      { session_id: 's-1', mcp_server_id: 'kept' },
      { session_id: 's-1', mcp_server_id: 'deleted' },
    ]);
    await load;
    expect(agorStore.getState().sessionMcpServerIds.get('s-1')).toEqual(['kept', 'b']);
  });

  it('keeps a complete selection patched during the read', async () => {
    const { client, responses } = makeClient();
    const load = loadSessionMcpServerIds(client, 's-1');
    sessionMcpPatched({ session_id: 's-1', mcp_server_ids: ['p'] });
    responses[0].resolve([{ session_id: 's-1', mcp_server_id: 'old' }]);
    await load;
    expect(agorStore.getState().sessionMcpServerIds.get('s-1')).toEqual(['p']);
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(true);
  });

  it('leaves the session unloaded when the read fails', async () => {
    const { client, responses } = makeClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = loadSessionMcpServerIds(client, 's-1');
    responses[0].reject(new Error('boom'));
    await load;
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(false);
    warn.mockRestore();
  });

  it('a read that spans a reset or a cancellation applies nothing', async () => {
    const { client, responses } = makeClient();
    const reset = loadSessionMcpServerIds(client, 's-1');
    resetSessionMcpLinks();
    responses[0].resolve([{ session_id: 's-1', mcp_server_id: 'a' }]);
    await reset;
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionMcpServerIds.has('s-1')).toBe(false);

    const cancelled = loadSessionMcpServerIds(client, 's-2');
    cancelAllHydrations();
    responses[1].resolve([{ session_id: 's-2', mcp_server_id: 'a' }]);
    await cancelled;
    expect(agorStore.getState().sessionMcpLoaded.has('s-2')).toBe(false);
    expect(agorStore.getState().sessionMcpServerIds.has('s-2')).toBe(false);
  });
});

describe('updateSessionMcpServers before the links load', () => {
  beforeEach(holdSession);

  it('refuses a diff for an unloaded session, so nothing it never saw is detached', async () => {
    const { client, responses, nested } = makeClient();
    // An event put one link in the store; a and b are attached on the server.
    sessionMcpCreated({ session_id: 's-1', mcp_server_id: 'c' });
    await expect(updateSessionMcpServers(client, 's-1', [], ['c'])).rejects.toThrow(
      /still loading/
    );
    expect(nested.create).not.toHaveBeenCalled();
    expect(nested.remove).not.toHaveBeenCalled();

    const load = loadSessionMcpServerIds(client, 's-1');
    responses[0].resolve([
      { session_id: 's-1', mcp_server_id: 'a' },
      { session_id: 's-1', mcp_server_id: 'b' },
      { session_id: 's-1', mcp_server_id: 'c' },
    ]);
    await load;
    const current = agorStore.getState().sessionMcpServerIds.get('s-1') ?? [];
    expect(current).toEqual(['a', 'b', 'c']);
    await updateSessionMcpServers(client, 's-1', current, ['a', 'b']);
    expect(nested.remove).toHaveBeenCalledTimes(1);
    expect(nested.remove).toHaveBeenCalledWith('c');
    expect(nested.create).not.toHaveBeenCalled();
  });
});

describe('session MCP links of deleted sessions', () => {
  beforeEach(holdSession);

  const session = (id: string, branchId = 'b-1') =>
    ({ session_id: id, branch_id: branchId, archived: false }) as never;

  it('forgets a removed session: its loaded mark and its link rows', async () => {
    const { client, responses } = makeClient();
    const load = loadSessionMcpServerIds(client, 's-1');
    responses[0].resolve([{ session_id: 's-1', mcp_server_id: 'a' }]);
    await load;
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(true);

    sessionRemoved(session('s-1'));
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionMcpServerIds.has('s-1')).toBe(false);
  });

  it('forgets the sessions of a hard-deleted branch', async () => {
    agorStore.getState().setMap('sessionById', new Map([['s-2', session('s-2', 'b-9')]]));
    const { client, responses } = makeClient();
    const load = loadSessionMcpServerIds(client, 's-2');
    responses[0].resolve([{ session_id: 's-2', mcp_server_id: 'a' }]);
    await load;

    branchRemoved({ branch_id: 'b-9' } as never);
    expect(agorStore.getState().sessionMcpLoaded.has('s-2')).toBe(false);
    expect(agorStore.getState().sessionMcpServerIds.has('s-2')).toBe(false);
  });

  it('applies nothing from a read that lands after its session was deleted', async () => {
    const { client, responses } = makeClient();
    const load = loadSessionMcpServerIds(client, 's-3');
    sessionRemoved(session('s-3'));
    responses[0].resolve([{ session_id: 's-3', mcp_server_id: 'a' }]);
    await load;
    expect(agorStore.getState().sessionMcpLoaded.has('s-3')).toBe(false);
    expect(agorStore.getState().sessionMcpServerIds.has('s-3')).toBe(false);
  });
});

describe('links of sessions nothing holds', () => {
  const other = (id: string) =>
    makeSession(id, 'br-9', { branch_board_id: 'b9', created_by: 'user-b' } as Partial<Session>);

  it('never enter: 100 rejected creates leave no links', () => {
    for (let i = 0; i < 100; i++) {
      sessionCreated(other(`s-${i}`));
      sessionMcpCreated({ session_id: `s-${i}`, mcp_server_id: 'mcp-1' });
      sessionMcpPatched({ session_id: `s-${i}`, mcp_server_ids: ['mcp-2'] });
    }
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(agorStore.getState().sessionMcpServerIds.size).toBe(0);
  });

  it("a held session's links enter, a pinned one's too", () => {
    sessionCreated({ ...other('s-mine'), created_by: 'user-a' } as Session);
    const release = pinRows({ sessions: ['s-open'] });
    sessionMcpCreated({ session_id: 's-mine', mcp_server_id: 'mcp-1' });
    sessionMcpPatched({ session_id: 's-open', mcp_server_ids: ['mcp-2'] });
    expect(agorStore.getState().sessionMcpServerIds.get('s-mine')).toEqual(['mcp-1']);
    expect(agorStore.getState().sessionMcpServerIds.get('s-open')).toEqual(['mcp-2']);
    release();
    expect(agorStore.getState().sessionMcpServerIds.has('s-open')).toBe(false);
  });

  it('a read that lands after its session left applies nothing', async () => {
    const { client, responses } = makeClient();
    const release = pinRows({ sessions: ['s-open'] });
    const load = loadSessionMcpServerIds(client, 's-open');
    release();
    responses[0].resolve([{ session_id: 's-open', mcp_server_id: 'mcp-1' }]);
    await load;
    expect(agorStore.getState().sessionMcpServerIds.has('s-open')).toBe(false);
    expect(agorStore.getState().sessionMcpLoaded.has('s-open')).toBe(false);
  });
});
