import type { ReactNode } from 'react';
import styles from './Tree.module.css';

// Styles a plain nested markdown list as an ASCII-style tree (├─ └─ │ drawn
// with CSS borders). Author the content as a normal markdown list inside
// <Tree> — no bespoke data structure, stays maintainable and diffable.
export function Tree({ children }: { children: ReactNode }) {
  return <div className={styles.tree}>{children}</div>;
}
