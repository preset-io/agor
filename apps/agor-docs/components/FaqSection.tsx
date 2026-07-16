import type { ReactNode } from 'react';
import styles from './FaqSection.module.css';

// Presentational container for one FAQ question + answer. The `## heading`
// stays as real markdown inside `children` so Nextra's TOC/anchors keep
// working — this only adds the card chrome around each section.
export function FaqSection({ children }: { children: ReactNode }) {
  return <section className={styles.card}>{children}</section>;
}
