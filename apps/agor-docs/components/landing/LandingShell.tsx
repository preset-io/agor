'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useRef } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, PRESET_URL, presetUtm } from '../../lib/links';
import { getBasePath, LOGO_MARK_PATH } from '../../lib/siteMetadata';
import { CloudCtaLink } from '../CloudCtaLink';
import { FinePrint } from '../FinePrint';
import styles from '../LandingPage.module.css';
import { SocialLinks } from '../SocialLinks';
import { DemoButton } from './DemoButton';
import { LandingLink } from './LandingLink';
import { LANDING_PAGES } from './pages';

const basePath = getBasePath();

interface LandingShellProps {
  /** Prefix for the Cloud CTA attribution slugs, e.g. `landing` or `board-page`. */
  ctaPrefix: string;
  children: ReactNode;
}

/** Page frame shared by the home page and every landing page: reveal-on-scroll, final CTA, footer. */
export function LandingShell({ ctaPrefix, children }: LandingShellProps) {
  const landingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const landing = landingRef.current;
    if (!landing) {
      return;
    }

    const revealItems = Array.from(landing.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!revealItems.length) {
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealItems.forEach((item) => {
        item.classList.add(styles.isVisible);
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Very tall sections can never reach the 14% ratio in a phone
          // viewport, so also reveal once the visible slice fills a third
          // of the screen.
          if (
            entry.isIntersecting &&
            (entry.intersectionRatio >= 0.14 ||
              entry.intersectionRect.height >= window.innerHeight * 0.34)
          ) {
            entry.target.classList.add(styles.isVisible);
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: [0, 0.07, 0.14] }
    );

    revealItems.forEach((item) => {
      observer.observe(item);
    });

    return () => observer.disconnect();
  }, []);

  return (
    // <main> (not div): landing pages use Nextra's "full" layout, which
    // provides no main landmark of its own — this is the page's only one.
    // id matches Nextra's "Skip to Content" anchor (#nextra-skip-nav) — the
    // full-page layout omits the docs content wrapper that normally carries it.
    <main ref={landingRef} id="nextra-skip-nav" className={styles.landingShell}>
      {children}

      <section className={styles.finalCta} data-reveal data-troupe-section="final">
        <div className={styles.ctaCard}>
          <h2>
            Bring your <span className={styles.headingStrong}>team</span> and{' '}
            <span className={styles.headingAccent}>agents</span>{' '}
            <span data-troupe="together">together</span>
          </h2>
          <p>
            Start on your own with Agor Community Edition and bring colleagues in as you go, or talk
            to us about rolling Agor out across your team. Agor Cloud is here when you’d rather we
            run it.
          </p>
          <div className={styles.heroActions}>
            <CloudCtaLink placement={`${ctaPrefix}-final-cta`} className={styles.primaryButton} />
            <DemoButton className={styles.secondaryButton}>Book a demo</DemoButton>
            <Link href="/guide/getting-started" className={styles.secondaryButton}>
              Install Community Edition
            </Link>
          </div>
        </div>
      </section>

      <footer className={styles.landingFooter} data-reveal>
        <div className={styles.footerBrand}>
          {/* Decorative: the adjacent wordmark already names the product. */}
          {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
          <img src={`${basePath}${LOGO_MARK_PATH}`} alt="" width="44" height="44" />
          <div>
            <strong>agor</strong>
            <p>Multiplayer AI. Work together again.</p>
            <Link href="/blog/making-of-agor" className={styles.footerEtymology}>
              <span>AG</span>ent <span>OR</span>chestration
            </Link>
            <SocialLinks placement={`${ctaPrefix}-footer`} />
          </div>
        </div>
        <div className={styles.footerLinks}>
          <div>
            <h3>Product</h3>
            {LANDING_PAGES.map((page) => (
              <LandingLink key={page.id} page={page.id} placement={`${ctaPrefix}-footer`}>
                {page.navLabel}
              </LandingLink>
            ))}
            <Link href="/cloud">Agor Cloud</Link>
            <Link href="/security">Security</Link>
          </div>
          <div>
            <h3>Resources</h3>
            <Link href="/guide/getting-started">Get started</Link>
            <Link href="/guide">Documentation</Link>
            <Link href="/blog">Blog</Link>
            <Link href="/agent-roster">Agent roster</Link>
            <Link href="/faq">FAQ</Link>
            <Link href="/contact">Talk to us</Link>
          </div>
          <div>
            <h3>Community</h3>
            <Link href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </Link>
            <Link href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
              Discord
            </Link>
            <CloudCtaLink placement={`${ctaPrefix}-footer`} />
          </div>
        </div>
        <p className={styles.footerCredit}>
          <Link
            href={`${PRESET_URL}${presetUtm('footer-logo')}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Preset website"
          >
            {/* biome-ignore lint/performance/noImgElement: Static docs asset */}
            <img src="/preset-logo.svg" alt="Preset logo" className={styles.footerCreditLogo} />
          </Link>
          Built by{' '}
          <Link
            href={`${PRESET_URL}${presetUtm('footer-credit')}`}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.footerCreditLink}
          >
            Preset, Inc.
          </Link>
        </p>
        <p className={styles.footerTrademarks}>
          <FinePrint />
        </p>
      </footer>
    </main>
  );
}
