import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { brandMarkHref } from '../branding/brand';
import { SURFACE_REGISTRY } from '../surfaces/surfaceRegistry';
import { useSurfaceBranding } from './useSurfaceBranding';

function setIconLink(href: string): void {
  let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

function currentIconHref(): string | null {
  return document.querySelector("link[rel~='icon']")?.getAttribute('href') ?? null;
}

const STATIC_SURFACES = SURFACE_REGISTRY.filter((s) => s.branding !== 'dynamic');
const DYNAMIC_SURFACE = SURFACE_REGISTRY.find((s) => s.branding === 'dynamic');

describe('useSurfaceBranding', () => {
  beforeEach(() => {
    for (const el of document.head.querySelectorAll("link[rel~='icon']")) el.remove();
    document.title = 'initial';
  });

  // Every static surface in the registry must end up with the absolute brand
  // mark + its declared title — so a newly added static surface inherits the
  // behavior for free through the central AppContent call.
  it.each(STATIC_SURFACES)('applies favicon + title for static surface "$id"', (surface) => {
    setIconLink('/stale-from-previous-surface.png');
    renderHook(() => useSurfaceBranding(surface));

    expect(document.title).toBe(surface.branding);
    expect(currentIconHref()).toBe(brandMarkHref());
  });

  it('leaves favicon + title untouched for the dynamic Workspace surface', () => {
    expect(DYNAMIC_SURFACE).toBeDefined();
    setIconLink('/board-status-dot.png');
    document.title = 'workspace-managed';

    renderHook(() => useSurfaceBranding(DYNAMIC_SURFACE!));

    // The Workspace shell owns the favicon/title via useFaviconStatus /
    // useBoardTitle; this hook must not stomp them.
    expect(document.title).toBe('workspace-managed');
    expect(currentIconHref()).toBe('/board-status-dot.png');
  });

  it('no-ops gracefully when no favicon link exists yet', () => {
    expect(STATIC_SURFACES.length).toBeGreaterThan(0);
    expect(() => renderHook(() => useSurfaceBranding(STATIC_SURFACES[0]))).not.toThrow();
    expect(document.title).toBe(STATIC_SURFACES[0].branding);
  });
});

describe('central branding wiring', () => {
  it('AppContent applies branding from the current surface', () => {
    // Structural guard: branding is enforced centrally off the registry, not
    // per-page. If this call is removed, static surfaces silently regress.
    const appSource = readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(appSource).toMatch(/useSurfaceBranding\(\s*currentSurface\s*\)/);
  });
});
