'use client';

import landing from '../LandingPage.module.css';
import { boardDetails } from './details/board';
import { FeatureSelector, type SelectorFeature } from './FeatureSelector';
import styles from './FeatureSelector.module.css';

/**
 * Home-page board section: four features drive the media panel. The media
 * are the real captures /board's detail blocks use (looked up by anchor, so
 * the two never drift apart); the cursor troupe performs their cursors.
 */
const mediaFor = (anchor: string) => boardDetails.find((detail) => detail.id === anchor)?.media;

const FEATURES: SelectorFeature[] = [
  {
    anchor: 'boards-and-zones',
    label: 'Boards & zones',
    body: 'Give every piece of work a place. Drop a branch into a zone and its prompt template starts the next step.',
  },
  {
    anchor: 'attention',
    label: 'What needs you',
    body: 'Cards glow when an agent is waiting on you, the browser tab shows it too, and every prompt shows what it cost.',
  },
  {
    anchor: 'sessions',
    label: 'Agent sessions',
    body: 'Follow tool calls as they happen, queue the next instruction while the agent works, and branch off child sessions.',
  },
  {
    anchor: 'gateway',
    label: 'Slack & more',
    body: 'Mention your Agor bot in Slack, Discord, GitHub, or Shortcut. It runs as the person who asked and replies in the thread.',
  },
].map((feature) => ({ ...feature, media: mediaFor(feature.anchor) }));

export function BoardSelector() {
  return (
    <section
      className={`${landing.showcaseSection} ${styles.section}`}
      data-reveal
      data-troupe-section="board"
    >
      {/* No aurora divider here: the multiplayer band above already
          carries one, and a second poked a bright strip into it. */}
      <div className={`${landing.sectionHeader} ${styles.head}`}>
        <h2>
          See the work and <span className={landing.headingStrong}>shape</span> it{' '}
          <span className={landing.headingAccent}>together</span>
        </h2>
        <p className={styles.sub}>
          <span className={styles.subLead}>Live boards for your agent work.</span> Organize it, see
          what needs you, and follow every session, from the canvas or the threads your team already
          uses.
        </p>
      </div>
      <FeatureSelector
        features={FEATURES}
        page="board"
        placement="home-section"
        label="Board features"
        troupe
      />
    </section>
  );
}
