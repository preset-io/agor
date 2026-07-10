import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLinkImageObjectUrl } from './linkContent';

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
