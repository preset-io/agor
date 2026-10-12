'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from '../LandingPage.module.css';
import { BoardSection } from './BoardSection';
import { CommandCenterSection } from './CommandCenterSection';
import { DetailNav, DetailSection } from './DetailSection';
import { LANDING_DETAILS } from './details';
import { GovernanceSection } from './GovernanceSection';
import { LandingLink } from './LandingLink';
import { LandingShell } from './LandingShell';
import { MultiplayerSection } from './MultiplayerSection';
import { LANDING_PAGES, type LandingPageId, landingPage } from './pages';
import { TeammatesSection } from './TeammatesSection';

// Each landing page's hero is its home-page section, promoted: h1 heading,
// CTA row, first-screen height (see the sections' `hero` prop).
const PAGE_HEROES: Record<LandingPageId, ReactNode> = {
  multiplayer: <MultiplayerSection hero />,
  board: <BoardSection hero />,
  teammates: <TeammatesSection hero />,
  'command-center': <CommandCenterSection hero />,
  governance: <GovernanceSection hero />,
};

// Proof that closes the story, after the detail blocks. (The teammates
// roster moved to its own page, /agent-roster.)
const PAGE_PROOF: Partial<Record<LandingPageId, ReactNode>> = {};

/**
 * Spoke page: its section as the hero, the detail blocks beside a section nav
 * (deep-link targets), proof, then docs and sibling pages.
 */
export function FeatureLanding({ page }: { page: LandingPageId }) {
  const entry = landingPage(page);
  const details = LANDING_DETAILS[page];
  const ctaPrefix = `${page}-page`;

  return (
    <LandingShell ctaPrefix={ctaPrefix}>
      {PAGE_HEROES[page]}
      {details.length ? (
        // Section nav rail beside the blocks (a pill row on narrow screens).
        <div className={styles.detailLayout}>
          <DetailNav details={details} />
          <div className={styles.detailColumn}>
            {details.map((detail) => (
              <DetailSection key={detail.id} detail={detail} />
            ))}
          </div>
        </div>
      ) : (
        details.map((detail) => <DetailSection key={detail.id} detail={detail} />)
      )}
      {PAGE_PROOF[page]}
      <section className={styles.pageLinks} data-reveal>
        <div>
          <h2 className={styles.pageLinksTitle}>Go deeper in the docs</h2>
          <ul className={styles.pageLinksList}>
            {entry.docs.map((doc) => (
              <li key={doc.href}>
                <Link href={doc.href}>
                  {doc.label} <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={styles.pageLinksTitle}>Explore more of Agor</h2>
          <ul className={styles.pageLinksList}>
            {LANDING_PAGES.filter((other) => other.id !== page).map((other) => (
              <li key={other.id}>
                <LandingLink page={other.id} placement={`${ctaPrefix}-explore`}>
                  {other.navLabel} <span aria-hidden="true">→</span>
                </LandingLink>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </LandingShell>
  );
}
