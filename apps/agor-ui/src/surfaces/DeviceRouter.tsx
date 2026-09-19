import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useIsMobileViewport } from '../hooks/useIsMobileViewport';
import { agorStore } from '../store/agorStore';
import { responsiveRoutePath } from '../utils/uiRoutes';
import { routeUsesDeviceRouter } from './surfaceRegistry';

/** Redirects between the mobile and desktop shells as the viewport crosses the shell breakpoint. */
export function DeviceRouter() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    if (!routeUsesDeviceRouter(pathname)) return;
    const isOnMobilePath = pathname.startsWith('/m');
    if (isMobile === isOnMobilePath) return;

    const state = agorStore.getState();
    const routeEntities = {
      boards: state.boardById.values(),
      sessions: state.sessionById.values(),
    };
    navigate(responsiveRoutePath(pathname, isMobile ? 'mobile' : 'desktop', routeEntities), {
      replace: true,
    });
  }, [pathname, isMobile, navigate]);

  return null;
}
