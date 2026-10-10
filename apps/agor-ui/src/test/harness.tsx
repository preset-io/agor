/**
 * Shared harness for store, hook and component tests: the realtime authority
 * a test runs under, a fake Feathers client that records every call and
 * answers only what the test says, deferred replies, entity factories, and a
 * provider wrapper for components.
 */
import type {
  AgorClient,
  Board,
  BoardComment,
  BoardEntityObject,
  Branch,
  CardWithType,
  Session,
} from '@agor-live/client';
import { cleanup, render } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { resetHydrationRevisions } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../store/realtimeBatch';

export const ME = 'user-me';
/** The default authority: `ME`, a member, first socket authentication. */
export const AUTHORITY = `${ME}:member:1`;

/** A usable connection, as `App` provides it once the socket authenticated. */
export const CONNECTED = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
} as const;

/**
 * Run every test of the enclosing file or `describe` under `authority`: a
 * fresh store and revision baseline, the realtime queue's authority, and the
 * store's data authority (unless `dataAuthority: false`). Everything is torn
 * down after each test, mounted views first.
 */
export function withTestAuthority(
  authority: string | null = AUTHORITY,
  { dataAuthority = true }: { dataAuthority?: boolean } = {}
): void {
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    discardRealtimeNow();
    setRealtimeAuthorityScope(authority);
    if (authority && dataAuthority) agorStore.getState().setDataAuthority(authority);
    agorStore.getState().setLoading(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    setRealtimeAuthorityScope(null);
    discardRealtimeNow();
    agorStore.getState().reset();
    resetHydrationRevisions();
  });
}

/** A promise and the functions that settle it. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Waiters released together: `wait()` in a reply, `release()` in the test. */
export function gate() {
  const waiters: Array<() => void> = [];
  return {
    wait: () => new Promise<void>((resolve) => waiters.push(resolve)),
    /** Release every reply waiting now. */
    release: () => {
      for (const resolve of waiters.splice(0)) resolve();
    },
    get waiting() {
      return waiters.length;
    },
  };
}

type Method = 'find' | 'findAll' | 'get' | 'create' | 'patch' | 'update' | 'remove';
const METHODS: readonly Method[] = [
  'find',
  'findAll',
  'get',
  'create',
  'patch',
  'update',
  'remove',
];

export interface FakeCall {
  service: string;
  method: Method;
  /** The query exactly as sent (`params.query`, or `find`'s first argument's `query`). */
  query: Record<string, unknown>;
  /** The id of `get`, `patch`, `update` and `remove`. */
  id?: unknown;
  /** The data of `create`, `patch` and `update`. */
  data?: unknown;
  /** The arguments as passed. */
  args: unknown[];
}

/** One method's reply: a value or a promise of it; a throw rejects the call. */
export type FakeReply = (call: FakeCall) => unknown;
export type FakeServices = Record<string, Partial<Record<Method, FakeReply>>>;

type Listener = (payload: unknown) => void;

/**
 * A Feathers client that answers only what `services` says, and records
 * every call with the query it sent: the fake never filters, so a test's
 * reply decides what a missing filter returns. A call without a service
 * reply goes to `fallback`; without one, an unanswered `find` or `findAll`
 * resolves `[]` (the app's background reads must not fail a test) and any
 * other method rejects. `on`/`removeListener` and `io.on`/`io.off` keep
 * listeners for `emit` and `emitIo`.
 */
export function fakeFeathersClient(
  initial: FakeServices = {},
  { fallback }: { fallback?: FakeReply } = {}
) {
  const services: FakeServices = { ...initial };
  const calls: FakeCall[] = [];
  const listeners = new Map<string, Listener[]>();
  const ioListeners = new Map<string, Listener[]>();
  const add = (map: Map<string, Listener[]>, key: string, fn: Listener) =>
    map.set(key, [...(map.get(key) ?? []), fn]);
  const remove = (map: Map<string, Listener[]>, key: string, fn: Listener) =>
    map.set(
      key,
      (map.get(key) ?? []).filter((listener) => listener !== fn)
    );

  const call = async (service: string, method: Method, args: unknown[]): Promise<unknown> => {
    // A versioned full-set read (store/listSync) is a `find` carrying `$sync`.
    // Model it as the `findAll` it stands for (recorded with the plain query,
    // answered by that reply), returned as a page of full rows.
    const syncQuery = (args[0] as { query?: Record<string, unknown> } | undefined)?.query;
    if (method === 'find' && syncQuery && '$sync' in syncQuery) {
      const { $sync: _sync, $skip: _skip, ...query } = syncQuery;
      const result = await call(service, 'findAll', [{ query }]);
      const rows = Array.isArray(result) ? result : ((result as { data?: unknown[] }).data ?? []);
      return {
        total: rows.length,
        limit: rows.length,
        skip: 0,
        data: rows,
        $sync: { versions: '' },
      };
    }
    const withId =
      method === 'get' || method === 'patch' || method === 'update' || method === 'remove';
    const withData = method === 'create' || method === 'patch' || method === 'update';
    const params = (withId ? (withData ? args[2] : args[1]) : withData ? args[1] : args[0]) as
      | { query?: Record<string, unknown> }
      | undefined;
    const record: FakeCall = {
      service,
      method,
      query: params?.query ?? {},
      ...(withId ? { id: args[0] } : {}),
      ...(withData ? { data: withId ? args[1] : args[0] } : {}),
      args,
    };
    calls.push(record);
    const reply = services[service]?.[method];
    if (reply) return reply(record);
    if (fallback) return fallback(record);
    if (method === 'find' || method === 'findAll') return [];
    throw new Error(`fakeFeathersClient: no ${service}.${method} reply`);
  };

  const serviceCache = new Map<string, Record<string, unknown>>();
  const service = (name: string) => {
    let handle = serviceCache.get(name);
    if (!handle) {
      handle = {
        on: (event: string, fn: Listener) => add(listeners, `${name}\u0000${event}`, fn),
        removeListener: (event: string, fn: Listener) =>
          remove(listeners, `${name}\u0000${event}`, fn),
        off: (event: string, fn: Listener) => remove(listeners, `${name}\u0000${event}`, fn),
      };
      for (const method of METHODS) {
        handle[method] = vi.fn((...args: unknown[]) => call(name, method, args));
      }
      serviceCache.set(name, handle);
    }
    return handle;
  };

  const client = {
    service,
    io: {
      on: (event: string, fn: Listener) => add(ioListeners, event, fn),
      off: (event: string, fn: Listener) => remove(ioListeners, event, fn),
      removeListener: (event: string, fn: Listener) => remove(ioListeners, event, fn),
    },
  } as unknown as AgorClient;

  return {
    client,
    /** Every call, in order. */
    calls,
    /** The calls to `service` (and `method`). */
    callsTo: (name: string, method?: Method) =>
      calls.filter((c) => c.service === name && (!method || c.method === method)),
    /** The queries sent to `service` (and `method`). */
    queries: (name: string, method?: Method) =>
      calls
        .filter((c) => c.service === name && (!method || c.method === method))
        .map((c) => c.query),
    /** Answer `service.method` with `reply` from now on. */
    reply: (name: string, method: Method, reply: FakeReply) => {
      services[name] = { ...services[name], [method]: reply };
    },
    /** Deliver a realtime event to the service's listeners. */
    emit: (name: string, event: string, payload?: unknown) => {
      for (const fn of listeners.get(`${name}\u0000${event}`) ?? []) fn(payload);
    },
    /** Deliver a socket event (`connect`, `oauth:completed`, …). */
    emitIo: (event: string, payload?: unknown) => {
      for (const fn of ioListeners.get(event) ?? []) fn(payload);
    },
    listenerCount: (name: string, event: string) =>
      (listeners.get(`${name}\u0000${event}`) ?? []).length,
  };
}

export type FakeFeathersClient = ReturnType<typeof fakeFeathersClient>;

/** A `find` page, as the daemon answers a paginated read. */
export const page = <T,>(data: readonly T[], total = data.length) => ({
  data: [...data],
  total,
  limit: data.length,
  skip: 0,
});

// ── Entity factories ─────────────────────────────────────────────────────
// Minimal rows with the fields the store and selectors read; pass overrides
// for anything a test depends on.

export const BOARD = 'board-1';

export const makeBranch = (id: string, overrides: Partial<Branch> = {}) =>
  ({ branch_id: id, board_id: BOARD, name: id, archived: false, ...overrides }) as Branch;

export const makeSession = (id: string, branchId: string, overrides: Partial<Session> = {}) =>
  ({
    session_id: id,
    branch_id: branchId,
    status: 'idle',
    archived: false,
    title: id,
    genealogy: { children: [] },
    ...overrides,
  }) as unknown as Session;

export const makeBoard = (id: string = BOARD, overrides: Partial<Board> = {}) =>
  ({ board_id: id, name: id, ...overrides }) as Board;

export const makeCard = (id: string, overrides: Partial<CardWithType> = {}) =>
  ({ card_id: id, board_id: BOARD, title: id, ...overrides }) as CardWithType;

export const makeBoardObject = (id: string, overrides: Partial<BoardEntityObject> = {}) =>
  ({ object_id: id, board_id: BOARD, ...overrides }) as BoardEntityObject;

export const makeComment = (id: string, overrides: Partial<BoardComment> = {}) =>
  ({
    comment_id: id,
    board_id: BOARD,
    content: id,
    resolved: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as BoardComment;

// ── Mounting ─────────────────────────────────────────────────────────────

/** The providers a surface needs outside `App`: router, antd and connection. */
export function Providers({
  route = '/',
  connection = CONNECTED,
  children,
}: {
  route?: string;
  connection?: Parameters<typeof ConnectionProvider>[0]['value'];
  children?: ReactNode;
}) {
  return (
    <MemoryRouter initialEntries={[route]}>
      <AntdApp>
        <ConnectionProvider value={connection}>{children}</ConnectionProvider>
      </AntdApp>
    </MemoryRouter>
  );
}

/** Render `ui` inside `Providers`; `rerender` keeps them. */
export function mount(
  ui: ReactElement,
  options: { route?: string; connection?: Parameters<typeof Providers>[0]['connection'] } = {}
) {
  const view = render(<Providers {...options}>{ui}</Providers>);
  return {
    ...view,
    rerender: (next: ReactElement) => view.rerender(<Providers {...options}>{next}</Providers>),
  };
}
