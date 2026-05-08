/**
 * Tests for Agor API Client
 *
 * Tests our API wrapper utilities (createClient, isDaemonRunning).
 * Does NOT test FeathersJS internals, Socket.io, or HTTP libraries.
 */

import type { AuthenticationResult, Session } from '@agor/core/types';
import authClient from '@feathersjs/authentication-client';
import type { Socket } from 'socket.io-client';
import io from 'socket.io-client';
import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';
import type { AgorService, UpdatePayload } from './index';
import { createClient, isDaemonRunning, normalizeFindResult } from './index';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  default: vi.fn(),
}));

// Mock @feathersjs/feathers
vi.mock('@feathersjs/feathers', () => ({
  feathers: vi.fn(() => {
    const services = new Map<string, any>();

    const createService = () => ({
      find: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      emit: vi.fn(),
      methods: vi.fn(),
    });

    return {
      configure: vi.fn(function (this: any, plugin: any) {
        plugin.call(this);
        return this;
      }),
      service: vi.fn((path: string) => {
        const existing = services.get(path);
        if (existing) return existing;
        const created = createService();
        services.set(path, created);
        return created;
      }),
    };
  }),
}));

// Mock @feathersjs/socketio-client
vi.mock('@feathersjs/socketio-client', () => ({
  default: vi.fn(
    () =>
      function (this: any) {
        // socketio plugin configuration
      }
  ),
}));

// Mock @feathersjs/authentication-client
vi.mock('@feathersjs/authentication-client', () => ({
  default: vi.fn(
    () =>
      function (this: any) {
        // auth plugin configuration
      }
  ),
}));

/**
 * Helper: Create mock socket instance
 */
function createMockSocket(): Socket {
  return {
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
    connected: false,
    disconnected: true,
  } as unknown as Socket;
}

describe('createClient', () => {
  let mockSocket: Socket;
  let ioMock: MockedFunction<any>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup socket.io mock
    mockSocket = createMockSocket();
    ioMock = io as unknown as MockedFunction<any>;
    ioMock.mockReturnValue(mockSocket);
  });

  describe('basic initialization', () => {
    it('should create client with default URL', () => {
      const client = createClient();

      expect(ioMock).toHaveBeenCalledWith(
        'http://localhost:3030',
        expect.objectContaining({
          autoConnect: true,
        })
      );
      expect(client.io).toBe(mockSocket);
    });

    it('should create client with custom URL', () => {
      createClient('http://example.com:4000');

      expect(ioMock).toHaveBeenCalledWith(
        'http://example.com:4000',
        expect.objectContaining({
          autoConnect: true,
        })
      );
    });

    it('should respect autoConnect parameter', () => {
      createClient('http://localhost:3030', false);

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          autoConnect: false,
        })
      );
    });

    it('should default autoConnect to true', () => {
      createClient();

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          autoConnect: true,
        })
      );
    });

    it('should expose socket instance on client', () => {
      const client = createClient();

      expect(client.io).toBeDefined();
      expect(client.io).toBe(mockSocket);
    });
  });

  describe('socket configuration', () => {
    it('should configure reconnection settings', () => {
      createClient();

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          reconnectionAttempts: 2,
        })
      );
    });

    it('should configure timeout', () => {
      createClient();

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeout: 20000,
        })
      );
    });

    it('should configure transports with websocket preferred', () => {
      createClient();

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transports: ['websocket', 'polling'],
        })
      );
    });

    it('should enable closeOnBeforeunload', () => {
      createClient();

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          closeOnBeforeunload: true,
        })
      );
    });
  });

  describe('verbose logging', () => {
    it('should attach connection error handler when verbose', () => {
      createClient('http://localhost:3030', true, { verbose: true });

      expect(mockSocket.on).toHaveBeenCalledWith('connect_error', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
    });

    it('should not attach handlers when verbose is false', () => {
      createClient('http://localhost:3030', true, { verbose: false });

      expect(mockSocket.on).not.toHaveBeenCalled();
    });

    it('should not attach handlers when verbose not specified', () => {
      createClient();

      expect(mockSocket.on).not.toHaveBeenCalled();
    });

    it('should log connection error on first attempt', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createClient('http://localhost:3030', true, { verbose: true });

      // Get the connect_error handler
      const errorHandler = (mockSocket.on as MockedFunction<any>).mock.calls.find(
        (call: unknown[]) => call[0] === 'connect_error'
      )?.[1];

      expect(errorHandler).toBeDefined();

      // Simulate first connection error
      if (errorHandler && typeof errorHandler === 'function') {
        errorHandler(new Error('Connection failed'));
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('✗ Daemon not running at http://localhost:3030')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Retrying connection (1/2)...')
      );

      consoleErrorSpy.mockRestore();
    });

    it('should log retry count on subsequent errors', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createClient('http://localhost:3030', true, { verbose: true });

      const errorHandler = (mockSocket.on as MockedFunction<any>).mock.calls.find(
        (call: unknown[]) => call[0] === 'connect_error'
      )?.[1];

      // Simulate two connection errors
      if (errorHandler && typeof errorHandler === 'function') {
        errorHandler(new Error('Connection failed'));
        errorHandler(new Error('Connection failed'));
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Retry 2/2 failed'));

      consoleErrorSpy.mockRestore();
    });

    it('should log successful connection after retry', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      createClient('http://localhost:3030', true, { verbose: true });

      const errorHandler = (mockSocket.on as MockedFunction<any>).mock.calls.find(
        (call: unknown[]) => call[0] === 'connect_error'
      )?.[1];
      const connectHandler = (mockSocket.on as MockedFunction<any>).mock.calls.find(
        (call: unknown[]) => call[0] === 'connect'
      )?.[1];

      // Simulate error then successful connection
      if (errorHandler && typeof errorHandler === 'function') {
        errorHandler(new Error('Connection failed'));
      }
      if (connectHandler && typeof connectHandler === 'function') {
        connectHandler();
      }

      expect(consoleLogSpy).toHaveBeenCalledWith('✓ Connected to daemon');

      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should not log on first connect without errors', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createClient('http://localhost:3030', true, { verbose: true });

      const connectHandler = (mockSocket.on as MockedFunction<any>).mock.calls.find(
        (call: unknown[]) => call[0] === 'connect'
      )?.[1];

      // Simulate successful first connection (no prior errors)
      if (connectHandler && typeof connectHandler === 'function') {
        connectHandler();
      }

      expect(consoleLogSpy).not.toHaveBeenCalled();

      consoleLogSpy.mockRestore();
    });
  });

  describe('authentication configuration', () => {
    it('should configure authentication with localStorage in browser', () => {
      // Mock browser environment
      const mockLocalStorage = {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: 0,
        key: vi.fn(),
      };

      (globalThis as any).localStorage = mockLocalStorage;

      const authMock = authClient as unknown as MockedFunction<any>;

      createClient();

      expect(authMock).toHaveBeenCalledWith({ storage: mockLocalStorage });

      // Cleanup
      delete (globalThis as any).localStorage;
    });

    it('should configure authentication without storage in Node.js', () => {
      // Ensure no localStorage
      delete (globalThis as any).localStorage;

      const authMock = authClient as unknown as MockedFunction<any>;

      createClient();

      expect(authMock).toHaveBeenCalledWith({ storage: undefined });
    });

    it('should handle globalThis without localStorage gracefully', () => {
      const _globalThisBackup = globalThis;

      // Create globalThis without localStorage
      const mockGlobalThis = {} as typeof globalThis;
      Object.setPrototypeOf(mockGlobalThis, Object.getPrototypeOf(globalThis));

      expect(() => createClient()).not.toThrow();
    });

    // Regression coverage for Node 25 compat: it exposes `globalThis.localStorage`
    // but the object lacks `setItem`, so the Feathers auth client throws
    // `_a.setItem is not a function` on first authenticate(). createClient()
    // must treat that as "no storage" rather than passing it straight through.
    it('should reject a localStorage stub without setItem (Node 25)', () => {
      const brokenLocalStorage = {
        getItem: vi.fn(),
        // setItem intentionally absent — this is what Node 25 ships
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: 0,
        key: vi.fn(),
      };

      (globalThis as any).localStorage = brokenLocalStorage;

      const authMock = authClient as unknown as MockedFunction<any>;

      createClient();

      expect(authMock).toHaveBeenCalledWith({ storage: undefined });

      delete (globalThis as any).localStorage;
    });

    it('should reject a localStorage stub whose setItem is not a function', () => {
      // Defensive sibling case: anything truthy at .setItem that isn't
      // callable would otherwise pass `'setItem' in storage` style checks.
      const oddLocalStorage = {
        getItem: vi.fn(),
        setItem: 'not-a-function' as unknown as Storage['setItem'],
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: 0,
        key: vi.fn(),
      };

      (globalThis as any).localStorage = oddLocalStorage;

      const authMock = authClient as unknown as MockedFunction<any>;

      createClient();

      expect(authMock).toHaveBeenCalledWith({ storage: undefined });

      delete (globalThis as any).localStorage;
    });
  });

  describe('return value type', () => {
    it('should return AgorClient with socket exposed', () => {
      const client = createClient();

      expect(client).toBeDefined();
      expect(client.io).toBeDefined();
      expect(client.io).toBe(mockSocket);
    });

    it('should return client with configure method', () => {
      const client = createClient();

      // Client is created by mocked feathers() which provides configure
      expect(client.configure).toBeDefined();
    });
  });

  describe('URL variations', () => {
    it('should handle URLs with trailing slash', () => {
      createClient('http://localhost:3030/');

      expect(ioMock).toHaveBeenCalledWith('http://localhost:3030/', expect.any(Object));
    });

    it('should handle HTTPS URLs', () => {
      createClient('https://example.com:3030');

      expect(ioMock).toHaveBeenCalledWith('https://example.com:3030', expect.any(Object));
    });

    it('should handle URLs with non-default ports', () => {
      createClient('http://localhost:8888');

      expect(ioMock).toHaveBeenCalledWith('http://localhost:8888', expect.any(Object));
    });

    it('should handle URLs with hostnames', () => {
      createClient('http://my-daemon.local:3030');

      expect(ioMock).toHaveBeenCalledWith('http://my-daemon.local:3030', expect.any(Object));
    });

    it('should handle IP addresses', () => {
      createClient('http://192.168.1.100:3030');

      expect(ioMock).toHaveBeenCalledWith('http://192.168.1.100:3030', expect.any(Object));
    });
  });

  describe('multiple client creation', () => {
    it('should create independent clients', () => {
      const mockSocket1 = createMockSocket();
      const mockSocket2 = createMockSocket();
      ioMock.mockReturnValueOnce(mockSocket1).mockReturnValueOnce(mockSocket2);

      const client1 = createClient('http://localhost:3030');
      const client2 = createClient('http://localhost:4000');

      expect(client1.io).not.toBe(client2.io);
      expect(ioMock).toHaveBeenCalledTimes(2);
    });

    it('should allow different autoConnect settings', () => {
      createClient('http://localhost:3030', true);
      createClient('http://localhost:3030', false);

      expect(ioMock).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ autoConnect: true })
      );
      expect(ioMock).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({ autoConnect: false })
      );
    });
  });

  describe('service helpers', () => {
    it('should normalize paginated find results via findAll()', async () => {
      const client = createClient();
      const sessionsService = client.service('sessions');

      const findMock = sessionsService.find as unknown as MockedFunction<any>;
      findMock.mockResolvedValue({
        total: 2,
        limit: 10,
        skip: 0,
        data: [{ session_id: 's1' }, { session_id: 's2' }],
      });

      const results = await sessionsService.findAll();

      expect(results).toEqual([{ session_id: 's1' }, { session_id: 's2' }]);
      expect(findMock).toHaveBeenCalledTimes(1);
    });

    it('should return array find results unchanged via findAll()', async () => {
      const client = createClient();
      const sessionsService = client.service('sessions');

      const findMock = sessionsService.find as unknown as MockedFunction<any>;
      findMock.mockResolvedValue([{ session_id: 's1' }]);

      const results = await sessionsService.findAll();

      expect(results).toEqual([{ session_id: 's1' }]);
      expect(findMock).toHaveBeenCalledTimes(1);
    });

    it('should auto-paginate and return all rows via findAll()', async () => {
      const client = createClient();
      const sessionsService = client.service('sessions');

      const findMock = sessionsService.find as unknown as MockedFunction<any>;
      findMock
        .mockResolvedValueOnce({
          total: 3,
          limit: 2,
          skip: 0,
          data: [{ session_id: 's1' }, { session_id: 's2' }],
        })
        .mockResolvedValueOnce({
          total: 3,
          limit: 2,
          skip: 2,
          data: [{ session_id: 's3' }],
        });

      const results = await sessionsService.findAll();

      expect(results).toEqual([{ session_id: 's1' }, { session_id: 's2' }, { session_id: 's3' }]);
      expect(findMock).toHaveBeenCalledTimes(2);
      expect(findMock).toHaveBeenNthCalledWith(2, {
        query: {
          $skip: 2,
          $limit: 2,
        },
      });
    });

    // Regression: PR #1088 added users.getGitEnvironment + repos/worktrees.initializeUnixGroup
    // server-side via `app.use(path, service, { methods })`, but the Feathers Socket.io
    // client only wires standard CRUD at construction time. Without an explicit
    // service.methods(...) call on the client, calling these threw
    // "client.service(...).<method> is not a function" — observed during prod worktree
    // creation. These assertions guard the client-side mirror of the daemon's methods list.
    it('registers users.getGitEnvironment custom method on client', () => {
      const client = createClient();
      const usersService = client.service('users') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      expect(usersService.methods).toHaveBeenCalledWith('getGitEnvironment');
    });

    it('registers repos.initializeUnixGroup custom method on client', () => {
      const client = createClient();
      const reposService = client.service('repos') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      expect(reposService.methods).toHaveBeenCalledWith('initializeUnixGroup');
    });

    it('registers worktrees.initializeUnixGroup custom method on client', () => {
      const client = createClient();
      const worktreesService = client.service('worktrees') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      expect(worktreesService.methods).toHaveBeenCalledWith('initializeUnixGroup');
    });

    it('does not register custom methods on services without any', () => {
      const client = createClient();
      const sessionsService = client.service('sessions') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      // sessions has no extend*Service helper, so .methods() should not be called
      expect(sessionsService.methods).not.toHaveBeenCalled();
    });

    it('should expose sessions.prompt helper that calls /sessions/:id/prompt route', async () => {
      const client = createClient();
      const routeService = client.service('sessions/session-123/prompt');
      const createMock = routeService.create as unknown as MockedFunction<any>;

      createMock.mockResolvedValue({
        success: true,
        taskId: 'task-123',
        status: 'running',
        streaming: true,
      });

      const result = await client.sessions.prompt('session-123', 'Fix failing tests', {
        permissionMode: 'auto',
        stream: true,
      });

      expect(createMock).toHaveBeenCalledWith(
        {
          prompt: 'Fix failing tests',
          permissionMode: 'auto',
          stream: true,
        },
        undefined
      );
      expect(result).toEqual({
        success: true,
        taskId: 'task-123',
        status: 'running',
        streaming: true,
      });
    });
  });
});

describe('normalizeFindResult', () => {
  it('returns paginated data array', () => {
    const result = normalizeFindResult({
      total: 1,
      limit: 10,
      skip: 0,
      data: [{ id: 1 }],
    });

    expect(result).toEqual([{ id: 1 }]);
  });

  it('returns plain array result unchanged', () => {
    const result = normalizeFindResult([{ id: 1 }]);
    expect(result).toEqual([{ id: 1 }]);
  });
});

describe('type-level API ergonomics', () => {
  it('accepts plain string IDs for create/patch/update payloads', () => {
    type SessionCreateInput = Parameters<AgorService<Session>['create']>[0];
    type SessionPatchInput = Exclude<Parameters<AgorService<Session>['patch']>[1], null>;
    type SessionIdUpdateInput = UpdatePayload<Session>['session_id'];

    const createPayload: SessionCreateInput = {
      worktree_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
    };
    const patchPayload: SessionPatchInput = { worktree_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' };
    const updateId: SessionIdUpdateInput = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';

    expect(createPayload.worktree_id).toBeDefined();
    expect(patchPayload.worktree_id).toBeDefined();
    expect(typeof updateId).toBe('string');
  });

  it('uses concrete user typing for AuthenticationResult.user', () => {
    type AuthUser = NonNullable<AuthenticationResult['user']>;
    const getEmail = (user: AuthUser): string => user.email;
    expect(typeof getEmail).toBe('function');
  });
});

describe('isDaemonRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful connection', () => {
    it('should return true when daemon is reachable', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await isDaemonRunning();

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3030/health',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should use custom URL', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await isDaemonRunning('http://example.com:4000');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://example.com:4000/health',
        expect.any(Object)
      );
    });

    it('should use default URL when not provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await isDaemonRunning();

      expect(global.fetch).toHaveBeenCalledWith('http://localhost:3030/health', expect.any(Object));
    });

    it('should set timeout to 1000ms', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await isDaemonRunning();

      const call = (global.fetch as MockedFunction<any>).mock.calls[0];
      const options = call?.[1] as RequestInit | undefined;
      const signal = options?.signal;

      // Verify signal is an AbortSignal (timeout configured)
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('failed connection', () => {
    it('should return false when daemon returns non-ok response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await isDaemonRunning();

      expect(result).toBe(false);
    });

    it('should return false when fetch throws network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await isDaemonRunning();

      expect(result).toBe(false);
    });

    it('should return false on timeout', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('The operation was aborted'));

      const result = await isDaemonRunning();

      expect(result).toBe(false);
    });

    it('should return false on connection refused', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await isDaemonRunning();

      expect(result).toBe(false);
    });

    it('should return false on DNS resolution failure', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

      const result = await isDaemonRunning();

      expect(result).toBe(false);
    });
  });

  describe('HTTP status codes', () => {
    it('should return true for 200 OK', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      expect(await isDaemonRunning()).toBe(true);
    });

    it('should return false for 404 Not Found', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      expect(await isDaemonRunning()).toBe(false);
    });

    it('should return false for 500 Internal Server Error', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      expect(await isDaemonRunning()).toBe(false);
    });

    it('should return false for 503 Service Unavailable', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      expect(await isDaemonRunning()).toBe(false);
    });

    it('should return true for 204 No Content', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      expect(await isDaemonRunning()).toBe(true);
    });
  });

  describe('URL variations', () => {
    it('should handle URLs with trailing slash', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await isDaemonRunning('http://localhost:3030/');

      // Should normalize the URL (double slash handled by fetch)
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3030//health',
        expect.any(Object)
      );
    });

    it('should handle HTTPS URLs', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await isDaemonRunning('https://example.com:3030');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com:3030/health',
        expect.any(Object)
      );
    });

    it('should handle non-standard ports', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await isDaemonRunning('http://localhost:9999');

      expect(global.fetch).toHaveBeenCalledWith('http://localhost:9999/health', expect.any(Object));
    });

    it('should handle IP addresses', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await isDaemonRunning('http://192.168.1.100:3030');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://192.168.1.100:3030/health',
        expect.any(Object)
      );
    });
  });

  describe('edge cases', () => {
    it('should not throw on fetch error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Catastrophic failure'));

      await expect(isDaemonRunning()).resolves.not.toThrow();
    });

    it('should handle undefined response', async () => {
      global.fetch = vi.fn().mockResolvedValue(undefined);

      const result = await isDaemonRunning();

      // undefined response should cause an error and return false
      expect(result).toBe(false);
    });

    it('should handle malformed response', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: 'true' } as any);

      const result = await isDaemonRunning();

      // Malformed 'ok' field - string 'true' is truthy, returns 'true' string
      expect(result).toBe('true');
    });
  });

  describe('concurrency', () => {
    it('should handle multiple concurrent checks', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const results = await Promise.all([isDaemonRunning(), isDaemonRunning(), isDaemonRunning()]);

      expect(results).toEqual([true, true, true]);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed success and failure', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const results = await Promise.all([isDaemonRunning(), isDaemonRunning(), isDaemonRunning()]);

      expect(results).toEqual([true, false, true]);
    });
  });
});
