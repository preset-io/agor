'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CloudCtaVariant } from '../../lib/cloudCta';
import { CloudCtaLink } from '../CloudCtaLink';
import { FaqSection } from '../FaqSection';
import { HighlightedText } from '../heroCopy';
import styles from '../LandingPage.module.css';
import { DemoButton } from './DemoButton';
import { DetailNav, DetailSection } from './DetailSection';
import {
  teamsBeforeAfter,
  teamsFaq,
  teamsHero,
  teamsProblem,
  teamsSolution,
  teamsSteps,
  teamsTeamLayer,
  teamsTrust,
} from './details/teams';
import { LandingShell } from './LandingShell';
import { SocialProofBand, SourceLink } from './SocialProofBand';
import campaign from './TeamsCampaignLanding.module.css';

const CTA_PREFIX = 'teams-campaign';

// The campaign's ads promise "Get started", so the label stays fixed whatever
// the Cloud gate status; CloudCtaLink still picks the href, fires the GA4
// events, and forwards gclid/gbraid/wbraid and the HubSpot token.
const GET_STARTED_LABELS: Record<CloudCtaVariant, string> = {
  console: 'Get started',
  waitlist: 'Get started',
  capacity: 'Get started',
  hubspot_modal: 'Get started',
};

const NAV = [
  { id: teamsProblem.id, navLabel: teamsProblem.navLabel },
  { id: teamsSolution.id, navLabel: teamsSolution.navLabel },
  { id: 'how-it-works', navLabel: 'How it works' },
  { id: 'proof', navLabel: 'In practice' },
  { id: teamsTeamLayer.id, navLabel: teamsTeamLayer.navLabel },
  { id: teamsTrust.id, navLabel: teamsTrust.navLabel },
  { id: 'faq', navLabel: 'FAQ' },
];

function CampaignActions({ placement, align }: { placement: string; align?: 'start' }) {
  return (
    <div
      className={
        align === 'start'
          ? `${styles.heroActions} ${styles.sectionHeroActionsStart}`
          : styles.heroActions
      }
    >
      <CloudCtaLink
        placement={placement}
        labels={GET_STARTED_LABELS}
        className={styles.primaryButton}
      />
      <DemoButton className={styles.secondaryButton}>Book a demo</DemoButton>
    </div>
  );
}

/** `[label](href)` in FAQ copy becomes a link; everything else is plain text. */
function withLinks(text: string): ReactNode[] {
  return text.split(/(\[[^\]]+\]\([^)]+\))/).map((part) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    return link ? (
      <Link key={part} href={link[2]}>
        {link[1]}
      </Link>
    ) : (
      part
    );
  });
}

/**
 * /teams: a standalone Google Ads landing page for Agor Cloud. Unlisted
 * (noindex, out of the sitemap and site search, linked from nowhere), so it
 * reuses the landing skeleton without joining LANDING_PAGES.
 */
export function TeamsCampaignLanding() {
  return (
    <LandingShell
      ctaPrefix={CTA_PREFIX}
      searchable={false}
      finalCta={
        <section className={styles.finalCta} data-reveal>
          <div className={styles.ctaCard}>
            <h2>
              Give your best AI habits to the{' '}
              <span className={styles.headingAccent}>whole team</span>
            </h2>
            <CampaignActions placement={`${CTA_PREFIX}-final-cta`} />
          </div>
        </section>
      }
    >
      <section className={`${styles.controlSection} ${styles.sectionHero}`} data-reveal>
        <div>
          <span className={styles.eyebrow}>{teamsHero.eyebrow}</span>
          <h1>
            <HighlightedText text={teamsHero.headline} />
          </h1>
          <p className={campaign.subhead}>{teamsHero.subhead}</p>
          <CampaignActions placement={`${CTA_PREFIX}-hero`} align="start" />
        </div>
        {/* TODO(campaign): replace with a real capture of a Slack thread
            next to the Agor board. Do not ship a mocked-up product shot. */}
        <div
          className={campaign.placeholder}
          role="img"
          aria-label="Placeholder for a Slack thread beside the Agor board"
        >
          <span className={campaign.placeholderTag}>Placeholder</span>
          <span>Hero visual: Slack thread plus Agor board capture</span>
        </div>
      </section>

      <div className={styles.detailLayout}>
        <DetailNav details={NAV} />
        <div className={styles.detailColumn}>
          <DetailSection detail={teamsProblem} />
          <DetailSection detail={teamsSolution} />

          <section className={campaign.compare} data-reveal>
            <table className={campaign.compareTable}>
              <caption className={styles.srOnly}>Before Agor and with Agor</caption>
              <thead>
                <tr>
                  <th scope="col">Before Agor</th>
                  <th scope="col">With Agor</th>
                </tr>
              </thead>
              <tbody>
                {teamsBeforeAfter.map((row) => (
                  <tr key={row.before}>
                    <td>{row.before}</td>
                    <td>{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section id="how-it-works" className={campaign.steps} data-reveal>
            <h2 className={styles.detailTitle}>
              How it <span className={styles.headingAccent}>works</span>
            </h2>
            <ol className={campaign.stepList}>
              {teamsSteps.map((step) => (
                <li key={step.title}>
                  <strong>{step.title}</strong> <span>{step.body}</span>
                </li>
              ))}
            </ol>
            <p className={campaign.stepsHelp}>
              Want help setting it up?{' '}
              <DemoButton className={campaign.inlineButton}>Book a demo</DemoButton>.
            </p>
          </section>

          <div id="proof" className={campaign.proof}>
            <SocialProofBand
              only={[1]}
              attribution={
                <>
                  From the Red Hat blog,{' '}
                  <SourceLink>
                    ‘Taming the agent beast: from monolithic prompt to modular agentic workflow’
                  </SourceLink>
                </>
              }
            />
          </div>

          <DetailSection detail={teamsTeamLayer} />
          <DetailSection detail={teamsTrust} />

          <section id="faq" className={campaign.faq} data-reveal>
            <h2 className={styles.detailTitle}>
              Frequently asked <span className={styles.headingStrong}>questions</span>
            </h2>
            {teamsFaq.map((item) => (
              <FaqSection key={item.question}>
                <h3>{item.question}</h3>
                <p>{withLinks(item.answer)}</p>
              </FaqSection>
            ))}
          </section>
        </div>
      </div>
    </LandingShell>
  );
}
