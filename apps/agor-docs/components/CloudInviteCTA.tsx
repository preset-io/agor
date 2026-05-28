import { AGOR_CLOUD_INVITE_URL } from '../lib/links';
import styles from './CloudInviteCTA.module.css';

interface CloudInviteCTAProps {
  label?: string;
}

export function CloudInviteCTA({ label = 'Join the Private Beta' }: CloudInviteCTAProps) {
  return (
    <div className={styles.wrapper}>
      <a
        href={AGOR_CLOUD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.cta}
      >
        {label} →
      </a>
    </div>
  );
}
