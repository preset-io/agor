'use client';

import { useState } from 'react';
import { AGOR_CLOUD_INVITE_URL } from '../lib/links';
import styles from './CloudInviteCTA.module.css';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';

interface CloudInviteCTAProps {
  primaryLabel?: string;
  demoLabel?: string;
  primaryHref?: string;
  /** Render the primary pill. Set false for a demo-only secondary CTA. */
  showPrimary?: boolean;
  /** Render the "Book a Demo" button. Set false for a primary-only CTA. */
  showDemo?: boolean;
  /** Append a trailing arrow to button labels. */
  arrow?: boolean;
}

export function CloudInviteCTA({
  primaryLabel = 'Join the Private Beta',
  demoLabel = 'Book a Demo',
  primaryHref = AGOR_CLOUD_INVITE_URL,
  showPrimary = true,
  showDemo = true,
  arrow = true,
}: CloudInviteCTAProps) {
  const suffix = arrow ? ' →' : '';
  const isInPageAnchor = primaryHref.startsWith('#') || primaryHref.startsWith('/');
  // The scheduler opens in an on-site modal instead of linking out to the
  // (Preset-branded) meetings.hubspot.com page.
  const [isDemoOpen, setIsDemoOpen] = useState(false);
  return (
    <div className={styles.wrapper}>
      {showPrimary && (
        <a
          href={primaryHref}
          {...(isInPageAnchor ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          className={styles.primary}
        >
          {primaryLabel}
          {suffix}
        </a>
      )}
      {showDemo && (
        <>
          <button
            type="button"
            className={styles.secondary}
            style={{ cursor: 'pointer', font: 'inherit' }}
            onClick={() => setIsDemoOpen(true)}
          >
            {demoLabel}
            {suffix}
          </button>
          <HubSpotMeetingModal isOpen={isDemoOpen} onClose={() => setIsDemoOpen(false)} />
        </>
      )}
    </div>
  );
}
