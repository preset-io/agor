import type { AgorClient, Branch } from '@agor-live/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { recoverTeammateFilesystem } from './recoverTeammateFilesystem';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

vi.mock('./waitForBranchFilesystemReady', () => ({
  waitForBranchFilesystemReady: vi.fn(async () => undefined),
}));
beforeEach(() => vi.clearAllMocks());
function setup(status: Branch['filesystem_status'] = 'failed') {
  const get = vi.fn(async () => ({ branch_id: 'retained', filesystem_status: status }));
  const create = vi.fn(async () => ({}));
  const service = vi.fn((name: string) => (name === 'branches' ? { get } : { create }));
  return { client: { service } as unknown as AgorClient, get, create, service };
}
it('invokes authorized exact-branch recovery before waiting', async () => {
  const { client, create, service } = setup();
  await recoverTeammateFilesystem(client, 'retained', () => true);
  expect(service).toHaveBeenCalledWith('branches/retained/retry-filesystem');
  expect(create).toHaveBeenCalledWith({});
  expect(create.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(waitForBranchFilesystemReady).mock.invocationCallOrder[0]
  );
});
it.each(['creating', 'ready'] as const)('does not restart %s work', async (status) => {
  const { client, create } = setup(status);
  await recoverTeammateFilesystem(client, 'retained', () => true);
  expect(create).not.toHaveBeenCalled();
});
it('does not blindly repoll failed or unauthorized recovery', async () => {
  const { client, create } = setup();
  create.mockRejectedValue(new Error('Forbidden'));
  await expect(recoverTeammateFilesystem(client, 'retained', () => true)).rejects.toThrow(
    'Forbidden'
  );
  expect(waitForBranchFilesystemReady).not.toHaveBeenCalled();
});
it('fences caller replacement and mismatched branch reads', async () => {
  const { client, create, get } = setup();
  get.mockResolvedValue({ branch_id: 'foreign', filesystem_status: 'failed' });
  await expect(recoverTeammateFilesystem(client, 'retained', () => true)).rejects.toThrow(
    'Unexpected'
  );
  expect(create).not.toHaveBeenCalled();
  await expect(recoverTeammateFilesystem(client, 'retained', () => false)).rejects.toThrow(
    'Reconnect'
  );
});
