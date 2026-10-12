'use client';

import styles from '../LandingPage.module.css';
import { commandCenterDetails } from './details/command-center';
import { FeatureSelector, type SelectorFeature } from './FeatureSelector';
import { LearnMore } from './LandingLink';
import { SectionHeroActions } from './SectionHeroActions';

// The builder's working surface, in the order a run of many agents needs it:
// organize, branch, fan out, share context, then build and run. Boards,
// sessions, and the gateway are the /board story; teammates and schedules are
// the /teammates story. Each row's anchor is its detail block on this page,
// whose screenshot it shows.
const FEATURES: SelectorFeature[] = [
  {
    label: 'Zones & prompts',
    body: 'Drop a branch into a zone to trigger its reusable prompt, so a review or release check starts the same way every time.',
    anchor: 'zones-and-prompts',
  },
  {
    label: 'Session trees',
    body: 'Fork to try an alternative, or spawn focused child sessions, and keep the whole thread in one tree.',
    anchor: 'session-trees',
  },
  {
    label: 'Parallel agents',
    body: 'Fan work out to several agents at once, then review the results together on the same branch card.',
    anchor: 'parallel-agents',
  },
  {
    label: 'Knowledge base',
    body: 'Give your team and its agents one shared place for decisions, runbooks, prompts, and reusable context.',
    anchor: 'knowledge',
  },
  {
    label: 'Branch environments',
    body: 'Start, stop, health-check, and read logs for every branch environment without port fights.',
    anchor: 'environments',
  },
  {
    label: 'Artifacts',
    body: 'Let agents render live dashboards, mockups, and tools right on the board.',
    anchor: 'artifacts',
  },
  {
    label: 'Agor MCP',
    body: 'Agents drive Agor through the same API as the UI: spawn peers, move work, run environments, schedule runs, and report back.',
    anchor: 'mcp',
  },
].map((feature) => ({
  ...feature,
  media: commandCenterDetails.find((detail) => detail.id === feature.anchor)?.media,
}));

export function CommandCenterSection({
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
      className={hero ? `${styles.productShowcase} ${styles.sectionHero}` : styles.productShowcase}
      data-reveal
      data-troupe-section="command-center"
    >
      <div className={styles.sectionHeader}>
        <span className={styles.eyebrow}>Stay sane with a lot of agents</span>
        <Heading>
          A <span className={styles.headingStrong}>command center</span>
          <br />
          for <span className={styles.headingAccent}>agent work</span>
        </Heading>
        {hero && <SectionHeroActions page="command-center" align="start" />}
      </div>
      <FeatureSelector
        features={FEATURES}
        page="command-center"
        placement={sampler ? 'home-section' : 'command-center-page-carousel'}
        label="Command center features"
      />
      {sampler && <LearnMore page="command-center" />}
    </section>
  );
}
