import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileUpload } from './FileUpload';

const openUploadBlob = vi.fn();
vi.mock('../../utils/uploadBlob', () => ({
  openUploadBlob: (...args: unknown[]) => openUploadBlob(...args),
}));
const uploadFilesToSession = vi.fn();
vi.mock('./upload', () => ({
  uploadFilesToSession: (...args: unknown[]) => uploadFilesToSession(...args),
}));
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn(), showWarning: vi.fn(), showError: vi.fn() }),
}));

describe('FileUpload previews', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    openUploadBlob.mockReset();
  });

  it('only creates thumbnail blob URLs for raster images and routes previews through the safe opener', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const svg = new File(['<svg onload="alert(1)"/>'], 'evil.svg', { type: 'image/svg+xml' });
    const png = new File(['png'], 'chart.png', { type: 'image/png' });

    render(
      <FileUpload
        sessionId="session-1"
        daemonUrl="http://daemon.test"
        open
        onClose={vi.fn()}
        initialFiles={[svg, png]}
      />
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledWith(png);

    const thumbnails = document.querySelectorAll<HTMLAnchorElement>(
      'a.ant-upload-list-item-thumbnail'
    );
    expect(thumbnails).toHaveLength(1);
    // Excluded types opt out of Ant Design's automatic canvas thumbnail.
    expect(document.querySelectorAll('img.ant-upload-list-item-image')).toHaveLength(1);
    fireEvent.click(thumbnails[0]);
    expect(openUploadBlob).toHaveBeenCalledWith(png, 'chart.png', false);
  });
});

describe('FileUpload errors', () => {
  afterEach(() => {
    uploadFilesToSession.mockReset();
  });

  it('asks for a file inline when none is selected', () => {
    render(
      <FileUpload sessionId="session-1" daemonUrl="http://daemon.test" open onClose={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(screen.getByText('Select at least one file.')).toBeInTheDocument();
    expect(uploadFilesToSession).not.toHaveBeenCalled();
  });

  it('says the upload was not confirmed when the connection drops mid-request', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
    uploadFilesToSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(
      <FileUpload
        sessionId="session-1"
        daemonUrl="http://daemon.test"
        open
        onClose={vi.fn()}
        initialFiles={[new File(['x'], 'big.txt', { type: 'text/plain' })]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(
      await screen.findByText(
        'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to upload the files again.'
      )
    ).toBeInTheDocument();
  });

  it('keeps the modal open with the plain reason, and the reference under Details', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
    uploadFilesToSession.mockRejectedValueOnce(
      new Error('A file exceeds the upload size limit (reference: req-123)')
    );
    const onClose = vi.fn();
    render(
      <FileUpload
        sessionId="session-1"
        daemonUrl="http://daemon.test"
        open
        onClose={onClose}
        initialFiles={[new File(['x'], 'big.txt', { type: 'text/plain' })]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(
      await screen.findByText("Couldn't upload the files. A file is over the size limit.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(
      screen.getByText('A file exceeds the upload size limit (reference: req-123)')
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('big.txt')).toBeInTheDocument();
  });
});
