import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLinkImageObjectUrl, getLinkContentAction } from './linkContent';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('fetchLinkImageObjectUrl', () => {
  it('uses authenticated, abortable requests and accepts only supported raster images', async () => {
    localStorage.setItem('feathers-jwt', 'test-token');
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['image'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    );
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail');

    await expect(fetchLinkImageObjectUrl('link/1', controller.signal)).resolves.toBe(
      'blob:thumbnail'
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/link-content/link%2F1?disposition=inline'),
      {
        headers: {
          Accept: 'image/png, image/jpeg, image/gif, image/webp',
          Authorization: 'Bearer test-token',
        },
        signal: controller.signal,
      }
    );
    expect(createObjectUrlSpy).toHaveBeenCalledOnce();
  });

  it('rejects content that is not a supported raster image before creating an object URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<svg />', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      })
    );
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL');

    await expect(fetchLinkImageObjectUrl('link-1')).rejects.toThrow(
      'Preview returned an unsupported image type'
    );
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
  });
});

describe('getLinkContentAction', () => {
  it('downloads any uploaded file that does not have an inline preview', () => {
    expect(
      getLinkContentAction({
        category: 'unknown',
        source: 'upload',
        kind: 'document',
        linkId: 'link-1',
        filePath: 'archive.bin',
      })
    ).toBe('download');
  });

  it('keeps supported uploaded content previewable and rejects non-upload file paths', () => {
    expect(
      getLinkContentAction({
        category: 'image',
        source: 'upload',
        kind: 'image',
        linkId: 'image-1',
        filePath: 'chart.png',
        mimeType: 'image/png',
      })
    ).toBe('preview');
    expect(
      getLinkContentAction({
        category: 'image',
        source: 'upload',
        kind: 'image',
        linkId: 'svg-1',
        filePath: 'diagram.svg',
        mimeType: 'image/svg+xml',
      })
    ).toBe('download');
    expect(
      getLinkContentAction({
        category: 'document',
        source: 'manual',
        kind: 'document',
        linkId: 'link-2',
        filePath: '/tmp/report.pdf',
      })
    ).toBeNull();
  });
});
