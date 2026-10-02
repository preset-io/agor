import type { ExecutorCommandResult } from '@agor/core/executor-protocol';
import type { BranchID } from '@agor/core/types';
import { expect, it } from 'vitest';
import { verifyBranchWorkspacePreflight } from './branch-workspace-preflight';

const branchId = '01900000-0000-7000-8000-000000000001' as BranchID;
const directory = { branchId, exists: true, kind: 'directory' };

it('accepts the single-branch executor status envelope', async () => {
  await expect(
    verifyBranchWorkspacePreflight(branchId, async () => ({
      success: true,
      data: directory,
    }))
  ).resolves.toBeUndefined();
});

it.each([
  [undefined, 'invalid filesystem status'],
  [{ statuses: [directory] }, 'invalid filesystem status'],
  [{ ...directory, branchId: 'another-branch' }, 'invalid filesystem status'],
  [{ exists: true }, 'invalid filesystem status'],
  [{ ...directory, exists: 'true' }, 'invalid filesystem status'],
  [{ ...directory, exists: false }, 'invalid filesystem status'],
  [{ branchId, exists: false, kind: 'missing' }, 'not visible to the executor'],
  [{ ...directory, kind: 'file' }, 'not a directory'],
  [{ ...directory, kind: 'other' }, 'not a directory'],
])('rejects unavailable or invalid data %j without claiming cleanup', async (data, reason) => {
  await expect(
    verifyBranchWorkspacePreflight(branchId, async () => ({ success: true, data }))
  ).rejects.toThrow(reason);
});

it.each([
  ['EXECUTOR_TIMEOUT', 'did not respond in time'],
  ['EXECUTOR_SPAWN_ERROR', 'could not start'],
  ['EXECUTOR_RESPONSE_UNSUPPORTED', 'does not support filesystem status responses'],
  ['UNKNOWN_COMMAND', 'does not support filesystem status'],
  ['BRANCH_FILESYSTEM_STATUS_FAILED', 'could not inspect'],
  ['UNREVIEWED_SECRET_CODE', 'failed to return a usable status'],
  ['__proto__', 'failed to return a usable status'],
])('classifies %s without leaking executor diagnostics', async (code, reason) => {
  const result: ExecutorCommandResult = {
    success: false,
    data: directory, // Failure wins even if there is data.
    error: { code, message: 'SECRET raw launcher output', details: { token: 'SECRET' } },
  };
  const outcome = verifyBranchWorkspacePreflight(branchId, async () => result);
  await expect(outcome).rejects.toThrow(reason);
  await expect(outcome).rejects.toThrow('No archive or file changes were made');
  await expect(outcome).rejects.toThrow('filesystemAction: preserved');
  await expect(outcome).rejects.not.toThrow('SECRET');
});

it('sanitizes a rejected transport promise and offers explicit metadata-only archival', async () => {
  const outcome = verifyBranchWorkspacePreflight(branchId, async () => {
    throw new Error('SECRET connection URL');
  });
  await expect(outcome).rejects.toThrow('could not be reached');
  await expect(outcome).rejects.not.toThrow('SECRET');
});

it.each([undefined, null, { success: 'true' }])(
  'rejects a malformed response envelope %j',
  async (response) => {
    await expect(
      verifyBranchWorkspacePreflight(
        branchId,
        async () => response as unknown as ExecutorCommandResult
      )
    ).rejects.toThrow('invalid status response');
  }
);
