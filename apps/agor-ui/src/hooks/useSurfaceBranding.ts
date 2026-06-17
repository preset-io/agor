/**
 * Applies a surface's static branding (favicon + document title) for surfaces
 * that render outside the Workspace shell and therefore don't run
 * useFaviconStatus / useBoardTitle.
 *
 * Pins the favicon to the absolute, base-aware brand mark so deep-linked nested
 * routes (e.g. `/ui/knowledge/<ns>/<doc>`) don't fall back to the relative
 * index.html href, which resolves against the current path and 404s.
 */

import { useEffect } from 'react';
import { brandMarkHref } from '../branding/brand';
import type { RouteSurfaceDefinition } from '../surfaces/surfaceRegistry';

export function useSurfaceBranding(surface: RouteSurfaceDefinition) {
  useEffect(() => {
    if (surface.branding === 'dynamic') return;

    const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
    if (link) {
      link.href = brandMarkHref();
    }
    document.title = surface.branding;
  }, [surface]);
}
