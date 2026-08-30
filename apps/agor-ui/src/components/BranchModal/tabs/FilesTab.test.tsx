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
  FileCollection: ({ onDownload }: { onDownload: (file: unknown) => Promise<void> }) => (
    <button
      type="button"
      onClick={() => onDownload({ path: 'archive.bin', size: 7, isText: false })}
    >
      Download fixture
    </button>
  ),
}));

vi.mock('../../CodePreviewModal/CodePreviewModal', () => ({ CodePreviewModal: () => null }));

import { FilesTab } from './FilesTab';

describe('FilesTab download messages', () => {
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
    findAll.mockClear();
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
});
