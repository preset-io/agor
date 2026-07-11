'use client';

import { useEffect, useState } from 'react';
import { HubSpotForm } from './HubSpotForm';
import styles from './HubSpotFormModal.module.css';
import { MeetingEmbed } from './HubSpotMeetingModal';

interface HubSpotFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
}

export function HubSpotFormModal({
  isOpen,
  onClose,
  title = 'Contact us about Agor Cloud',
}: HubSpotFormModalProps) {
  // "Prefer a chat first?" swaps the modal body to the meeting scheduler
  // instead of bouncing to the (Preset-branded) hubspot.com page.
  const [view, setView] = useState<'form' | 'meeting'>('form');

  // Fresh form view on every open.
  useEffect(() => {
    if (!isOpen) setView('form');
  }, [isOpen]);

  // Esc-to-close + lock background scroll while open.
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

  // Unmount the form entirely when closed so the next open gets a fresh
  // useId / target div — no stale hbspt-rendered DOM hanging around.
  if (!isOpen) return null;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation" aria-hidden="true">
      <div
        className={view === 'meeting' ? `${styles.content} ${styles.contentWide}` : styles.content}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={view === 'meeting' ? 'Book a demo' : title}
      >
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <h2 className={styles.title}>{view === 'meeting' ? 'Book a demo' : title}</h2>
        {view === 'meeting' ? (
          <MeetingEmbed />
        ) : (
          <HubSpotForm onBookDemo={() => setView('meeting')} />
        )}
      </div>
    </div>
  );
}
