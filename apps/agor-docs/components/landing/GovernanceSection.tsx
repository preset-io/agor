'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { AI_ENABLEMENT_POST_URL } from '../../lib/links';
import { CloudCtaLink } from '../CloudCtaLink';
import styles from '../LandingPage.module.css';
import { LandingLink, LearnMore } from './LandingLink';
import type { LandingPageId } from './pages';
import { SectionHeroActions } from './SectionHeroActions';

// The "Compound Amplifying Bus": six trust items on a vertical mint spine —
// the deliberate counterpoint to the six amber problem cards piled up near the
// top of the home page (same count, calm straight line). These are the supporting
// trust layer: what's running, what it costs, who can do what. Ripple ring sizes
// and delays are static literals (SSR-safe, no randomness): ring count and
// size grow toward the bottom of the line — the "amplifying" effect. Delays
// spread each node's rings evenly across the shared 3s loop.
const busItems: Array<{
  title: string;
  page: LandingPageId;
  anchor: string;
  desc: string;
  beta?: boolean;
  rippleSize: number;
  rippleDelays: number[];
}> = [
  {
    title: 'Community Edition, self-hosted',
    page: 'governance',
    anchor: 'self-hosted',
    desc: 'Your repos, your database, your infrastructure. Source-available under BSL 1.1, with production use permitted.',
    rippleSize: 10,
    rippleDelays: [0, 1500],
  },
  {
    title: 'No frontier lock-in',
    page: 'governance',
    anchor: 'model-choice',
    desc: 'Claude Code, Codex, Gemini, Copilot, OpenCode. Pick the best harness per session, and switch the day something better ships.',
    rippleSize: 13,
    rippleDelays: [0, 1000, 2000],
  },
  {
    title: 'Governance & visibility',
    page: 'governance',
    anchor: 'visibility',
    desc: 'Visibility across your boards and agent sessions, with usage tracked along the way. Know what’s running and what it costs.',
    rippleSize: 17,
    rippleDelays: [0, 750, 1500, 2250],
  },
  {
    title: 'Permissions',
    page: 'governance',
    anchor: 'permissions',
    desc: 'Roles on every board and branch decide who can view the work, collaborate on it, or manage it.',
    rippleSize: 20,
    rippleDelays: [0, 600, 1200, 1800, 2400],
  },
  {
    title: 'Execution isolation',
    page: 'governance',
    anchor: 'isolation',
    desc: 'Application RBAC paired with fail-closed local sandboxing or a reviewed delegated runtime.',
    rippleSize: 24,
    rippleDelays: [0, 600, 1200, 1800, 2400],
  },
  {
    title: 'Agor Cloud is here',
    page: 'governance',
    anchor: 'cloud',
    desc: 'Fully managed Agor for teams who’d rather not run it themselves. ',
    beta: true,
    rippleSize: 27,
    rippleDelays: [0, 600, 1200, 1800, 2400],
  },
];

// Story beat: the problem section's six amber cards in a chaotic pile → six
// mint items on a calm straight line here. The "Compound Amplifying Bus".
export function GovernanceSection({
  sampler = false,
  hero = false,
}: {
  sampler?: boolean;
  /** Render as its landing page's hero: h1 heading, CTA row, first-screen height. */
  hero?: boolean;
}) {
  const Heading = hero ? 'h1' : 'h2';
  return (
    <section
      className={hero ? `${styles.controlSection} ${styles.sectionHero}` : styles.controlSection}
      data-reveal
      data-troupe-section="governance"
    >
      <div>
        {hero ? (
          <>
            <Heading>
              Know what’s <span className={styles.headingStrong}>running</span>
              <br />
              and who can do{' '}
              <span className={`${styles.headingAccent} ${styles.compoundWord}`}>what</span>
            </Heading>
            <p>
              See every agent session and what it costs, decide who can view, collaborate on, or
              manage each board and branch, and choose where it runs: on your own infrastructure or
              ours. Controls that help your team work together, not a way to watch over it.
            </p>
          </>
        ) : (
          <>
            <Heading>
              Bring AI to the <span className={styles.headingStrong}>whole team</span>
              <br />
              with{' '}
              <span className={`${styles.headingAccent} ${styles.compoundWord}`}>confidence</span>
            </Heading>
            <p>
              Agor gives your{' '}
              <Link href={AI_ENABLEMENT_POST_URL} target="_blank" rel="noopener noreferrer">
                AI enablers
              </Link>{' '}
              a way to make useful work visible, bring colleagues into it, and turn it into
              workflows everyone can use and improve. Along the way, you know what’s running, what
              it costs, and who can do what.
            </p>
          </>
        )}
        {/* Home keeps just the Explore link; the landing page gets the CTAs. */}
        {hero && <SectionHeroActions page="governance" align="start" />}
        {sampler && <LearnMore page="governance" />}
      </div>
      <ul className={styles.busList}>
        {busItems.map((item) => (
          <li key={item.title} className={styles.busItem}>
            <span className={styles.busNode} aria-hidden="true">
              {item.rippleDelays.map((delay) => (
                <i
                  key={delay}
                  className={styles.busRipple}
                  style={
                    {
                      '--ripple-size': `${item.rippleSize}px`,
                      '--ripple-delay': `${delay}ms`,
                    } as CSSProperties
                  }
                />
              ))}
              <i className={styles.busNodeDot} />
            </span>
            <h3 className={styles.busTitle}>
              <LandingLink
                page={item.page}
                anchor={item.anchor}
                placement={sampler ? 'home-section' : 'governance-page-bus'}
                className={styles.titleLink}
              >
                {item.title}
                {hero ? (
                  <span aria-hidden="true" className={styles.busJump}>
                    ↓
                  </span>
                ) : null}
              </LandingLink>
            </h3>
            <div className={styles.busDesc}>
              {item.desc}
              {item.beta && (
                <>
                  <CloudCtaLink placement="landing-bus-item" className={styles.busBetaLink} />.
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
