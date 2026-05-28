import Link from 'next/link';
import styles from './NavbarCloudCTA.module.css';

export function NavbarCloudCTA() {
  return (
    <Link href="/blog/agor-cloud" className={styles.link}>
      Agor Cloud
    </Link>
  );
}
