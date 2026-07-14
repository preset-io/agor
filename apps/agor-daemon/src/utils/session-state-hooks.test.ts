import {
  getCurrentTenantDatabaseScope,
  runWithTenantContext,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteById: vi.fn(),
  deletePreviousTurns: vi.fn(),
  findLatest: vi.fn(),
  findLatestDone: vi.fn(),
  getSessionFilePath: vi.fn(() => '/tmp/session.jsonl'),
  insertProcessing: vi.fn(),
  markDone: vi.fn(),
  repositoryDbs: [] as unknown[],
  restoreFile: vi.fn(),
  serializeFile: vi.fn(),
}));

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  SerializedSessionRepository: class {
    constructor(db: unknown) {
      mocks.repositoryDbs.push(db);
    }
    deleteById = mocks.deleteById;
    deletePreviousTurns = mocks.deletePreviousTurns;
    findLatest = mocks.findLatest;
    findLatestDone = mocks.findLatestDone;
    insertProcessing = mocks.insertProcessing;
    markDone = mocks.markDone;
  },
}));

vi.mock('./session-state', () => ({
  computeFileHash: vi.fn(async () => 'current-md5'),
  findCodexSessionFile: vi.fn(),
  getCodexHome: vi.fn(() => '/tmp/codex'),
  getCodexSessionRelativePath: vi.fn(() => 'sessions/2026/01/01/rollout-session.jsonl'),
  getSessionFilePath: mocks.getSessionFilePath,
  resolveCodexSessionRelativePath: vi.fn(() => '/tmp/codex/session.jsonl'),
  restoreFile: mocks.restoreFile,
  serializeFile: mocks.serializeFile,
}));

import { pullIfNeeded, pushAsync } from './session-state-hooks';

const db = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;
const pullContext = {
  db,
  sessionId: 'session-1',
  sdkSessionId: 'sdk-session-1',
  branchPath: '/tmp/branch',
  tool: 'claude-code' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repositoryDbs.length = 0;
  mocks.findLatest.mockResolvedValue(null);
  mocks.findLatestDone.mockResolvedValue(null);
  mocks.insertProcessing.mockResolvedValue({ id: 'row-1' });
  mocks.serializeFile.mockResolvedValue(Buffer.from('snapshot'));
});

describe('session state hook tenant scopes', () => {
  it('opens a short tenant unit for restore metadata reads', async () => {
    mocks.findLatest.mockImplementation(async () => {
      expect(getCurrentTenantDatabaseScope()).toMatchObject({
        kind: 'tenant',
        tenantId: 'tenant-x',
      });
      return null;
    });

    await runWithTenantContext('tenant-x', () => pullIfNeeded(pullContext));

    expect(mocks.findLatest).toHaveBeenCalledOnce();
    expect(mocks.repositoryDbs).toEqual([expect.anything()]);
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
  });

  it('fails fast without tenant identity', async () => {
    await expect(pullIfNeeded(pullContext)).rejects.toThrow(
      'Missing active tenant context for session state restore'
    );
    expect(() =>
      pushAsync({
        ...pullContext,
        branchId: 'branch-1',
        taskId: 'task-1',
      })
    ).toThrow('Missing active tenant context for session state persistence');
  });

  it('restores legacy Codex snapshots without a relative path to the canonical flat path', async () => {
    mocks.findLatest.mockResolvedValue({
      id: 'legacy-row',
      status: 'done',
      created_at: Date.now(),
      turn_index: 1,
      md5: 'stored-md5',
      payload: Buffer.from('legacy'),
      relative_path: null,
    });

    await runWithTenantContext('tenant-x', () => pullIfNeeded({ ...pullContext, tool: 'codex' }));

    expect(mocks.getSessionFilePath).toHaveBeenCalledWith(
      'codex',
      pullContext.branchPath,
      pullContext.sdkSessionId,
      undefined
    );
    expect(mocks.restoreFile).toHaveBeenCalledWith('/tmp/session.jsonl', Buffer.from('legacy'));
  });
});

describe('pushAsync', () => {
  it('discards a snapshot when a newer task takes ownership during serialization', async () => {
    const isCurrentTask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await runWithTenantContext('tenant-x', () =>
      pushAsync({
        db,
        sessionId: 'session-1',
        branchId: 'branch-1',
        taskId: 'task-1',
        sdkSessionId: 'sdk-session-1',
        branchPath: '/tmp/branch',
        tool: 'claude-code',
        isCurrentTask,
      })
    );

    expect(isCurrentTask).toHaveBeenCalledTimes(2);
    expect(mocks.deleteById).toHaveBeenCalledWith('row-1');
    expect(mocks.markDone).not.toHaveBeenCalled();
    expect(mocks.deletePreviousTurns).not.toHaveBeenCalled();
  });

  it('does not replace the last good snapshot when the transcript hash is unchanged', async () => {
    mocks.findLatestDone.mockResolvedValue({ md5: 'current-md5' });

    await expect(
      runWithTenantContext('tenant-x', () =>
        pushAsync({
          db,
          sessionId: 'session-1',
          branchId: 'branch-1',
          taskId: 'task-2',
          sdkSessionId: 'sdk-session-1',
          branchPath: '/tmp/branch',
          tool: 'claude-code',
        })
      )
    ).resolves.toBe('current-md5');

    expect(mocks.insertProcessing).not.toHaveBeenCalled();
    expect(mocks.deletePreviousTurns).not.toHaveBeenCalled();
  });

  it('keeps a committed snapshot successful when previous-turn GC fails', async () => {
    mocks.deletePreviousTurns.mockRejectedValueOnce(new Error('gc unavailable'));

    await expect(
      runWithTenantContext('tenant-x', () =>
        pushAsync({
          db,
          sessionId: 'session-1',
          branchId: 'branch-1',
          taskId: 'task-3',
          sdkSessionId: 'sdk-session-1',
          branchPath: '/tmp/branch',
          tool: 'claude-code',
        })
      )
    ).resolves.toBe('current-md5');

    expect(mocks.markDone).toHaveBeenCalledWith('row-1', Buffer.from('snapshot'));
  });
});
