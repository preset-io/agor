import { describe, expect, it } from 'vitest';
import { getRouterBasename, responsiveRoutePath, uiRouteHref } from './uiRoutes';

describe('uiRoutes', () => {
  it('uses the /ui basename when the UI is mounted under /ui', () => {
    expect(getRouterBasename('/ui/')).toBe('/ui');
    expect(uiRouteHref('/a/artifact/fullscreen', '/ui/')).toBe('/ui/a/artifact/fullscreen');
  });

  it('omits the basename for dev-root mounted UI routes', () => {
    expect(getRouterBasename('/')).toBe('');
    expect(uiRouteHref('a/artifact/fullscreen', '/')).toBe('/a/artifact/fullscreen');
  });

  it('accepts canonical /ui deep links in root-mounted dev environments', () => {
    expect(getRouterBasename('/', '/ui/kb/global/readme.md')).toBe('/ui');
    expect(getRouterBasename('/', '/')).toBe('');
  });
});

describe('responsiveRoutePath', () => {
  const entities = {
    boards: [{ board_id: '01a012d8-1b9b-7909-b6f4-2024dfc7c51e', slug: 'default' }],
    sessions: [{ session_id: '01a012d8-4f50-7c32-9daa-6e3f70819b2c' }],
  };

  it('preserves board context in both directions', () => {
    expect(responsiveRoutePath('/b/default/', 'mobile', entities)).toBe(
      '/m/board/01a012d8-1b9b-7909-b6f4-2024dfc7c51e'
    );
    expect(
      responsiveRoutePath('/m/board/01a012d8-1b9b-7909-b6f4-2024dfc7c51e', 'desktop', entities)
    ).toBe('/b/default/');
  });

  it('preserves session context in both directions', () => {
    expect(responsiveRoutePath('/s/01a012d8/', 'mobile', entities)).toBe(
      '/m/session/01a012d8-4f50-7c32-9daa-6e3f70819b2c'
    );
    expect(
      responsiveRoutePath('/m/session/01a012d8-4f50-7c32-9daa-6e3f70819b2c', 'desktop', entities)
    ).toBe('/s/01a012d8/');
  });
});
