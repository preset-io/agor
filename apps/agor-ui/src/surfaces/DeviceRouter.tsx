import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useIsMobileViewport } from '../hooks/useIsMobileViewport';
import { agorStore } from '../store/agorStore';
import { isMobileShellPath, responsiveRoutePath } from '../utils/uiRoutes';
import { routeUsesDeviceRouter } from './surfaceRegistry';

/** Redirects between the mobile and desktop shells as the viewport crosses the shell breakpoint. */
export function DeviceRouter() {
  const { pathname, state: routeState } = useLocation();
  const routeStateRef = useRef(routeState);
  routeStateRef.current = routeState;
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    if (!routeUsesDeviceRouter(pathname)) return;
    const isOnMobilePath = isMobileShellPath(pathname);
    if (isMobile === isOnMobilePath) return;

    const state = agorStore.getState();
    const routeEntities = {
      boards: state.boardById.values(),
      sessions: state.sessionById.values(),
    };
    // Keep the entry's state (e.g. where the teammates directory was opened from) across the shell swap.
    navigate(responsiveRoutePath(pathname, isMobile ? 'mobile' : 'desktop', routeEntities), {
      replace: true,
      state: routeStateRef.current,
    });
  }, [pathname, isMobile, navigate]);

  return null;
}
