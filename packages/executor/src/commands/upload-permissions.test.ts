import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  open: vi.fn(),
  rm: vi.fn(),
  resolvePathInsideBranch: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  open: mocks.open,
  rm: mocks.rm,
}));
vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: vi.fn(async () => ({ io: { disconnect: vi.fn() } })),
}));
vi.mock('./branch-filesystem.js', () => ({
  resolveExecutorBranch: vi.fn(async () => ({ path: '/branch' })),
  resolvePathInsideBranch: mocks.resolvePathInsideBranch,
}));

import { handleBranchUploadMaterialize } from './upload.js';

const payload = {
  command: 'branch.upload.materialize' as const,
  sessionToken: 'token',
  daemonUrl: 'http://daemon',
  params: {
    branchId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    uploadRef: 'upl_00000000-0000-4000-8000-000000000003',
    filename: 'notes.txt',
  },
};

describe('upload materialization branch permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePathInsideBranch.mockResolvedValue({
      absolute:
        '/branch/.agor/session-staging/00000000-0000-4000-8000-000000000002/upl_00000000-0000-4000-8000-000000000003/notes.txt',
      relative:
        '.agor/session-staging/00000000-0000-4000-8000-000000000002/upl_00000000-0000-4000-8000-000000000003/notes.txt',
    });
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.open.mockResolvedValue({
      createWriteStream: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      close: vi.fn(async () => undefined),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello'))
    );
  });

  it('does not override the branch ACL and umask with private modes', async () => {
    const result = await handleBranchUploadMaterialize(payload, { dryRun: false });

    expect(result.success).toBe(true);
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.stringContaining('.agor/session-staging'), {
      recursive: true,
    });
    expect(mocks.open).toHaveBeenCalledWith(expect.stringContaining('notes.txt'), 'wx');
  });

  it('reports branch filesystem permission denial without bypassing it', async () => {
    mocks.mkdir.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

    const result = await handleBranchUploadMaterialize(payload, { dryRun: false });

    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringMatching(/branch filesystem permissions denied/i) },
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
