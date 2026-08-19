'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * Shrinks an element's font-size (inline style) just enough that its
 * content fits within its own box, instead of overflowing. `clamp(...vw...)`
 * sizing scales with viewport width, not with how long a given line of text
 * is, so a long forced-nowrap line (see .heroForcedBreak in
 * LandingPage.module.css) can outgrow its box before a short one would.
 * Only engages once nowrap is actually active — below the 640px breakpoint,
 * normal wrapping already handles long lines safely, so there's nothing to
 * fit.
 *
 * Compares against the element's *own* clientWidth, not its parent's — the
 * parent (.heroCopy) has its own horizontal padding baked into its
 * clientWidth, which isn't available space for this child's content. Using
 * the parent's width as the target under-shrinks by exactly that padding.
 */
export function useFitText<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      el.style.fontSize = '';
      if (window.getComputedStyle(el).whiteSpace !== 'nowrap') return;

      const availableWidth = el.clientWidth;
      if (!availableWidth) return;

      if (el.scrollWidth > availableWidth) {
        const baseSize = Number.parseFloat(window.getComputedStyle(el).fontSize);
        // Floor at half size — if it still doesn't fit there, the copy
        // itself needs shortening rather than shrinking further into
        // illegibility.
        const scale = Math.max(0.5, availableWidth / el.scrollWidth);
        el.style.fontSize = `${baseSize * scale}px`;
      }
    };

    fit();
    // The custom webfont may still be loading at mount time — an early
    // fit() can measure against the fallback font's (often narrower)
    // metrics, under- or over-shrinking once the real font swaps in.
    // Re-fit once the browser confirms every requested font has loaded.
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });

    window.addEventListener('resize', fit);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', fit);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally re-runs the fit when the line's own content changes
  }, deps);

  return ref;
}
