'use client';

import { useEffect, useState } from 'react';
import { AGOR_CLOUD_DEMO_URL } from '../lib/links';
import styles from './HubSpotFormModal.module.css';

interface HubSpotMeetingModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
}

/**
 * "Book a Demo" scheduler in the same glass modal as the beta form, instead
 * of bouncing to the (Preset-branded) meetings.hubspot.com page. HubSpot's
 * official MeetingsEmbedCode.js just injects an iframe pointed at the
 * scheduler URL with ?embed=true — rendering that iframe directly makes
 * repeat opens deterministic (no loader-script re-scan). The calendar's
 * internals are HubSpot-rendered; we own everything around it.
 */
declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

/** Spinner-gated scheduler iframe — shared by the standalone meeting modal
 * and the beta-form modal's "book a demo instead" view. */
export function MeetingEmbed() {
  const [frameReady, setFrameReady] = useState(false);

  // "Opened" isn't something HubSpot's meeting embed reports back to us —
  // unlike the contact form's hsFormCallback postMessage contract, the
  // meetings scheduler bundle only ever posts a consent-readiness handshake,
  // an iframe-resize notice, and a final booking success/failure (confirmed
  // by reading its shipped JS — see app/layout.tsx's booking-tracking
  // script). There's no "in progress" signal to latch onto either. So the
  // "opened the scheduler" moment is something we already know ourselves —
  // this component mounting IS that moment, in every context it's used
  // (the standalone meeting modal and the contact-form modal's "book a demo
  // instead" view alike).
  useEffect(() => {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: 'hubspot_meeting_open' });
  }, []);

  return (
    <>
      {!frameReady && (
        <output className={styles.meetingLoading} aria-label="Loading scheduler">
          <span className={styles.meetingSpinner} aria-hidden="true" />
        </output>
      )}
      <iframe
        src={`${AGOR_CLOUD_DEMO_URL}?embed=true`}
        className={
          frameReady ? `${styles.meetingFrame} ${styles.meetingFrameReady}` : styles.meetingFrame
        }
        title="Book a demo — scheduling calendar"
        onLoad={() => setFrameReady(true)}
      />
    </>
  );
}

export function HubSpotMeetingModal({
  isOpen,
  onClose,
  title = 'Book a demo',
}: HubSpotMeetingModalProps) {
  // Esc-to-close + lock background scroll while open (mirrors HubSpotFormModal).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  // Unmount when closed so each open gets a fresh iframe + spinner.
  if (!isOpen) return null;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation" aria-hidden="true">
      <div
        className={`${styles.content} ${styles.contentWide}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <h2 className={styles.title}>{title}</h2>
        <MeetingEmbed />
      </div>
    </div>
  );
}
