/**
 * Tests for Agor API Client
 *
 * Tests our API wrapper utilities (createClient, isDaemonRunning).
 * Does NOT test FeathersJS internals, Socket.io, or HTTP libraries.
 */

import type { AuthenticationResult, Session, Task, UserID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
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

interface MockMessageRow {
  message_id: string;
  task_id: string;
  index: number;
}

function mockExactMessagePages(
  findMock: MockedFunction<any>,
  rows: MockMessageRow[],
  serverMax = 1000,
  beforeQuery?: (query: Record<string, any>, rows: MockMessageRow[]) => void
): void {
  findMock.mockImplementation(async ({ query = {} }: { query?: Record<string, any> } = {}) => {
    beforeQuery?.(query, rows);
    let matches = [...rows];
    const cursor = query.message_id;
    if (cursor && typeof cursor === 'object') {
      if (typeof cursor.$gt === 'string') {
        matches = matches.filter((row) => row.message_id > cursor.$gt);
      }
      if (typeof cursor.$lte === 'string') {
        matches = matches.filter((row) => row.message_id <= cursor.$lte);
      }
    }
    const direction = query.$sort?.message_id === -1 ? -1 : 1;
    matches.sort((left, right) => direction * left.message_id.localeCompare(right.message_id));
    const limit = Math.min(Number(query.$limit ?? serverMax), serverMax);
    const data = matches
      .slice(0, limit)
      .map((row) =>
        Array.isArray(query.$select)
          ? Object.fromEntries(
              query.$select.map((field: keyof MockMessageRow) => [field, row[field]])
            )
          : row
      );
    return { total: matches.length, limit, skip: 0, data };
  });
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

    it('does not install Feathers live-authentication methods on a socket client', () => {
      const client = createClient('http://localhost:3030', false, {
        socketAuthentication: { accessToken: 'access-token' },
      });

      expect(client).not.toHaveProperty('authenticate');
      expect(client).not.toHaveProperty('reAuthenticate');
      expect(client).not.toHaveProperty('logout');
    });
  });

  describe('socket configuration', () => {
    it('reads the latest access token for every authenticated handshake', () => {
      let token = 'token-a';
      createClient('http://localhost:3030', false, {
        socketAuthentication: { accessToken: () => token },
      });

      const authorize = vi.fn();
      const auth = ioMock.mock.calls[0]?.[1]?.auth as
        | ((callback: (data: Record<string, string>) => void) => void)
        | undefined;
      auth?.(authorize);
      token = 'token-b';
      auth?.(authorize);

      expect(authorize).toHaveBeenNthCalledWith(1, { token: 'token-a' });
      expect(authorize).toHaveBeenNthCalledWith(2, { token: 'token-b' });
    });

    it('forwards an explicit acknowledgement timeout without enabling retries', () => {
      createClient('http://localhost:3030', true, { ackTimeout: 60_000 });

      expect(ioMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          ackTimeout: 60_000,
        })
      );
      expect(ioMock.mock.calls[0]?.[1]).not.toHaveProperty('retries');
    });

    it('leaves acknowledgement timeout unset when omitted', () => {
      createClient();

      expect(ioMock.mock.calls[0]?.[1]).not.toHaveProperty('ackTimeout');
      expect(ioMock.mock.calls[0]?.[1]).not.toHaveProperty('retries');
    });

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

    it('should auto-paginate only the requested tail after a nonzero $skip', async () => {
      const client = createClient();
      const sessionsService = client.service('sessions');
      const findMock = sessionsService.find as unknown as MockedFunction<any>;
      findMock
        .mockResolvedValueOnce({
          total: 5,
          limit: 2,
          skip: 1,
          data: [{ session_id: 's2' }, { session_id: 's3' }],
        })
        .mockResolvedValueOnce({
          total: 5,
          limit: 2,
          skip: 3,
          data: [{ session_id: 's4' }, { session_id: 's5' }],
        });

      await expect(sessionsService.findAll({ query: { $skip: 1, $limit: 2 } })).resolves.toEqual([
        { session_id: 's2' },
        { session_id: 's3' },
        { session_id: 's4' },
        { session_id: 's5' },
      ]);
      expect(findMock).toHaveBeenCalledTimes(2);
      expect(findMock).toHaveBeenNthCalledWith(2, { query: { $skip: 3, $limit: 2 } });
    });

    it('should preserve an exact Task filter while walking server-clamped pages', async () => {
      const client = createClient();
      const messagesService = client.service('messages');
      const findMock = messagesService.find as unknown as MockedFunction<any>;
      mockExactMessagePages(
        findMock,
        [
          { message_id: 'm1', task_id: 't1', index: 0 },
          { message_id: 'm2', task_id: 't1', index: 1 },
        ],
        1
      );

      await expect(
        messagesService.findAll({
          query: { task_id: 't1', $sort: { index: 1 }, $limit: 10_000 },
        })
      ).resolves.toEqual([
        { message_id: 'm1', task_id: 't1', index: 0 },
        { message_id: 'm2', task_id: 't1', index: 1 },
      ]);
      expect(findMock).toHaveBeenCalled();
      for (const [params] of findMock.mock.calls) {
        expect(params.query.task_id).toBe('t1');
      }
    });

    it('accepts an exact result that fits in one server page without a verification scan', async () => {
      const client = createClient();
      const messagesService = client.service('messages');
      const findMock = messagesService.find as unknown as MockedFunction<any>;
      mockExactMessagePages(findMock, [
        { message_id: 'm2', task_id: 't1', index: 1 },
        { message_id: 'm1', task_id: 't1', index: 0 },
      ]);

      await expect(
        messagesService.findAll({ query: { task_id: 't1', $sort: { index: 1 } } })
      ).resolves.toEqual([
        { message_id: 'm1', task_id: 't1', index: 0 },
        { message_id: 'm2', task_id: 't1', index: 1 },
      ]);
      expect(findMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when an offset-paginated result changes between pages', async () => {
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
        .mockResolvedValueOnce({ total: 2, limit: 2, skip: 2, data: [] });

      await expect(sessionsService.findAll()).rejects.toThrow(
        'Paginated findAll() changed while pages were being read'
      );
    });

    it('uses a high-water keyset rather than offsets for a multi-page transcript', async () => {
      const client = createClient();
      const messagesService = client.service('messages');
      const findMock = messagesService.find as unknown as MockedFunction<any>;
      const firstPage = Array.from({ length: 1000 }, (_, index) => ({
        message_id: `m${String(index).padStart(4, '0')}`,
        task_id: 't1',
        index,
      }));
      const final = { message_id: 'm1000', task_id: 't1', index: 1000 };
      mockExactMessagePages(findMock, [...firstPage, final]);

      const results = await messagesService.findAll({
        query: { task_id: 't1', $sort: { index: 1 } },
      });
      expect(results).toHaveLength(1001);
      expect(results.at(-1)).toEqual(final);
      expect(findMock).toHaveBeenCalledWith({
        query: expect.objectContaining({
          task_id: 't1',
          message_id: { $gt: 'm0999', $lte: 'm1000' },
          $sort: { message_id: 1 },
        }),
      });
    });

    it('continues keyset hydration when the server clamps below the client page limit', async () => {
      const client = createClient();
      const messagesService = client.service('messages');
      const findMock = messagesService.find as unknown as MockedFunction<any>;
      mockExactMessagePages(
        findMock,
        [
          { message_id: 'm1', task_id: 't1', index: 0 },
          { message_id: 'm2', task_id: 't1', index: 1 },
          { message_id: 'm3', task_id: 't1', index: 2 },
        ],
        1
      );

      await expect(
        messagesService.findAll({ query: { task_id: 't1', $sort: { index: 1 } } })
      ).resolves.toEqual([
        { message_id: 'm1', task_id: 't1', index: 0 },
        { message_id: 'm2', task_id: 't1', index: 1 },
        { message_id: 'm3', task_id: 't1', index: 2 },
      ]);
      expect(findMock).toHaveBeenCalledWith({
        query: expect.objectContaining({
          task_id: 't1',
          message_id: { $gt: 'm2', $lte: 'm3' },
          $sort: { message_id: 1 },
        }),
      });
    });

    it('fails closed when keyset hydration empties before its high-water mark', async () => {
      const client = createClient();
      const messagesService = client.service('messages');
      const findMock = messagesService.find as unknown as MockedFunction<any>;
      findMock.mockImplementation(async ({ query = {} }: { query?: Record<string, any> } = {}) => {
        if (query.$sort?.message_id === -1) {
          return { total: 2, limit: 1, skip: 0, data: [{ message_id: 'm2' }] };
        }
        if (query.message_id?.$gt) {
          return { total: 0, limit: 1, skip: 0, data: [] };
        }
        return {
          total: 2,
          limit: 1,
          skip: 0,
          data: [{ message_id: 'm1', task_id: 't1', index: 0 }],
        };
      });

      await expect(
        messagesService.findAll({ query: { task_id: 't1', $sort: { index: 1 } } })
      ).rejects.toThrow('keyset ended before message_id high-water mark');
    });

    it('retries when a concurrent lower ID appears behind the keyset cursor', async () => {
      const client = createClient();
      const messagesService = client.service('messages');
      const findMock = messagesService.find as unknown as MockedFunction<any>;
      const rows: MockMessageRow[] = [
        { message_id: 'm1', task_id: 't1', index: 0 },
        { message_id: 'm3', task_id: 't1', index: 2 },
        { message_id: 'm4', task_id: 't1', index: 3 },
      ];
      let inserted = false;
      mockExactMessagePages(findMock, rows, 2, (query, currentRows) => {
        if (!inserted && query.message_id?.$gt === 'm3') {
          inserted = true;
          currentRows.push({ message_id: 'm2', task_id: 't1', index: 1 });
        }
      });

      await expect(
        messagesService.findAll({ query: { task_id: 't1', $sort: { index: 1 } } })
      ).resolves.toEqual([
        { message_id: 'm1', task_id: 't1', index: 0 },
        { message_id: 'm2', task_id: 't1', index: 1 },
        { message_id: 'm3', task_id: 't1', index: 2 },
        { message_id: 'm4', task_id: 't1', index: 3 },
      ]);
      expect(findMock.mock.calls.length).toBeGreaterThan(8);
    });

    // Executor lifecycle callbacks use explicitly registered custom methods.
    // server-side via `app.use(path, service, { methods })`, but the Feathers Socket.io
    // client only wires standard CRUD at construction time. Without an explicit
    // service.methods(...) call on the client, calling these threw
    // "client.service(...).<method> is not a function" — observed during prod branch
    // creation. These assertions guard the client-side mirror of the daemon's methods list.
    it('registers users custom methods on client', () => {
      const client = createClient();
      const usersService = client.service('users') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      expect(usersService.methods).toHaveBeenCalledWith(
        'getAvatarSettings',
        'updateAvatarSettings',
        'syncAvatars',
        'getPrimaryTeammate',
        'getPrimaryTeammateCandidates',
        'setPrimaryTeammate',
        'setPrimaryTeammateIfUnset',
        'setPrimaryAgenticToolIfUnset'
      );
    });

    it('registers branches custom methods on client', () => {
      const client = createClient();
      const branchesService = client.service('branches') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      expect(branchesService.methods).toHaveBeenCalledWith(
        'updateEnvironment',
        'settleFilesystem',
        'recoverFilesystem',
        'ensureTeammateKnowledgeNamespace'
      );
    });

    it('registers task executor custom methods on client', () => {
      const client = createClient();
      const tasksService = client.service('tasks') as unknown as {
        methods: MockedFunction<(...names: string[]) => unknown>;
      };
      expect(tasksService.methods).toHaveBeenCalledWith(
        'connectExecutor',
        'reportTerminationComplete',
        'reportRuntimeTelemetry',
        'reportSdkHealthFailure'
      );
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
      const admittedTask: Task = {
        task_id: 'task-123' as Task['task_id'],
        session_id: 'session-123' as Task['session_id'],
        created_by: 'user-123',
        full_prompt: 'Fix failing tests',
        status: TaskStatus.DISPATCHING,
        created_at: '2026-08-20T00:00:00.000Z',
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: '2026-08-20T00:00:00.000Z',
        },
        tool_use_count: 0,
        git_state: { ref_at_start: 'feature', sha_at_start: 'abc123' },
      };

      createMock.mockResolvedValue(admittedTask);

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
      expect(result).toBe(admittedTask);
    });

    it('should expose sessions.initialize helper for backend-owned setup', async () => {
      const client = createClient();
      const routeService = client.service('sessions/session-123/initialize');
      const createMock = routeService.create as unknown as MockedFunction<any>;
      const resultValue = { sessionId: 'session-123', task: { task_id: 'task-1' } };
      createMock.mockResolvedValue(resultValue);

      const result = await client.sessions.initialize('session-123', {
        expectedUserId: 'user-123' as UserID,
        mcpServerIds: ['mcp-1'],
        envVarNames: ['TOKEN'],
        prompt: 'Start here',
        permissionMode: 'auto',
      });

      expect(createMock).toHaveBeenCalledWith(
        {
          expectedUserId: 'user-123',
          mcpServerIds: ['mcp-1'],
          envVarNames: ['TOKEN'],
          prompt: 'Start here',
          permissionMode: 'auto',
        },
        undefined
      );
      expect(result).toBe(resultValue);
    });

    // The pure-REST counterpart to client.sessions.prompt() — a thin wrapper
    // around POST /tasks/:id/run, the explicit executor-trigger route added
    // for harnesses that don't speak MCP. See issue #1118.
    it('should expose tasks.run helper that calls /tasks/:id/run route', async () => {
      const client = createClient();
      const routeService = client.service('tasks/task-456/run');
      const createMock = routeService.create as unknown as MockedFunction<any>;

      createMock.mockResolvedValue({
        task_id: 'task-456',
        session_id: 'session-123',
        status: 'running',
      });

      const result = await client.tasks.run('task-456', {
        permissionMode: 'auto',
        stream: true,
      });

      expect(createMock).toHaveBeenCalledWith(
        {
          permissionMode: 'auto',
          stream: true,
        },
        undefined
      );
      expect(result).toEqual({
        task_id: 'task-456',
        session_id: 'session-123',
        status: 'running',
      });
    });

    it('should call tasks.run with empty body when no options provided', async () => {
      const client = createClient();
      const routeService = client.service('tasks/task-789/run');
      const createMock = routeService.create as unknown as MockedFunction<any>;

      createMock.mockResolvedValue({ task_id: 'task-789', status: 'running' });

      await client.tasks.run('task-789');

      expect(createMock).toHaveBeenCalledWith({}, undefined);
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
      branch_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
    };
    const patchPayload: SessionPatchInput = { branch_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' };
    const updateId: SessionIdUpdateInput = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';

    expect(createPayload.branch_id).toBeDefined();
    expect(patchPayload.branch_id).toBeDefined();
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
