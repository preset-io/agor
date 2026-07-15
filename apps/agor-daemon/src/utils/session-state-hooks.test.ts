import {
  getCurrentTenantDatabaseScope,
  runWithTenantContext,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findLatest: vi.fn(async () => null),
  repositoryDbs: [] as unknown[],
}));

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  SerializedSessionRepository: class {
    constructor(db: unknown) {
      mocks.repositoryDbs.push(db);
    }
    findLatest = mocks.findLatest;
  },
}));

vi.mock('./session-state', () => ({
  computeFileHash: vi.fn(async () => ''),
  findCodexSessionFile: vi.fn(async () => null),
  getCodexHome: vi.fn(() => '/tmp/codex'),
  getSessionFilePath: vi.fn(() => '/tmp/session.jsonl'),
  restoreFile: vi.fn(),
  serializeFile: vi.fn(),
}));

import { pullIfNeeded, pushAsync } from './session-state-hooks';

const db = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;
const context = {
  db,
  sessionId: 'session-1',
  sdkSessionId: 'sdk-session-1',
  branchPath: '/tmp/branch',
  tool: 'claude-code' as const,
};

describe('session state hook tenant scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoryDbs.length = 0;
    mocks.findLatest.mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toMatchObject({
        kind: 'tenant',
        tenantId: 'tenant-x',
      });
      return null;
    });
  });

  it('opens a short tenant unit for restore metadata reads', async () => {
    await runWithTenantContext('tenant-x', () => pullIfNeeded(context));

    expect(mocks.findLatest).toHaveBeenCalledOnce();
    expect(mocks.repositoryDbs).toEqual([expect.anything()]);
    expect(mocks.repositoryDbs[0]).toBeDefined();
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
  });

  it('fails fast without tenant identity', async () => {
    await expect(pullIfNeeded(context)).rejects.toThrow(
      'Missing active tenant context for session state restore'
    );
    expect(() =>
      pushAsync({
        ...context,
        branchId: 'branch-1',
        taskId: 'task-1',
      })
    ).toThrow('Missing active tenant context for session state persistence');
  });
});
