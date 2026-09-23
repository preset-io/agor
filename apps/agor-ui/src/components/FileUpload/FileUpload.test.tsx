import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileUpload } from './FileUpload';

const openUploadBlob = vi.fn();
vi.mock('../../utils/uploadBlob', () => ({
  openUploadBlob: (...args: unknown[]) => openUploadBlob(...args),
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
