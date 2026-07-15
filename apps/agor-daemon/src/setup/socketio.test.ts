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

import type { Application } from '@agor/core/feathers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueRuntimeToken } from '../auth/runtime-tokens.js';
import {
  boardPresenceRoomName,
  configureChannels,
  createSocketIOConfig,
  createTokenBucket,
  getSocketAuthState,
  parseTerminalChannel,
  type SocketIOOptions,
  tenantChannelName,
  tenantUserChannelName,
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
  left: Set<string>;
  /** Events actually delivered TO this socket (models room fanout). */
  received: Array<{ event: string; data: unknown }>;
  handlers: Map<string, (...args: any[]) => void>;
  on(event: string, fn: (...args: any[]) => void): void;
  join(channel: string): void;
  leave(channel: string): void;
  broadcast: {
    emit: (event: string, data: unknown) => void;
    to: (channel: string) => { emit: (event: string, data: unknown) => void };
  };
  // socket.to(room) — broadcasts to a room EXCLUDING this socket. Mirrors the
  // real socket.io semantics used by the terminal:output relay.
  to: (channel: string) => { emit: (event: string, data: unknown) => void };
}

interface FakeIO {
  connectionHandler?: (socket: FakeSocket) => void;
  emitted: Array<{ channel: string; event: string; data: unknown }>;
  /** Sender ids passed through the sender-excluding `socket.to` path. */
  excludedSenders: string[];
  sockets: { sockets: Map<string, FakeSocket> };
  middlewares: Array<(socket: FakeSocket, next: (err?: Error) => void) => void>;
  on(event: string, fn: any): void;
  use(fn: any): void;
  to(channel: string): { emit: (event: string, data: unknown) => void };
}

function makeSocket(id = 'sock1', io?: FakeIO): FakeSocket {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    id,
    data: {},
    handshake: { auth: {}, headers: {} },
    connected: true,
    joined: new Set(),
    left: new Set(),
    received: [],
    handlers,
    on(event, fn) {
      handlers.set(event, fn);
    },
    join(channel) {
      this.joined.add(channel);
    },
    leave(channel) {
      this.left.add(channel);
    },
    broadcast: {
      emit: (event: string, data: unknown) => {
        io?.emitted.push({ channel: '*', event, data });
      },
      to: (channel: string) => ({
        emit: (event: string, data: unknown) => {
          io?.emitted.push({ channel, event, data });
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
  };
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
    on(event, fn) {
      if (event === 'connection') {
        this.connectionHandler = fn;
      }
    },
    use(fn) {
      this.middlewares.push(fn);
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

function makeApp(): Application {
  // Minimal Application surface used by createSocketIOConfig: app.service('users').get,
  // app.on('login'), and app.emit for the terminal:ready/error relay. Tests
  // don't exercise the login event path.
  return {
    service: () => ({ get: async () => ({ user_id: 'u' }) }),
    on: () => {},
    emit: vi.fn(),
  } as any;
}

function buildHarness(opts: Partial<SocketIOOptions> = {}) {
  const app = makeApp();
  const io = makeIO();
  const config = createSocketIOConfig(app, {
    corsOrigin: '*',
    jwtSecret: 'test-secret',
    credentialsAllowed: false,
    webTerminalEnabled: true,
    ...opts,
  } as SocketIOOptions);
  config.callback(io as any);
  return { io, config, app };
}

function connect(io: FakeIO, socket: FakeSocket) {
  io.sockets.sockets.set(socket.id, socket);
  io.connectionHandler?.(socket);
}

// Identity helpers — keep all strings UUID-shaped enough for log slicing.
const ALICE = '11111111-aaaa-aaaa-aaaa-111111111111';
const BOB = '22222222-bbbb-bbbb-bbbb-222222222222';

function asUser(socket: FakeSocket, userId: string) {
  socket.feathers = { user: { user_id: userId } };
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
function asServiceForUser(socket: FakeSocket, userId: string) {
  socket.feathers = {
    user: {
      user_id: 'executor-service',
      role: 'terminal-executor',
      _isTerminalExecutor: true,
      terminal_user_id: userId,
    },
  };
}
/** Handshake-token variant of a user-scoped terminal executor socket. */
function asServiceHandshakeForUser(socket: FakeSocket, userId: string) {
  socket.feathers = {
    user: {
      user_id: 'executor-service',
      role: 'terminal-executor',
      _isTerminalExecutor: true,
      terminal_user_id: userId,
    },
  };
  socket.data.terminalUserId = userId;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseTerminalChannel', () => {
  it('extracts user id from a well-formed channel', () => {
    expect(parseTerminalChannel(`user/${ALICE}/terminal`)).toBe(ALICE);
  });
  it('rejects non-terminal channels', () => {
    expect(parseTerminalChannel('user/abc/other')).toBeNull();
    expect(parseTerminalChannel('foo/abc/terminal')).toBeNull();
    expect(parseTerminalChannel('')).toBeNull();
  });
  it('rejects empty or nested userIds', () => {
    expect(parseTerminalChannel('user//terminal')).toBeNull();
    expect(parseTerminalChannel('user/a/b/terminal')).toBeNull();
  });
});

describe('getSocketAuthState', () => {
  it('reports user auth when feathers.user.user_id is present', () => {
    const s = makeSocket();
    asUser(s, ALICE);
    expect(getSocketAuthState(s as any)).toEqual({ userId: ALICE, isService: false });
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
      terminalUserId: ALICE,
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
      s.handlers.get('terminal:input')?.({ userId: ALICE, input: 'rm -rf ~\r' });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('terminal:input rejected'));
    });

    it('rejects when payload userId does not match authed user (impersonation)', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      // Alice forges Bob's userId — must be rejected.
      s.handlers.get('terminal:input')?.({ userId: BOB, input: ': pwn\r' });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not match'));
    });

    it('accepts and re-emits with the AUTHED userId when payload matches', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:input')?.({ userId: ALICE, input: 'echo hi\r' });
      expect(io.emitted).toEqual([
        {
          channel: `user/${ALICE}/terminal`,
          event: 'terminal:input',
          // The handler must re-emit with the trusted userId (not whatever
          // the client sent), so executors never see attacker-controlled ids.
          data: { userId: ALICE, input: 'echo hi\r' },
        },
      ]);
    });

    it('rejects when allow_web_terminal is false', () => {
      const { io } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:input')?.({ userId: ALICE, input: 'echo hi\r' });
      expect(io.emitted).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('web terminal disabled'));
    });

    it('rate-limits per socket (drops events past the burst cap)', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      // Burst = 1000 tokens. Fire 1500 events back-to-back; expect ~1000
      // through, the rest dropped. Use ≤1000 / ≥500 bounds to allow tiny
      // wall-clock refill during the loop without making the test flaky.
      for (let i = 0; i < 1500; i++) {
        s.handlers.get('terminal:input')?.({ userId: ALICE, input: 'x' });
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
      s.handlers.get('terminal:resize')?.({ userId: BOB, cols: 1, rows: 1 });
      expect(io.emitted).toEqual([]);
    });

    it('accepts when payload userId matches authed user', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:resize')?.({ userId: ALICE, cols: 80, rows: 24 });
      expect(io.emitted).toEqual([
        {
          channel: `user/${ALICE}/terminal`,
          event: 'terminal:resize',
          data: { userId: ALICE, cols: 80, rows: 24 },
        },
      ]);
    });
  });

  describe('terminal:output / terminal:exit / terminal:tab (executor-only)', () => {
    it.each([
      'terminal:output',
      'terminal:exit',
      'terminal:tab',
    ])('%s rejects user-token sockets (only service may emit)', (event) => {
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
    });

    it('terminal:output accepts post-connect authed, user-scoped service sockets and relays', () => {
      // Regression for executor flow: connect anonymously, then
      // client.authenticate() attaches `_isServiceAccount: true` +
      // `terminal_user_id` to feathers.user without setting socket.data.isService.
      const { io } = buildHarness();
      const s = makeSocket('exec-sock', io);
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:output')?.({ userId: ALICE, data: 'hello' });
      expect(io.emitted).toEqual([
        {
          channel: `user/${ALICE}/terminal`,
          event: 'terminal:output',
          data: { userId: ALICE, data: 'hello' },
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
      s.handlers.get('terminal:output')?.({ userId: ALICE, data: 'hello' });
      expect(io.emitted).toEqual([
        {
          channel: `user/${ALICE}/terminal`,
          event: 'terminal:output',
          data: { userId: ALICE, data: 'hello' },
        },
      ]);
      expect(io.excludedSenders).toEqual(['exec-sock']);
    });

    it('terminal:output reaches every other room member but not the sending executor', () => {
      // Model the real topology: the executor and two browser tabs are all
      // joined to `user/<id>/terminal`. The relay must reach both browsers
      // while excluding the executor that produced the output.
      const { io } = buildHarness();
      const channel = `user/${ALICE}/terminal`;

      const exec = makeSocket('exec-sock', io);
      asServiceForUser(exec, ALICE);
      connect(io, exec);
      exec.join(channel);

      const browserA = makeSocket('browser-a', io);
      asUser(browserA, ALICE);
      connect(io, browserA);
      browserA.join(channel);

      const browserB = makeSocket('browser-b', io);
      asUser(browserB, ALICE);
      connect(io, browserB);
      browserB.join(channel);

      exec.handlers.get('terminal:output')?.({ userId: ALICE, data: 'hello' });

      const frame = { event: 'terminal:output', data: { userId: ALICE, data: 'hello' } };
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
      s.handlers.get('terminal:output')?.({ userId: ALICE, data: 'hi' });
      expect(io.emitted).toEqual([
        {
          channel: `user/${ALICE}/terminal`,
          event: 'terminal:output',
          data: { userId: ALICE, data: 'hi' },
        },
      ]);
    });

    it("a user-scoped executor may not emit output/tab for a different user's channel", () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:output')?.({ userId: BOB, data: 'x' });
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
      s.handlers.get('terminal:output')?.({ userId: ALICE, data: 'x' });
      s.handlers.get('terminal:exit')?.({ userId: ALICE, exitCode: 0 });
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
      s.handlers.get('terminal:output')?.({ userId: ALICE, data: 'x' });
      s.handlers.get('terminal:exit')?.({ userId: ALICE, exitCode: 0 });
      s.handlers.get('terminal:tab')?.({ userId: ALICE, action: 'create', tabName: 't' });
      expect(io.emitted).toEqual([]);
    });
  });

  describe('terminal:ready / terminal:error (executor readiness acks)', () => {
    it('relays a user-scoped service socket ready ack to the app', () => {
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: ALICE, sessionName: 'agor-x', tabName: 't' });
      expect(app.emit).toHaveBeenCalledWith('terminal:ready', {
        userId: ALICE,
        sessionName: 'agor-x',
        tabName: 't',
      });
    });

    it('relays a user-scoped service socket error ack to the app', () => {
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:error')?.({ userId: ALICE, message: 'boom' });
      expect(app.emit).toHaveBeenCalledWith('terminal:error', { userId: ALICE, message: 'boom' });
    });

    it("rejects an executor scoped to ALICE flipping BOB's readiness (cross-user forgery)", () => {
      const { io, app } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: BOB });
      s.handlers.get('terminal:error')?.({ userId: BOB, message: 'spoof' });
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
      s.handlers.get('terminal:ready')?.({ userId: ALICE });
      s.handlers.get('terminal:error')?.({ userId: ALICE });
      expect(app.emit).not.toHaveBeenCalled();
    });

    it('rejects ready/error acks from user-token sockets (only service may emit)', () => {
      const { io, app } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: ALICE });
      s.handlers.get('terminal:error')?.({ userId: ALICE, message: 'spoof' });
      expect(app.emit).not.toHaveBeenCalled();
    });

    it('rejects ready/error acks when allow_web_terminal is false', () => {
      const { io, app } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('terminal:ready')?.({ userId: ALICE });
      s.handlers.get('terminal:error')?.({ userId: ALICE });
      expect(app.emit).not.toHaveBeenCalled();
    });
  });

  describe('join / leave', () => {
    it('rejects unauthenticated joins', () => {
      const { io } = buildHarness();
      const s = makeSocket('anon');
      connect(io, s);
      s.handlers.get('join')?.(`user/${ALICE}/terminal`);
      expect(s.joined.size).toBe(0);
    });

    it("rejects a user joining another user's terminal channel", () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      // Authed users are auto-joined to `user:<id>` presence room on
      // connect — assert specifically that the terminal channel is NOT
      // joined rather than `joined.size === 0`.
      s.handlers.get('join')?.(`user/${BOB}/terminal`);
      expect(s.joined.has(`user/${BOB}/terminal`)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('join rejected'));
    });

    it('allows a user to join their own terminal channel', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(`user/${ALICE}/terminal`);
      expect(s.joined.has(`user/${ALICE}/terminal`)).toBe(true);
    });

    it('allows a user-scoped executor to join ONLY its own user terminal channel', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServiceForUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(`user/${ALICE}/terminal`);
      s.handlers.get('join')?.(`user/${BOB}/terminal`);
      expect(s.joined.has(`user/${ALICE}/terminal`)).toBe(true);
      // Scoped to ALICE — must NOT be able to join BOB's channel and harvest
      // his terminal traffic.
      expect(s.joined.has(`user/${BOB}/terminal`)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('may not join'));
    });

    it('rejects a join from an unscoped service token entirely', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asServicePostConnect(s); // service, no terminal scope
      connect(io, s);
      s.handlers.get('join')?.(`user/${ALICE}/terminal`);
      expect(s.joined.has(`user/${ALICE}/terminal`)).toBe(false);
    });

    it('rejects join when allow_web_terminal is false', () => {
      const { io } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('join')?.(`user/${ALICE}/terminal`);
      expect(s.joined.has(`user/${ALICE}/terminal`)).toBe(false);
    });

    it("rejects a user leaving another user's terminal channel", () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('leave')?.(`user/${BOB}/terminal`);
      expect(s.left.size).toBe(0);
    });

    it('still allows leaving non-terminal channels (no auth check applied)', () => {
      // The hardening is scoped to terminal channels; non-terminal channels
      // (e.g. board-foo) keep the prior behavior so we don't regress
      // unrelated WS features.
      const { io } = buildHarness();
      const s = makeSocket('alice-sock');
      asUser(s, ALICE);
      connect(io, s);
      s.handlers.get('leave')?.('board:abc');
      expect(s.left.has('board:abc')).toBe(true);
    });
  });

  describe('cursor presence routing', () => {
    it('joins and leaves board presence rooms explicitly', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock', io);
      asUser(s, ALICE);
      connect(io, s);

      s.handlers.get('presence:watch-board')?.('board-1');
      expect(s.joined.has(boardPresenceRoomName('board-1'))).toBe(true);

      s.handlers.get('presence:unwatch-board')?.('board-1');
      expect(s.left.has(boardPresenceRoomName('board-1'))).toBe(true);
    });

    it('routes cursor-moved only to the active board room and emits a lightweight global presence update', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock', io);
      asUser(s, ALICE);
      connect(io, s);

      s.handlers.get('cursor-move')?.({
        boardId: 'board-1',
        x: 10,
        y: 20,
        timestamp: 1_000,
      });

      expect(io.emitted).toContainEqual({
        channel: boardPresenceRoomName('board-1'),
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
        channel: '*',
        event: 'presence-updated',
        data: {
          userId: ALICE,
          boardId: 'board-1',
          timestamp: 1_000,
        },
      });
    });

    it('coalesces global presence updates but still streams per-board cursor movement', () => {
      const { io } = buildHarness();
      const s = makeSocket('alice-sock', io);
      asUser(s, ALICE);
      connect(io, s);

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
        io.emitted.filter((entry) => entry.event === 'presence-updated' && entry.channel === '*')
      ).toHaveLength(1);
      expect(
        io.emitted.filter(
          (entry) =>
            entry.event === 'cursor-moved' && entry.channel === boardPresenceRoomName('board-1')
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
    expect(s.joined.has(boardPresenceRoomName('board-1'))).toBe(false);
  });

  it('DOES join a normal authenticated user to a board presence room', () => {
    const { io } = buildHarness();
    const s = makeSocket('alice-sock');
    asUser(s, ALICE);
    connect(io, s);
    s.handlers.get('presence:watch-board')?.('board-1');
    expect(s.joined.has(boardPresenceRoomName('board-1'))).toBe(true);
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

  it('still broadcasts cursor-move from a normal user', () => {
    const { io } = buildHarness();
    const s = makeSocket('alice-sock', io);
    asUser(s, ALICE);
    connect(io, s);
    s.handlers.get('cursor-move')?.({ boardId: 'board-1', x: 1, y: 2, timestamp: 1 });
    expect(io.emitted.some((e) => e.event === 'cursor-moved')).toBe(true);
  });
});

describe('configureChannels tenant isolation', () => {
  function makeChannelHarness() {
    const handlers = new Map<string, (...args: any[]) => void>();
    const joins = new Map<string, unknown[]>();
    const leaves = new Map<string, unknown[]>();
    const app = {
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

  it('joins tenant channel from login params when auth result has no tenant claim yet', () => {
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
        authentication: { payload: {} },
      },
      {
        connection,
        params: { tenant: { tenant_id: 'tenant-from-params', source: 'auth_claim' } },
      }
    );

    expect(connection.tenant).toEqual({ tenant_id: 'tenant-from-params', source: 'auth_claim' });
    expect(connection.data.tenant).toEqual({
      tenant_id: 'tenant-from-params',
      source: 'auth_claim',
    });
    expect(joins.get('authenticated')).toEqual([connection]);
    expect(joins.get(tenantChannelName('tenant-from-params'))).toEqual([connection]);
    expect(joins.get(tenantUserChannelName('tenant-from-params', ALICE))).toEqual([connection]);
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

  it('leaves tenant-scoped channels on logout', () => {
    const { app, handlers, leaves } = makeChannelHarness();
    configureChannels(app, {
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });
    const connection = {
      data: { tenant: { tenant_id: 'tenant-a', source: 'static' } },
      feathers: { user: { user_id: ALICE } },
    } as any;

    handlers.get('logout')?.({}, { connection });

    expect(leaves.get('authenticated')).toEqual([connection]);
    expect(leaves.get(tenantChannelName('tenant-a'))).toEqual([connection]);
    expect(leaves.get(tenantUserChannelName('tenant-a', ALICE))).toEqual([connection]);
  });
});
