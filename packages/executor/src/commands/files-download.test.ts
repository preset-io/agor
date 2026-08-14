import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
  createReadStream: vi.fn(),
  resolvePathInsideBranch: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('node:fs', () => ({ createReadStream: mocks.createReadStream }));
vi.mock('node:fs/promises', () => ({
  lstat: mocks.lstat,
  realpath: mocks.realpath,
  // Unused by the download path but imported by the module under test.
  open: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: vi.fn(async () => ({ io: { disconnect: mocks.disconnect } })),
}));
vi.mock('./branch-filesystem.js', () => ({
  resolveExecutorBranch: vi.fn(async () => ({ path: '/branch' })),
  resolvePathInsideBranch: mocks.resolvePathInsideBranch,
  filesystemStatus: vi.fn(),
}));

import { handleBranchFilesDownload } from './files.js';

const DOWNLOAD_REF = 'dl_00000000-0000-4000-8000-000000000009';

const payload = {
  command: 'branch.files.download' as const,
  sessionToken: 'scoped-token',
  daemonUrl: 'http://daemon',
  params: {
    branchId: '00000000-0000-4000-8000-000000000001',
    filePath: 'assets/big.bin',
    downloadRef: DOWNLOAD_REF,
    maxBytes: 1024,
  },
};

function statsFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    size: 512,
    isSymbolicLink: () => false,
    isFile: () => true,
    ...overrides,
  };
}

describe('branch.files.download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.realpath.mockResolvedValue('/branch');
    mocks.resolvePathInsideBranch.mockResolvedValue({
      absolute: '/branch/assets/big.bin',
      relative: 'assets/big.bin',
    });
    mocks.lstat.mockResolvedValue(statsFor());
    mocks.createReadStream.mockReturnValue('READ_STREAM');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
  });

  it('streams the file body to the daemon rendezvous instead of returning bytes', async () => {
    const result = await handleBranchFilesDownload(payload, { dryRun: false });

    expect(result.success).toBe(true);
    // The JSON result carries metadata only — never the file contents. This is
    // the whole point: bytes must not ride the stdout/Socket.IO path.
    expect(result.data).toEqual({ path: 'assets/big.bin', size: 512 });
    expect(JSON.stringify(result)).not.toContain('READ_STREAM');

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://daemon/executor/files/downloads/${DOWNLOAD_REF}/content`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('READ_STREAM');
    expect(init.duplex).toBe('half');
    // Capability token travels in the header, never in the URL.
    expect(init.headers.Authorization).toBe('Bearer scoped-token');
    expect(url).not.toContain('scoped-token');
    expect(init.headers['Content-Length']).toBe('512');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers['X-Agor-Filename']).toBe('big.bin');
  });

  it('confines the path inside the branch root before opening anything', async () => {
    await handleBranchFilesDownload(payload, { dryRun: false });

    expect(mocks.resolvePathInsideBranch).toHaveBeenCalledWith('/branch', 'assets/big.bin', {
      mustExist: true,
    });
  });

  it('refuses a symlink rather than following it out of the branch', async () => {
    mocks.lstat.mockResolvedValue(statsFor({ isSymbolicLink: () => true }));

    const result = await handleBranchFilesDownload(payload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BRANCH_FILES_DOWNLOAD_FAILED');
    expect(result.error?.message).toMatch(/symlink/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a directory or device node', async () => {
    mocks.lstat.mockResolvedValue(statsFor({ isFile: () => false }));

    const result = await handleBranchFilesDownload(payload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/not a file/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a file larger than the daemon authorized, before streaming', async () => {
    mocks.lstat.mockResolvedValue(statsFor({ size: 4096 }));

    const result = await handleBranchFilesDownload(payload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/exceeds the 1024-byte download limit/);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createReadStream).not.toHaveBeenCalled();
  });

  it('reports a rejected transfer as a failed command', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 }))
    );

    const result = await handleBranchFilesDownload(payload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/HTTP 403/);
  });

  it('translates a permission error into an actionable message', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mocks.lstat.mockRejectedValue(denied);

    const result = await handleBranchFilesDownload(payload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/permissions denied/i);
  });

  it('always disconnects the Feathers client', async () => {
    await handleBranchFilesDownload(payload, { dryRun: false });
    expect(mocks.disconnect).toHaveBeenCalled();

    mocks.lstat.mockRejectedValue(new Error('boom'));
    await handleBranchFilesDownload(payload, { dryRun: false });
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
  });

  it('does no filesystem work on a dry run', async () => {
    const result = await handleBranchFilesDownload(payload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(mocks.lstat).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
