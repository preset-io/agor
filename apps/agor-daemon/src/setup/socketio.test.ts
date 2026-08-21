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

import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { BranchID, UserID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitExecutorConnectionCapability,
  getExecutorConnectionCapability,
  getOrCreateExecutorConnectionRevocationFence,
} from '../auth/executor-connection-capability.js';
import { issueRuntimeToken } from '../auth/runtime-tokens.js';
import {
  boardPresenceRoomName,
  HA_AUTHORIZATION_INVALIDATION_EVENT,
  HA_EXECUTOR_TOKEN_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT,
  LOCAL_AUTHORIZATION_INVALIDATION_EVENT,
  sessionStreamRoomName,
  tenantChannelName,
  tenantUserChannelName,
  terminalChannelName,
} from '../realtime/routing';
import { fingerprintExecutorSessionToken } from '../services/session-token-service';
import type { TerminalAttachmentIdentity } from '../services/terminals';
import { TERMINAL_REQUEST_JOIN_CHANNEL } from '../terminal-socket-connection';
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
    to: (channel: string) => { emit: (event: string, data: unknown) => void };
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
      to: (channel: string) => ({
        emit: (event: string, data: unknown) => {
          io?.emitted.push({ channel, event, data });
          deliverToRoom(io, channel, event, data, id);
        },
      }),
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

function makeApp() {
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
  return {
    service: (path: string) =>
      path === 'terminals'
        ? { matchesOwnedAttachment }
        : { get: async (userId: string) => ({ user_id: userId }) },
    on: (event: string, handler: (...args: any[]) => void) => eventHandlers.set(event, handler),
    emit: vi.fn(),
    eventHandlers,
    matchesOwnedAttachment,
  };
}

function buildHarness(opts: Partial<SocketIOOptions> = {}) {
  const app = makeApp();
  const io = makeIO();
  const config = createSocketIOConfig(
    app as unknown as Application,
    {
      corsOrigin: '*',
      jwtSecret: 'test-secret',
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
  asUser(tenantA, ALICE);
  asUser(tenantB, BOB);
  tenantA.data.tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };
  tenantB.data.tenant = { tenant_id: 'tenant-b', source: 'auth_claim' };
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
  asUser(tenantA, ALICE);
  asUser(tenantB, BOB);
  tenantA.data.tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };
  tenantB.data.tenant = { tenant_id: 'tenant-b', source: 'auth_claim' };
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

it('fences an already-authenticated task executor on exact and HA session revocation', () => {
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
  commitExecutorConnectionCapability(
    exact.feathers,
    {
      tenantId: tenantA.tenant_id,
      sessionId: 'session-1',
      taskId: 'task-1',
      expiresAt: Date.now() + 60_000,
      tokenFingerprint: fingerprintExecutorSessionToken(exactToken),
      revocationSnapshot: fence.snapshot(tenantA.tenant_id),
    },
    tenantA,
    fence
  );
  connect(io, exact);

  (app as any).eventHandlers.get('realtime:executor-token-invalidated')?.({
    tenantId: 'tenant-a',
    tokenFingerprint: fingerprintExecutorSessionToken(exactToken),
  });
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
  commitExecutorConnectionCapability(
    session.feathers,
    {
      tenantId: tenantB.tenant_id,
      sessionId: 'session-2',
      taskId: 'task-2',
      expiresAt: Date.now() + 60_000,
      tokenFingerprint: fingerprintExecutorSessionToken('another-token'),
      revocationSnapshot: fence.snapshot(tenantB.tenant_id),
    },
    tenantB,
    fence
  );
  connect(io, session);

  io.serverHandlers.get(HA_EXECUTOR_TOKEN_INVALIDATION_EVENT)?.({
    tenantId: 'tenant-b',
    sessionId: 'session-2',
  });
  expect(session.connected).toBe(false);
});

it('revokes a captured terminal subscription capability on logout', async () => {
  const { app, io } = buildHarness();
  const socket = makeSocket('logout-terminal-requester', io);
  asUser(socket, ALICE);
  connect(io, socket);
  const connection = socket.feathers;
  const capturedJoin = connection?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  expect(capturedJoin).toBeTypeOf('function');

  (app as any).eventHandlers.get('logout')?.({}, { connection });

  const allocation = { userId: ALICE, terminalId: TERMINAL, branchId: BRANCH };
  await expect(capturedJoin?.(terminalChannel(), allocation)).resolves.toBe(false);
  expect(socket.joined).not.toContain(terminalChannel());
  expect(connection?.[TERMINAL_REQUEST_JOIN_CHANNEL]).toBeUndefined();
});

it('revokes the previous user and tenant capability on authentication replacement', async () => {
  const { app, io } = buildHarness({
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    },
  });
  const socket = makeSocket('replacement-terminal-requester', io);
  socket.feathers = { user: { user_id: ALICE } };
  socket.data.tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };
  connect(io, socket);
  const connection = socket.feathers;
  const capturedJoin = connection?.[TERMINAL_REQUEST_JOIN_CHANNEL];

  connection!.user = { user_id: BOB };
  (app as any).eventHandlers.get('login')?.(
    { user: { user_id: BOB }, authentication: { payload: { tenant_id: 'tenant-b' } } },
    {
      connection,
      params: { authentication: { payload: { tenant_id: 'tenant-b' } } },
    }
  );

  await expect(
    capturedJoin?.(terminalChannel(ALICE, TERMINAL, 'tenant-a'), {
      userId: ALICE,
      terminalId: TERMINAL,
      branchId: BRANCH,
    })
  ).resolves.toBe(false);
  const replacementJoin = connection?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  expect(replacementJoin).toBeTypeOf('function');
  await expect(
    replacementJoin?.(terminalChannel(BOB, TERMINAL, 'tenant-b'), {
      userId: BOB,
      terminalId: TERMINAL,
      branchId: BRANCH,
    })
  ).resolves.toBe(true);
  expect(socket.joined).not.toContain(terminalChannel(ALICE, TERMINAL, 'tenant-a'));
  expect(socket.joined).toContain(terminalChannel(BOB, TERMINAL, 'tenant-b'));
});

it('removes a terminal room when authentication changes while its join is pending', async () => {
  const { app, io } = buildHarness({
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    },
  });
  const socket = makeSocket('pending-terminal-requester', io);
  socket.feathers = { user: { user_id: ALICE } };
  socket.data.tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };
  connect(io, socket);
  const connection = socket.feathers;
  const capturedJoin = connection?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  const channel = terminalChannel(ALICE, TERMINAL, 'tenant-a');
  let releaseJoin!: () => void;
  let markJoinStarted!: () => void;
  const joinGate = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  const joinStarted = new Promise<void>((resolve) => {
    markJoinStarted = resolve;
  });
  const normalJoin = socket.join.bind(socket);
  socket.join = async (candidate) => {
    if (candidate === channel) {
      markJoinStarted();
      await joinGate;
    }
    await normalJoin(candidate);
  };

  const pending = capturedJoin?.(channel, {
    userId: ALICE,
    terminalId: TERMINAL,
    branchId: BRANCH,
  });
  await joinStarted;
  connection!.user = { user_id: BOB };
  (app as any).eventHandlers.get('login')?.(
    { user: { user_id: BOB }, authentication: { payload: { tenant_id: 'tenant-b' } } },
    {
      connection,
      params: { authentication: { payload: { tenant_id: 'tenant-b' } } },
    }
  );
  releaseJoin();

  await expect(pending).resolves.toBe(false);
  expect(socket.joined).not.toContain(channel);
  expect(socket.left).toContain(channel);
  expect(socket.received).not.toContainEqual({
    event: 'terminal:allocated',
    data: expect.objectContaining({ userId: ALICE }),
  });
});

it('does not let a stale join remove the replacement generation from the same room', async () => {
  const { app, io } = buildHarness({
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'default' as never,
      auth_claim: 'tenant_id',
    },
  });
  const socket = makeSocket('same-identity-replacement', io);
  socket.feathers = { user: { user_id: ALICE } };
  socket.data.tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };
  connect(io, socket);
  const connection = socket.feathers;
  const staleJoin = connection?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  const channel = terminalChannel(ALICE, TERMINAL, 'tenant-a');
  const allocation = { userId: ALICE, terminalId: TERMINAL, branchId: BRANCH };
  let releaseStaleJoin!: () => void;
  let markStaleJoinStarted!: () => void;
  const staleJoinGate = new Promise<void>((resolve) => {
    releaseStaleJoin = resolve;
  });
  const staleJoinStarted = new Promise<void>((resolve) => {
    markStaleJoinStarted = resolve;
  });
  const normalJoin = socket.join.bind(socket);
  let terminalJoinCount = 0;
  socket.join = async (candidate) => {
    if (candidate === channel && terminalJoinCount++ === 0) {
      markStaleJoinStarted();
      await staleJoinGate;
    }
    await normalJoin(candidate);
  };

  const staleResult = staleJoin?.(channel, allocation);
  await staleJoinStarted;
  (app as any).eventHandlers.get('login')?.(
    { user: { user_id: ALICE }, authentication: { payload: { tenant_id: 'tenant-a' } } },
    {
      connection,
      params: { authentication: { payload: { tenant_id: 'tenant-a' } } },
    }
  );
  const replacementJoin = connection?.[TERMINAL_REQUEST_JOIN_CHANNEL];
  expect(replacementJoin).not.toBe(staleJoin);
  const replacementResult = replacementJoin?.(channel, allocation);

  releaseStaleJoin();
  await expect(staleResult).resolves.toBe(false);
  await expect(replacementResult).resolves.toBe(true);
  expect(socket.joined).toContain(channel);
  expect(socket.received).toContainEqual({ event: 'terminal:allocated', data: allocation });
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

function asUser(socket: FakeSocket, userId: string) {
  socket.feathers = { user: { user_id: userId } };
  socket.data.tenant = { tenant_id: 'default', source: 'static' };
}
/**
 * Simulate a socket that presented a service token in the initial handshake.
 * The handshake middleware sets socket.data.isService AND attaches a synthetic
 * service user to feathers.user — we mirror both markers here.
 */
function asServiceHandshake(socket: FakeSocket) {
  socket.feathers = {
    user: { user_id: 'executor-service', _isServiceAccount: true },
  };
  socket.data.isService = true;
}
/**
 * Simulate an executor that connected anonymously and then authenticated
 * post-connect via `client.authenticate({ strategy: 'jwt', ... })`. The
 * Feathers login flow attaches the synthetic user with `_isServiceAccount:
 * true` but does NOT set socket.data.isService. This path is what
 * packages/executor/src/services/feathers-client.ts actually does.
 */
function asServicePostConnect(socket: FakeSocket) {
  socket.feathers = {
    user: { user_id: 'executor-service', _isServiceAccount: true },
  };
}
/**
 * A terminal executor socket: a RESTRICTED identity user-scoped via
 * `terminal_user_id`. Deliberately NOT a full service account (no
 * `_isServiceAccount`) — that's the whole point of the terminal-scoped token.
 * Mirrors what ServiceJWTStrategy mints for a token carrying terminal_user_id.
 */
function asServiceForUser(socket: FakeSocket, userId: string, terminalId = TERMINAL) {
  socket.feathers = {
    user: {
      user_id: 'executor-service',
      role: 'terminal-executor',
      _isTerminalExecutor: true,
      terminal_user_id: userId,
      terminal_id: terminalId,
      terminal_branch_id: BRANCH,
      terminal_owner_boot_id: 'daemon-a-boot',
    },
  };
  socket.data.tenant = { tenant_id: 'default', source: 'static' };
}
/** Handshake-token variant of a user-scoped terminal executor socket. */
function asServiceHandshakeForUser(socket: FakeSocket, userId: string, terminalId = TERMINAL) {
  socket.feathers = {
    user: {
      user_id: 'executor-service',
      role: 'terminal-executor',
      _isTerminalExecutor: true,
      terminal_user_id: userId,
      terminal_id: terminalId,
      terminal_branch_id: BRANCH,
      terminal_owner_boot_id: 'daemon-a-boot',
    },
  };
  socket.data.terminalUserId = userId;
  socket.data.terminalId = terminalId;
  socket.data.terminalBranchId = BRANCH;
  socket.data.terminalOwnerBootId = 'daemon-a-boot';
  socket.data.tenant = { tenant_id: 'default', source: 'static' };
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

  it('logs first authentication and identity changes but omits same-identity repeats', () => {
    const { app, io } = buildHarness();
    const socket = makeSocket('alice-sock');
    connect(io, socket);

    const connection = {};
    socket.feathers = connection;
    (app as any).eventHandlers.get('login')?.(
      { user: { user_id: ALICE, email: 'alice@example.com' } },
      { connection }
    );
    (app as any).eventHandlers.get('login')?.(
      { user: { user_id: ALICE, email: 'repeat@example.com' } },
      { connection }
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy.mock.calls.flat().join(' ')).not.toContain('re-authenticated');
    expect(logSpy).toHaveBeenCalledWith(
      'socket authenticated: alice-sock user:11111111aaaaaaaaaaaa1111'
    );
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('alice@example.com');
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('repeat@example.com');

    (app as any).eventHandlers.get('login')?.(
      { user: { user_id: BOB, email: 'bob@example.com' } },
      { connection }
    );

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenLastCalledWith(
      'socket authenticated: alice-sock user:22222222bbbbbbbbbbbb2222'
    );
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('bob@example.com');
  });

  it('keeps post-connect authenticated sockets out of unauthenticated disconnect metrics', () => {
    vi.useFakeTimers();
    const { app, io } = buildHarness();
    const socket = makeSocket('post-connect-auth');
    connect(io, socket);

    const connection = {};
    socket.feathers = connection;
    (app as any).eventHandlers.get('login')?.({ user: { user_id: ALICE } }, { connection });
    socket.feathers = {};
    debugSpy.mockClear();
    logSpy.mockClear();
    warnSpy.mockClear();

    socket.handlers.get('disconnect')?.('ping timeout');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(
      '🔌 Socket.io disconnected: post-connect-auth (reason: ping timeout, remaining: 0)'
    );

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith(
      'ws_active_connections=0 ws_unauthenticated_disconnects=0'
    );
  });

  it('joins post-connect browser auth only to tenant-scoped raw rooms', () => {
    const { app, io } = buildHarness({
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const socket = makeSocket('alice-sock');
    connect(io, socket);
    const connection = { user: { user_id: ALICE } };
    socket.feathers = connection;
    (app as any).eventHandlers.get('login')?.(
      { user: { user_id: ALICE } },
      { connection, params: {} }
    );

    expect(socket.joined).toContain(tenantChannelName('tenant-a'));
    expect(socket.joined).toContain(tenantUserChannelName('tenant-a', ALICE));
    expect([...socket.joined]).not.toContain(`user:${ALICE}`);
    expect(socket.feathers?.[TERMINAL_REQUEST_JOIN_CHANNEL]).toBeTypeOf('function');
  });

  it('uses the same single authentication signal for handshake-authenticated users', async () => {
    const { app, io } = buildHarness();
    const socket = makeSocket('handshake-sock');
    socket.handshake.auth = {
      token: issueRuntimeToken({ sub: ALICE, type: 'access' }, 'test-secret', '5m'),
    };

    await new Promise<void>((resolve, reject) => {
      io.middlewares[0]?.(socket, (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    connect(io, socket);
    (app as any).eventHandlers.get('login')?.(
      { user: { user_id: ALICE } },
      { connection: socket.feathers }
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      'socket authenticated: handshake-sock user:11111111aaaaaaaaaaaa1111'
    );
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('joined user room'));
  });

  it.each([
    {
      kind: 'full service',
      user: {
        user_id: 'executor-service',
        email: 'executor@agor.internal',
        role: 'service',
        _isServiceAccount: true,
      },
      joinsUserRoom: false,
    },
    {
      kind: 'terminal executor',
      user: {
        user_id: 'executor-service',
        email: 'executor@agor.internal',
        role: 'terminal-executor',
        _isTerminalExecutor: true,
        terminal_user_id: ALICE,
      },
      joinsUserRoom: false,
    },
  ])('logs post-connect $kind authentication as service', ({ user, joinsUserRoom }) => {
    const { app, io } = buildHarness();
    const socket = makeSocket('post-connect-service');
    connect(io, socket);

    const connection = {};
    socket.feathers = connection;
    (app as any).eventHandlers.get('login')?.({ user }, { connection });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith('socket authenticated: post-connect-service service');
    expect([...socket.joined].some((room) => room.includes('executor-service'))).toBe(
      joinsUserRoom
    );
  });

  it.each([
    { kind: 'full service', terminalUserId: undefined, joinsUserRoom: false },
    { kind: 'terminal executor', terminalUserId: ALICE, joinsUserRoom: false },
  ])(
    'deduplicates handshake $kind authentication followed by the same service login',
    async ({ terminalUserId, joinsUserRoom }) => {
      const { app, io } = buildHarness();
      const socket = makeSocket('handshake-service');
      socket.handshake.auth = {
        token: issueRuntimeToken(
          {
            sub: 'executor-service',
            type: 'service',
            ...(terminalUserId ? { terminal_user_id: terminalUserId } : {}),
          },
          'test-secret',
          '5m'
        ),
      };

      await new Promise<void>((resolve, reject) => {
        io.middlewares[0]?.(socket, (error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      connect(io, socket);
      (app as any).eventHandlers.get('login')?.(
        { user: socket.feathers?.user },
        { connection: socket.feathers }
      );

      expect(logSpy).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith('socket authenticated: handshake-service service');
      expect([...socket.joined].some((room) => room.includes('executor-service'))).toBe(
        joinsUserRoom
      );
    }
  );

  it('revokes prior raw tenant and board rooms when authentication is replaced by service', () => {
    const { app, io } = buildHarness({
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const socket = makeSocket('replacement-sock');
    const connection = {};
    socket.feathers = connection;
    socket.data.tenant = { tenant_id: 'tenant-a', source: 'static' };
    socket.data.currentBoardId = 'board-1';
    socket.data.authorizedBoardIds = new Set(['board-1']);
    socket.joined.add(tenantChannelName('tenant-a'));
    socket.joined.add(tenantUserChannelName('tenant-a', ALICE));
    socket.joined.add(boardPresenceRoomName('tenant-a', 'board-1'));
    socket.joined.add(terminalChannel(ALICE, TERMINAL, 'tenant-a'));
    connect(io, socket);

    (app as any).eventHandlers.get('login')?.(
      { user: { user_id: 'executor-service', _isServiceAccount: true } },
      { connection }
    );

    expect([...socket.joined].filter((room) => room.startsWith('tenant:'))).toEqual([]);
    expect(socket.joined.has(terminalChannel(ALICE, TERMINAL, 'tenant-a'))).toBe(false);
    expect(socket.data.authorizedBoardIds).toEqual(new Set());
    expect(socket.data.currentBoardId).toBeUndefined();
    expect(socket.data.tenant).toBeUndefined();
  });

  it('revokes terminal output room membership on logout', () => {
    const { app, io } = buildHarness();
    const socket = makeSocket('logout-sock');
    asUser(socket, ALICE);
    const connection = socket.feathers;
    socket.joined.add(terminalChannel());
    connect(io, socket);

    (app as any).eventHandlers.get('logout')?.({}, { connection });

    expect(socket.joined.has(terminalChannel())).toBe(false);
  });

  it('emits an unconditional five-minute gauge and stops it when Engine.IO closes', () => {
    vi.useFakeTimers();
    const { io } = buildHarness();

    vi.advanceTimersByTime(5_000);
    expect(logSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60 * 1000 - 5_000);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenLastCalledWith(
      'ws_active_connections=0 ws_unauthenticated_disconnects=0'
    );

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenLastCalledWith(
      'ws_active_connections=0 ws_unauthenticated_disconnects=0'
    );

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

  it('aggregates sockets that disconnect before authentication and resets each interval', () => {
    vi.useFakeTimers();
    const { app, io } = buildHarness();
    const firstAnonymousSocket = makeSocket('anonymous-1');
    const secondAnonymousSocket = makeSocket('anonymous-2');
    const previouslyAuthenticatedSocket = makeSocket('authenticated');

    connect(io, firstAnonymousSocket);
    connect(io, secondAnonymousSocket);
    connect(io, previouslyAuthenticatedSocket);
    const connection = {};
    previouslyAuthenticatedSocket.feathers = connection;
    (app as any).eventHandlers.get('login')?.({ user: { user_id: ALICE } }, { connection });
    previouslyAuthenticatedSocket.feathers = {};
    debugSpy.mockClear();
    logSpy.mockClear();
    warnSpy.mockClear();

    firstAnonymousSocket.handlers.get('disconnect')?.('ping timeout');
    secondAnonymousSocket.handlers.get('disconnect')?.('client namespace disconnect');
    previouslyAuthenticatedSocket.handlers.get('disconnect')?.('ping timeout');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Socket.io disconnected: authenticated (reason: ping timeout')
    );
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('anonymous-');

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith(
      'ws_active_connections=0 ws_unauthenticated_disconnects=2'
    );

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith(
      'ws_active_connections=0 ws_unauthenticated_disconnects=0'
    );

    io.engine.closeHandler?.();
    const logCountAfterClose = logSpy.mock.calls.length;
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenCalledTimes(logCountAfterClose);
  });

  it('preserves transport-error warnings while aggregating unauthenticated disconnects', () => {
    vi.useFakeTimers();
    const { io } = buildHarness();
    const socket = makeSocket('transport-error');
    connect(io, socket);
    debugSpy.mockClear();

    socket.handlers.get('disconnect')?.('transport error');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reason: transport error'));
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(logSpy).toHaveBeenLastCalledWith(
      'ws_active_connections=0 ws_unauthenticated_disconnects=1'
    );
  });
});

describe('getSocketAuthState', () => {
  it('reports user auth when feathers.user.user_id is present', () => {
    const s = makeSocket();
    asUser(s, ALICE);
    expect(getSocketAuthState(s as any)).toEqual({
      userId: ALICE,
      isService: false,
      tenant: { tenant_id: 'default', source: 'static' },
    });
  });
  it('reports service auth for handshake-tagged sockets (socket.data.isService)', () => {
    const s = makeSocket();
    asServiceHandshake(s);
    expect(getSocketAuthState(s as any)).toEqual({ userId: null, isService: true });
  });
  it('reports service auth for post-connect authed sockets (_isServiceAccount only)', () => {
    // This is the path the executor actually takes:
    //   client.io.connect()  → anonymous, no socket.data.isService
    //   client.authenticate({ strategy: 'jwt', ... })
    //     → ServiceJWTStrategy.getEntity attaches _isServiceAccount: true
    // The previous implementation rejected these sockets for terminal:output /
    // exit / tab because it only checked socket.data.isService.
    const s = makeSocket();
    asServicePostConnect(s);
    expect(getSocketAuthState(s as any)).toEqual({ userId: null, isService: true });
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
// Handshake authentication
// ---------------------------------------------------------------------------

describe('socket handshake tenant propagation', () => {
  it('passes resolved JWT tenant context into the user lookup', async () => {
    const usersGet = vi.fn(async () => ({ user_id: ALICE, email: 'alice@example.test' }));
    const app = {
      service: () => ({ get: usersGet }),
      on: () => {},
    } as unknown as Application;
    const io = makeIO();
    const config = createSocketIOConfig(app, {
      corsOrigin: '*',
      jwtSecret: 'test-secret',
      credentialsAllowed: false,
      webTerminalEnabled: true,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'tenant_id',
      },
    } as SocketIOOptions);
    config.callback(io as any);
    const socket = makeSocket('tenant-user-socket', io);
    socket.handshake.auth = {
      token: issueRuntimeToken(
        { sub: ALICE, type: 'access', tenant_id: 'tenant-a' },
        'test-secret',
        '5m'
      ),
    };

    await new Promise<void>((resolve, reject) => {
      io.middlewares[0]?.(socket, (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    expect(usersGet).toHaveBeenCalledWith(
      ALICE,
      expect.objectContaining({
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        authentication: { payload: expect.objectContaining({ tenant_id: 'tenant-a' }) },
      })
    );
    expect(socket.feathers?.user).toMatchObject({ user_id: ALICE, tenant_id: 'tenant-a' });
    expect(socket.data.tenant).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
  });

  it('ignores a caller-supplied trusted tenant header on the Socket.IO handshake', async () => {
    const usersGet = vi.fn(async () => ({ user_id: ALICE }));
    const app = { service: () => ({ get: usersGet }), on: () => {} } as unknown as Application;
    const io = makeIO();
    createSocketIOConfig(app, {
      corsOrigin: '*',
      jwtSecret: 'test-secret',
      credentialsAllowed: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        trusted_header: 'x-agor-tenant-id',
      },
    } as SocketIOOptions).callback(io as never);
    const socket = makeSocket('header-tenant-socket', io);
    socket.handshake.auth = {
      token: issueRuntimeToken(
        { sub: ALICE, type: 'access', tenant_id: 'tenant-from-signature' },
        'test-secret',
        '5m'
      ),
    };
    socket.handshake.headers = { 'x-agor-tenant-id': 'attacker-selected-tenant' };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error).toBeUndefined();
    expect(socket.data.tenant?.tenant_id).toBe('tenant-from-signature');
    expect(usersGet).toHaveBeenCalledWith(
      ALICE,
      expect.objectContaining({
        tenant: expect.objectContaining({ tenant_id: 'tenant-from-signature' }),
      })
    );
  });

  it('rejects conflicting signed tenant aliases instead of selecting one', async () => {
    const { io } = buildHarness({
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'workspace_id',
      },
    });
    const socket = makeSocket('conflicting-claims', io);
    socket.handshake.auth = {
      token: issueRuntimeToken(
        {
          sub: ALICE,
          type: 'access',
          tenant_id: 'tenant-a',
          workspace_id: 'tenant-b',
        },
        'test-secret',
        '5m'
      ),
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error?.message).toBe('Invalid or expired authentication token');
    expect(socket.data.tenant).toBeUndefined();
  });

  it('rejects conflicting auth-object and Authorization-header credentials', async () => {
    const { io } = buildHarness();
    const socket = makeSocket('conflicting-credentials', io);
    socket.handshake.auth = {
      token: issueRuntimeToken({ sub: ALICE, type: 'access' }, 'test-secret', '5m'),
    };
    socket.handshake.headers = {
      authorization: `Bearer ${issueRuntimeToken({ sub: BOB, type: 'access' }, 'test-secret', '5m')}`,
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error?.message).toBe('Conflicting authentication credentials');
    expect(socket.feathers).toBeUndefined();
  });

  it('rejects user tokens invalidated after issuance', async () => {
    const usersGet = vi.fn(async () => ({
      user_id: ALICE,
      tokens_valid_after: new Date(Date.now() + 60_000).toISOString(),
    }));
    const app = { service: () => ({ get: usersGet }), on: () => {} } as unknown as Application;
    const io = makeIO();
    createSocketIOConfig(app, {
      corsOrigin: '*',
      jwtSecret: 'test-secret',
      credentialsAllowed: false,
    } as SocketIOOptions).callback(io as never);
    const socket = makeSocket('invalidated-token', io);
    socket.handshake.auth = {
      token: issueRuntimeToken({ sub: ALICE, type: 'access' }, 'test-secret', '5m'),
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error?.message).toBe('Invalid or expired authentication token');
    expect(socket.feathers).toBeUndefined();
  });

  it('rejects a service-typed JWT without the executor-service subject', async () => {
    const { io } = buildHarness();
    const socket = makeSocket('forged-service-shape', io);
    socket.handshake.auth = {
      token: issueRuntimeToken({ sub: ALICE, type: 'service' }, 'test-secret', '5m'),
    };

    const error = await new Promise<Error | undefined>((resolve) =>
      io.middlewares[0]?.(socket, resolve)
    );

    expect(error?.message).toBe('Invalid service token scope');
    expect(socket.data.isService).toBeUndefined();
  });

  it('disconnects an authenticated socket when its JWT expires', async () => {
    vi.useFakeTimers();
    try {
      const { io } = buildHarness();
      const socket = makeSocket('expiring-socket', io);
      socket.handshake.auth = {
        token: issueRuntimeToken({ sub: ALICE, type: 'access' }, 'test-secret', '1s'),
      };
      const error = await new Promise<Error | undefined>((resolve) =>
        io.middlewares[0]?.(socket, resolve)
      );
      expect(error).toBeUndefined();
      connect(io, socket);
      expect(socket.connected).toBe(true);

      await vi.advanceTimersByTimeAsync(1_100);

      expect(socket.connected).toBe(false);
      expect(socket.joined.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

    it('terminal:output accepts post-connect authed, user-scoped service sockets and relays', () => {
      // Regression for executor flow: connect anonymously, then
      // client.authenticate() attaches `_isServiceAccount: true` +
      // `terminal_user_id` to feathers.user without setting socket.data.isService.
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
        expect.stringContaining('not scoped to a terminal user')
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
      asServiceForUser(s, ALICE);
      s.feathers.user.terminal_owner_boot_id = 'old-boot';
      connect(io, s);
      s.handlers.get('join')?.(terminalChannel());
      expect(s.joined.has(terminalChannel())).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('owner boot fence'));
    });

    it('rejects an executor capability for a different branch attachment', () => {
      const { io } = buildHarness();
      const s = makeSocket('wrong-branch-executor');
      asServiceForUser(s, ALICE);
      s.feathers.user.terminal_branch_id = 'other-branch';
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
      asUser(tenantA, ALICE);
      asUser(tenantB, BOB);
      tenantA.data.tenant = { tenant_id: 'tenant-a', source: 'auth_claim' };
      tenantB.data.tenant = { tenant_id: 'tenant-b', source: 'auth_claim' };
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
          boardId: 'board-1',
          x: 10,
          y: 20,
          timestamp: 1_000,
        },
      });

      expect(io.emitted).toContainEqual({
        channel: tenantChannelName('default'),
        event: 'presence-updated',
        data: {
          userId: ALICE,
          timestamp: 1_000,
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

  it('does not restore a board room when logout races an in-flight authorization', async () => {
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
    (app as any).eventHandlers.get('logout')?.({}, { connection: s.feathers });
    resolveBoard({ board_id: 'board-1' });
    await watch;

    expect(s.joined.has(boardPresenceRoomName('default', 'board-1'))).toBe(false);
    expect(acknowledge).toHaveBeenCalledWith({ ok: false });
  });
});

describe('configureChannels tenant isolation', () => {
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

  function installTaskExecutorCapability(
    app: Application,
    connection: object,
    tenantId: string,
    sessionId: string,
    taskId: string
  ) {
    const fence = getOrCreateExecutorConnectionRevocationFence(app);
    const tenant = { tenant_id: tenantId, source: 'auth_claim' } as const;
    return commitExecutorConnectionCapability(
      connection,
      {
        tenantId,
        sessionId,
        taskId,
        expiresAt: Date.now() + 60_000,
        tokenFingerprint: fingerprintExecutorSessionToken(`${sessionId}:${taskId}`),
        revocationSnapshot: fence.snapshot(tenantId),
      },
      tenant,
      fence
    );
  }

  it('joins authenticated sockets to tenant-scoped channels on login', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'tenant_id',
      },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.(
      {
        user: { user_id: ALICE, email: 'alice@example.test' },
        authentication: { payload: { tenant_id: 'tenant-a' } },
      },
      { connection }
    );

    expect(connection.tenant).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
    expect(connection.data.tenant).toEqual({ tenant_id: 'tenant-a', source: 'auth_claim' });
    expect(joins.get('authenticated')).toEqual([connection]);
    expect(joins.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(joins.get(tenantUserChannelName('tenant-a', ALICE))).toEqual([connection]);
    expect(joins.has(tenantChannelName('tenant-b'))).toBe(false);
  });

  it('ignores caller-controlled login params and joins only from the signed tenant claim', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'tenant_id',
      },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.(
      {
        user: { user_id: ALICE, email: 'alice@example.test' },
        authentication: { payload: { tenant_id: 'tenant-from-signed-claim' } },
      },
      {
        connection,
        params: { tenant: { tenant_id: 'tenant-from-params', source: 'auth_claim' } },
      }
    );

    expect(connection.tenant).toEqual({
      tenant_id: 'tenant-from-signed-claim',
      source: 'auth_claim',
    });
    expect(connection.data.tenant).toEqual({
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
    configureChannels(app, {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'workspace_id',
      },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.(
      {
        user: { user_id: ALICE },
        authentication: { payload: { tenant_id: 'tenant-canonical' } },
      },
      { connection }
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
    configureChannels(app, {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'tenant_id',
      },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.(
      {
        user: { user_id: 'executor-service', _isTerminalExecutor: true },
        authentication: { payload: { tenant_id: 'tenant-a' } },
      },
      { connection }
    );

    expect(joins.size).toBe(0);
  });

  it('still joins a full service account to broadcast channels (service delivery)', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.(
      { user: { user_id: 'executor-service', _isServiceAccount: true }, authentication: {} },
      { connection }
    );

    expect(joins.get('authenticated')).toEqual([connection]);
  });

  it('leaves executor Task-room ownership to the Socket.IO capability commit', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'tenant_id',
      },
    });
    const connection = { data: {} } as any;
    installTaskExecutorCapability(app, connection, 'tenant-a', 'session-1', 'task-1');

    handlers.get('login')?.(
      {
        user: { user_id: ALICE },
        task_id: 'task-1',
        authentication: {
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            task_id: 'task-1',
            session_id: 'session-1',
            tenant_id: 'tenant-a',
          },
        },
      },
      { connection }
    );

    expect(joins.has(executorTaskChannelName('tenant-a', 'task-1'))).toBe(false);
    expect(getExecutorConnectionCapability(connection)).toBeUndefined();
  });

  it('does not trust an unscoped login or mismatched result task claim', () => {
    const { app, handlers, joins } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.(
      {
        user: { user_id: ALICE },
        task_id: 'task-2',
        authentication: {
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            task_id: 'task-1',
          },
        },
      },
      { connection }
    );

    expect(joins.has(executorTaskChannelName('tenant-a', 'task-1'))).toBe(false);
    expect(joins.has(executorTaskChannelName('tenant-a', 'task-2'))).toBe(false);
  });

  it('drops the prior Task room without independently joining the replacement room', () => {
    const { app, handlers, joins, leaves } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const connection = { data: {} } as any;
    joins.set(executorTaskChannelName('tenant-a', 'task-1'), [connection]);
    const login = (taskId: string) => {
      installTaskExecutorCapability(app, connection, 'tenant-a', 'session-1', taskId);
      handlers.get('login')?.(
        {
          user: { user_id: ALICE },
          task_id: taskId,
          authentication: {
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: taskId,
            },
          },
        },
        { connection }
      );
    };

    login('task-2');

    expect(joins.has(executorTaskChannelName('tenant-a', 'task-2'))).toBe(false);
    expect(leaves.get(executorTaskChannelName('tenant-a', 'task-1'))).toEqual([connection]);
    expect(joins.has('authenticated')).toBe(false);
    expect(joins.has(tenantChannelName('tenant-a'))).toBe(false);
    expect(joins.has(tenantUserChannelName('tenant-a', ALICE))).toBe(false);
  });

  it('revokes prior tenant and session-stream channels before replacing authentication', () => {
    const { app, handlers, joins, leaves } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as never,
        auth_claim: 'tenant_id',
      },
    });
    const connection = { data: {} } as any;
    const login = (tenantId: string, userId: string) =>
      handlers.get('login')?.(
        {
          user: { user_id: userId },
          authentication: { payload: { tenant_id: tenantId } },
        },
        { connection }
      );

    login('tenant-a', ALICE);
    joins.set(sessionStreamRoomName('tenant-a', 'session-a'), [connection]);
    login('tenant-b', BOB);

    expect(leaves.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(leaves.get(tenantUserChannelName('tenant-a', ALICE))).toEqual([connection]);
    expect(leaves.get(sessionStreamRoomName('tenant-a', 'session-a'))).toEqual([connection]);
    expect(joins.get(tenantChannelName('tenant-b'))).toEqual([connection]);
    expect(joins.get(tenantUserChannelName('tenant-b', BOB))).toEqual([connection]);
    expect(connection.tenant).toEqual({ tenant_id: 'tenant-b', source: 'auth_claim' });
  });

  it('revokes prior broadcast channels when authentication changes to a terminal executor', () => {
    const { app, handlers, joins, leaves } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const connection = { data: {} } as any;

    handlers.get('login')?.({ user: { user_id: ALICE }, authentication: {} }, { connection });
    handlers.get('login')?.(
      { user: { user_id: 'executor-service', _isTerminalExecutor: true } },
      { connection }
    );

    expect(joins.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(leaves.get('authenticated')).toEqual([connection, connection]);
    expect(leaves.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(leaves.get(tenantUserChannelName('tenant-a', ALICE))).toEqual([connection]);
    expect(connection.tenant).toBeUndefined();
    expect(connection.data.tenant).toBeUndefined();
  });

  it('leaves tenant-scoped channels on logout', () => {
    const { app, handlers, joins, leaves } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const connection = {
      data: { tenant: { tenant_id: 'tenant-a', source: 'static' } },
      feathers: { user: { user_id: ALICE } },
    } as any;
    // These channels exist only after an authenticated join in real Feathers.
    joins.set(tenantChannelName('tenant-a'), [connection]);
    joins.set(tenantUserChannelName('tenant-a', ALICE), [connection]);

    handlers.get('logout')?.({}, { connection });

    expect(leaves.get('authenticated')).toEqual([connection]);
    expect(leaves.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(leaves.get(tenantUserChannelName('tenant-a', ALICE))).toEqual([connection]);
  });
});
