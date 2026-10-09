'use client';

import {
  Blocks,
  Brain,
  CalendarClock,
  Hash,
  type LucideIcon,
  MessagesSquare,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AI_ENABLEMENT_POST_URL } from '../../lib/links';
import styles from '../LandingPage.module.css';
import Orb from '../Orb/Orb';
import { teammatesDetails } from './details/teammates';
import { LandingLink } from './LandingLink';
import { SectionHeroActions } from './SectionHeroActions';

// The ring is /teammates' table of contents: one node per detail block, in
// page order, labeled with the block's jump-link label (details/teammates.ts)
// so the ring, the jump links, and the blocks read as one set. The ring adds
// an icon and a one-line summary for the hub.
const RING: Record<string, { icon: LucideIcon; body: string }> = {
  'shared-ownership': {
    icon: Users,
    body: 'A teammate lives on a shared branch, so its instructions, memory, and history belong to the team, not one person’s setup.',
  },
  memory: {
    icon: Brain,
    body: 'Teammates keep memory across conversations, and Knowledge gives people and agents one shared place for runbooks and decisions.',
  },
  channels: {
    icon: Hash,
    body: 'Mention a teammate in Slack, Discord, GitHub, or Shortcut. It replies where you asked, running as the person who asked.',
  },
  schedules: {
    icon: CalendarClock,
    body: 'Standups, digests, and audits run on a schedule, each leaving a full transcript your team can review.',
  },
  'skills-and-mcp': {
    icon: Blocks,
    body: 'Package the steps your team repeats as skills, and connect teammates to your tools through MCP.',
  },
  onboarding: {
    icon: MessagesSquare,
    body: 'Onboard a teammate through a guided first conversation, then keep teaching it by correcting it, like a new colleague.',
  },
  identity: {
    icon: SlidersHorizontal,
    body: 'Give each teammate a clear job, a voice, and limits: what it does on its own and when it stops to ask.',
  },
};

const featureCards = teammatesDetails.flatMap((detail) => {
  const ring = RING[detail.id];
  return ring ? [{ anchor: detail.id, title: detail.navLabel, ...ring }] : [];
});

export function TeammatesSection({
  sampler = false,
  hero = false,
}: {
  sampler?: boolean;
  /** Render as its landing page's hero: h1 heading, CTA row, first-screen height. */
  hero?: boolean;
}) {
  const Heading = hero ? 'h1' : 'h2';
  const [activeFeature, setActiveFeature] = useState(0);
  const placement = sampler ? 'home-section' : 'teammates-page-ring';

  return (
    <section
      className={
        hero ? `${styles.workspaceSection} ${styles.sectionHero}` : styles.workspaceSection
      }
      data-reveal
      data-troupe-section="teammates"
    >
      <div className={styles.workspaceCopy}>
        <span className={styles.eyebrow}>Build on what your team teaches them</span>
        <Heading>
          Raise <span className={styles.headingAccent}>AI teammates</span> your whole{' '}
          <span className={styles.headingStrong}>team</span> can teach
        </Heading>
        <p>
          You shouldn’t have to start over every time. Give teammates memory, teach them skills,
          connect them to your tools, and bring them where your team works. People decide their
          scope and when they ask for help, and anyone can pick up where a colleague left off. What
          your{' '}
          <Link href={AI_ENABLEMENT_POST_URL} target="_blank" rel="noopener noreferrer">
            most AI-enabled people
          </Link>{' '}
          figure out becomes something the whole team can build on.
        </p>
        {hero && <SectionHeroActions page="teammates" align="start" />}
      </div>
      <div className={styles.featureRing} data-reveal>
        <div className={styles.ringStage}>
          {/* ReactBits orb: its glowing rim threads through the node
              centers, replacing the old 1px dashed guide circle. Sized so
              the rim (~80% of the orb's half-width) lands on the 37.5%
              node radius. */}
          <div className={styles.ringOrb} aria-hidden="true">
            <Orb hue={41} hoverIntensity={0} rotateOnHover forceHoverState={false} />
          </div>
          {featureCards.map((feature, index) => {
            const angle = ((-90 + index * (360 / featureCards.length)) * Math.PI) / 180;
            const radius = 37.5; // percent of stage, from center to node center
            const left = 50 + radius * Math.cos(angle);
            const top = 50 + radius * Math.sin(angle);
            const isActive = index === activeFeature;
            return (
              // Each node jumps to its block on /teammates; hover and focus
              // preview it in the hub.
              <LandingLink
                key={feature.anchor}
                page="teammates"
                anchor={feature.anchor}
                placement={placement}
                className={
                  isActive ? `${styles.ringNode} ${styles.ringNodeActive}` : styles.ringNode
                }
                style={{ left: `${left}%`, top: `${top}%` }}
                onPreview={() => setActiveFeature(index)}
              >
                <span className={styles.ringNodeIcon} aria-hidden>
                  <feature.icon size={15} />
                </span>
                <span>{feature.title}</span>
              </LandingLink>
            );
          })}
          <div className={styles.ringHub}>
            <div className={styles.ringHubInner} key={activeFeature}>
              <p>{featureCards[activeFeature].body}</p>
              <LandingLink
                page="teammates"
                anchor={featureCards[activeFeature].anchor}
                placement={placement}
                className={styles.ringButton}
              >
                Learn more
              </LandingLink>
            </div>
          </div>
        </div>
      </div>
      {/* Phone fallback for the ring (hover/click doesn't earn its keep on
          touch): every feature expanded in a scrollable divider list —
          icon left, content right, no interaction required. */}
      <div className={styles.featureList} data-reveal>
        {featureCards.map((feature) => (
          <article key={feature.anchor} className={styles.featureListItem}>
            <span className={styles.featureListIcon} aria-hidden>
              <feature.icon size={15} />
            </span>
            <div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <LandingLink
                page="teammates"
                anchor={feature.anchor}
                placement={placement}
                className={styles.featureListLink}
              >
                Learn more <span aria-hidden="true">→</span>
              </LandingLink>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
