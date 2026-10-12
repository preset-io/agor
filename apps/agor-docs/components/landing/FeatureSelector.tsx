'use client';

import { ChevronRight, Pause, Play } from 'lucide-react';
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import type { DetailMedia } from './details/types';
import styles from './FeatureSelector.module.css';
import { LandingLink } from './LandingLink';
import type { LandingPageId } from './pages';

/**
 * Feature selector (design handoff "feature demo selector"): an accordion of
 * features on the left drives the media panel on the right. Only the open row
 * shows its sentence, so the list reads as a menu to explore; chevrons make it
 * plain on phones that the rows open. Each open row's progress bar follows its
 * clip's playback and the next row takes over when the clip ends; a still
 * gets STILL_MS. Clicking a row holds it (auto-advance stops, the clip loops).
 * Stacked (≤1100px), the one panel opens beneath the open row.
 */

const STILL_MS = 8000;

export interface SelectorFeature {
  /** Detail block id on `page`: the Learn more target. */
  anchor: string;
  label: string;
  body: string;
  media?: DetailMedia;
}

/** Whether the home page's cursor troupe is running (html[data-troupe-on]). */
function useTroupeOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setOn(root.hasAttribute('data-troupe-on'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-troupe-on'] });
    return () => observer.disconnect();
  }, []);
  return on;
}

interface State {
  active: number;
  held: boolean;
}

type Action = { type: 'next'; count: number } | { type: 'select'; index: number };

function reducer(state: State, action: Action): State {
  if (action.type === 'select') return { active: action.index, held: true };
  if (state.held) return state;
  return { ...state, active: (state.active + 1) % action.count };
}

const on = (condition: boolean, className: string) => (condition ? ` ${className}` : '');
const pad = (n: number) => String(n).padStart(2, '0');

export function FeatureSelector({
  features,
  page,
  placement,
  label,
  troupe = false,
}: {
  features: SelectorFeature[];
  /** Landing page the Learn more links open. */
  page: LandingPageId;
  placement: string;
  /** Accessible name for the feature list. */
  label: string;
  /** The home page's board selector: the cursor troupe performs its videos. */
  troupe?: boolean;
}) {
  const [state, dispatch] = useReducer(reducer, { active: 0, held: false });
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [progress, setProgress] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const troupeOn = useTroupeOn() && troupe;
  const id = useId();

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const narrow = window.matchMedia('(max-width: 1100px)');
    const sync = () => {
      setReduced(motion.matches);
      setStacked(narrow.matches);
    };
    sync();
    motion.addEventListener('change', sync);
    narrow.addEventListener('change', sync);
    return () => {
      motion.removeEventListener('change', sync);
      narrow.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.2,
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const count = features.length;
  const media = features[state.active].media;
  const running = visible && !reduced && !userPaused;

  // Playback + progress. Videos report their own position; a still runs on a
  // wall clock. Either way the bar reads 0 → 1 over the clip and the next row
  // takes over at the end (or the clip starts over when the row is held).
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts per row, hold, and stacking (which remounts the panel)
  useEffect(() => {
    setProgress(0);
    const video = videoRef.current;
    if (!running) {
      video?.pause();
      return;
    }
    let raf = 0;
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {
        // Autoplay refused (e.g. data saver): the poster stays up.
      });
      const onEnded = () => {
        if (state.held) {
          video.currentTime = 0;
          video.play().catch(() => {});
        } else {
          dispatch({ type: 'next', count });
        }
      };
      video.addEventListener('ended', onEnded);
      const frame = () => {
        if (video.duration) setProgress(video.currentTime / video.duration);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      return () => {
        cancelAnimationFrame(raf);
        video.removeEventListener('ended', onEnded);
        video.pause();
      };
    }
    let start = performance.now();
    const frame = (now: number) => {
      const p = (now - start) / STILL_MS;
      if (p >= 1) {
        if (state.held) {
          start = now;
        } else {
          dispatch({ type: 'next', count });
          return;
        }
      }
      setProgress(Math.min(1, p));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running, state.active, state.held, stacked, troupeOn]);

  const bar = state.held || reduced ? 1 : progress;

  // While the troupe is on, play the cursor-free cuts (it supplies the cursors).
  const cut = (src: string) => (troupeOn ? src.replace(/(-540)?\.mp4$/, '-clean$1.mp4') : src);

  const panel = (className: string) => (
    <div
      className={`${styles.panel} ${className}`}
      data-troupe={troupe ? 'board-panel' : undefined}
    >
      {media?.type === 'video' ? (
        <video
          // Remount when switching to the cursor-free cut, so it reloads.
          key={`${media.src}${troupeOn ? ':clean' : ''}`}
          ref={videoRef}
          // The home page's cursor troupe performs this video's cursors from
          // its recorded track (demo-videos/capture.mjs --clean).
          data-troupe-video={troupeOn ? media.src.replace(/\.mp4$/, '-cursors.json') : undefined}
          className={styles.media}
          muted
          playsInline
          preload="metadata"
          poster={media.poster}
          aria-label={media.alt}
        >
          {media.srcSmall && (
            <source src={cut(media.srcSmall)} type="video/mp4" media="(max-width: 720px)" />
          )}
          <source src={cut(media.src)} type="video/mp4" />
        </video>
      ) : media?.type === 'image' ? (
        // biome-ignore lint/performance/noImgElement: Static product screenshot (static export, unoptimized images)
        <img key={media.src} className={styles.mediaStill} src={media.src} alt={media.alt} />
      ) : null}
      <span className={styles.counter} aria-hidden="true">
        {pad(state.active + 1)} / {pad(count)}
      </span>
      {!reduced && (
        <button
          type="button"
          className={styles.pauseToggle}
          onClick={() => setUserPaused((value) => !value)}
          aria-label={userPaused ? 'Play' : 'Pause'}
        >
          {userPaused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
        </button>
      )}
    </div>
  );

  return (
    <div className={styles.body} ref={bodyRef}>
      <ul className={styles.rows} aria-label={label}>
        {features.map((feature, index) => {
          const isActive = index === state.active;
          const regionId = `${id}-${index}`;
          return (
            <li key={feature.anchor} className={`${styles.row}${on(isActive, styles.rowActive)}`}>
              <button
                type="button"
                className={styles.rowButton}
                aria-expanded={isActive}
                aria-controls={regionId}
                onClick={() => dispatch({ type: 'select', index })}
              >
                <ChevronRight className={styles.chevron} size={20} aria-hidden />
                <span className={styles.rowTitle}>{feature.label}</span>
              </button>
              <div className={styles.reveal} id={regionId} inert={!isActive}>
                <div className={styles.revealInner}>
                  <p className={styles.rowBody}>
                    {feature.body}{' '}
                    <LandingLink
                      page={page}
                      anchor={feature.anchor}
                      placement={placement}
                      className={styles.learnMore}
                    >
                      Learn more
                      <span className={styles.srOnly}> about {feature.label.toLowerCase()}</span>{' '}
                      <span aria-hidden="true">→</span>
                    </LandingLink>
                  </p>
                  {/* One panel only: under the open row when stacked. */}
                  {stacked && isActive && panel(styles.panelInline)}
                </div>
              </div>
              <span className={styles.track} aria-hidden="true">
                <span
                  className={styles.fill}
                  style={{ transform: `scaleX(${isActive ? bar : 0})` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {!stacked && panel('')}
    </div>
  );
}
