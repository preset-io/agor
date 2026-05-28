import Link from 'next/link';
import styles from './NavbarCloudCTA.module.css';

export function NavbarCloudCTA() {
  return (
    <Link href="/blog/agor-cloud" className={styles.link} aria-label="Agor Cloud">
      <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4a7.5 7.5 0 0 0-6.93 4.74A5.99 5.99 0 0 0 6 20h13a5 5 0 0 0 .35-9.96zM19 18H6a4 4 0 0 1-.39-7.98 5.5 5.5 0 0 1 10.83-.97A3.5 3.5 0 1 1 19 18z" />
      </svg>
      <span>Agor Cloud</span>
    </Link>
  );
}
