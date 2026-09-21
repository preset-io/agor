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
    expect(responsiveRoutePath('/s/01a012d84f507c329daa6e3f/', 'mobile', entities)).toBe(
      '/m/session/01a012d8-4f50-7c32-9daa-6e3f70819b2c'
    );
    expect(
      responsiveRoutePath('/m/session/01a012d8-4f50-7c32-9daa-6e3f70819b2c', 'desktop', entities)
    ).toBe('/s/01a012d84f507c329daa6e3f/');
  });

  it('preserves cold board and canonical session tokens for loader healing', () => {
    const cold = { boards: [], sessions: [] };
    expect(responsiveRoutePath('/b/delivery/', 'mobile', cold)).toBe('/m/board/delivery');
    expect(responsiveRoutePath('/s/01a012d84f507c329daa6e3f/', 'mobile', cold)).toBe(
      '/m/session/01a012d84f507c329daa6e3f'
    );
  });

  it('does not select an arbitrary session for an ambiguous prefix', () => {
    const ambiguous = {
      boards: [],
      sessions: [...entities.sessions, { session_id: '01a012d8-4f50-7c32-9daa-6e3f99999999' }],
    };
    expect(responsiveRoutePath('/s/01a012d84f507c329daa6e3f/', 'mobile', ambiguous)).toBe(
      '/m/session/01a012d84f507c329daa6e3f'
    );
  });

  // A board the store hasn't hydrated yet has no slug to route by, so the
  // desktop path has to fall back to the canonical short id rather than the
  // raw UUID the mobile route carries.
  it('falls back to the canonical short id when the board is unknown', () => {
    expect(
      responsiveRoutePath('/m/board/01a012d8-9999-7909-b6f4-2024dfc7c51e', 'desktop', entities)
    ).toBe('/b/01a012d899997909b6f42024/');
  });

  // Marketplace and search are desktop modals with no route, so hand off a flag
  // the workspace opens on arrival instead of dumping the user on a bare Home.
  it('hands the marketplace and search tabs to the matching desktop surface', () => {
    expect(responsiveRoutePath('/m/marketplace', 'desktop', entities)).toBe('/?open=mcp-catalog');
    expect(responsiveRoutePath('/m/search', 'desktop', entities)).toBe('/?open=search');
  });

  it('still sends other mobile-only tabs (e.g. sessions) to desktop Home', () => {
    expect(responsiveRoutePath('/m/sessions', 'desktop', entities)).toBe('/');
    expect(responsiveRoutePath('/m', 'desktop', entities)).toBe('/');
  });
});
