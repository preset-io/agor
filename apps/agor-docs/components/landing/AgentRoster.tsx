'use client';

import Link from 'next/link';
import { trackEvent } from '../../lib/analytics';
import landing from '../LandingPage.module.css';
import styles from './AgentRoster.module.css';
import { LandingShell } from './LandingShell';
import { RosterSection } from './RosterSection';
import { ROSTER } from './roster';

const TEAMMATE_REPO_URL = 'https://github.com/preset-io/agor-teammate';

const FRAMEWORK_LINKS = [
  {
    title: 'Docs',
    links: [
      { label: 'Raise your first teammate', href: '/guide/first-teammate' },
      { label: 'How teammates remember', href: '/guide/teammates' },
      { label: 'AI teammates on Agor', href: '/teammates' },
    ],
  },
  {
    title: 'From the blog',
    links: [
      { label: 'Agent modeling 101', href: '/blog/agent-modeling-101' },
      { label: 'Raise a team helper agent', href: '/blog/raise-team-helper-agent' },
      { label: 'Agor and OpenClaw', href: '/blog/openclaw' },
    ],
  },
];

// Only members someone has written about get a listing; each card links on
// to that post. The radar still shows the whole roster.
const LISTINGS = ROSTER.filter((member) => member.story);

/**
 * /agent-roster: the AI teammates Preset runs on its own Agor instance, as
 * worked examples of what a team can raise. The radar is the hero, then one
 * listing per teammate, then how a teammate is defined.
 */
export function AgentRoster() {
  return (
    <LandingShell ctaPrefix="agent-roster-page">
      <RosterSection hero />

      <section className={styles.listings} aria-labelledby="roster-listings" data-reveal>
        <h2 id="roster-listings" className={styles.listingsTitle}>
          Meet the <span className={landing.headingAccent}>roster</span>
        </h2>
        <div className={styles.grid}>
          {LISTINGS.map((member) => (
            <article key={member.id} id={member.id} className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.icon} aria-hidden="true">
                  <member.icon size={18} />
                </span>
                <div>
                  <h3>{member.name}</h3>
                  <p className={styles.role}>{member.role}</p>
                </div>
              </div>
              {member.abstract ? <p className={styles.abstract}>{member.abstract}</p> : null}
              <p className={styles.meta}>{member.meta}</p>
              {member.story ? (
                <Link
                  href={member.story.href}
                  className={styles.storyLink}
                  {...(member.story.external
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                  onClick={() => trackEvent('roster_story_click', { member: member.name })}
                >
                  {member.story.label} <span aria-hidden="true">→</span>
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {/* Raise your own: how every teammate above is defined, with where to
          read more. Set apart from the listings on purpose. */}
      <section className={styles.frameworkSection} aria-labelledby="teammate-framework" data-reveal>
        <div className={styles.framework}>
          <div>
            <span className={landing.eyebrow}>Raise your own</span>
            <h2 id="teammate-framework">How a teammate is defined</h2>
            <p>
              Every teammate above is built on the{' '}
              <Link href={TEAMMATE_REPO_URL} target="_blank" rel="noopener noreferrer">
                agor-teammate framework
              </Link>
              , inspired by OpenClaw. A teammate lives on its own branch with a few plain markdown
              files: <code>SOUL.md</code> for its values and voice, <code>IDENTITY.md</code> for its
              name, board, and Knowledge namespace, <code>USER.md</code> for who it works with,{' '}
              <code>BOOT.md</code> for its startup checklist, and an optional{' '}
              <code>HEARTBEAT.md</code> for recurring work. Long-term memory lives in Agor
              Knowledge, where the team can read and correct it. A new teammate onboards through its
              first conversation, working toward a real result.
            </p>
          </div>
          <div className={styles.frameworkLinks}>
            {FRAMEWORK_LINKS.map((group) => (
              <div key={group.title}>
                <h3>{group.title}</h3>
                <ul>
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href}>
                        {link.label} <span aria-hidden="true">→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>
    </LandingShell>
  );
}
