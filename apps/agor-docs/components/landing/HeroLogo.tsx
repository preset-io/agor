'use client';

import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import styles from './HeroLogo.module.css';

/*
 * The Agor mark's reveal, ported from the reel intro
 * (demo-videos/animated_agor_logo/index.html on the demo-videos-syllabus
 * branch): the dots coalesce from the center and spin out to their resting
 * angles, the comet-tail arcs and inner ring sweep on behind them, the A draws
 * in one stroke, the crossbar shrinks up into place, and a shine crosses the
 * finished mark. 734×734 viewBox, 29px strokes, everything on one 4.5s clock.
 */
const A_PATH =
  'M188,607 C188,607 306.427,380.615 351.693,294.083 C355.033,287.698 361.66,283.713 368.865,283.756 C376.071,283.799 382.649,287.862 385.914,294.286 C420.058,361.482 494,507 494,507';
const CROSSBAR_PATH =
  'M293.84,404.67 C307.45,431.55 335.34,450 367.5,450 C400,450 428.13,431.17 441.58,403.83';
const RING_PATH = 'M556,367 A189,189 0 1,0 178,367 A189,189 0 1,0 556,367';
const ARC_PATHS = ['M367,70 A297,297 0 0,0 188,607', 'M367,664 A297,297 0 0,0 664,367'];
/** Each dot and the angle its arm starts the spin from. */
const DOTS = [
  { cx: 367, cy: 70, start: 360 },
  { cx: 367, cy: 664, start: 360 },
  { cx: 188, cy: 607, start: 413 },
  { cx: 664, cy: 367, start: 360 },
];

/** How long the finished mark takes to fade before a replay. */
const FADE_MS = 220;

/** When the dots finish spinning out (60% of the 4.5s build). */
const DOTS_LAND_MS = 2_700;

/**
 * The home hero's Agor mark: plays its reveal on load (the cursor troupe
 * emerges from behind it), then rests as the static logo. Clicking replays it;
 * the troupe listens for the same click to start its show over.
 */
export function HeroLogo({ className }: { className?: string }) {
  const [take, setTake] = useState(0);
  const [ready, setReady] = useState(false);
  // Set once the dots have spun to rest (60% of the 4.5s build); the cursor
  // troupe waits for it and emerges from the dots.
  const [landed, setLanded] = useState(false);
  const [fading, setFading] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const maskId = `agor-logo-mask-${useId().replace(/:/g, '')}`;

  // Measure each drawn path (dash lengths), then start every animation on the
  // same frame. Padded by 2: at dashoffset === dasharray exactly, some
  // browsers paint a stray rounded-cap stub at the path's start.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure per take (remount)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    setReady(false);
    setLanded(false);
    for (const path of svg.querySelectorAll<SVGPathElement>(`.${styles.drawable}`)) {
      path.style.setProperty('--len', String(path.getTotalLength() + 2));
    }
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(raf);
  }, [take]);

  useEffect(() => {
    if (!ready) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => setLanded(true), reduced ? 0 : DOTS_LAND_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <button
      type="button"
      className={`${styles.logo}${className ? ` ${className}` : ''}`}
      onClick={() => {
        if (fading) return;
        // Clear "landed" in this same render (not the effect's later one), so
        // the troupe never sees the old flag after its replay.
        setLanded(false);
        // Fade the finished mark out quickly, then replay the reveal.
        setFading(true);
        setTimeout(() => {
          setFading(false);
          setTake((n) => n + 1);
        }, FADE_MS);
      }}
      data-dots-landed={landed ? '' : undefined}
      aria-label="Agor"
      title="Agor"
    >
      <svg
        key={take}
        ref={svgRef}
        className={
          [ready && styles.ready, fading && styles.fading].filter(Boolean).join(' ') || undefined
        }
        viewBox="0 0 734 734"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${maskId}-shine`} x1="0" y1="1" x2="0.7" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          {/* The finished silhouette: the shine only lights the mark itself. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="734" height="734">
            <g
              fill="none"
              stroke="#fff"
              strokeWidth="29"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={RING_PATH} />
              {ARC_PATHS.map((d) => (
                <path key={d} d={d} />
              ))}
              <path d={A_PATH} />
              <path d={CROSSBAR_PATH} />
            </g>
            <g fill="#fff">
              {DOTS.map(({ cx, cy }) => (
                <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={40} />
              ))}
            </g>
          </mask>
        </defs>

        {/* Under the frame, so while it grows any overhang is cropped by the
            frame's own strokes on top. */}
        <path className={`${styles.stroke} ${styles.crossbar}`} d={CROSSBAR_PATH} />
        <path className={`${styles.stroke} ${styles.drawable} ${styles.apath}`} d={A_PATH} />
        <path className={`${styles.stroke} ${styles.drawable} ${styles.ring}`} d={RING_PATH} />
        {ARC_PATHS.map((d) => (
          <path key={d} className={`${styles.stroke} ${styles.drawable} ${styles.arc}`} d={d} />
        ))}
        {DOTS.map(({ cx, cy, start }) => (
          <g
            key={`${cx},${cy}`}
            className={styles.arm}
            style={{ '--s': `${start}deg` } as CSSProperties}
          >
            {/* r=40 in markup: browsers that can't animate `r` still show it. */}
            <circle className={styles.dot} data-logo-dot="" cx={cx} cy={cy} r={40} />
          </g>
        ))}
        <rect
          className={styles.shine}
          x="0"
          y="0"
          width="260"
          height="734"
          fill={`url(#${maskId}-shine)`}
          mask={`url(#${maskId})`}
        />
      </svg>
    </button>
  );
}
