'use client';

import { CloudCtaLink } from '../CloudCtaLink';
import styles from '../LandingPage.module.css';
import { DemoButton } from './DemoButton';
import type { LandingPageId } from './pages';

/** CTA row a home section gains when it becomes its landing page's hero. */
export function SectionHeroActions({
  page,
  align = 'center',
}: {
  page: LandingPageId;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={
        align === 'start'
          ? `${styles.heroActions} ${styles.sectionHeroActionsStart}`
          : styles.heroActions
      }
    >
      <CloudCtaLink placement={`${page}-page-hero`} className={styles.primaryButton} />
      <DemoButton className={styles.secondaryButton}>Book a demo</DemoButton>
    </div>
  );
}
