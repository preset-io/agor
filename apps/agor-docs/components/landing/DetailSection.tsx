'use client';

import Link from 'next/link';
import { type CSSProperties, type MouseEvent, useEffect, useRef, useState } from 'react';
import { HighlightedText } from '../heroCopy';
import styles from '../LandingPage.module.css';
import type { DetailMedia, LandingDetail } from './details/types';
import { RoleMatrix } from './RoleMatrix';

// Plays only while on screen, so a page of loops never decodes them all at once.
function InViewVideo({ media }: { media: Extract<DetailMedia, { type: 'video' }> }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.35 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      className={styles.detailMedia}
      muted
      loop
      playsInline
      preload="none"
      poster={media.poster}
      aria-label={media.alt}
    >
      {media.srcSmall ? (
        <source src={media.srcSmall} type="video/mp4" media="(max-width: 720px)" />
      ) : null}
      <source src={media.src} type="video/mp4" />
    </video>
  );
}

export function DetailSection({ detail }: { detail: LandingDetail }) {
  const { media } = detail;
  return (
    <section
      id={detail.id}
      className={media ? styles.detailSection : `${styles.detailSection} ${styles.detailTextOnly}`}
      data-reveal
    >
      <div className={styles.detailCopy}>
        {detail.eyebrow ? <span className={styles.eyebrow}>{detail.eyebrow}</span> : null}
        <h2 className={styles.detailTitle}>
          <HighlightedText text={detail.title} />
        </h2>
        {detail.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {detail.points?.length ? (
          <ul className={styles.detailPoints}>
            {detail.points.map((point) => (
              <li key={point.title}>
                <strong>{point.title}</strong>
                <span>{point.body}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {detail.links?.length ? (
          <p className={styles.detailLinks}>
            {detail.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                {...(link.href.startsWith('http')
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
              >
                {link.label} <span aria-hidden="true">→</span>
              </Link>
            ))}
          </p>
        ) : null}
      </div>
      {media ? (
        <div className={styles.detailMediaFrame}>
          {media.type === 'roleMatrix' ? (
            <RoleMatrix />
          ) : media.type === 'video' ? (
            <InViewVideo media={media} />
          ) : (
            // biome-ignore lint/performance/noImgElement: Static product screenshot
            <img className={styles.detailMedia} src={media.src} alt={media.alt} loading="lazy" />
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Section nav for a landing page's detail blocks. At desktop widths it's a
 * sticky rail beside the blocks that highlights the one in view; below that
 * it's the pill row. Clicks scroll smoothly (instantly under reduced motion)
 * and update the hash without a jump.
 */
export function DetailNav({ details }: { details: LandingDetail[] }) {
  const [active, setActive] = useState(details[0]?.id);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      let current = details[0]?.id;
      for (const detail of details) {
        const el = document.getElementById(detail.id);
        if (el && el.getBoundingClientRect().top <= line) current = detail.id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [details]);

  const go = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
    setActive(id);
  };

  return (
    <nav className={styles.detailNav} aria-label="On this page">
      <span className={styles.detailNavTitle}>On this page</span>
      {details.map((detail) => (
        <a
          key={detail.id}
          href={`#${detail.id}`}
          className={
            detail.id === active
              ? `${styles.detailNavLink} ${styles.detailNavLinkActive}`
              : styles.detailNavLink
          }
          aria-current={detail.id === active ? 'location' : undefined}
          onClick={(event) => go(event, detail.id)}
        >
          {/* Rail node (desktop): a quiet ring on the line; the active one
              lights up and pulses, like the trust list's bus. */}
          <span className={styles.detailNavNode} aria-hidden="true">
            {detail.id === active &&
              [0, 1, 2].map((ring) => (
                <i
                  key={ring}
                  className={styles.busRipple}
                  style={
                    {
                      '--ripple-size': '10px',
                      '--ripple-delay': `${ring * 1000}ms`,
                    } as CSSProperties
                  }
                />
              ))}
            <i className={styles.detailNavDot} />
          </span>
          {detail.navLabel}
        </a>
      ))}
    </nav>
  );
}
