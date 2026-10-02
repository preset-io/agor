'use client';

import { useState } from 'react';
import styles from './CloudInviteCTA.module.css';
import { HubSpotFormModal } from './HubSpotFormModal';

interface JoinBetaCTAProps {
  label?: string;
  /** Attribution tag for the hidden `source_page` field — identify the
   * specific spot this instance renders (e.g. `blog-agor-cloud`), since this
   * component can appear in more than one place. */
  sourceCta: string;
}

/**
 * "Join the private beta" button that opens the HubSpot signup form in a
 * modal instead of navigating anywhere. Used where the form used to be
 * inline-embedded (blog/agor-cloud) and anywhere a beta CTA should keep the
 * reader on the page. Reuses CloudInviteCTA's primary-pill styling.
 */
export function JoinBetaCTA({ label = 'Sign up for Agor Cloud', sourceCta }: JoinBetaCTAProps) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={styles.primary}
        style={{ border: 0, cursor: 'pointer', font: 'inherit', fontWeight: 700 }}
        onClick={() => setIsOpen(true)}
      >
        {label} →
      </button>
      <HubSpotFormModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Join the Agor Cloud private beta"
        sourceCta={sourceCta}
      />
    </div>
  );
}
