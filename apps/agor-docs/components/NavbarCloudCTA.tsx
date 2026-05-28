import { AGOR_CLOUD_INVITE_URL } from '../lib/links';
import styles from './NavbarCloudCTA.module.css';

export function NavbarCloudCTA() {
  return (
    <a
      href={AGOR_CLOUD_INVITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.cta}
      aria-label="Request Agor Cloud access"
    >
      <span className={styles.full}>Request Cloud access</span>
      <span className={styles.short}>Cloud access</span>
    </a>
  );
}
