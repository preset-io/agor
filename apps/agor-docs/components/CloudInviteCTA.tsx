'use client';

import { useState } from 'react';
import { CloudCtaLink } from './CloudCtaLink';
import styles from './CloudInviteCTA.module.css';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';

interface CloudInviteCTAProps {
  /** Attribution slug for this spot (utm_content on the console link). */
  placement?: string;
  demoLabel?: string;
  /**
   * A fixed primary link instead of the status-driven Cloud CTA (e.g. the
   * open beta post linking straight to the console). Both must be set.
   */
  primaryLabel?: string;
  primaryHref?: string;
  /** Render the primary pill. Set false for a demo-only secondary CTA. */
  showPrimary?: boolean;
  /** Render the "Book a Demo" button. Set false for a primary-only CTA. */
  showDemo?: boolean;
  /** Ignored: buttons never carry arrows on this site. Kept for existing posts. */
  arrow?: boolean;
}

export function CloudInviteCTA({
  placement = 'cloud-invite',
  demoLabel = 'Book a Demo',
  primaryLabel,
  primaryHref,
  showPrimary = true,
  showDemo = true,
}: CloudInviteCTAProps) {
  // The scheduler opens in an on-site modal instead of linking out to the
  // (Preset-branded) meetings.hubspot.com page.
  const [isDemoOpen, setIsDemoOpen] = useState(false);
  const isInPageAnchor = primaryHref?.startsWith('#') || primaryHref?.startsWith('/');
  return (
    <div className={styles.wrapper}>
      {showPrimary &&
        (primaryHref && primaryLabel ? (
          <a
            href={primaryHref}
            {...(isInPageAnchor ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
            className={styles.primary}
          >
            {primaryLabel}
          </a>
        ) : (
          <CloudCtaLink placement={placement} className={styles.primary} />
        ))}
      {showDemo && (
        <>
          <button
            type="button"
            className={styles.secondary}
            style={{ cursor: 'pointer', font: 'inherit' }}
            onClick={() => setIsDemoOpen(true)}
          >
            {demoLabel}
          </button>
          <HubSpotMeetingModal isOpen={isDemoOpen} onClose={() => setIsDemoOpen(false)} />
        </>
      )}
    </div>
  );
}
