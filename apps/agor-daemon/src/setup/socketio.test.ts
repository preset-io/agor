/**
 * Socket.io terminal-channel authorization tests.
 *
 * Covers the auth/identity boundary on `terminal:*` events and the
 * `user/*\/terminal` channel join. The vulnerability we're testing for:
 *
 *   - An anonymous (or any other-user) socket must NOT be able to inject
 *     keystrokes into another user's web terminal.
 *   - A client-supplied `userId` in an event payload must NEVER be trusted
 *     in place of the socket's authenticated identity.
 *   - `execution.allow_web_terminal: false` must kill terminal:* on the WS
 *     transport, not just on HTTP.
 *   - Only service-token sockets (executor) may emit terminal:output /
 *     terminal:exit / terminal:tab — otherwise a member could spoof output
 *     into another user's terminal or open a Zellij tab in a branch
 *     they don't have RBAC on.
 *   - terminal:input must be rate-limited per-socket.
 *
 * Strategy: build a minimal fake socket / fake io / fake app, run the
 * connection callback, capture the registered handlers, and exercise them
 * directly. Avoids spinning a real socket.io server / port.
 */

import {
  type ResolvedMultiTenancyConfig,
  SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
} from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import {
  type BranchID,
  MAX_PRESENCE_BOARD_SUBSCRIPTIONS,
  PRESENCE_SOCKET_EVENTS,
  type UserID,
} from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeAuthenticatedConnectionAuthority,
  getAuthenticatedConnectionAuthority,
  retireAuthenticatedConnectionAuthority,
} from '../auth/authenticated-connection-authority.js';
import {
  attachExecutorConnectionCandidate,
  getOrCreateExecutorConnectionRevocationFence,
} from '../auth/executor-connection-admission.js';
import {
  boardPresenceAssociationRoomName,
  boardPresenceRoomName,
  HA_AUTHORIZATION_INVALIDATION_EVENT,
  HA_EXECUTOR_TOKEN_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_INVALIDATION_EVENT,
  tenantChannelName,
  tenantUserChannelName,
  terminalChannelName,
} from '../realtime/routing';
import { fingerprintExecutorSessionToken } from '../services/session-token-service';
import type { TerminalAttachmentIdentity } from '../services/terminals';
import { TERMINAL_REQUEST_JOIN_CHANNEL } from '../terminal-socket-connection';
import { FEATHERS_INSTRUMENTATION_REASON } from '../utils/feathers-instrumentation';
import { executorTaskChannelName } from '../utils/realtime-publish';
import {
  configureChannels,
  createSocketIOConfig,
  createTokenBucket,
  getSocketAuthState,
  parseTerminalChannel,
  type SocketIOOptions,
} from './socketio';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSocket {
  id: string;
  feathers?: any;
  data: Record<string, any>;
  handshake: { auth?: { token?: string }; headers?: Record<string, string> };
  connected: boolean;
  joined: Set<string>;
  readonly rooms: Set<string>;
  left: Set<string>;
  /** Events actually delivered TO this socket (models room fanout). */
  received: Array<{ event: string; data: unknown }>;
  handlers: Map<string, (...args: any[]) => any>;
  on(event: string, fn: (...args: any[]) => any): void;
  emit(event: string, data: unknown): void;
  join(channel: string): void | Promise<void>;
  leave(channel: string): void | Promise<void>;
  disconnect(close?: boolean): void;
  broadcast: {
    emit: (event: string, data: unknown) => void;
    to: (channel: string) => {
      emit: (event: string, data: unknown) => void;
      readonly volatile: { emit: (event: string, data: unknown) => void };
    };
  };
  // socket.to(room) — broadcasts to a room EXCLUDING this socket. Mirrors the
  // real socket.io semantics used by the terminal:output relay.
  to: (channel: string) => { emit: (event: string, data: unknown) => void };
  readonly local: {
    to: (channel: string) => { emit: (event: string, data: unknown) => void };
  };
}

interface FakeIO {
  connectionHandler?: (socket: FakeSocket) => void;
  emitted: Array<{ channel: string; event: string; data: unknown }>;
  /** Best-effort packets emitted through Socket.IO's volatile operator. */
  volatileEmitted: Array<{ channel: string; event: string; data: unknown }>;
  /** Sender ids passed through the sender-excluding `socket.to` path. */
  excludedSenders: string[];
  sockets: { sockets: Map<string, FakeSocket> };
  middlewares: Array<(socket: FakeSocket, next: (err?: Error) => void) => void>;
  serverHandlers: Map<string, (...args: any[]) => void>;
  serverSideEmitted: Array<{ event: string; data: unknown }>;
  engine: {
    closeHandler?: () => void;
    once(event: string, fn: () => void): void;
  };
  on(event: string, fn: any): void;
  use(fn: any): void;
  serverSideEmit(event: string, data: unknown): void;
  to(channel: string): { emit: (event: string, data: unknown) => void };
  readonly local: Pick<FakeIO, 'to'>;
}

function makeSocket(id = 'sock1', io?: FakeIO): FakeSocket {
  const handlers = new Map<string, (...args: any[]) => any>();
  const socket: FakeSocket = {
    id,
    data: {},
    handshake: { auth: {}, headers: {} },
    connected: true,
    joined: new Set(),
    get rooms() {
      return new Set([id, ...this.joined]);
    },
    left: new Set(),
    received: [],
    handlers,
    on(event, fn) {
      handlers.set(event, fn);
    },
    emit(event, data) {
      this.received.push({ event, data });
    },
    join(channel) {
      this.joined.add(channel);
    },
    leave(channel) {
      this.left.add(channel);
      this.joined.delete(channel);
    },
    disconnect() {
      this.connected = false;
      this.joined.clear();
      this.handlers.get('disconnect')?.('server namespace disconnect');
    },
    broadcast: {
      emit: (event: string, data: unknown) => {
        io?.emitted.push({ channel: '*', event, data });
      },
      to: (channel: string) => {
        const emit = (event: string, data: unknown) => {
          io?.emitted.push({ channel, event, data });
          deliverToRoom(io, channel, event, data, id);
        };
        return {
          emit,
          get volatile() {
            return {
              emit: (event: string, data: unknown) => {
                io?.volatileEmitted.push({ channel, event, data });
                emit(event, data);
              },
            };
          },
        };
      },
    },
    to: (channel: string) => ({
      emit: (event: string, data: unknown) => {
        io?.emitted.push({ channel, event, data });
        io?.excludedSenders.push(id);
        // socket.to fanout: deliver to every OTHER member of the room.
        deliverToRoom(io, channel, event, data, id);
      },
    }),
    get local() {
      return { to: this.to };
    },
  };
  return socket;
}

/**
 * Fan an emit out to every socket currently joined to `channel`, optionally
 * excluding the sender id (mirrors io.to vs socket.to). Records delivery on
 * each recipient's `received` list so tests can assert real membership-based
 * routing, not just that the emit API was called.
 */
function deliverToRoom(
  io: FakeIO | undefined,
  channel: string,
  event: string,
  data: unknown,
  excludeId?: string
) {
  if (!io) return;
  for (const member of io.sockets.sockets.values()) {
    if (member.id === excludeId) continue;
    if (member.joined.has(channel)) {
      member.received.push({ event, data });
    }
  }
}

function makeIO(): FakeIO {
  const io: FakeIO = {
    emitted: [],
    volatileEmitted: [],
    excludedSenders: [],
    sockets: { sockets: new Map() },
    middlewares: [],
    serverHandlers: new Map(),
    serverSideEmitted: [],
    engine: {
      once(event, fn) {
        if (event === 'close') this.closeHandler = fn;
      },
    },
    on(event, fn) {
      if (event === 'connection') {
        this.connectionHandler = fn;
      } else {
        this.serverHandlers.set(event, fn);
      }
    },
    use(fn) {
      this.middlewares.push(fn);
    },
    serverSideEmit(event, data) {
      this.serverSideEmitted.push({ event, data });
    },
    get local() {
      return this;
    },
    to(channel: string) {
      return {
        emit: (event: string, data: unknown) => {
          io.emitted.push({ channel, event, data });
          // io.to fanout: deliver to EVERY member of the room (no exclusion).
          deliverToRoom(io, channel, event, data);
        },
      };
    },
  };
  return io;
}

function makeApp(multiTenancy?: ResolvedMultiTenancyConfig) {
  // Minimal Application surface used by createSocketIOConfig: app.service('users').get,
  // app.on('login'), and app.emit for the terminal:ready/error relay.
  const eventHandlers = new Map<string, (...args: any[]) => void>();
  const matchesOwnedAttachment = vi.fn(
    (identity: TerminalAttachmentIdentity) =>
      identity.terminalId === TERMINAL &&
      identity.tenantId === 'default' &&
      identity.userId === ALICE &&
      identity.branchId === BRANCH &&
      identity.ownerBootId === 'daemon-a-boot'
  );
  const app = {
    service: (path: string) =>
      path === 'terminals'
        ? { matchesOwnedAttachment }
        : path === 'authentication'
          ? authentication
          : path === 'boards'
            ? {
                get: async (boardId: string) => ({ board_id: boardId, archived: false }),
                find: async (params?: { query?: { board_id?: { $in?: string[] } } }) =>
                  (params?.query?.board_id?.$in ?? []).map((boardId) => ({
                    board_id: boardId,
                    archived: false,
                  })),
              }
            : { get: async (userId: string) => ({ user_id: userId }) },
    on: (event: string, handler: (...args: any[]) => void) => eventHandlers.set(event, handler),
    emit: vi.fn(),
    eventHandlers,
    matchesOwnedAttachment,
  };
  const authentication = {
    async authenticate(
      _data: unknown,
      params: { connection?: { pendingAuthenticationResult?: object } }
    ) {
      const result = params.connection?.pendingAuthenticationResult;
      if (!result) throw new Error('Test handshake authentication result is unavailable');
      return result;
    },
    async handleConnection(_event: 'login', connection: object, result: object) {
      finalizeAuthenticatedConnectionAuthority({ connection, authResult: result, multiTenancy });
    },
  };
  return app;
}

function buildHarness(
  opts: Partial<SocketIOOptions> = {},
  authenticationMultiTenancy: ResolvedMultiTenancyConfig | null = opts.multiTenancy ?? null
) {
  const app = makeApp(authenticationMultiTenancy ?? undefined);
  const io = makeIO();
  const config = createSocketIOConfig(
    app as unknown as Application,
    {
      corsOrigin: '*',
      credentialsAllowed: false,
      webTerminalEnabled: true,
      workIdentity: { instanceId: 'daemon-a', bootId: 'daemon-a-boot' },
      ...opts,
    } as SocketIOOptions
  );
  config.callback(io as any);
  openHarnesses.add(io);
  return { io, config, app };
}

const openHarnesses = new Set<FakeIO>();

afterEach(() => {
  for (const io of openHarnesses) io.engine.closeHandler?.();
  openHarnesses.clear();
});

function connect(io: FakeIO, socket: FakeSocket) {
  io.sockets.sockets.set(socket.id, socket);
  io.connectionHandler?.(socket);
}

function subscribeBoardAssociations(
  socket: FakeSocket,
  boardIds: string[]
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    socket.handlers.get(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations)?.({ boardIds }, resolve);
  });
}

it('binds a server-only terminal subscription capability to the Feathers connection', async () => {
  const { io } = buildHarness();
  const socket = makeSocket('terminal-requester', io);
  asUser(socket, ALICE);
  connect(io, socket);

  const join = socket.feathers?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  expect(join).toBeTypeOf('function');
  expect(
    Object.getOwnPropertyDescriptor(socket.feathers, TERMINAL_REQUEST_JOIN_CHANNEL)?.enumerable
  ).toBe(false);
  const allocation = { userId: ALICE, terminalId: TERMINAL, branchId: BRANCH };
  await expect(join?.(terminalChannel(), allocation)).resolves.toBe(true);
  expect(socket.joined).toContain(terminalChannel());
  expect(socket.received).toContainEqual({ event: 'terminal:allocated', data: allocation });
  await expect(join?.(terminalChannel(ALICE, TERMINAL, 'other-tenant'), allocation)).resolves.toBe(
    false
  );
  await expect(join?.(terminalChannel(), { ...allocation, userId: BOB })).resolves.toBe(false);
  expect(socket.joined).not.toContain(terminalChannel(ALICE, TERMINAL, 'other-tenant'));

  socket.connected = false;
  await expect(join?.(terminalChannel(ALICE, 'other-terminal'), allocation)).resolves.toBe(false);
  expect(socket.joined).not.toContain(terminalChannel(ALICE, 'other-terminal'));
});

it('does not bind a terminal subscription capability to an anonymous socket', () => {
  const { io } = buildHarness();
  const socket = makeSocket('anonymous-terminal-requester', io);
  connect(io, socket);

  expect(socket.feathers?.[TERMINAL_REQUEST_JOIN_CHANNEL]).toBeUndefined();
});

it('evicts stale tenant sockets locally and propagates the eviction across HA replicas', () => {
  const { app, io } = buildHarness({ adapter: {} as never });
  const tenantA = makeSocket('tenant-a-socket', io);
  const tenantB = makeSocket('tenant-b-socket', io);
  asUser(tenantA, ALICE, 'tenant-a');
  asUser(tenantB, BOB, 'tenant-b');
  connect(io, tenantA);
  connect(io, tenantB);

  (app as any).eventHandlers.get('realtime:authorization-invalidated')?.({
    tenantId: 'tenant-a',
  });

  expect(tenantA.connected).toBe(false);
  expect(tenantB.connected).toBe(true);
  expect(io.serverSideEmitted).toContainEqual({
    event: HA_AUTHORIZATION_INVALIDATION_EVENT,
    data: { tenantId: 'tenant-a' },
  });
  expect(app.emit).toHaveBeenCalledWith(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, {
    tenantId: 'tenant-a',
  });

  io.serverHandlers.get(HA_AUTHORIZATION_INVALIDATION_EVENT)?.({ tenantId: 'tenant-b' });
  expect(tenantB.connected).toBe(false);
});

it('clears distributed authorization caches without disconnecting sockets for additive grants', () => {
  const { app, io } = buildHarness({ adapter: {} as never });
  const tenantA = makeSocket('tenant-a-socket', io);
  const tenantB = makeSocket('tenant-b-socket', io);
  asUser(tenantA, ALICE, 'tenant-a');
  asUser(tenantB, BOB, 'tenant-b');
  connect(io, tenantA);
  connect(io, tenantB);

  const invalidation = { tenantId: 'tenant-a', disconnectSockets: false };
  (app as any).eventHandlers.get('realtime:authorization-invalidated')?.(invalidation);

  expect(tenantA.connected).toBe(true);
  expect(tenantB.connected).toBe(true);
  expect(io.serverSideEmitted).toContainEqual({
    event: HA_AUTHORIZATION_INVALIDATION_EVENT,
    data: invalidation,
  });
  expect(app.emit).toHaveBeenCalledWith(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, {
    tenantId: 'tenant-a',
  });
  expect(app.emit).not.toHaveBeenCalledWith(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, {
    tenantId: 'tenant-a',
  });

  io.serverHandlers.get(HA_AUTHORIZATION_INVALIDATION_EVENT)?.({
    tenantId: 'tenant-b',
    disconnectSockets: false,
  });
  expect(tenantB.connected).toBe(true);
  expect(app.emit).toHaveBeenCalledWith(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, {
    tenantId: 'tenant-b',
  });
});

it('fences already-authenticated task executors on local and HA exact revocation', async () => {
  const { app, io } = buildHarness({
    adapter: {} as never,
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    },
  });
  const exactToken = 'executor-token-exact';
  const fence = getOrCreateExecutorConnectionRevocationFence(app);
  const exact = makeSocket('executor-exact', io);
  exact.feathers = {};
  const tenantA = { tenant_id: 'tenant-a', source: 'auth_claim' } as const;
  const exactResult = {
    user: { user_id: ALICE },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-task',
        session_id: 'session-1',
        task_id: 'task-1',
        tenant_id: tenantA.tenant_id,
      },
    },
  };
  attachExecutorConnectionCandidate(exactResult, {
    tenantId: tenantA.tenant_id,
    taskId: 'task-1',
    tokenFingerprint: fingerprintExecutorSessionToken(exactToken),
    revocationGeneration: fence.snapshot(tenantA.tenant_id),
  });
  finalizeAuthenticatedConnectionAuthority({
    connection: exact.feathers,
    authResult: exactResult,
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    },
    executorRevocationFence: fence,
  });
  connect(io, exact);

  (app as any).eventHandlers.get('realtime:executor-token-invalidated')?.({
    tenantId: 'tenant-a',
    tokenFingerprint: fingerprintExecutorSessionToken(exactToken),
  });
  expect(getAuthenticatedConnectionAuthority(exact.feathers)).toBeUndefined();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(exact.connected).toBe(false);
  expect(io.serverSideEmitted).toContainEqual({
    event: HA_EXECUTOR_TOKEN_INVALIDATION_EVENT,
    data: {
      tenantId: 'tenant-a',
      tokenFingerprint: fingerprintExecutorSessionToken(exactToken),
    },
  });

  const session = makeSocket('executor-session', io);
  session.feathers = {};
  const tenantB = { tenant_id: 'tenant-b', source: 'auth_claim' } as const;
  const sessionResult = {
    user: { user_id: BOB },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-task',
        session_id: 'session-2',
        task_id: 'task-2',
        tenant_id: tenantB.tenant_id,
      },
    },
  };
  attachExecutorConnectionCandidate(sessionResult, {
    tenantId: tenantB.tenant_id,
    taskId: 'task-2',
    tokenFingerprint: fingerprintExecutorSessionToken('another-token'),
    revocationGeneration: fence.snapshot(tenantB.tenant_id),
  });
  finalizeAuthenticatedConnectionAuthority({
    connection: session.feathers,
    authResult: sessionResult,
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    },
    executorRevocationFence: fence,
  });
  connect(io, session);

  io.serverHandlers.get(HA_EXECUTOR_TOKEN_INVALIDATION_EVENT)?.({
    tenantId: 'tenant-b',
    tokenFingerprint: fingerprintExecutorSessionToken('another-token'),
  });
  expect(getAuthenticatedConnectionAuthority(session.feathers)).toBeUndefined();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(session.connected).toBe(false);
});

it('does not let a failed concurrent join remove a successful same-generation claim', async () => {
  const { io } = buildHarness();
  const socket = makeSocket('concurrent-terminal-requester', io);
  asUser(socket, ALICE);
  connect(io, socket);
  const join = socket.feathers?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  const channel = terminalChannel();
  const allocation = { userId: ALICE, terminalId: TERMINAL, branchId: BRANCH };
  let releaseFailedJoin!: () => void;
  let markFailedJoinStarted!: () => void;
  const failedJoinGate = new Promise<void>((resolve) => {
    releaseFailedJoin = resolve;
  });
  const failedJoinStarted = new Promise<void>((resolve) => {
    markFailedJoinStarted = resolve;
  });
  const normalJoin = socket.join.bind(socket);
  let terminalJoinCount = 0;
  socket.join = async (candidate) => {
    if (candidate === channel && terminalJoinCount++ === 0) {
      markFailedJoinStarted();
      await failedJoinGate;
      throw new Error('first join failed');
    }
    await normalJoin(candidate);
  };

  const failedAttempt = join?.(channel, allocation);
  await failedJoinStarted;
  const successfulAttempt = join?.(channel, allocation);

  releaseFailedJoin();
  await expect(failedAttempt).resolves.toBe(false);
  await expect(successfulAttempt).resolves.toBe(true);
  expect(socket.joined).toContain(channel);
  expect(socket.received).toContainEqual({ event: 'terminal:allocated', data: allocation });
});

it('does not retry or remove an already-established authorized membership', async () => {
  const { io } = buildHarness();
  const socket = makeSocket('redundant-terminal-requester', io);
  asUser(socket, ALICE);
  connect(io, socket);
  const join = socket.feathers?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  const channel = terminalChannel();
  const allocation = { userId: ALICE, terminalId: TERMINAL, branchId: BRANCH };

  await expect(join?.(channel, allocation)).resolves.toBe(true);
  let redundantLowLevelJoins = 0;
  socket.join = async () => {
    redundantLowLevelJoins += 1;
    throw new Error('redundant join should not run');
  };

  await expect(join?.(channel, allocation)).resolves.toBe(true);
  expect(redundantLowLevelJoins).toBe(0);
  expect(socket.joined).toContain(channel);
  expect(socket.left).not.toContain(channel);
});

async function attachTerminal(io: FakeIO, browser: FakeSocket): Promise<FakeSocket> {
  const join = browser.feathers?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  await join?.(terminalChannel(), { userId: ALICE, terminalId: TERMINAL, branchId: BRANCH });
  const executor = makeSocket('exec-sock', io);
  asServiceForUser(executor, ALICE);
  connect(io, executor);
  executor.handlers.get('join')?.(terminalChannel());
  return executor;
}

// Identity helpers — keep all strings UUID-shaped enough for log slicing.
const ALICE = '11111111-aaaa-aaaa-aaaa-111111111111' as UserID;
const BOB = '22222222-bbbb-bbbb-bbbb-222222222222' as UserID;
const TERMINAL = '33333333-cccc-cccc-cccc-333333333333';
const BRANCH = '44444444-dddd-dddd-dddd-444444444444' as BranchID;

function terminalChannel(userId = ALICE, terminalId = TERMINAL, tenantId = 'default') {
  return terminalChannelName(tenantId, userId, terminalId);
}

function asUser(socket: FakeSocket, userId: string, tenantId = 'default') {
  socket.feathers = { user: { user_id: userId } };
  finalizeAuthenticatedConnectionAuthority({
    connection: socket.feathers,
    authResult: {
      user: { user_id: userId },
      authentication: {
        strategy: 'jwt',
        payload: tenantId === 'default' ? {} : { tenant_id: tenantId },
      },
    },
    multiTenancy:
      tenantId === 'default'
        ? { mode: 'static', static_tenant_id: 'default' as never }
        : {
            mode: 'required_from_auth',
            static_tenant_id: 'default' as never,
            auth_claim: 'tenant_id',
          },
  });
}
function asServiceHandshake(socket: FakeSocket) {
  socket.feathers = {
    user: { user_id: 'executor-service', _isServiceAccount: true },
  };
  finalizeAuthenticatedConnectionAuthority({
    connection: socket.feathers,
    authResult: { user: socket.feathers.user, authentication: { strategy: 'jwt' } },
    multiTenancy: { mode: 'static', static_tenant_id: 'default' as never },
  });
}
function asServicePostConnect(socket: FakeSocket) {
  asServiceHandshake(socket);
}
/**
 * A terminal executor socket: a RESTRICTED identity user-scoped via
 * `terminal_user_id`. Deliberately NOT a full service account (no
 * `_isServiceAccount`) — that's the whole point of the terminal-scoped token.
 * Mirrors what RuntimeJWTStrategy mints for a token carrying terminal_user_id.
 */
function asServiceForUser(
  socket: FakeSocket,
  userId: string,
  terminalId = TERMINAL,
  scope: { branchId?: string; ownerBootId?: string } = {}
) {
  socket.feathers = {
    user: {
      user_id: 'executor-service',
      role: 'terminal-executor',
      _isTerminalExecutor: true,
      terminal_user_id: userId,
      terminal_id: terminalId,
      terminal_branch_id: scope.branchId ?? BRANCH,
      terminal_owner_boot_id: scope.ownerBootId ?? 'daemon-a-boot',
    },
  };
  finalizeAuthenticatedConnectionAuthority({
    connection: socket.feathers,
    authResult: { user: socket.feathers.user, authentication: { strategy: 'jwt' } },
    multiTenancy: { mode: 'static', static_tenant_id: 'default' as never },
  });
}
/** Handshake-token variant of a user-scoped terminal executor socket. */
function asServiceHandshakeForUser(socket: FakeSocket, userId: string, terminalId = TERMINAL) {
  asServiceForUser(socket, userId, terminalId);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseTerminalChannel', () => {
  it('extracts tenant, user, and terminal ids from a well-formed channel', () => {
    expect(parseTerminalChannel(terminalChannel())).toEqual({
      tenantId: 'default',
      userId: ALICE,
      terminalId: TERMINAL,
    });
  });
  it('rejects non-terminal channels', () => {
    expect(parseTerminalChannel('user/abc/other')).toBeNull();
    expect(parseTerminalChannel('foo/abc/terminal')).toBeNull();
    expect(parseTerminalChannel('')).toBeNull();
  });
  it('rejects empty or nested userIds', () => {
    expect(parseTerminalChannel('tenant//user/a/terminal/b')).toBeNull();
    expect(parseTerminalChannel('tenant/t/user/a/terminal/')).toBeNull();
  });
});

describe('Socket.IO transport ceiling', () => {
  it('uses the shared core packet ceiling', () => {
    const { config } = buildHarness();

    expect(SOCKET_IO_MAX_BUFFER_SIZE_BYTES).toBe(1_000_000);
    expect(config.serverOptions).toMatchObject({
      maxHttpBufferSize: SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
    });
  });
});

describe('Socket.IO lifecycle logging', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    debugSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('treats handshake-authorized sockets as authenticated for disconnect metrics', () => {
    vi.useFakeTimers();
    const { io } = buildHarness();
    const socket = makeSocket('authenticated');
    asUser(socket, ALICE);
    connect(io, socket);
    debugSpy.mockClear();
    logSpy.mockClear();

    socket.handlers.get('disconnect')?.('ping timeout');

    expect(logSpy).toHaveBeenCalledWith(
      '🔌 Socket.io disconnected: authenticated (reason: ping timeout, remaining: 0)'
    );
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith('ws_active_connections=0 ws_authentication_failures=0');
  });

  it('emits an unconditional five-minute gauge and stops it when Engine.IO closes', () => {
    vi.useFakeTimers();
    const { io } = buildHarness();

    vi.advanceTimersByTime(5_000);
    expect(logSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60 * 1000 - 5_000);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenLastCalledWith('ws_active_connections=0 ws_authentication_failures=0');

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenLastCalledWith('ws_active_connections=0 ws_authentication_failures=0');

    io.engine.closeHandler?.();
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it.each(['transport close', 'client namespace disconnect'])(
    'keeps benign authenticated disconnect reason %s below info',
    (reason) => {
      const { io } = buildHarness();
      const socket = makeSocket('browser-sock');
      asUser(socket, ALICE);
      connect(io, socket);

      socket.handlers.get('disconnect')?.(reason);

      expect(logSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining(`reason: ${reason}`));
    }
  );

  it('warns on transport errors while retaining ping timeouts at info', () => {
    const { io } = buildHarness();
    const transportErrorSocket = makeSocket('transport-error');
    const pingTimeoutSocket = makeSocket('ping-timeout');
    asUser(transportErrorSocket, ALICE);
    asUser(pingTimeoutSocket, ALICE);
    connect(io, transportErrorSocket);
    connect(io, pingTimeoutSocket);

    transportErrorSocket.handlers.get('disconnect')?.('transport error');
    pingTimeoutSocket.handlers.get('disconnect')?.('ping timeout');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason: transport error'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reason: ping timeout'));
  });

  it('aggregates rejected handshakes and resets each interval', async () => {
    vi.useFakeTimers();
    const { io } = buildHarness();
    const missing = makeSocket('missing');
    const conflicting = makeSocket('conflicting');
    conflicting.handshake.auth = { token: 'auth-token' };
    conflicting.handshake.headers = { authorization: 'Bearer header-token' };

    await new Promise<void>((resolve) => io.middlewares[0]?.(missing, () => resolve()));
    await new Promise<void>((resolve) => io.middlewares[0]?.(conflicting, () => resolve()));

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith('ws_active_connections=0 ws_authentication_failures=2');

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith('ws_active_connections=0 ws_authentication_failures=0');

    io.engine.closeHandler?.();
    const logCountAfterClose = logSpy.mock.calls.length;
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenCalledTimes(logCountAfterClose);
  });
});

describe('getSocketAuthState', () => {
  it('reports user auth from immutable connection authority', () => {
    const s = makeSocket();
    asUser(s, ALICE);
    expect(getSocketAuthState(s as any)).toEqual({
      userId: ALICE,
      isService: false,
      tenant: { tenant_id: 'default', source: 'static' },
    });
  });
  it('reports full service authority', () => {
    const s = makeSocket();
    asServiceHandshake(s);
    expect(getSocketAuthState(s as any)).toEqual({
      userId: null,
      isService: true,
      tenant: { tenant_id: 'default', source: 'static' },
    });
  });
  it('does not derive service authority from mutable socket data', () => {
    const s = makeSocket();
    asServicePostConnect(s);
    expect(getSocketAuthState(s as any)).toEqual({
      userId: null,
      isService: true,
      tenant: { tenant_id: 'default', source: 'static' },
    });
  });
  it('reports a terminal-scoped identity as service-for-terminal WITH its terminalUserId', () => {
    const s = makeSocket();
    asServiceForUser(s, ALICE);
    expect(getSocketAuthState(s as any)).toEqual({
      userId: null,
      isService: true,
      tenant: { tenant_id: 'default', source: 'static' },
      terminalUserId: ALICE,
      terminalId: TERMINAL,
      terminalBranchId: BRANCH,
      terminalOwnerBootId: 'daemon-a-boot',
    });
  });
  it('a terminal-scoped identity carries no _isServiceAccount (no REST RBAC bypass)', () => {
    // The whole point of the terminal token: it authenticates the socket for
    // its own channel but is NOT a full service account, so the RBAC-bypass
    // hooks (which read user._isServiceAccount) never fire for it.
    const s = makeSocket();
    asServiceForUser(s, ALICE);
    const user = (s.feathers as { user: { _isServiceAccount?: boolean; role?: string } }).user;
    expect(user._isServiceAccount).toBeUndefined();
    expect(user.role).not.toBe('service');
  });
  it('service account wins over user_id: synthetic executor user is not treated as a real user', () => {
    // The synthetic service user carries user_id='executor-service'. If we
    // checked user_id first, we'd treat that as a real user and allow
    // terminal:input/resize (which are disallowed for service sockets).
    const s = makeSocket();
    asServicePostConnect(s);
    const auth = getSocketAuthState(s as any);
    expect(auth.userId).toBeNull();
    expect(auth.isService).toBe(true);
  });
  it('reports unauthenticated when no markers are present', () => {
    const s = makeSocket();
    expect(getSocketAuthState(s as any)).toEqual({ userId: null, isService: false });
  });
  it('treats an empty feathers object without isService as anonymous', () => {
    // Defends against confusing service ↔ "feathers attached but no user yet".
    const s = makeSocket();
    s.feathers = {};
    const auth = getSocketAuthState(s as any);
    expect(auth.userId).toBeNull();
    expect(auth.isService).toBe(false);
  });
});

describe('createTokenBucket', () => {
  it('allows up to capacity immediately, then rejects until refill', () => {
    let now = 0;
    const limit = createTokenBucket(3, 1, () => now);
    expect(limit()).toBe(true);
    expect(limit()).toBe(true);
    expect(limit()).toBe(true);
    expect(limit()).toBe(false); // capacity exhausted
    now += 1000; // +1 token
    expect(limit()).toBe(true);
    expect(limit()).toBe(false);
  });

  it('caps refilled tokens at capacity', () => {
    let now = 0;
    const limit = createTokenBucket(2, 1, () => now);
    expect(limit()).toBe(true);
    expect(limit()).toBe(true);
    now += 1_000_000; // would refill far past capacity
    expect(limit()).toBe(true);
    expect(limit()).toBe(true);
    expect(limit()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handshake authentication transport boundary
// ---------------------------------------------------------------------------

describe('Socket.IO handshake credential extraction', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects a missing bearer before accepting the namespace connection', async () => {
    const { io } = buildHarness();
    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(makeSocket('missing-bearer', io), resolve)
    );
    expect(error).toMatchObject({
      message: 'Invalid or expired authentication token',
      data: { code: 401, className: 'not-authenticated' },
    });
  });

  it('rejects conflicting auth-object and Authorization-header credentials', async () => {
    const { io } = buildHarness();
    const socket = makeSocket('conflicting-credentials', io);
    socket.handshake.auth = { token: 'auth-object-token' };
    socket.handshake.headers = { authorization: 'Bearer header-token' };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error).toMatchObject({
      message: 'Invalid or expired authentication token',
      data: { code: 401, className: 'not-authenticated' },
    });
  });

  it('accepts an Authorization bearer through the normalized namespace boundary', async () => {
    const { io } = buildHarness();
    const socket = makeSocket('header-credential', io);
    socket.handshake.headers = { authorization: 'Bearer signed-token' };
    socket.feathers = {
      pendingAuthenticationResult: {
        user: { user_id: ALICE },
        authentication: {
          strategy: 'jwt',
          payload: { exp: (Date.now() + 60_000) / 1000 },
        },
      },
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error).toBeUndefined();
    expect(getAuthenticatedConnectionAuthority(socket.feathers)).toMatchObject({
      principal: { kind: 'user', userId: ALICE },
    });
  });

  it('rejects an authority missing tenant scope on a tenant-aware daemon', async () => {
    const { io } = buildHarness(
      { multiTenancy: { mode: 'static', static_tenant_id: 'default' as never } },
      null
    );
    const socket = makeSocket('unscoped-authority', io);
    socket.handshake.auth = { token: 'signed-token' };
    socket.feathers = {
      pendingAuthenticationResult: {
        user: { user_id: ALICE },
        authentication: { strategy: 'jwt', payload: {} },
      },
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error).toMatchObject({
      message: 'Invalid or expired authentication token',
      data: { code: 401, className: 'not-authenticated' },
    });
    expect(getAuthenticatedConnectionAuthority(socket.feathers)).toBeUndefined();
  });

  it('rejects a signed connection authority without a bounded expiry', async () => {
    const { io } = buildHarness({
      multiTenancy: { mode: 'static', static_tenant_id: 'default' as never },
    });
    const socket = makeSocket('unbounded-authority', io);
    socket.handshake.auth = { token: 'signed-token' };
    socket.feathers = {
      pendingAuthenticationResult: {
        user: { user_id: ALICE },
        authentication: { strategy: 'jwt', payload: {} },
      },
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error).toMatchObject({
      message: 'Invalid or expired authentication token',
      data: { code: 401, className: 'not-authenticated' },
    });
    expect(getAuthenticatedConnectionAuthority(socket.feathers)).toBeUndefined();
  });

  it('keeps ordinary user authority across routine access-token expiry', async () => {
    vi.useFakeTimers();
    const { io } = buildHarness();
    const socket = makeSocket('expiring-authority', io);
    socket.handshake.auth = { token: 'signed-token' };
    socket.feathers = {
      pendingAuthenticationResult: {
        user: { user_id: ALICE },
        authentication: {
          strategy: 'jwt',
          payload: { exp: (Date.now() + 1_000) / 1000 },
        },
      },
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );
    expect(error).toBeUndefined();
    connect(io, socket);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(socket.connected).toBe(true);
    expect(getAuthenticatedConnectionAuthority(socket.feathers)).toMatchObject({
      principal: { kind: 'user', userId: ALICE },
      retireAtExpiry: false,
    });
  });

  it('retires impersonated user authority at the verified JWT expiry', async () => {
    vi.useFakeTimers();
    const { io } = buildHarness({
      multiTenancy: { mode: 'static', static_tenant_id: 'default' as never },
    });
    const socket = makeSocket('expiring-impersonation', io);
    const observer = makeSocket('expiry-observer', io);
    asUser(observer, BOB);
    connect(io, observer);
    await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({ ok: true });
    socket.handshake.auth = { token: 'signed-impersonation-token' };
    socket.feathers = {
      pendingAuthenticationResult: {
        user: { user_id: ALICE },
        authentication: {
          strategy: 'jwt',
          payload: { exp: (Date.now() + 1_000) / 1000, is_impersonated: true },
        },
      },
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );
    expect(error).toBeUndefined();
    connect(io, socket);
    await expect(subscribeBoardAssociations(socket, ['board-1'])).resolves.toEqual({ ok: true });
    socket.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
    expect(observer.received).toContainEqual({
      event: PRESENCE_SOCKET_EVENTS.updated,
      data: expect.objectContaining({ userId: ALICE, boardId: 'board-1' }),
    });
    observer.received.length = 0;

    await vi.advanceTimersByTimeAsync(1_001);

    expect(socket.connected).toBe(false);
    expect(getAuthenticatedConnectionAuthority(socket.feathers)).toBeUndefined();
    expect(observer.received).toContainEqual({
      event: PRESENCE_SOCKET_EVENTS.left,
      data: expect.objectContaining({ userId: ALICE, boardId: 'board-1' }),
    });
  });
});

// ---------------------------------------------------------------------------
// Handler authorization
// ---------------------------------------------------------------------------

describe('terminal:* handler authorization', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe('terminal:input', () => {
    it('rejects anonymous sockets', () => {
      const { io } = buildHarness();
      const s = makeSocket('anon');
      connect(io, s);
      s.handlers.get('terminal:input')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        input: 'rm -rf ~\r',
      });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('terminal:input rejected'));
    });

    it('rejects when payload userId does not match authed user (impersonation)', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      // Alice forges Bob's userId — must be rejected.
      s.handlers.get('terminal:input')?.({ userId: BOB, terminalId: TERMINAL, input: ': pwn\r' });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not match'));
    });

    it('accepts and re-emits with the AUTHED userId when payload matches', async () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      await attachTerminal(io, s);
      s.handlers.get('terminal:input')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        input: 'echo hi\r',
      });
      expect(io.emitted).toEqual([
        {
          channel: 'exec-sock',
          event: 'terminal:input',
          // The handler must re-emit with the trusted userId (not whatever
          // the client sent), so executors never see attacker-controlled ids.
          data: { userId: ALICE, terminalId: TERMINAL, input: 'echo hi\r' },
        },
      ]);
    });

    it('rejects when allow_web_terminal is false', async () => {
      const { io } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      await attachTerminal(io, s);
      s.handlers.get('terminal:input')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        input: 'echo hi\r',
      });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('web terminal disabled'));
    });

    it('rate-limits per socket (drops events past the burst cap)', async () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      await attachTerminal(io, s);
      // Burst = 1000 tokens. Fire 1500 events back-to-back; expect ~1000
      // through, the rest dropped. Use ≤1000 / ≥500 bounds to allow tiny
      // wall-clock refill during the loop without making the test flaky.
      for (let i = 0; i < 1500; i++) {
        s.handlers.get('terminal:input')?.({ userId: ALICE, terminalId: TERMINAL, input: 'x' });
      }
      expect(io.emitted.length).toBeLessThanOrEqual(1100);
      expect(io.emitted.length).toBeGreaterThanOrEqual(900);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rate limit exceeded'));
    });
  });

  describe('terminal:resize', () => {
    it('rejects when payload userId does not match authed user', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:resize')?.({ userId: BOB, terminalId: TERMINAL, cols: 1, rows: 1 });
      expect(io.emitted).toEqual([]);
    });

    it('accepts when payload userId matches authed user', async () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      await attachTerminal(io, s);
      s.handlers.get('terminal:resize')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        cols: 80,
        rows: 24,
      });
      expect(io.emitted).toEqual([
        {
          channel: 'exec-sock',
          event: 'terminal:resize',
          data: { userId: ALICE, terminalId: TERMINAL, cols: 80, rows: 24 },
        },
      ]);
    });
  });

  describe('terminal:output / terminal:exit / terminal:tab (executor-only)', () => {
    it.each(['terminal:output', 'terminal:exit', 'terminal:tab'])(
      '%s rejects user-token sockets (only service may emit)',
      (event) => {
        const { io } = buildHarness();
        const s = makeSocket('alice-sock');
        asUser(s, ALICE);
        connect(io, s);
        // Even an authenticated user must not be able to spoof these — a
        // forged terminal:output could fake a "permission granted" prompt
        // into another user's terminal, etc.
        s.handlers.get(event)?.({
          userId: ALICE,
          data: 'x',
          exitCode: 0,
          action: 'create',
          tabName: 't',
        });
        expect(io.emitted).toEqual([]);
      }
    );

    it('terminal:output accepts handshake-authenticated, user-scoped service sockets and relays', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock', io);
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      s.handlers.get('terminal:output')?.({ userId: ALICE, terminalId: TERMINAL, data: 'hello' });
      expect(io.emitted).toEqual([
        {
          channel: terminalChannel(),
          event: 'terminal:output',
          data: { userId: ALICE, terminalId: TERMINAL, data: 'hello' },
        },
      ]);
    });

    it('terminal:output excludes the sending executor socket from the broadcast', () => {
      // The executor joins its own `user/<id>/terminal` channel; relaying via
      // `io.to` would echo every output frame back to it. The handler must use
      // `socket.to` so the sender is excluded.
      const { io } = buildHarness();
      const s = makeSocket('exec-sock', io);
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      s.handlers.get('terminal:output')?.({ userId: ALICE, terminalId: TERMINAL, data: 'hello' });
      expect(io.emitted).toEqual([
        {
          channel: terminalChannel(),
          event: 'terminal:output',
          data: { userId: ALICE, terminalId: TERMINAL, data: 'hello' },
        },
      ]);
      expect(io.excludedSenders).toEqual(['exec-sock']);
    });

    it('terminal:output reaches every other room member but not the sending executor', () => {
      // Model the real topology: the executor and two browser tabs are all
      // joined to `user/<id>/terminal`. The relay must reach both browsers
      // while excluding the executor that produced the output.
      const { io } = buildHarness();
      const channel = terminalChannel();

      const exec = makeSocket('exec-sock', io);
      asServiceForUser(exec, ALICE);
      connect(io, exec);
      exec.handlers.get('join')?.(channel);

      const browserA = makeSocket('browser-a', io);
      asUser(browserA, ALICE);
      connect(io, browserA);
      browserA.join(channel);

      const browserB = makeSocket('browser-b', io);
      asUser(browserB, ALICE);
      connect(io, browserB);
      browserB.join(channel);

      exec.handlers.get('terminal:output')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        data: 'hello',
      });

      const frame = {
        event: 'terminal:output',
        data: { userId: ALICE, terminalId: TERMINAL, data: 'hello' },
      };
      expect(browserA.received).toEqual([frame]);
      expect(browserB.received).toEqual([frame]);
      // The executor is a member of the room but must NOT receive its own output.
      expect(exec.received).toEqual([]);
    });

    it('terminal:output also accepts user-scoped handshake-token service sockets', () => {
      // Separately covers the fast-path: service token presented at handshake.
      const { io } = buildHarness();
      const s = makeSocket('exec-sock', io);
      asServiceHandshakeForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      s.handlers.get('terminal:output')?.({ userId: ALICE, terminalId: TERMINAL, data: 'hi' });
      expect(io.emitted).toEqual([
        {
          channel: terminalChannel(),
          event: 'terminal:output',
          data: { userId: ALICE, terminalId: TERMINAL, data: 'hi' },
        },
      ]);
    });

    it("a user-scoped executor may not emit output/tab for a different user's channel", () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:output')?.({ userId: BOB, terminalId: TERMINAL, data: 'x' });
      s.handlers.get('terminal:tab')?.({ userId: BOB, action: 'create', tabName: 't' });
      expect(io.emitted).toEqual([]);
    });

    it('an UNSCOPED service token may not forge output/exit/tab for any user', () => {
      // Closes the "enforce-if-present" bypass: a generic service token with no
      // terminal_user_id can no longer supply a victim userId on these events.
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServicePostConnect(s); // service, but no terminal scope
      connect(io, s);
      s.handlers.get('terminal:output')?.({ userId: ALICE, terminalId: TERMINAL, data: 'x' });
      s.handlers.get('terminal:exit')?.({ userId: ALICE, terminalId: TERMINAL, exitCode: 0 });
      s.handlers.get('terminal:tab')?.({ userId: ALICE, action: 'create', tabName: 't' });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('terminal executor is not scoped to a user')
      );
    });

    it('all three reject when allow_web_terminal is false even for service sockets', () => {
      const { io } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('exec-sock');
      asServicePostConnect(s);
      connect(io, s);
      s.handlers.get('terminal:output')?.({ userId: ALICE, terminalId: TERMINAL, data: 'x' });
      s.handlers.get('terminal:exit')?.({ userId: ALICE, terminalId: TERMINAL, exitCode: 0 });
      s.handlers.get('terminal:tab')?.({ userId: ALICE, action: 'create', tabName: 't' });
      expect(io.emitted).toEqual([]);
    });

    it('rejects events from a stale duplicate after a replacement executor joins', () => {
      const { io, app } = buildHarness();
      const stale = makeSocket('stale-executor', io);
      asServiceForUser(stale, ALICE);
      connect(io, stale);
      stale.handlers.get('join')?.(terminalChannel());

      const replacement = makeSocket('replacement-executor', io);
      asServiceForUser(replacement, ALICE);
      connect(io, replacement);
      replacement.handlers.get('join')?.(terminalChannel());
      expect(stale.joined.has(terminalChannel())).toBe(false);
      expect(io.emitted).toContainEqual({
        channel: 'stale-executor',
        event: 'terminal:shutdown',
        data: { terminalId: TERMINAL, userId: ALICE },
      });

      io.emitted.length = 0;
      app.emit.mockClear();
      stale.handlers.get('terminal:exit')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        exitCode: 0,
      });
      expect(app.emit).not.toHaveBeenCalled();
      expect(io.emitted).toEqual([]);

      replacement.handlers.get('terminal:ready')?.({
        userId: ALICE,
        terminalId: TERMINAL,
      });
      expect(app.emit).toHaveBeenCalledWith('terminal:ready', {
        userId: ALICE,
        terminalId: TERMINAL,
      });
    });
  });

  describe('terminal:ready / terminal:error (executor readiness acks)', () => {
    it('relays a user-scoped service socket ready ack to the app', () => {
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      s.handlers.get('terminal:ready')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        sessionName: 'agor-x',
        tabName: 't',
      });
      expect(app.emit).toHaveBeenCalledWith('terminal:ready', {
        userId: ALICE,
        terminalId: TERMINAL,
        sessionName: 'agor-x',
        tabName: 't',
      });
    });

    it('relays a user-scoped service socket error ack to the app', () => {
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      s.handlers.get('terminal:error')?.({ userId: ALICE, terminalId: TERMINAL, message: 'boom' });
      expect(app.emit).toHaveBeenCalledWith('terminal:error', {
        userId: ALICE,
        terminalId: TERMINAL,
        message: 'boom',
      });
    });

    it("rejects an executor scoped to ALICE flipping BOB's readiness (cross-user forgery)", () => {
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: BOB, terminalId: TERMINAL });
      s.handlers.get('terminal:error')?.({ userId: BOB, terminalId: TERMINAL, message: 'spoof' });
      expect(app.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('may not act for'));
    });

    it('rejects ready/error from an unscoped service token (requireScope)', () => {
      // A generic (non-terminal) service token carries no terminal_user_id and
      // therefore may not drive per-user readiness state.
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServicePostConnect(s);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: ALICE, terminalId: TERMINAL });
      s.handlers.get('terminal:error')?.({ userId: ALICE, terminalId: TERMINAL });
      expect(app.emit).not.toHaveBeenCalled();
    });

    it('rejects ready/error acks from user-token sockets (only service may emit)', () => {
      const { io, app } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: ALICE, terminalId: TERMINAL });
      s.handlers.get('terminal:error')?.({ userId: ALICE, terminalId: TERMINAL, message: 'spoof' });
      expect(app.emit).not.toHaveBeenCalled();
    });

    it('rejects ready/error acks when allow_web_terminal is false', () => {
      const { io, app } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: ALICE, terminalId: TERMINAL });
      s.handlers.get('terminal:error')?.({ userId: ALICE, terminalId: TERMINAL });
      expect(app.emit).not.toHaveBeenCalled();
    });
  });

  describe('join / leave', () => {
    it('rejects unauthenticated joins', () => {
      const { io } = buildHarness();
      const s = makeSocket('anon');
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.size).toBe(0);
    });

    it('does not expose executor control rooms through the client join event', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      const room = executorTaskChannelName('tenant-a', 'task-1');

      s.handlers.get('join')?.(room);

      expect(s.joined.has(room)).toBe(false);
    });

    it("rejects a user joining another user's terminal channel", () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      // Authed users are auto-joined to `user:<id>` presence room on
      // connect — assert specifically that the terminal channel is NOT
      // joined rather than `joined.size === 0`.
      s.handlers.get('join')?.(terminalChannel(BOB));
      expect(s.joined.has(terminalChannel(BOB))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('join rejected'));
    });

    it('rejects a browser raw-joining even its own previously known terminal channel', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.has(terminalChannel())).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('browser terminal joins require an authorized allocation')
      );
    });

    it('rejects the same user and terminal id in another tenant', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      const otherTenant = terminalChannel(ALICE, TERMINAL, 'tenant-b');
      s.handlers.get('join')?.(otherTenant);
      expect(s.joined.has(otherTenant)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tenant does not match'));
    });

    it('allows a user-scoped executor to join ONLY its own user terminal channel', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      s.handlers.get('join')?.(terminalChannel(BOB));
      expect(s.joined.has(terminalChannel())).toBe(true);
      // Scoped to ALICE — must NOT be able to join BOB's channel and harvest
      // his terminal traffic.
      expect(s.joined.has(terminalChannel(BOB))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scope or owner boot fence'));
    });

    it('rejects an executor capability minted by a previous daemon boot', () => {
      const { io } = buildHarness();
      const s = makeSocket('stale-executor');
      asServiceForUser(s, ALICE, TERMINAL, { ownerBootId: 'old-boot' });
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.has(terminalChannel())).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('owner boot fence'));
    });

    it('rejects an executor capability for a different branch attachment', () => {
      const { io } = buildHarness();
      const s = makeSocket('wrong-branch-executor');
      asServiceForUser(s, ALICE, TERMINAL, { branchId: 'other-branch' });
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.has(terminalChannel())).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('live attachment'));
    });

    it('rejects executor reconnect after the local attachment is retired', () => {
      const { io, app } = buildHarness();
      const original = makeSocket('original-executor', io);
      asServiceForUser(original, ALICE);
      connect(io, original);
      original.handlers.get('join')?.(terminalChannel());

      app.matchesOwnedAttachment.mockReturnValue(false);
      app.eventHandlers.get('terminal:shutdown-local')?.({
        terminalId: TERMINAL,
        userId: ALICE,
      });

      const reconnect = makeSocket('reconnecting-executor', io);
      asServiceForUser(reconnect, ALICE);
      connect(io, reconnect);
      reconnect.handlers.get('join')?.(terminalChannel());
      expect(reconnect.joined.has(terminalChannel())).toBe(false);

      io.emitted.length = 0;
      original.handlers.get('terminal:output')?.({
        userId: ALICE,
        terminalId: TERMINAL,
        data: 'stale',
      });
      expect(io.emitted).toEqual([]);
    });

    it('rejects a join from an unscoped service token entirely', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServicePostConnect(s); // service, no terminal scope
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.has(terminalChannel())).toBe(false);
    });

    it('rejects join when allow_web_terminal is false', () => {
      const { io } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.has(terminalChannel())).toBe(false);
    });

    it("rejects a user leaving another user's terminal channel", () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('leave')?.(terminalChannel(BOB));
      expect(s.left.size).toBe(0);
    });

    it('rejects arbitrary adapter-room leaves outside the terminal protocol', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      const foreignTenantRoom = tenantChannelName('tenant-b');
      s.handlers.get('leave')?.(foreignTenantRoom);
      expect(s.left.has(foreignTenantRoom)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid terminal channel'));
    });
  });

  describe('cursor presence routing', () => {
    it('does not deliver the same board id across tenant rooms', async () => {
      const { io } = buildHarness();
      const tenantA = makeSocket('tenant-a', io);
      const tenantB = makeSocket('tenant-b', io);
      asUser(tenantA, ALICE, 'tenant-a');
      asUser(tenantB, BOB, 'tenant-b');
      connect(io, tenantA);
      connect(io, tenantB);
      await tenantA.handlers.get('presence:watch-board')?.('shared-board-id');
      await tenantB.handlers.get('presence:watch-board')?.('shared-board-id');

      tenantA.handlers.get('cursor-move')?.({
        boardId: 'shared-board-id',
        x: 1,
        y: 2,
        timestamp: 1,
      });

      expect(tenantB.received).not.toContainEqual(
        expect.objectContaining({ event: 'cursor-moved' })
      );
      expect(tenantA.joined).toContain(boardPresenceRoomName('tenant-a', 'shared-board-id'));
      expect(tenantB.joined).toContain(boardPresenceRoomName('tenant-b', 'shared-board-id'));
    });

    it('joins and leaves board presence rooms explicitly', async () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock', io);
      asUser(s, ALICE);
      connect(io, s);

      await s.handlers.get('presence:watch-board')?.('board-1');
      expect(s.joined.has(boardPresenceRoomName('default', 'board-1'))).toBe(true);

      s.handlers.get('presence:unwatch-board')?.('board-1');
      expect(s.left.has(boardPresenceRoomName('default', 'board-1'))).toBe(true);
    });

    it('routes cursor-moved only to the active board room and emits a lightweight global presence update', async () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock', io);
      asUser(s, ALICE);
      connect(io, s);
      await s.handlers.get('presence:watch-board')?.('board-1');

      s.handlers.get('cursor-move')?.({
        boardId: 'board-1',
        x: 10,
        y: 20,
        timestamp: 1_000,
      });

      expect(io.emitted).toContainEqual({
        channel: boardPresenceRoomName('default', 'board-1'),
        event: 'cursor-moved',
        data: {
          userId: ALICE,
          presenceId: expect.any(String),
          boardId: 'board-1',
          x: 10,
          y: 20,
          timestamp: expect.any(Number),
        },
      });
      expect(io.volatileEmitted).toContainEqual(
        expect.objectContaining({
          channel: boardPresenceRoomName('default', 'board-1'),
          event: PRESENCE_SOCKET_EVENTS.cursorMoved,
        })
      );

      expect(io.emitted).toContainEqual({
        channel: tenantChannelName('default'),
        event: 'presence-updated',
        data: {
          userId: ALICE,
          presenceId: expect.any(String),
          timestamp: expect.any(Number),
        },
      });
    });

    it('coalesces global presence updates but still streams per-board cursor movement', async () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock', io);
      asUser(s, ALICE);
      connect(io, s);
      await s.handlers.get('presence:watch-board')?.('board-1');

      s.handlers.get('cursor-move')?.({
        boardId: 'board-1',
        x: 10,
        y: 20,
        timestamp: 1_000,
      });
      s.handlers.get('cursor-move')?.({
        boardId: 'board-1',
        x: 30,
        y: 40,
        timestamp: 5_000,
      });

      expect(
        io.emitted.filter(
          (entry) =>
            entry.event === 'presence-updated' && entry.channel === tenantChannelName('default')
        )
      ).toHaveLength(1);
      expect(
        io.emitted.filter(
          (entry) =>
            entry.event === 'cursor-moved' &&
            entry.channel === boardPresenceRoomName('default', 'board-1')
        )
      ).toHaveLength(2);
    });

    it('does no Feathers or database work for accepted cursor samples after admission', async () => {
      const { app, io } = buildHarness();
      const originalService = (app as any).service;
      const boardGet = vi.fn(async (boardId: string) => ({ board_id: boardId, archived: false }));
      const boardFind = vi.fn();
      const service = vi.fn((path: string) =>
        path === 'boards' ? { get: boardGet, find: boardFind } : originalService(path)
      );
      (app as any).service = service;
      const publisher = makeSocket('cheap-cursor-publisher', io);
      asUser(publisher, ALICE);
      connect(io, publisher);

      await publisher.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      expect(boardGet).toHaveBeenCalledOnce();
      service.mockClear();
      boardGet.mockClear();

      for (let index = 0; index < 20; index++) {
        publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
          boardId: 'board-1',
          x: index,
          y: index,
        });
      }

      expect(service).not.toHaveBeenCalled();
      expect(boardGet).not.toHaveBeenCalled();
      expect(boardFind).not.toHaveBeenCalled();
      expect(
        io.volatileEmitted.filter((entry) => entry.event === PRESENCE_SOCKET_EVENTS.cursorMoved)
      ).toHaveLength(20);
    });

    it('never derives a navbar board association from cursor-only authorization', async () => {
      const { io } = buildHarness();
      const publisher = makeSocket('cursor-only-publisher', io);
      const observer = makeSocket('association-observer', io);
      asUser(publisher, ALICE);
      asUser(observer, BOB);
      connect(io, publisher);
      connect(io, observer);
      await publisher.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({
        ok: true,
      });

      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
        boardId: 'board-1',
        x: 10,
        y: 20,
      });

      expect(observer.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.updated,
        data: expect.objectContaining({ userId: ALICE }),
      });
      expect(
        observer.received.filter(
          (entry) =>
            entry.event === PRESENCE_SOCKET_EVENTS.updated &&
            (entry.data as { boardId?: string }).boardId !== undefined
        )
      ).toEqual([]);
    });

    it('treats acknowledgement arguments as untrusted wire data', async () => {
      const { io } = buildHarness();
      const socket = makeSocket('invalid-ack', io);
      asUser(socket, ALICE);
      connect(io, socket);

      expect(() =>
        socket.handlers.get(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations)?.(
          { boardIds: 'not-an-array' },
          {}
        )
      ).not.toThrow();
      await expect(
        socket.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('', {})
      ).resolves.toBeUndefined();
    });

    it('publishes board identity only after separate publisher and subscriber authorization', async () => {
      const { io } = buildHarness();
      const publisher = makeSocket('publisher', io);
      const authorized = makeSocket('authorized', io);
      const tenantOnly = makeSocket('tenant-only', io);
      const foreignTenant = makeSocket('foreign-tenant', io);
      asUser(publisher, ALICE, 'tenant-a');
      asUser(authorized, BOB, 'tenant-a');
      asUser(tenantOnly, '33333333-cccc-4ccc-8ccc-333333333333', 'tenant-a');
      asUser(foreignTenant, BOB, 'tenant-b');
      for (const socket of [publisher, authorized, tenantOnly, foreignTenant]) connect(io, socket);

      await publisher.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      await expect(subscribeBoardAssociations(publisher, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      await expect(subscribeBoardAssociations(authorized, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
        boardId: 'board-1',
        x: 10,
        y: 20,
        timestamp: Number.MAX_SAFE_INTEGER,
      });

      expect(authorized.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.updated,
        data: expect.objectContaining({
          userId: ALICE,
          presenceId: expect.any(String),
          boardId: 'board-1',
        }),
      });
      const authorizedPayload = authorized.received.find(
        (entry) =>
          entry.event === PRESENCE_SOCKET_EVENTS.updated &&
          (entry.data as { boardId?: string }).boardId === 'board-1'
      )?.data as Record<string, unknown> | undefined;
      expect(Object.keys(authorizedPayload ?? {}).sort()).toEqual([
        'boardId',
        'presenceId',
        'timestamp',
        'userId',
      ]);
      expect(
        tenantOnly.received.filter(
          (entry) =>
            entry.event === PRESENCE_SOCKET_EVENTS.updated &&
            (entry.data as { boardId?: string }).boardId !== undefined
        )
      ).toEqual([]);
      expect(tenantOnly.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.updated,
        data: expect.objectContaining({ userId: ALICE, presenceId: expect.any(String) }),
      });
      expect(foreignTenant.received).toEqual([]);
    });

    it('silently omits missing, foreign, private, and archived association subscriptions', async () => {
      const { app, io } = buildHarness();
      const findBoards = vi.fn(async () => [{ board_id: 'visible-board', archived: false }]);
      (app as any).service = (path: string) =>
        path === 'boards'
          ? {
              get: vi.fn(async (id: string) => ({ board_id: id, archived: false })),
              find: findBoards,
            }
          : { get: vi.fn(async (id: string) => ({ user_id: id })) };
      const socket = makeSocket('subscriber', io);
      asUser(socket, ALICE);
      connect(io, socket);

      await expect(
        subscribeBoardAssociations(socket, [
          'visible-board',
          'private-board',
          'foreign-board',
          'archived-board',
          'missing-board',
        ])
      ).resolves.toEqual({ ok: true });

      expect(socket.joined).toContain(boardPresenceAssociationRoomName('default', 'visible-board'));
      expect(findBoards).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'socketio',
          tenant: expect.objectContaining({ tenant_id: 'default' }),
          query: expect.objectContaining({ archived: false, lean: true }),
        })
      );
      for (const denied of ['private-board', 'foreign-board', 'archived-board', 'missing-board']) {
        expect(socket.joined).not.toContain(boardPresenceAssociationRoomName('default', denied));
      }
    });

    it('rejects forged heartbeats and bounds association/cursor room membership', async () => {
      const { io } = buildHarness();
      const socket = makeSocket('publisher', io);
      asUser(socket, ALICE);
      connect(io, socket);
      const acknowledge = vi.fn();

      socket.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'private-board' });
      socket.handlers.get(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations)?.(
        {
          boardIds: Array.from(
            { length: MAX_PRESENCE_BOARD_SUBSCRIPTIONS + 1 },
            (_, index) => `board-${index}`
          ),
        },
        acknowledge
      );

      expect(io.emitted).toContainEqual({
        channel: tenantChannelName('default'),
        event: PRESENCE_SOCKET_EVENTS.updated,
        data: expect.not.objectContaining({ boardId: expect.anything() }),
      });
      expect(
        io.emitted.filter(
          (entry) =>
            entry.event === PRESENCE_SOCKET_EVENTS.updated &&
            (entry.data as { boardId?: string }).boardId !== undefined
        )
      ).toEqual([]);
      expect(acknowledge).toHaveBeenCalledWith({ ok: false });
      expect(socket.joined.size).toBe(2); // server-derived tenant + user rooms only
    });

    it('reserves in-flight cursor admissions inside the hard room bound', async () => {
      const { app, io } = buildHarness();
      const originalService = (app as any).service;
      let releaseAdmission: (() => void) | undefined;
      const getBoard = vi.fn(
        (id: string) =>
          new Promise((resolve) => {
            releaseAdmission = () => resolve({ board_id: id, archived: false });
          })
      );
      (app as any).service = (path: string) =>
        path === 'boards' ? { get: getBoard, find: vi.fn() } : originalService(path);
      const socket = makeSocket('concurrent-cursor-watch', io);
      asUser(socket, ALICE);
      connect(io, socket);
      socket.data.authorizedBoardIds = new Set(
        Array.from(
          { length: MAX_PRESENCE_BOARD_SUBSCRIPTIONS - 1 },
          (_, index) => `granted-board-${index}`
        )
      );

      const results = ['last-slot', 'over-bound'].map(
        (requestedBoardId) =>
          new Promise<{ ok: boolean }>((resolve) => {
            void socket.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.(
              requestedBoardId,
              resolve
            );
          })
      );
      await vi.waitFor(() => expect(getBoard).toHaveBeenCalledTimes(1));
      releaseAdmission?.();
      const acknowledgements = await Promise.all(results);

      expect(acknowledgements).toEqual([{ ok: true }, { ok: false }]);
      expect(socket.data.authorizedBoardIds.size).toBe(MAX_PRESENCE_BOARD_SUBSCRIPTIONS);
      expect(getBoard).toHaveBeenCalledWith(
        'last-slot',
        expect.objectContaining({
          provider: 'socketio',
          tenant: expect.objectContaining({ tenant_id: 'default' }),
          [FEATHERS_INSTRUMENTATION_REASON]: 'presence_cursor_admission',
        })
      );
      expect(getBoard).not.toHaveBeenCalledWith('over-bound', expect.anything());
      expect(socket.joined).toContain(boardPresenceRoomName('default', 'last-slot'));

      // The UI emits on both Socket.IO connect and Feathers authentication.
      // Once the first admission finishes, that duplicate event is an in-memory
      // capability hit rather than a second boards.get authorization query.
      await expect(
        new Promise<{ ok: boolean }>((resolve) => {
          void socket.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.(
            'last-slot',
            resolve
          );
        })
      ).resolves.toEqual({ ok: true });
      expect(getBoard).toHaveBeenCalledTimes(1);
    });

    it('invalidates a published board when a same-set synchronization is rate-limited', async () => {
      const { io } = buildHarness();
      const publisher = makeSocket('rate-limited-subscription-publisher', io);
      const observer = makeSocket('rate-limited-subscription-observer', io);
      asUser(publisher, ALICE);
      asUser(observer, BOB);
      connect(io, publisher);
      connect(io, observer);
      await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      await expect(subscribeBoardAssociations(publisher, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });

      // The initial publisher sync consumed one of five burst tokens. Consume
      // the remaining four, re-establishing presence only after each grant.
      for (let index = 0; index < 4; index++) {
        await expect(subscribeBoardAssociations(publisher, ['board-1'])).resolves.toEqual({
          ok: true,
        });
        publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
      }
      observer.received.length = 0;

      await expect(subscribeBoardAssociations(publisher, ['board-1'])).resolves.toEqual({
        ok: false,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });

      expect(observer.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.left,
        data: expect.objectContaining({ userId: ALICE, boardId: 'board-1' }),
      });
      expect(
        observer.received.filter(
          (entry) =>
            entry.event === PRESENCE_SOCKET_EVENTS.updated &&
            (entry.data as { boardId?: string }).boardId === 'board-1'
        )
      ).toEqual([]);
    });

    it('coalesces association authorization to one in flight plus the latest desired set', async () => {
      const { app, io } = buildHarness();
      const originalService = (app as any).service;
      const releases: Array<() => void> = [];
      const findBoards = vi.fn(
        (params: { query?: { board_id?: { $in?: string[] } } }) =>
          new Promise((resolve) => {
            const ids = params.query?.board_id?.$in ?? [];
            releases.push(() => resolve(ids.map((board_id) => ({ board_id, archived: false }))));
          })
      );
      (app as any).service = (path: string) =>
        path === 'boards' ? { get: vi.fn(), find: findBoards } : originalService(path);
      const socket = makeSocket('subscription-flood', io);
      asUser(socket, ALICE);
      connect(io, socket);

      const results = Array.from(
        { length: 5 },
        (_, index) =>
          new Promise<{ ok: boolean }>((resolve) => {
            socket.handlers.get(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations)?.(
              { boardIds: [`board-${index}`] },
              resolve
            );
          })
      );
      await vi.waitFor(() => expect(findBoards).toHaveBeenCalledTimes(1));
      releases.shift()?.();
      await vi.waitFor(() => expect(findBoards).toHaveBeenCalledTimes(2));
      releases.shift()?.();
      const acknowledgements = await Promise.all(results);

      expect(findBoards).toHaveBeenCalledTimes(2);
      expect(acknowledgements.filter(({ ok }) => ok)).toHaveLength(1);
      expect(socket.joined).toContain(boardPresenceAssociationRoomName('default', 'board-4'));
      for (const intermediate of ['board-0', 'board-1', 'board-2', 'board-3']) {
        expect(socket.joined).not.toContain(
          boardPresenceAssociationRoomName('default', intermediate)
        );
      }
    });

    it('rate-limits cursor samples and alternating board associations per socket', async () => {
      const { io } = buildHarness();
      const publisher = makeSocket('realtime-flood', io);
      asUser(publisher, ALICE);
      connect(io, publisher);
      await publisher.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      await expect(subscribeBoardAssociations(publisher, ['board-1', 'board-2'])).resolves.toEqual({
        ok: true,
      });

      for (let index = 0; index < 200; index++) {
        publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
          boardId: 'board-1',
          x: index,
          y: index,
        });
      }
      expect(
        io.emitted.filter((entry) => entry.event === PRESENCE_SOCKET_EVENTS.cursorMoved).length
      ).toBeLessThanOrEqual(31);

      io.emitted.length = 0;
      for (let index = 0; index < 100; index++) {
        publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorLeave)?.({ boardId: 'board-1' });
      }
      expect(
        io.emitted.filter((entry) => entry.event === PRESENCE_SOCKET_EVENTS.cursorLeft)
      ).toHaveLength(1);

      io.emitted.length = 0;
      for (let index = 0; index < 100; index++) {
        publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({
          boardId: index % 2 === 0 ? 'board-1' : 'board-2',
        });
      }
      expect(
        io.emitted.filter(
          (entry) =>
            entry.event === PRESENCE_SOCKET_EVENTS.updated &&
            (entry.data as { boardId?: string }).boardId !== undefined
        ).length
      ).toBeLessThanOrEqual(10);
    });

    it('uses per-connection identities so one tab leaving cannot clear another tab', async () => {
      const { io } = buildHarness();
      const tabOne = makeSocket('tab-one', io);
      const tabTwo = makeSocket('tab-two', io);
      const observer = makeSocket('observer', io);
      asUser(tabOne, ALICE);
      asUser(tabTwo, ALICE);
      asUser(observer, BOB);
      for (const socket of [tabOne, tabTwo, observer]) connect(io, socket);
      await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      await observer.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      for (const [index, tab] of [tabOne, tabTwo].entries()) {
        await tab.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
        await expect(subscribeBoardAssociations(tab, ['board-1'])).resolves.toEqual({ ok: true });
        tab.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
        tab.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
          boardId: 'board-1',
          x: index,
          y: index,
          timestamp: 0,
        });
      }

      const boardUpdates = observer.received.filter(
        (entry) =>
          entry.event === PRESENCE_SOCKET_EVENTS.updated &&
          (entry.data as { boardId?: string }).boardId === 'board-1'
      );
      const presenceIds = boardUpdates.map(
        (entry) => (entry.data as { presenceId: string }).presenceId
      );
      expect(new Set(presenceIds).size).toBe(2);

      tabOne.handlers.get(PRESENCE_SOCKET_EVENTS.leave)?.();
      const boardLeaves = observer.received.filter(
        (entry) =>
          entry.event === PRESENCE_SOCKET_EVENTS.left &&
          (entry.data as { boardId?: string }).boardId === 'board-1'
      );
      expect(boardLeaves).toHaveLength(1);
      const leftPresence = boardLeaves[0]?.data as { presenceId: string } | undefined;
      expect(leftPresence?.presenceId).toBe(presenceIds[0]);
      expect(leftPresence?.presenceId).not.toBe(presenceIds[1]);

      tabOne.handlers.get(PRESENCE_SOCKET_EVENTS.cursorLeave)?.({ boardId: 'board-1' });
      const cursorLeaves = observer.received.filter(
        (entry) => entry.event === PRESENCE_SOCKET_EVENTS.cursorLeft
      );
      expect(cursorLeaves).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.cursorLeft,
        data: expect.objectContaining({ presenceId: presenceIds[0], boardId: 'board-1' }),
      });
      expect(cursorLeaves).not.toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.cursorLeft,
        data: expect.objectContaining({ presenceId: presenceIds[1], boardId: 'board-1' }),
      });
    });

    it('retracts a published board before acknowledging a full-set unsubscribe', async () => {
      const { io } = buildHarness();
      const publisher = makeSocket('subscription-publisher', io);
      const observer = makeSocket('subscription-observer', io);
      asUser(publisher, ALICE);
      asUser(observer, BOB);
      connect(io, publisher);
      connect(io, observer);
      await expect(subscribeBoardAssociations(publisher, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
      observer.received.length = 0;

      await expect(subscribeBoardAssociations(publisher, [])).resolves.toEqual({ ok: true });

      expect(observer.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.left,
        data: expect.objectContaining({ userId: ALICE, boardId: 'board-1' }),
      });
    });

    it('retracts the previous route while replacement authorization is still in flight', async () => {
      const { app, io } = buildHarness();
      const originalService = (app as any).service;
      let releaseReplacement: (() => void) | undefined;
      const findBoards = vi.fn(async (params: { query?: { board_id?: { $in?: string[] } } }) => {
        const ids = params.query?.board_id?.$in ?? [];
        if (ids[0] === 'board-2') {
          await new Promise<void>((resolve) => {
            releaseReplacement = resolve;
          });
        }
        return ids.map((board_id) => ({ board_id, archived: false }));
      });
      (app as any).service = (path: string) =>
        path === 'boards' ? { get: vi.fn(), find: findBoards } : originalService(path);
      const publisher = makeSocket('route-transition-publisher', io);
      const observer = makeSocket('route-transition-observer', io);
      asUser(publisher, ALICE);
      asUser(observer, BOB);
      connect(io, publisher);
      connect(io, observer);
      await expect(subscribeBoardAssociations(publisher, ['board-1', 'board-2'])).resolves.toEqual({
        ok: true,
      });
      await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
      observer.received.length = 0;
      const acknowledge = vi.fn();

      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations)?.(
        { boardIds: ['board-2', 'board-1'] },
        acknowledge
      );

      expect(observer.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.left,
        data: expect.objectContaining({ userId: ALICE, boardId: 'board-1' }),
      });
      expect(acknowledge).not.toHaveBeenCalled();
      releaseReplacement?.();
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith({ ok: true }));
    });

    it('disconnects explicit logouts and promptly retracts their board association', async () => {
      const { app, io } = buildHarness();
      const publisher = makeSocket('logout-publisher', io);
      const observer = makeSocket('logout-observer', io);
      asUser(publisher, ALICE);
      asUser(observer, BOB);
      connect(io, publisher);
      connect(io, observer);
      await expect(subscribeBoardAssociations(observer, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      await expect(subscribeBoardAssociations(publisher, ['board-1'])).resolves.toEqual({
        ok: true,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.heartbeat)?.({ boardId: 'board-1' });
      const presenceId = (
        observer.received.find(
          (entry) =>
            entry.event === PRESENCE_SOCKET_EVENTS.updated &&
            (entry.data as { boardId?: string }).boardId === 'board-1'
        )?.data as { presenceId?: string } | undefined
      )?.presenceId;
      observer.received.length = 0;

      retireAuthenticatedConnectionAuthority(publisher.feathers);
      app.eventHandlers.get('disconnect')?.(publisher.feathers);

      expect(publisher.connected).toBe(false);
      expect(observer.received).toContainEqual({
        event: PRESENCE_SOCKET_EVENTS.left,
        data: expect.objectContaining({
          userId: ALICE,
          presenceId,
          boardId: 'board-1',
        }),
      });
    });

    it('validates cursor payloads and replaces caller timestamps with server time', async () => {
      const { io } = buildHarness();
      const publisher = makeSocket('publisher', io);
      const observer = makeSocket('observer', io);
      asUser(publisher, ALICE);
      asUser(observer, BOB);
      connect(io, publisher);
      connect(io, observer);
      await publisher.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      await observer.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.('board-1');
      const before = Date.now();

      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
        boardId: 'board-1',
        x: 10,
        y: 20,
        timestamp: Number.MAX_SAFE_INTEGER,
      });
      publisher.handlers.get(PRESENCE_SOCKET_EVENTS.cursorMove)?.({
        boardId: 'board-1',
        x: Number.NaN,
        y: 20,
        timestamp: 1,
      });

      const cursorEvents = observer.received.filter(
        (entry) => entry.event === PRESENCE_SOCKET_EVENTS.cursorMoved
      );
      expect(cursorEvents).toHaveLength(1);
      expect(cursorEvents[0]?.data).toMatchObject({
        userId: ALICE,
        presenceId: expect.any(String),
        timestamp: expect.any(Number),
      });
      const cursorEvent = cursorEvents[0]?.data as { timestamp: number } | undefined;
      expect(cursorEvent?.timestamp).toBeGreaterThanOrEqual(before);
      expect(cursorEvent?.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });
});

describe('presence/cursor exclude the terminal-executor identity', () => {
  it('does NOT join a terminal-executor socket to a board presence room', () => {
    const { io } = buildHarness();
    const s = makeSocket('exec-sock');
    asServiceForUser(s, ALICE);
    connect(io, s);
    s.handlers.get('presence:watch-board')?.('board-1');
    expect(s.joined.has(boardPresenceRoomName('default', 'board-1'))).toBe(false);
  });

  it('DOES join a normal authenticated user to a board presence room', async () => {
    const { io } = buildHarness();
    const s = makeSocket('alice-sock');
    asUser(s, ALICE);
    connect(io, s);
    await s.handlers.get('presence:watch-board')?.('board-1');
    expect(s.joined.has(boardPresenceRoomName('default', 'board-1'))).toBe(true);
  });

  it('drops cursor-move / cursor-leave from a terminal-executor socket (no broadcast)', () => {
    const { io } = buildHarness();
    const s = makeSocket('exec-sock', io);
    asServiceForUser(s, ALICE);
    connect(io, s);
    s.handlers.get('cursor-move')?.({ boardId: 'board-1', x: 1, y: 2, timestamp: 1 });
    s.handlers.get('cursor-leave')?.({ boardId: 'board-1', timestamp: 1 });
    expect(io.emitted).toEqual([]);
  });

  it('still broadcasts cursor-move from a normal user', async () => {
    const { io } = buildHarness();
    const s = makeSocket('alice-sock', io);
    asUser(s, ALICE);
    connect(io, s);
    await s.handlers.get('presence:watch-board')?.('board-1');
    s.handlers.get('cursor-move')?.({ boardId: 'board-1', x: 1, y: 2, timestamp: 1 });
    expect(io.emitted.some((e) => e.event === 'cursor-moved')).toBe(true);
  });

  it('does not grant or emit to a board rejected by Feathers authorization', async () => {
    const { app, io } = buildHarness();
    (app as any).service = (path: string) =>
      path === 'boards'
        ? { get: vi.fn(async () => Promise.reject(new Error('forbidden'))) }
        : { get: vi.fn(async (id: string) => ({ user_id: id })) };
    const s = makeSocket('alice-sock', io);
    asUser(s, ALICE);
    connect(io, s);

    await s.handlers.get('presence:watch-board')?.('private-board');
    s.handlers.get('cursor-move')?.({
      boardId: 'private-board',
      x: 1,
      y: 2,
      timestamp: 1,
    });

    expect(s.joined.has(boardPresenceRoomName('default', 'private-board'))).toBe(false);
    expect(io.emitted).toEqual([]);
  });

  it('does not grant a cursor room when the authorized lookup returns an archived board', async () => {
    const { app, io } = buildHarness();
    (app as any).service = (path: string) =>
      path === 'boards'
        ? { get: vi.fn(async () => ({ board_id: 'archived-board', archived: true })) }
        : { get: vi.fn(async (id: string) => ({ user_id: id })) };
    const socket = makeSocket('archived-board-watcher', io);
    asUser(socket, ALICE);
    connect(io, socket);
    const acknowledge = vi.fn();

    await socket.handlers.get(PRESENCE_SOCKET_EVENTS.watchBoardCursors)?.(
      'archived-board',
      acknowledge
    );

    expect(acknowledge).toHaveBeenCalledWith({ ok: false });
    expect(socket.joined).not.toContain(boardPresenceRoomName('default', 'archived-board'));
  });

  it('does not restore a board room when disconnect races an in-flight authorization', async () => {
    const { app, io } = buildHarness();
    let resolveBoard!: (value: { board_id: string }) => void;
    const boardLookup = new Promise<{ board_id: string }>((resolve) => {
      resolveBoard = resolve;
    });
    (app as any).service = (path: string) =>
      path === 'boards'
        ? { get: vi.fn(async () => boardLookup) }
        : { get: vi.fn(async (id: string) => ({ user_id: id })) };
    const s = makeSocket('alice-sock', io);
    asUser(s, ALICE);
    connect(io, s);
    const acknowledge = vi.fn();

    const watch = s.handlers.get('presence:watch-board')?.('board-1', acknowledge);
    s.disconnect();
    resolveBoard({ board_id: 'board-1' });
    await watch;

    expect(s.joined.has(boardPresenceRoomName('default', 'board-1'))).toBe(false);
    expect(acknowledge).toHaveBeenCalledWith({ ok: false });
  });

  it('does not restore association rooms when disconnect races a full-set authorization', async () => {
    const { app, io } = buildHarness();
    let resolveBoards!: (value: Array<{ board_id: string; archived: boolean }>) => void;
    const boardLookup = new Promise<Array<{ board_id: string; archived: boolean }>>((resolve) => {
      resolveBoards = resolve;
    });
    (app as any).service = (path: string) =>
      path === 'boards'
        ? { find: vi.fn(async () => boardLookup) }
        : { get: vi.fn(async (id: string) => ({ user_id: id })) };
    const socket = makeSocket('association-race', io);
    asUser(socket, ALICE);
    connect(io, socket);
    const result = subscribeBoardAssociations(socket, ['board-1']);

    socket.disconnect();
    resolveBoards([{ board_id: 'board-1', archived: false }]);

    await expect(result).resolves.toEqual({ ok: false });
    expect(socket.joined).not.toContain(boardPresenceAssociationRoomName('default', 'board-1'));
  });
});

describe('configureChannels tenant isolation', () => {
  const REQUIRED_TENANCY = {
    mode: 'required_from_auth',
    static_tenant_id: 'default' as never,
    auth_claim: 'tenant_id',
  } as const;

  function makeChannelHarness() {
    const handlers = new Map<string, (...args: any[]) => void>();
    const joins = new Map<string, unknown[]>();
    const leaves = new Map<string, unknown[]>();
    const app = {
      get channels() {
        return [...new Set([...joins.keys(), ...leaves.keys()])];
      },
      on(event: string, fn: (...args: any[]) => void) {
        handlers.set(event, fn);
      },
      channel(name: string) {
        return {
          join(connection: unknown) {
            const list = joins.get(name) ?? [];
            list.push(connection);
            joins.set(name, list);
          },
          leave(connection: unknown) {
            const list = leaves.get(name) ?? [];
            list.push(connection);
            leaves.set(name, list);
          },
        };
      },
    };
    return { app: app as unknown as Application, handlers, joins, leaves };
  }

  function finalizeLogin(
    app: Application,
    handlers: Map<string, (...args: any[]) => void>,
    connection: object,
    authResult: object,
    multiTenancy: ResolvedMultiTenancyConfig,
    _params: Record<string, unknown> = {}
  ) {
    finalizeAuthenticatedConnectionAuthority({
      connection,
      authResult,
      multiTenancy,
      executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
    });
    handlers.get('connection')?.(connection);
  }

  function attachTaskExecutorCandidate(
    app: Application,
    authResult: object,
    tenantId: string,
    sessionId: string,
    taskId: string
  ) {
    const fence = getOrCreateExecutorConnectionRevocationFence(app);
    attachExecutorConnectionCandidate(authResult, {
      tenantId,
      taskId,
      tokenFingerprint: fingerprintExecutorSessionToken(`${sessionId}:${taskId}`),
      revocationGeneration: fence.snapshot(tenantId),
    });
  }

  it('joins authenticated sockets to tenant-scoped channels on connection', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;

    finalizeLogin(
      app,
      handlers,
      connection,
      {
        user: { user_id: ALICE, email: 'alice@example.test' },
        authentication: { strategy: 'jwt', payload: { tenant_id: 'tenant-a' } },
      },
      REQUIRED_TENANCY
    );

    expect(connection.tenant).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
    expect(joins.get('authenticated')).toEqual([connection]);
    expect(joins.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(joins.get(tenantUserChannelName('tenant-a', ALICE))).toEqual([connection]);
    expect(joins.has(tenantChannelName('tenant-b'))).toBe(false);
  });

  it('keeps connection authority immutable and cannot rebind a retired connection', () => {
    const { app } = makeChannelHarness();
    const connection = {};
    const authResult = {
      user: { user_id: ALICE, email: 'alice@example.test' },
      authentication: { strategy: 'jwt', payload: { tenant_id: 'tenant-a' } },
    };

    const authority = finalizeAuthenticatedConnectionAuthority({
      connection,
      authResult,
      multiTenancy: REQUIRED_TENANCY,
      executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.principal)).toBe(true);
    expect(Object.isFrozen(authority.tenant)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(connection, 'tenant')).toMatchObject({
      enumerable: true,
      writable: false,
    });

    retireAuthenticatedConnectionAuthority(connection);
    expect(getAuthenticatedConnectionAuthority(connection)).toBeUndefined();
    expect(connection).not.toHaveProperty('tenant');
    expect(() =>
      finalizeAuthenticatedConnectionAuthority({
        connection,
        authResult,
        multiTenancy: REQUIRED_TENANCY,
        executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
      })
    ).toThrow(/immutable/i);
  });

  it('ignores caller-controlled login params and joins only from the signed tenant claim', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;

    finalizeLogin(
      app,
      handlers,
      connection,
      {
        user: { user_id: ALICE, email: 'alice@example.test' },
        authentication: {
          strategy: 'jwt',
          payload: { tenant_id: 'tenant-from-signed-claim' },
        },
      },
      REQUIRED_TENANCY,
      { tenant: { tenant_id: 'tenant-from-params', source: 'auth_claim' } }
    );

    expect(connection.tenant).toEqual({
      tenant_id: 'tenant-from-signed-claim',
      source: 'auth_claim',
    });
    expect(joins.get('authenticated')).toEqual([connection]);
    expect(joins.get(tenantChannelName('tenant-from-signed-claim'))).toEqual([connection]);
    expect(joins.get(tenantUserChannelName('tenant-from-signed-claim', ALICE))).toEqual([
      connection,
    ]);
  });

  it('uses the canonical signed tenant claim when the configured alias is absent', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;

    finalizeLogin(
      app,
      handlers,
      connection,
      {
        user: { user_id: ALICE },
        authentication: { strategy: 'jwt', payload: { tenant_id: 'tenant-canonical' } },
      },
      { ...REQUIRED_TENANCY, auth_claim: 'workspace_id' }
    );

    expect(joins.get(tenantChannelName('tenant-canonical'))).toEqual([connection]);
    expect(connection.tenant).toEqual({
      tenant_id: 'tenant-canonical',
      source: 'auth_claim',
    });
  });

  it('does NOT join a terminal-executor identity to any broadcast channel', () => {
    // The long-lived terminal token must not get a realtime firehose
    // subscription — it consumes only raw terminal:* room events, never
    // Feathers channel broadcasts.
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;

    finalizeLogin(
      app,
      handlers,
      connection,
      {
        user: {
          user_id: 'executor-service',
          _isTerminalExecutor: true,
          terminal_user_id: ALICE,
          terminal_id: TERMINAL,
          terminal_branch_id: BRANCH,
          terminal_owner_boot_id: 'daemon-a-boot',
        },
        authentication: { strategy: 'jwt', payload: { tenant_id: 'tenant-a' } },
      },
      REQUIRED_TENANCY
    );

    expect(joins.size).toBe(0);
  });

  it('still joins a full service account to broadcast channels (service delivery)', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;

    finalizeLogin(
      app,
      handlers,
      connection,
      {
        user: { user_id: 'executor-service', _isServiceAccount: true },
        authentication: { strategy: 'jwt' },
      },
      { mode: 'static', static_tenant_id: 'tenant-a' as never }
    );

    expect(joins.get('authenticated')).toEqual([connection]);
  });

  it('joins the task room from finalized executor authority', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;
    const authResult = {
      user: { user_id: ALICE },
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          task_id: 'task-1',
          session_id: 'session-1',
          tenant_id: 'tenant-a',
        },
      },
    };
    attachTaskExecutorCandidate(app, authResult, 'tenant-a', 'session-1', 'task-1');
    finalizeLogin(app, handlers, connection, authResult, REQUIRED_TENANCY);

    expect(joins.get(executorTaskChannelName('tenant-a', 'task-1'))).toEqual([connection]);
    expect(getAuthenticatedConnectionAuthority(connection)).toMatchObject({
      tenant: { tenant_id: 'tenant-a' },
      principal: {
        kind: 'executor',
        taskId: 'task-1',
      },
    });
  });

  it('does not join a task room when revocation lands after authority commit', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;
    const authResult = {
      user: { user_id: ALICE },
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          task_id: 'task-1',
          session_id: 'session-1',
          tenant_id: 'tenant-a',
        },
      },
    };
    const fence = getOrCreateExecutorConnectionRevocationFence(app);
    attachTaskExecutorCandidate(app, authResult, 'tenant-a', 'session-1', 'task-1');
    finalizeAuthenticatedConnectionAuthority({
      connection,
      authResult,
      multiTenancy: REQUIRED_TENANCY,
      executorRevocationFence: fence,
    });

    fence.record({ tenantId: 'tenant-a', tokenFingerprint: fingerprintExecutorSessionToken('x') });
    handlers.get('connection')?.(connection);

    expect(joins.has(executorTaskChannelName('tenant-a', 'task-1'))).toBe(false);
  });

  it('does not trust an unscoped login or mismatched result task claim', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app);
    const connection = { data: {} } as any;

    handlers.get('connection')?.(connection);

    expect(joins.has(executorTaskChannelName('tenant-a', 'task-1'))).toBe(false);
    expect(joins.has(executorTaskChannelName('tenant-a', 'task-2'))).toBe(false);
  });
});
