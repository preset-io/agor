import { describe, expect, it } from 'vitest';
import { getRouterBasename, uiRouteHref } from './uiRoutes';

describe('uiRoutes', () => {
  it('uses the /ui basename when the UI is mounted under /ui', () => {
    expect(getRouterBasename('/ui/')).toBe('/ui');
    expect(uiRouteHref('/a/artifact/fullscreen', '/ui/')).toBe('/ui/a/artifact/fullscreen');
  });

  it('omits the basename for dev-root mounted UI routes', () => {
    expect(getRouterBasename('/')).toBe('');
    expect(uiRouteHref('a/artifact/fullscreen', '/')).toBe('/a/artifact/fullscreen');
  });
});
