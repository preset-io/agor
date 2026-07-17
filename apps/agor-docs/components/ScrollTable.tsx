import type { ReactNode } from 'react';
import styles from './ScrollTable.module.css';

// Wraps a wide markdown table in a horizontal scroll container with the first
// column pinned (frozen) and a visible scroll affordance. Author a normal
// markdown table inside <ScrollTable>.
export function ScrollTable({ children }: { children: ReactNode }) {
  return <div className={styles.scroll}>{children}</div>;
}
