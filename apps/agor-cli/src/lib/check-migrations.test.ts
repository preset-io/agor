import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock @agor/core/db to keep the test hermetic — we don't need real Drizzle
// migration metadata, we only need to exercise the branching in our helper.
vi.mock('@agor/core/db', () => ({
  checkMigrationStatus: vi.fn(),
  createDatabase: vi.fn(() => ({ __fake: true })),
  getDatabaseUrl: vi.fn(() => 'file:/tmp/agor-test.db'),
}));
vi.mock('@agor/core/utils/path', () => ({
  extractDbFilePath: vi.fn((url: string) => url.replace(/^file:/, '')),
}));

import { checkMigrationStatus } from '@agor/core/db';
import {
  formatPendingMigrationsMessage,
  getPendingMigrationsInfo,
  type PendingMigrationsInfo,
} from './check-migrations.js';

const checkMigrationStatusMock = vi.mocked(checkMigrationStatus);

describe('getPendingMigrationsInfo', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when migrations are up to date', async () => {
    checkMigrationStatusMock.mockResolvedValueOnce({
      hasPending: false,
      pending: [],
      applied: ['0000_init'],
    });

    await expect(getPendingMigrationsInfo()).resolves.toBeNull();
  });

  it('returns pending migration info when the database is behind', async () => {
    checkMigrationStatusMock.mockResolvedValueOnce({
      hasPending: true,
      pending: ['0005_add_widgets', '0006_add_gizmos'],
      applied: ['0000_init'],
    });

    const info = await getPendingMigrationsInfo();

    // Regression guard: this helper MUST surface pending migrations so that
    // `agor daemon start` can fail fast on stderr before spawning a detached
    // daemon that would otherwise die silently to the log file.
    expect(info).not.toBeNull();
    expect(info?.pending).toEqual(['0005_add_widgets', '0006_add_gizmos']);
    expect(info?.dbUrl).toBe('file:/tmp/agor-test.db');
    expect(info?.dbPath).toBe('/tmp/agor-test.db');
  });

  it('propagates errors from the underlying migration check', async () => {
    checkMigrationStatusMock.mockRejectedValueOnce(new Error('db unreachable'));

    await expect(getPendingMigrationsInfo()).rejects.toThrow('db unreachable');
  });
});

describe('formatPendingMigrationsMessage', () => {
  it('includes each pending tag and an actionable `agor db migrate` hint', () => {
    const info: PendingMigrationsInfo = {
      dbUrl: 'file:/tmp/agor-test.db',
      dbPath: '/tmp/agor-test.db',
      pending: ['0005_add_widgets', '0006_add_gizmos'],
    };

    const message = formatPendingMigrationsMessage(info);

    expect(message).toContain('Database migrations required');
    expect(message).toContain('0005_add_widgets');
    expect(message).toContain('0006_add_gizmos');
    expect(message).toContain('agor db migrate');
    // SQLite: include the backup command with the resolved db path.
    expect(message).toContain('cp /tmp/agor-test.db /tmp/agor-test.db.backup-');
  });

  it('omits the SQLite backup hint for postgres URLs', () => {
    const info: PendingMigrationsInfo = {
      dbUrl: 'postgresql://user:pass@localhost:5432/agor',
      dbPath: 'postgresql://user:pass@localhost:5432/agor',
      pending: ['0005_add_widgets'],
    };

    const message = formatPendingMigrationsMessage(info);

    expect(message).toContain('agor db migrate');
    expect(message).not.toContain('cp ');
    expect(message).not.toContain('backup-$(date');
  });
});
