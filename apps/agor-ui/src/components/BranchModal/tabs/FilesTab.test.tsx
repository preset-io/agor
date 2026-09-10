import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBranch } from '../testUtils';

const messageApi = vi.hoisted(() => ({
  showLoading: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => messageApi,
}));

vi.mock('../../FileCollection/FileCollection', () => ({
  FileCollection: ({
    files,
    onDownload,
    onFileClick,
    gitStatusSource,
  }: {
    files: Array<{ path?: string }>;
    onDownload: (file: unknown) => Promise<void>;
    onFileClick: (file: unknown) => Promise<void>;
    gitStatusSource?: string;
  }) => (
    <section data-testid={`file-collection-${gitStatusSource ?? 'combined'}`}>
      <span>{files.length} files</span>
      <span>{files.map((file) => file.path).join(',')}</span>
      {files.map((file) => (
        <button key={file.path} type="button" onClick={() => onFileClick(file)}>
          Open {file.path}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onDownload({ path: 'archive.bin', size: 7, isText: false })}
      >
        Download fixture
      </button>
    </section>
  ),
}));

vi.mock('../../CodePreviewModal/CodePreviewModal', () => ({ CodePreviewModal: () => null }));

import { FilesTab } from './FilesTab';

describe('FilesTab', () => {
  const get = vi.fn();
  const findAll = vi.fn().mockResolvedValue([]);
  const client = {
    service: () => ({ get, findAll }),
  } as unknown as AgorClient;
  const branch: Branch = makeBranch();
  let anchorClick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.values(messageApi).forEach((fn) => {
      fn.mockReset();
    });
    get.mockReset();
    findAll.mockReset();
    findAll.mockResolvedValue([]);
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:test'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    anchorClick.mockRestore();
    vi.restoreAllMocks();
  });

  it('uses one key for loading, failure, and retry success replacements', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    get
      .mockRejectedValueOnce(new Error('download failed'))
      .mockResolvedValueOnce({ path: 'archive.bin', encoding: 'utf8', content: 'safe file' });

    render(<FilesTab branch={branch} client={client} />);
    const download = screen.getByRole('button', { name: 'Download fixture' });

    fireEvent.click(download);
    await waitFor(() => expect(messageApi.showError).toHaveBeenCalledTimes(1));
    expect(messageApi.showLoading).toHaveBeenNthCalledWith(1, 'Downloading file...', {
      key: 'download',
    });
    expect(messageApi.showError).toHaveBeenCalledWith('Failed to download file', {
      key: 'download',
    });

    fireEvent.click(download);
    await waitFor(() => expect(messageApi.showSuccess).toHaveBeenCalledTimes(1));
    expect(messageApi.showLoading).toHaveBeenNthCalledWith(2, 'Downloading file...', {
      key: 'download',
    });
    expect(messageApi.showSuccess).toHaveBeenCalledWith('Downloaded!', { key: 'download' });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('refreshes the files and git statuses without remounting the tab', async () => {
    findAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { path: 'changed.ts', title: 'changed.ts', size: 12, gitStatus: 'modified' },
      ]);

    render(<FilesTab branch={branch} client={client} />);

    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('0 files')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }));

    await waitFor(() => expect(findAll).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('1 files')).toBeInTheDocument();
    expect(findAll).toHaveBeenLastCalledWith({
      query: { branch_id: branch.branch_id },
    });
  });

  it('shows only unstaged or staged files in the corresponding sub-tabs', async () => {
    get.mockResolvedValue({
      path: 'added-then-deleted.ts',
      title: 'added-then-deleted.ts',
      size: 10,
      lastModified: '',
      isText: true,
      gitStatus: 'added',
      content: 'staged content',
      encoding: 'utf-8',
      gitDiff: { baseContent: '' },
    });
    findAll.mockResolvedValueOnce([
      { path: 'clean.ts', title: 'clean.ts', size: 1 },
      {
        path: 'working.ts',
        title: 'working.ts',
        size: 2,
        gitStatus: 'modified',
        gitWorkingTreeStatus: 'modified',
      },
      {
        path: 'staged.ts',
        title: 'staged.ts',
        size: 3,
        gitStatus: 'added',
        gitStagedStatus: 'added',
      },
      {
        path: 'both.ts',
        title: 'both.ts',
        size: 4,
        gitStatus: 'modified',
        gitWorkingTreeStatus: 'modified',
        gitStagedStatus: 'modified',
      },
      {
        path: 'ignored.log',
        title: 'ignored.log',
        size: 5,
        gitStatus: 'ignored',
        gitWorkingTreeStatus: 'ignored',
      },
      {
        path: 'added-then-deleted.ts',
        title: 'added-then-deleted.ts',
        size: 0,
        isText: true,
        gitStatus: 'deleted',
        gitWorkingTreeStatus: 'deleted',
        gitStagedStatus: 'added',
      },
    ]);

    render(<FilesTab branch={branch} client={client} />);

    expect(await screen.findByRole('tab', { name: 'All files' })).toBeInTheDocument();
    expect(screen.getByTestId('file-collection-combined')).not.toHaveTextContent(
      'added-then-deleted.ts'
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Changes (3)' }));
    const changes = await screen.findByTestId('file-collection-workingTree');
    expect(changes).toHaveTextContent('working.ts,both.ts,added-then-deleted.ts');
    expect(changes).not.toHaveTextContent('clean.ts');
    expect(changes).not.toHaveTextContent('ignored.log');

    fireEvent.click(screen.getByRole('tab', { name: 'Staged changes (3)' }));
    const staged = await screen.findByTestId('file-collection-staged');
    expect(staged).toHaveTextContent('staged.ts,both.ts,added-then-deleted.ts');
    expect(staged).not.toHaveTextContent('working.ts');

    fireEvent.click(screen.getByRole('button', { name: 'Open added-then-deleted.ts' }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('added-then-deleted.ts', {
        query: {
          branch_id: branch.branch_id,
          git_status_source: 'staged',
        },
      })
    );
  });
});
