import type { AgorClient } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSessionMcpServers } from '../utils/sessionMcpServers';
import { cancelAllHydrations, resetHydrationRevisions } from './agorHydration';
import { branchRemoved, mcpServerRemoved, sessionRemoved } from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { setRealtimeAuthorityScope } from './realtimeBatch';
import { sessionMcpCreated, sessionMcpPatched, sessionMcpRemoved } from './sessionMcpActions';
import {
  loadSessionMcpServerIds,
  mergeSessionMcpSnapshot,
  resetSessionMcpLinks,
  sessionMcpPairKey,
} from './sessionMcpLinks';

const AUTHORITY = 'user-a:member:1';

type Row = { session_id: string; mcp_server_id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A client whose `session-mcp-servers.find` answers from a held promise. */
function makeClient() {
  const calls: unknown[] = [];
  const responses: Array<ReturnType<typeof deferred<Row[]>>> = [];
  const nested = { create: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) };
  const client = {
    service: (name: string) => {
      if (name === 'session-mcp-servers') {
        return {
          find: vi.fn((params: unknown) => {
            calls.push(params);
            const response = deferred<Row[]>();
            responses.push(response);
            return response.promise;
          }),
        };
      }
      return nested;
    },
  } as unknown as AgorClient;
  return { client, calls, responses, nested };
}

const never = () => false;

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
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    setRealtimeAuthorityScope(AUTHORITY);
  });
  afterEach(() => {
    setRealtimeAuthorityScope(null);
  });

  it('reads one session, marks it loaded, and deduplicates concurrent reads', async () => {
    const { client, calls, responses } = makeClient();
    const first = loadSessionMcpServerIds(client, 's-1');
    const second = loadSessionMcpServerIds(client, 's-1');
    expect(second).toBe(first);
    expect(calls).toEqual([{ query: { session_id: 's-1' } }]);
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(false);

    responses[0].resolve([{ session_id: 's-1', mcp_server_id: 'a' }]);
    await first;
    expect(agorStore.getState().sessionMcpServerIds.get('s-1')).toEqual(['a']);
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(true);
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
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    setRealtimeAuthorityScope(AUTHORITY);
  });
  afterEach(() => {
    setRealtimeAuthorityScope(null);
  });

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
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    setRealtimeAuthorityScope(AUTHORITY);
  });
  afterEach(() => {
    setRealtimeAuthorityScope(null);
  });

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
