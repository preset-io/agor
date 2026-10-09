'use client';

import Link from 'next/link';
import { CookieSettingsLink } from './CookieConsent';
import styles from './CookieConsent.module.css';

/** Privacy Policy · Terms of Use · Cookie settings, for every footer. */
export function FooterLegal({ className }: { className?: string }) {
  return (
    <nav className={`${styles.legal}${className ? ` ${className}` : ''}`} aria-label="Legal">
      <Link href="/privacy">Privacy Policy</Link>
      <span className={styles.legalDot} aria-hidden="true">
        ·
      </span>
      <Link href="/terms">Terms of Use</Link>
      <span className={styles.legalDot} aria-hidden="true">
        ·
      </span>
      <CookieSettingsLink className={styles.legalButton} />
    </nav>
  );
}
