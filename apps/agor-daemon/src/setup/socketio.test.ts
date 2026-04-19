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
 *     into another user's terminal or open a Zellij tab in a worktree
 *     they don't have RBAC on.
 *   - terminal:input must be rate-limited per-socket.
 *
 * Strategy: build a minimal fake socket / fake io / fake app, run the
 * connection callback, capture the registered handlers, and exercise them
 * directly. Avoids spinning a real socket.io server / port.
 */

import type { Application } from '@agor/core/feathers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
  left: Set<string>;
  handlers: Map<string, (...args: any[]) => void>;
  on(event: string, fn: (...args: any[]) => void): void;
  join(channel: string): void;
  leave(channel: string): void;
  broadcast: { emit: (...args: any[]) => void };
}

interface FakeIO {
  connectionHandler?: (socket: FakeSocket) => void;
  emitted: Array<{ channel: string; event: string; data: unknown }>;
  sockets: { sockets: Map<string, FakeSocket> };
  middlewares: Array<(socket: FakeSocket, next: (err?: Error) => void) => void>;
  on(event: string, fn: any): void;
  use(fn: any): void;
  to(channel: string): { emit: (event: string, data: unknown) => void };
}

function makeSocket(id = 'sock1'): FakeSocket {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    id,
    data: {},
    handshake: { auth: {}, headers: {} },
    connected: true,
    joined: new Set(),
    left: new Set(),
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
    broadcast: { emit: () => {} },
  };
}

function makeIO(): FakeIO {
  const io: FakeIO = {
    emitted: [],
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
      const emitted = this.emitted;
      return {
        emit(event: string, data: unknown) {
          emitted.push({ channel, event, data });
        },
      };
    },
  };
  return io;
}

function makeApp(): Application {
  // Minimal Application surface used by createSocketIOConfig: app.service('users').get
  // and app.on('login'). Tests don't exercise the login event path.
  return {
    service: () => ({ get: async () => ({ user_id: 'u' }) }),
    on: () => {},
  } as any;
}

function buildHarness(opts: Partial<SocketIOOptions> = {}) {
  const app = makeApp();
  const io = makeIO();
  const config = createSocketIOConfig(app, {
    corsOrigin: '*',
    jwtSecret: 'test-secret',
    allowAnonymous: false,
    credentialsAllowed: false,
    webTerminalEnabled: true,
    ...opts,
  } as SocketIOOptions);
  config.callback(io as any);
  return { io, config };
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
function asService(socket: FakeSocket) {
  socket.feathers = {};
  socket.data.isService = true;
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
    expect(getSocketAuthState(s as any)).toEqual({
      userId: ALICE,
      isService: false,
      isAuthenticated: true,
    });
  });
  it('reports service auth when socket.data.isService is set', () => {
    const s = makeSocket();
    asService(s);
    expect(getSocketAuthState(s as any)).toEqual({
      userId: null,
      isService: true,
      isAuthenticated: true,
    });
  });
  it('reports unauthenticated when neither marker is present', () => {
    const s = makeSocket();
    expect(getSocketAuthState(s as any)).toEqual({
      userId: null,
      isService: false,
      isAuthenticated: false,
    });
  });
  it('treats an empty feathers object without isService as anonymous', () => {
    // Defends against confusing service ↔ "feathers attached but no user yet".
    const s = makeSocket();
    s.feathers = {};
    expect(getSocketAuthState(s as any).isAuthenticated).toBe(false);
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

    it('terminal:output accepts service sockets and relays to the channel', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asService(s);
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

    it('all three reject when allow_web_terminal is false even for service sockets', () => {
      const { io } = buildHarness({ webTerminalEnabled: false });
      const s = makeSocket('exec-sock');
      asService(s);
      connect(io, s);
      s.handlers.get('terminal:output')?.({ userId: ALICE, data: 'x' });
      s.handlers.get('terminal:exit')?.({ userId: ALICE, exitCode: 0 });
      s.handlers.get('terminal:tab')?.({ userId: ALICE, action: 'create', tabName: 't' });
      expect(io.emitted).toEqual([]);
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

    it('allows a service socket to join any user terminal channel', () => {
      const { io } = buildHarness();
      const s = makeSocket('exec-sock');
      asService(s);
      connect(io, s);
      s.handlers.get('join')?.(`user/${ALICE}/terminal`);
      s.handlers.get('join')?.(`user/${BOB}/terminal`);
      expect(s.joined.has(`user/${ALICE}/terminal`)).toBe(true);
      expect(s.joined.has(`user/${BOB}/terminal`)).toBe(true);
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
});
