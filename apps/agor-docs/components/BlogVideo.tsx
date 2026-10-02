'use client';

import { useEffect, useRef } from 'react';

interface BlogVideoProps {
  /** Full-size MP4, served at >= 768px viewports. */
  src: string;
  /** Optional smaller MP4 for phones. Falls back to `src` when omitted. */
  srcSmall?: string;
  /** Poster frame, also shown when the viewer prefers reduced motion. */
  poster: string;
  /** Screen-reader description of what the clip shows. */
  label: string;
  /** Intrinsic dimensions so the layout reserves space before the poster loads. */
  width?: number;
  height?: number;
}

/**
 * Silent looping product clip for blog posts. Renders as ambient motion
 * (no controls, no audio) and stays on the poster frame when the viewer
 * has asked for reduced motion. `muted` is set imperatively because React
 * does not reliably emit it in server-rendered markup, which blocks
 * autoplay in Chrome and Safari.
 */
export function BlogVideo({
  src,
  srcSmall,
  poster,
  label,
  width = 1600,
  height = 900,
}: BlogVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      if (reduceMotion.matches) {
        video.pause();
        video.removeAttribute('autoplay');
      } else {
        video.setAttribute('autoplay', '');
        video.play().catch(() => {
          /* Autoplay can be refused by the browser; the poster stays visible. */
        });
      }
    };
    apply();
    reduceMotion.addEventListener('change', apply);
    return () => reduceMotion.removeEventListener('change', apply);
  }, []);

  return (
    <video
      ref={ref}
      aria-label={label}
      poster={poster}
      width={width}
      height={height}
      loop
      muted
      playsInline
      preload="metadata"
      style={{
        display: 'block',
        width: '100%',
        height: 'auto',
        margin: '2rem 0',
        borderRadius: '12px',
        border: '1px solid rgba(127, 232, 223, 0.18)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.35)',
      }}
    >
      {srcSmall ? <source src={srcSmall} type="video/mp4" media="(max-width: 767px)" /> : null}
      <source src={src} type="video/mp4" />
    </video>
  );
}
