import { render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInViewportOnce } from './useInViewportOnce';

type ObserverCallback = ConstructorParameters<typeof IntersectionObserver>[0];

function Probe() {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useInViewportOnce(ref);
  return <div ref={ref}>{seen ? 'seen' : 'hidden'}</div>;
}

describe('useInViewportOnce', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('latches true after the element intersects and disconnects on cleanup', async () => {
    let callback: ObserverCallback | undefined;
    const disconnect = vi.fn();

    class MockIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnect;
      takeRecords = vi.fn(() => []);

      constructor(cb: ObserverCallback) {
        callback = cb;
      }
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const { unmount } = render(<Probe />);

    expect(screen.getByText('hidden')).toBeInTheDocument();

    callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);

    await waitFor(() => expect(screen.getByText('seen')).toBeInTheDocument());

    unmount();

    expect(disconnect).toHaveBeenCalled();
  });
});
