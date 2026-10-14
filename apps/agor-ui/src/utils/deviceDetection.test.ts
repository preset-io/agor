import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIosDevice, preventIosInputZoom } from './deviceDetection';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

describe('isIosDevice', () => {
  it.each([
    [IPHONE, 5, true],
    [IPAD_DESKTOP_MODE, 5, true],
    [IPAD_DESKTOP_MODE, 0, false], // a Mac
    [ANDROID, 5, false],
  ])('%s with %d touch points -> %s', (userAgent, maxTouchPoints, expected) => {
    expect(isIosDevice({ userAgent, maxTouchPoints })).toBe(expected);
  });
});

describe('preventIosInputZoom', () => {
  const viewport = () => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;

  afterEach(() => {
    viewport()?.remove();
    vi.restoreAllMocks();
  });

  function setup(userAgent: string) {
    const meta = document.head.appendChild(document.createElement('meta'));
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  }

  it('caps the scale on iOS, once, so focusing a sub-16px field does not zoom', () => {
    setup(IPHONE);
    preventIosInputZoom();
    preventIosInputZoom();
    expect(viewport().content).toBe(
      'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1'
    );
  });

  it('leaves other browsers pinch-zoomable', () => {
    setup(ANDROID);
    preventIosInputZoom();
    expect(viewport().content).not.toContain('maximum-scale');
  });
});
