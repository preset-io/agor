'use client';

import { useState } from 'react';
import { AGOR_CLOUD_INVITE_URL, agorCloudInviteUrl } from '../lib/links';
import styles from './CloudInviteCTA.module.css';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';

interface CloudInviteCTAProps {
  primaryLabel?: string;
  demoLabel?: string;
  primaryHref?: string;
  /** Attribution tag the console forwards to HubSpot's source_page field. */
  source?: string;
}

export function CloudInviteCTA({
  primaryLabel = 'Join the Private Beta',
  demoLabel = 'Book a Demo',
  source,
  primaryHref = source ? agorCloudInviteUrl(source) : AGOR_CLOUD_INVITE_URL,
}: CloudInviteCTAProps) {
  const isInPageAnchor = primaryHref.startsWith('#') || primaryHref.startsWith('/');
  // The scheduler opens in an on-site modal instead of linking out to the
  // (Preset-branded) meetings.hubspot.com page.
  const [isDemoOpen, setIsDemoOpen] = useState(false);
  return (
    <div className={styles.wrapper}>
      <a
        href={primaryHref}
        {...(isInPageAnchor ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
        className={styles.primary}
      >
        {primaryLabel} →
      </a>
      <button
        type="button"
        className={styles.secondary}
        style={{ cursor: 'pointer', font: 'inherit' }}
        onClick={() => setIsDemoOpen(true)}
      >
        {demoLabel} →
      </button>
      <HubSpotMeetingModal isOpen={isDemoOpen} onClose={() => setIsDemoOpen(false)} />
    </div>
  );
}
