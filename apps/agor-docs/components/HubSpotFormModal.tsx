import { useEffect } from 'react';
import { HubSpotForm } from './HubSpotForm';
import styles from './HubSpotFormModal.module.css';

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
        className={styles.content}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <h2 className={styles.title}>{title}</h2>
        <HubSpotForm />
      </div>
    </div>
  );
}
