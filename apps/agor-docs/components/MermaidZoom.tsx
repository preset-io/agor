'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './MermaidZoom.module.css';

// Mounted once in the docs layout. Nextra renders mermaid diagrams inline and
// they're often too small to read; this makes every mermaid SVG click-to-open
// in a lightbox with wheel/button zoom and drag-to-pan. Diagrams render
// client-side and async, so a MutationObserver catches ones that appear late.
export function MermaidZoom() {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setSvgHtml(null), []);

  // Tag mermaid diagrams with an affordance + click handler.
  useEffect(() => {
    const enhance = () => {
      const svgs = document.querySelectorAll<SVGSVGElement>(
        'main svg[id^="mermaid"], main svg[aria-roledescription]'
      );
      for (const svg of svgs) {
        const host = svg.closest<HTMLElement>('[data-mermaid-zoom]') ?? svg.parentElement;
        if (!host || host.dataset.mermaidZoom === 'on') {
          continue;
        }
        host.dataset.mermaidZoom = 'on';
        host.classList.add(styles.host);
        host.addEventListener('click', () => {
          setScale(1);
          setSvgHtml(svg.outerHTML);
        });
      }
    };
    enhance();
    const mo = new MutationObserver(enhance);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  // Escape to close.
  useEffect(() => {
    if (!svgHtml) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [svgHtml, close]);

  // Wheel = zoom toward a clamped range.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(6, Math.max(0.4, s * (e.deltaY < 0 ? 1.12 : 0.89))));
  };

  // Drag to pan the scroll viewport.
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const vp = viewportRef.current;
    if (!vp) {
      return;
    }
    vp.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, l: vp.scrollLeft, t: vp.scrollTop };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const vp = viewportRef.current;
    if (!vp || !drag.current) {
      return;
    }
    vp.scrollLeft = drag.current.l - (e.clientX - drag.current.x);
    vp.scrollTop = drag.current.t - (e.clientY - drag.current.y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  if (!svgHtml) {
    return null;
  }

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Enlarged diagram"
      onClick={close}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: buttons carry their own handlers; this only stops backdrop close */}
      <div className={styles.toolbar} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setScale((s) => Math.max(0.4, s * 0.83))}
        >
          −
        </button>
        <button type="button" aria-label="Reset zoom" onClick={() => setScale(1)}>
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setScale((s) => Math.min(6, s * 1.2))}
        >
          +
        </button>
        <button type="button" aria-label="Close" onClick={close}>
          ✕
        </button>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop handles keys; this just stops propagation */}
      <div
        ref={viewportRef}
        className={styles.viewport}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          className={styles.stage}
          style={{ transform: `scale(${scale})` }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: cloning our own already-rendered mermaid SVG, not user input
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      </div>
    </div>
  );
}
