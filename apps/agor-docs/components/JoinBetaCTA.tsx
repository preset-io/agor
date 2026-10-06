import { CloudCtaLink } from './CloudCtaLink';
import styles from './CloudInviteCTA.module.css';

interface JoinBetaCTAProps {
  /** Attribution slug for this spot (utm_content on the console link). */
  placement: string;
}

/** Standalone Agor Cloud pill, styled like CloudInviteCTA's primary button. */
export function JoinBetaCTA({ placement }: JoinBetaCTAProps) {
  return (
    <div className={styles.wrapper}>
      <CloudCtaLink placement={placement} className={styles.primary} />
    </div>
  );
}
