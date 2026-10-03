'use client';

import { Download, Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { trackEvent } from '../../lib/analytics';
import { TIER_CTA_LABELS } from '../../lib/cloudCta';
import { GITHUB_REPO_URL } from '../../lib/links';
import { GitHubIcon } from '../BrandIcons';
import { CloudCtaLink } from '../CloudCtaLink';
import { HighlightedText, HOME_HERO } from '../heroCopy';
import styles from '../LandingPage.module.css';
import { DemoButton } from './DemoButton';
import { HeroLogo } from './HeroLogo';
import { LandingLink } from './LandingLink';
import { LANDING_PAGES } from './pages';

/**
 * Home hero (design handoff 2a): the pitch over a full-bleed video, the CTAs
 * in two labelled tiers (handoff "hero CTA tiers": Agor Cloud first, Agor
 * Community Edition smaller below), and the landing pages as a quiet row along
 * the bottom edge, so visitors who never scroll still see a way in.
 */
export function HomeHero() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);

  // Reduced motion or data saver: stay on the poster frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || saveData) {
      video.pause();
      setPaused(true);
    } else {
      video.play().catch(() => setPaused(true));
    }
  }, []);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setPaused(false));
    } else {
      video.pause();
      setPaused(true);
    }
  };

  return (
    <div className={styles.homeHero} data-troupe-section="hero">
      {/* Decorative loop; the poster is the layer's background image so it shows
          while loading, when paused, and under reduced motion. */}
      <div className={styles.homeHeroVideo} aria-hidden="true">
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          preload="metadata"
          poster="/videos/agor-hero-poster.jpg"
        >
          <source src="/videos/agor-hero-540.mp4" type="video/mp4" media="(max-width: 720px)" />
          <source src="/videos/agor-hero-720.mp4" type="video/mp4" media="(max-width: 1280px)" />
          <source src="/videos/agor-hero.mp4" type="video/mp4" />
        </video>
      </div>
      <div className={styles.homeHeroScrim} aria-hidden="true" />

      <section className={styles.homePitch}>
        {/* The troupe emerges from behind this (it anchors on .homeBadge). */}
        <HeroLogo className={styles.homeBadge} />
        <h1>
          <HighlightedText text={HOME_HERO.headline} />
        </h1>
        <p className={styles.homeSub}>
          <HighlightedText text={HOME_HERO.subheadline} />
        </p>
        <div className={styles.homeTiers}>
          <div className={styles.homeTier}>
            <p className={styles.homeKicker}>Agor Cloud</p>
            <div className={styles.homeCtaRow}>
              <CloudCtaLink
                placement="landing-hero"
                labels={TIER_CTA_LABELS}
                className={styles.homePrimary}
              />
              <DemoButton className={styles.homeSecondary}>Book a demo</DemoButton>
            </div>
          </div>
          <div className={`${styles.homeTier} ${styles.homeTierCe}`}>
            <p className={`${styles.homeKicker} ${styles.homeKickerMuted}`}>
              Agor Community Edition
            </p>
            <div className={styles.homeCeRow}>
              <Link
                href="/guide/getting-started"
                className={styles.homeCeBtn}
                onClick={() =>
                  trackEvent('nav_click', {
                    target: '/guide/getting-started',
                    placement: 'home-hero-ce',
                  })
                }
              >
                <Download size={16} aria-hidden />
                Install locally
              </Link>
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.homeCeBtn}
                onClick={() =>
                  trackEvent('nav_click', { target: GITHUB_REPO_URL, placement: 'home-hero-ce' })
                }
              >
                <GitHubIcon size={16} />
                Star on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      <nav className={styles.homeRow} aria-label="Explore Agor">
        {LANDING_PAGES.map((page) => (
          <LandingLink
            key={page.id}
            page={page.id}
            placement="home-hero"
            className={styles.homeRowItem}
          >
            <span className={styles.homeRowLabel}>
              {page.navLabel}
              <span aria-hidden="true">→</span>
            </span>
            <span className={styles.homeRowDesc}>{page.tagline}</span>
          </LandingLink>
        ))}
      </nav>

      <button
        type="button"
        className={styles.homeVideoToggle}
        onClick={togglePlayback}
        aria-label={paused ? 'Play background video' : 'Pause background video'}
      >
        {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
      </button>
    </div>
  );
}
