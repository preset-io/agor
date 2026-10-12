'use client';

import type { CSSProperties } from 'react';
import Aurora from '../Aurora/Aurora';
import styles from '../LandingPage.module.css';
import { LandingLink } from './LandingLink';
import { SectionHeroActions } from './SectionHeroActions';
import { WorkTogetherDemo } from './WorkTogetherDemo';

// Harnesses with an executor handler in packages/executor/src/sdk-handlers.
// Logos mirror the in-app ToolIcon set (apps/agor-ui/src/assets/tools), copied
// into this app's public/tools. Cursor is in beta and has no logo asset yet —
// it falls back to its ⌘ glyph until one lands.
const harnesses: Array<{ name: string; logo?: string; glyph?: string; beta?: boolean }> = [
  { name: 'Claude Code', logo: '/tools/claude-code.png' },
  { name: 'Codex', logo: '/tools/codex.png' },
  { name: 'Gemini', logo: '/tools/gemini.png' },
  { name: 'Copilot', logo: '/tools/copilot.png' },
  { name: 'OpenCode', logo: '/tools/opencode.png' },
  { name: 'Cursor', logo: '/tools/cursor.png', beta: true },
];

const revealDelay = (index: number): CSSProperties =>
  ({ '--reveal-delay': `${index * 70}ms` }) as CSSProperties;

// Multiplayer numbered cards (mockup design language, our copy)
const liveCards = [
  {
    title: 'Live presence',
    anchor: 'live-presence',
    body: 'Cursors, comments, and live sessions as work happens, all on the same board.',
  },
  {
    title: 'Shared dev environments',
    anchor: 'shared-environments',
    body: 'Engineers, reviewers, PMs, and QA rally around the same branches and builds. No more “spin up your own to see it.”',
  },
  {
    title: 'Learn from each other',
    anchor: 'learn-together',
    body: 'Watch how teammates prompt, standardize the patterns that work, and build a shared knowledge base as you go.',
  },
];

export function MultiplayerSection({
  sampler = false,
  hero = false,
}: {
  sampler?: boolean;
  /** Render as its landing page's hero: h1 heading, CTA row, first-screen height. */
  hero?: boolean;
}) {
  const Heading = hero ? 'h1' : 'h2';
  return (
    <div className={styles.auroraBand}>
      <div className={styles.bandAurora} aria-hidden="true">
        {/* Aqua is the solution color (amber marks problems, as in the problem
            section above); this ramp echoes the demo board's background. */}
        <Aurora colorStops={['#1b6f8a', '#2ec4b6', '#9bf6ff']} amplitude={0.9} blend={1} />
      </div>
      <section
        className={hero ? `${styles.liveSection} ${styles.sectionHero}` : styles.liveSection}
        data-reveal
      >
        {hero ? (
          // Hero: the statement beside the live-presence loop, cards below.
          <div className={styles.liveHeroGrid}>
            <div>
              <Heading className={styles.liveStatement}>
                Work <span className={styles.headingAccent}>together</span>{' '}
                <span className={styles.headingStrong}>again</span>
              </Heading>
              <p className={styles.liveSub}>
                One shared board instead of ten private terminals.
                <br />
                <span className={styles.headingDim}>
                  Bring your team and agents together on one live,{' '}
                  <span className={styles.headingAccent}>multiplayer canvas</span>.
                </span>
              </p>
              {hero && <SectionHeroActions page="multiplayer" align="start" />}
            </div>
            <div
              className={styles.liveHeroMedia}
              style={{ backgroundImage: 'url(/videos/showcase-multiplayer-poster.jpg)' }}
            >
              <video
                autoPlay
                muted
                loop
                playsInline
                poster="/videos/showcase-multiplayer-poster.jpg"
                aria-label="Teammates and agents working on the same Agor board, with live cursors"
              >
                <source
                  src="/videos/showcase-multiplayer-540.mp4"
                  type="video/mp4"
                  media="(max-width: 720px)"
                />
                <source src="/videos/showcase-multiplayer.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        ) : (
          // Home: the self-playing demo, which ends on the same three cards.
          <WorkTogetherDemo />
        )}
        {hero && (
          <div className={styles.liveGrid}>
            {liveCards.map((card, index) => (
              <article
                className={styles.numberedCard}
                key={card.title}
                data-reveal
                style={revealDelay(index)}
              >
                <h3>
                  <LandingLink
                    page="multiplayer"
                    anchor={card.anchor}
                    placement="multiplayer-page-cards"
                    className={styles.titleLink}
                  >
                    {card.title}
                  </LandingLink>
                </h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={styles.harnessStrip} data-reveal>
        <span className={styles.harnessLabel}>
          <LandingLink
            page="multiplayer"
            anchor="any-agent"
            placement={sampler ? 'home-section' : 'multiplayer-page-harness'}
            className={styles.titleLink}
          >
            Built on the harnesses you already use
          </LandingLink>
        </span>
        <ul className={styles.harnessList}>
          {harnesses.map((harness) => (
            <li className={styles.harnessItem} key={harness.name}>
              <span className={styles.harnessLogo}>
                {harness.logo ? (
                  // biome-ignore lint/performance/noImgElement: Static brand logo
                  <img src={harness.logo} alt={`${harness.name} logo`} />
                ) : (
                  <span className={styles.harnessGlyph}>{harness.glyph}</span>
                )}
              </span>
              <span className={styles.harnessName}>{harness.name}</span>
              {harness.beta ? <span className={styles.harnessBeta}>Beta</span> : null}
            </li>
          ))}
        </ul>
        <p className={styles.harnessNote}>
          Bring your own provider and subscription. Pick the best harness per session, no lock-in.
          All in a web workspace that leaves the terminal behind.
        </p>
      </section>
    </div>
  );
}
