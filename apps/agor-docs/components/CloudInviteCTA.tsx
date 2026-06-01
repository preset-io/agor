import { AGOR_CLOUD_DEMO_URL, AGOR_CLOUD_INVITE_URL } from '../lib/links';
import styles from './CloudInviteCTA.module.css';

interface CloudInviteCTAProps {
  primaryLabel?: string;
  demoLabel?: string;
}

export function CloudInviteCTA({
  primaryLabel = 'Join the Private Beta',
  demoLabel = 'Book a Demo',
}: CloudInviteCTAProps) {
  return (
    <div className={styles.wrapper}>
      <a
        href={AGOR_CLOUD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.primary}
      >
        {primaryLabel} →
      </a>
      <a
        href={AGOR_CLOUD_DEMO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.secondary}
      >
        {demoLabel} →
      </a>
    </div>
  );
}
