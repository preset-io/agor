import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkImageThumbnail } from './LinkImageThumbnail';
import * as linkContent from './linkContent';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LinkImageThumbnail', () => {
  it('loads a sanitized inline image preview and keeps click-to-expand behavior', async () => {
    const fetchSpy = vi.spyOn(linkContent, 'fetchLinkImageObjectUrl').mockResolvedValue('blob:img');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const onOpen = vi.fn();

    const { unmount } = render(
      <LinkImageThumbnail
        linkId="link-1"
        title="screenshot.png"
        subtitle="/home/agor/.agor/uploads/screenshot.png"
        onOpen={onOpen}
      />
    );

    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    const image = await screen.findByRole('img', { name: 'screenshot.png' });
    expect(image).toHaveAttribute('src', 'blob:img');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('link-1');
    expect(fetchSpy.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    fireEvent.click(
      screen.getByRole('button', { name: /open image preview for screenshot\.png/i })
    );

    expect(onOpen).toHaveBeenCalledWith({
      linkId: 'link-1',
      title: 'screenshot.png',
      subtitle: 'screenshot.png',
    });

    unmount();
    expect(revokeSpy).toHaveBeenCalledWith('blob:img');
  });

  it('falls back to click-to-preview when the inline thumbnail cannot load', async () => {
    vi.spyOn(linkContent, 'fetchLinkImageObjectUrl').mockRejectedValue(new Error('No preview'));

    render(
      <LinkImageThumbnail
        linkId="link-1"
        title="screenshot.png"
        subtitle="screenshot.png"
        onOpen={vi.fn()}
      />
    );

    expect(await screen.findByText('Click to preview')).toBeInTheDocument();
    expect(screen.queryByAltText('screenshot.png')).not.toBeInTheDocument();
  });

  it('defers image requests until the thumbnail is near the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;
    class IntersectionObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = '';
      thresholds = [];

      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    const fetchSpy = vi.spyOn(linkContent, 'fetchLinkImageObjectUrl').mockResolvedValue('blob:img');

    render(
      <LinkImageThumbnail
        linkId="link-1"
        title="screenshot.png"
        subtitle="screenshot.png"
        onOpen={vi.fn()}
      />
    );

    expect(fetchSpy).not.toHaveBeenCalled();

    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
  });
});
