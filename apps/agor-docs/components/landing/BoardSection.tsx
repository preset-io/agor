'use client';

import Aurora from '../Aurora/Aurora';
import styles from '../LandingPage.module.css';
import { BoardSelector } from './BoardSelector';
import selector from './FeatureSelector.module.css';
import { SectionHeroActions } from './SectionHeroActions';

/**
 * The board section. On the home page it's the feature selector
 * (BoardSelector), which hands off to /board. As /board's own hero it's just
 * the statement, CTAs, and a still of the board: the detail blocks below it
 * break each feature out, so the page doesn't need the selector too.
 */
export function BoardSection({ hero = false }: { sampler?: boolean; hero?: boolean }) {
  if (!hero) return <BoardSelector />;
  return (
    <section className={`${styles.showcaseSection} ${styles.sectionHero}`} data-reveal>
      <div className={styles.showcaseDivider} aria-hidden="true">
        <Aurora
          colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
          amplitude={0.9}
          blend={1}
          speed={0.6}
        />
      </div>
      <div className={`${styles.sectionHeader} ${selector.head}`}>
        <h1>
          See the work and <span className={styles.headingStrong}>shape</span> it{' '}
          <span className={styles.headingAccent}>together</span>
        </h1>
        <p className={selector.sub}>
          <span className={selector.subLead}>Live boards for your agent work.</span> Organize it,
          see what needs you, and follow every session, from the canvas or the threads your team
          already uses.
        </p>
        <SectionHeroActions page="board" align="start" />
      </div>
      {/* biome-ignore lint/performance/noImgElement: Static product screenshot (static export, unoptimized images) */}
      <img
        className={selector.heroShot}
        src="/screenshots/board-hero.png"
        alt="An Agor board with branch cards arranged in zones, live artifacts and notes, teammates’ cursors, and a comment thread."
      />
    </section>
  );
}
