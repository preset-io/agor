import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from './database.js';

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  ensureAgorHome: vi.fn(),
  getAgorHome: vi.fn(() => '/home/agor/.agor'),
}));

const dbMocks = vi.hoisted(() => ({
  checkMigrationStatus: vi.fn(),
  configureSecretKeyDerivationTracing: vi.fn(),
  createDatabaseAsync: vi.fn(),
  createTenantScopedDatabaseProxy: vi.fn(),
  runWithSystemDatabaseScope: vi.fn(),
  seedInitialData: vi.fn(),
}));

const adminMocks = vi.hoisted(() => ({
  runFirstRunAdminBootstrap: vi.fn(),
  logFirstRunAdminBootstrap: vi.fn(),
}));

const tracingMocks = vi.hoisted(() => ({ resolveDatadogTracer: vi.fn() }));
vi.mock('@agor/core/tracing/datadog', async (importOriginal) => ({
  ...(await importOriginal()),
  ...tracingMocks,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  ...fsMocks,
}));

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal()),
  ...dbMocks,
}));

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal()),
  ...configMocks,
}));

vi.mock('./first-run-admin.js', () => adminMocks);

describe('initializeDatabase logging', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const rawDb = {};
    const scopedDb = {};
    tracingMocks.resolveDatadogTracer.mockReturnValue(null);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.mkdir.mockResolvedValue(undefined);
    configMocks.ensureAgorHome.mockResolvedValue(undefined);
    dbMocks.createDatabaseAsync.mockResolvedValue(rawDb);
    dbMocks.createTenantScopedDatabaseProxy.mockReturnValue(scopedDb);
    dbMocks.checkMigrationStatus.mockResolvedValue({ hasPending: false, pending: [] });
    dbMocks.runWithSystemDatabaseScope.mockImplementation(
      async (_db, _operation, run: () => Promise<void>) => run()
    );
    dbMocks.seedInitialData.mockResolvedValue(undefined);
    adminMocks.runFirstRunAdminBootstrap.mockResolvedValue({
      createdAdmin: true,
      admin: { user_id: 'real-owner' },
      reattributedCount: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    logSpy.mockRestore();
  });

  it('uses the same startup APM gate and tracer for database and crypto timing', async () => {
    const tracer = { trace: vi.fn() };
    tracingMocks.resolveDatadogTracer.mockReturnValue(tracer);
    const url = 'file::memory:';
    await initializeDatabase(url, { skipFirstRunAdminBootstrap: true, traceServices: 'off' });
    expect(tracingMocks.resolveDatadogTracer).not.toHaveBeenCalled();
    expect(dbMocks.configureSecretKeyDerivationTracing).toHaveBeenLastCalledWith(null);
    await initializeDatabase(url, {
      skipFirstRunAdminBootstrap: true,
      traceServices: 'entrypoint',
    });
    expect(tracingMocks.resolveDatadogTracer).toHaveBeenCalledTimes(1);
    expect(dbMocks.configureSecretKeyDerivationTracing).toHaveBeenLastCalledWith(tracer);
    expect(dbMocks.createDatabaseAsync).toHaveBeenLastCalledWith({ url }, { tracer });
  });

  it.each([
    {
      backend: 'postgresql',
      url: 'postgresql://PG_USER_SENTINEL:PG_PASSWORD_SENTINEL@PG_HOST_SENTINEL:5432/agor?sslmode=PG_QUERY_SENTINEL',
      sentinels: [
        'PG_USER_SENTINEL',
        'PG_PASSWORD_SENTINEL',
        'PG_HOST_SENTINEL',
        'PG_QUERY_SENTINEL',
      ],
    },
    {
      backend: 'sqlite',
      url: 'file:/tmp/SQLITE_PATH_SENTINEL.db?mode=SQLITE_QUERY_SENTINEL',
      sentinels: ['SQLITE_PATH_SENTINEL', 'SQLITE_QUERY_SENTINEL'],
    },
    {
      backend: 'sqlite',
      url: 'libsql://LIBSQL_HOST_SENTINEL/agor?authToken=LIBSQL_QUERY_SENTINEL',
      sentinels: ['LIBSQL_HOST_SENTINEL', 'LIBSQL_QUERY_SENTINEL'],
    },
  ])(
    'logs only the $backend backend for a hostile connection string',
    async ({ backend, url, sentinels }) => {
      await initializeDatabase(url, { skipFirstRunAdminBootstrap: true });

      expect(logSpy).toHaveBeenCalledWith(`[database] connecting backend=${backend}`);
      const logged = logSpy.mock.calls.flat().map(String).join('\n');
      for (const sentinel of sentinels) expect(logged).not.toContain(sentinel);

      expect(dbMocks.createDatabaseAsync).toHaveBeenCalledWith({ url });
      expect(dbMocks.configureSecretKeyDerivationTracing).toHaveBeenCalledWith(null);
      expect(dbMocks.checkMigrationStatus).toHaveBeenCalledTimes(1);
      expect(dbMocks.seedInitialData).not.toHaveBeenCalled();
    }
  );

  it('uses the configured dialect fallback without logging the URL', async () => {
    vi.stubEnv('AGOR_DB_DIALECT', 'sqlite');
    const url = ':memory:FALLBACK_SENTINEL';

    await initializeDatabase(url, { skipFirstRunAdminBootstrap: true });

    expect(logSpy).toHaveBeenCalledWith('[database] connecting backend=sqlite');
    expect(logSpy.mock.calls.flat().map(String).join('\n')).not.toContain('FALLBACK_SENTINEL');
    expect(dbMocks.createDatabaseAsync).toHaveBeenCalledWith({ url });
  });

  it('creates the first real User before seeding the default Board', async () => {
    await initializeDatabase('file:/tmp/agor-first-run.db');

    expect(adminMocks.runFirstRunAdminBootstrap).toHaveBeenCalledOnce();
    expect(dbMocks.seedInitialData).toHaveBeenCalledWith(expect.anything(), 'real-owner');
    expect(adminMocks.runFirstRunAdminBootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      dbMocks.seedInitialData.mock.invocationCallOrder[0]
    );
  });

  it('forwards configured PostgreSQL pool settings to the database client', async () => {
    const url = 'postgresql://localhost/agor';
    const pool = { max: 25 };

    await initializeDatabase(url, { pool, skipFirstRunAdminBootstrap: true });

    expect(dbMocks.createDatabaseAsync).toHaveBeenCalledWith({ url, pool });
  });

  it('refuses to start an older binary against a newer database schema', async () => {
    dbMocks.checkMigrationStatus.mockResolvedValue({
      hasPending: false,
      pending: [],
      dbAheadOfBinary: true,
    });

    await expect(
      initializeDatabase('file:/tmp/agor-newer.db', { skipFirstRunAdminBootstrap: true })
    ).rejects.toThrow('Database schema is newer than this Agor binary');
    expect(dbMocks.seedInitialData).not.toHaveBeenCalled();
  });

  it('does not log a hostile SQLite directory when creating it', async () => {
    const url = 'file:/tmp/SQLITE_DIRECTORY_SENTINEL/agor.db';
    fsMocks.access.mockRejectedValueOnce(new Error('missing directory'));

    await initializeDatabase(url, { skipFirstRunAdminBootstrap: true });

    expect(fsMocks.mkdir).toHaveBeenCalledWith('/tmp/SQLITE_DIRECTORY_SENTINEL', {
      recursive: true,
    });
    expect(logSpy).toHaveBeenCalledWith('[database] creating sqlite directory');
    expect(logSpy.mock.calls.flat().map(String).join('\n')).not.toContain(
      'SQLITE_DIRECTORY_SENTINEL'
    );
    expect(dbMocks.createDatabaseAsync).toHaveBeenCalledWith({ url });
  });

  it('uses the private-home bootstrap for the canonical SQLite directory', async () => {
    const url = 'file:/home/agor/.agor/agor.db';
    fsMocks.access.mockRejectedValueOnce(new Error('missing directory'));

    await initializeDatabase(url, { skipFirstRunAdminBootstrap: true });

    expect(configMocks.ensureAgorHome).toHaveBeenCalledWith('/home/agor/.agor');
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
  });
});
