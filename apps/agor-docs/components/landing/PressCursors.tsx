'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import styles from './PressCursors.module.css';

/**
 * A few multiplayer cursors that wander the links inside `children`: glide
 * to one, hover (the link lights up in that cursor's color), click with the
 * same ring pulse as the home page's CursorTroupe, then move on. Purely
 * decorative: the layer ignores pointer events and nothing is really clicked.
 *
 * Shares the home troupe's colors, cursor shape, and opt-out (`?cursors=off`
 * on any page sets the same localStorage key). Never under reduced motion or
 * on touch, and the loop only runs while the section is on screen.
 */

const ENABLED_KEY = 'agor-cursor-troupe';

const CAST = [
  { color: '#f5a3c7', start: 0.3 },
  { color: '#6fdcf0', start: 1.4 },
  { color: '#f2d27a', start: 2.5 },
] as const;

type Phase = 'wait' | 'travel' | 'hover' | 'press' | 'linger';

interface Actor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: Phase;
  /** Seconds left in the current timed phase. */
  left: number;
  /** Seconds since the click, for the ring pulse; < 0 when idle. */
  pulse: number;
  size: number;
  opacity: number;
  link: HTMLAnchorElement | null;
  last: HTMLAnchorElement | null;
  /** Where on the link to land, as a 0..1 share of its width plus a y jitter. */
  ax: number;
  ay: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function readEnabled(): boolean {
  const param = new URLSearchParams(window.location.search).get('cursors');
  let off = param !== null && ['off', 'false', '0'].includes(param);
  try {
    if (param !== null) {
      if (off) localStorage.setItem(ENABLED_KEY, '0');
      else localStorage.removeItem(ENABLED_KEY);
    }
    off ||= param === null && localStorage.getItem(ENABLED_KEY) === '0';
  } catch {
    // Storage blocked: only the query param counts.
  }
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return !off && fine && !calm;
}

export function PressCursors({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRefs = useRef<Array<HTMLDivElement | null>>([]);
  const ringRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => setEnabled(readEnabled()), []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!enabled || !stage) return;
    const links = Array.from(stage.querySelectorAll<HTMLAnchorElement>('a[href]'));
    if (links.length < CAST.length) return;

    const actors: Actor[] = CAST.map((member) => ({
      x: Number.NaN,
      y: Number.NaN,
      vx: 0,
      vy: 0,
      phase: 'wait',
      left: member.start,
      pulse: -1,
      size: 0.72,
      opacity: 0,
      link: null,
      last: null,
      ax: 0,
      ay: 0,
    }));

    const release = (a: Actor) => {
      if (a.link) {
        a.link.removeAttribute('data-cursor-on');
        a.link.style.removeProperty('--cursor-color');
      }
      a.last = a.link;
      a.link = null;
    };

    const pickLink = (a: Actor) => {
      const taken = new Set(actors.map((o) => o.link).filter(Boolean));
      const free = links.filter((l) => !taken.has(l) && l !== a.last);
      a.link = free[Math.floor(Math.random() * free.length)] ?? null;
      a.ax = rand(0.15, 0.7);
      a.ay = rand(0.45, 0.8);
      a.phase = 'travel';
    };

    // Landing point on the link, in stage coordinates. Multi-line links use
    // their first line box so the cursor sits on actual text.
    const aim = (a: Actor, origin: DOMRect) => {
      const box = a.link?.getClientRects()[0];
      if (!box) return null;
      return {
        x: box.left - origin.left + Math.min(box.width * a.ax, 120),
        y: box.top - origin.top + box.height * a.ay,
      };
    };

    let raf = 0;
    let running = false;
    let prev = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000 || 0);
      prev = now;
      const origin = stage.getBoundingClientRect();

      actors.forEach((a, i) => {
        const el = cursorRefs.current[i];
        const ring = ringRefs.current[i];
        if (!el || !ring) return;

        if (Number.isNaN(a.x)) {
          // Enter from the stage's right edge at a staggered height.
          a.x = origin.width + 40;
          a.y = origin.height * (0.2 + i * 0.25);
        }

        if (a.phase === 'wait') {
          a.left -= dt;
          if (a.left <= 0) pickLink(a);
        }

        const target = a.link ? aim(a, origin) : null;
        if (target) {
          // Slightly underdamped spring: a quick glide with a small settle.
          const k = 34;
          const c = 2 * Math.sqrt(k) * 0.82;
          a.vx += ((target.x - a.x) * k - a.vx * c) * dt;
          a.vy += ((target.y - a.y) * k - a.vy * c) * dt;
          a.x += a.vx * dt;
          a.y += a.vy * dt;
        }

        if (a.phase === 'travel' && target) {
          const near = Math.hypot(target.x - a.x, target.y - a.y) < 3;
          if (near && Math.hypot(a.vx, a.vy) < 40) {
            a.phase = 'hover';
            a.left = rand(0.45, 0.9);
            a.link?.setAttribute('data-cursor-on', '');
            a.link?.style.setProperty('--cursor-color', CAST[i].color);
          }
        } else if (a.phase === 'hover' || a.phase === 'press' || a.phase === 'linger') {
          a.left -= dt;
          if (a.left <= 0) {
            if (a.phase === 'hover') {
              a.phase = 'press';
              a.left = 0.14;
              a.pulse = 0;
            } else if (a.phase === 'press') {
              a.phase = 'linger';
              a.left = rand(0.7, 1.6);
            } else {
              release(a);
              pickLink(a);
            }
          }
        }

        if (a.pulse >= 0) {
          a.pulse += dt / 0.6;
          if (a.pulse > 1) a.pulse = -1;
        }

        const busy = a.phase === 'hover' || a.phase === 'press' || a.phase === 'linger';
        const visible = a.phase !== 'wait';
        a.opacity += ((visible ? 1 : 0) - a.opacity) * Math.min(1, dt * 6);
        a.size += ((busy ? 1 : 0.72) - a.size) * Math.min(1, dt * 7);
        const fidget = a.phase === 'linger' ? Math.sin(now / 700 + i * 2.1) * 1.5 : 0;
        const px = a.x + fidget;
        const py = a.y + fidget * 0.6;
        const scale = a.size * (a.phase === 'press' ? 0.8 : 1);
        el.style.opacity = a.opacity.toFixed(3);
        el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        if (a.pulse >= 0) {
          ring.style.opacity = (1 - a.pulse).toFixed(3);
          ring.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) scale(${(0.3 + a.pulse * 1.2).toFixed(3)})`;
        } else if (ring.style.opacity !== '0') {
          ring.style.opacity = '0';
        }
      });

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      prev = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const io = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), {
      rootMargin: '80px 0px',
    });
    io.observe(stage);

    return () => {
      io.disconnect();
      stop();
      for (const a of actors) release(a);
    };
  }, [enabled]);

  return (
    <div className={styles.stage} ref={stageRef}>
      {children}
      {enabled ? (
        <div className={styles.layer} aria-hidden="true">
          {CAST.map((member, i) => (
            <div
              key={`ring-${member.color}`}
              className={styles.ring}
              style={{ borderColor: member.color }}
              ref={(el) => {
                ringRefs.current[i] = el;
              }}
            />
          ))}
          {CAST.map((member, i) => (
            <div
              key={member.color}
              className={styles.cursor}
              ref={(el) => {
                cursorRefs.current[i] = el;
              }}
            >
              <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
                <path
                  d="M2 1l15 8-7 1.6L7 18z"
                  fill={member.color}
                  stroke="#061010"
                  strokeWidth="1.2"
                />
              </svg>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
