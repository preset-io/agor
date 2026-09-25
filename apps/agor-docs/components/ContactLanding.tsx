import styles from './ContactLanding.module.css';
import { MeetingEmbed } from './HubSpotMeetingModal';

// Standalone /contact landing page. It reuses MeetingEmbed, the same
// spinner-gated HubSpot scheduler iframe (pointed at AGOR_CLOUD_DEMO_URL) that
// the "Book a demo" modal uses, but renders it inline on a full page rather
// than in a modal. A short hero header sits above the calendar.
export function ContactLanding() {
  return (
    // <main> with Nextra's skip-nav id; the "full" layout provides no main
    // landmark of its own, so this is the page's only one.
    <main id="nextra-skip-nav" className={styles.landingShell}>
      <div className={styles.inner}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>Talk to us</span>
          <h1>Book a meeting</h1>
          <p className={styles.sub}>
            Grab time with the team. Pick a slot that works for you and we will walk you through
            Agor, answer questions, and help you find the right fit.
          </p>
        </div>
        <div className={styles.schedulerCard}>
          <MeetingEmbed />
        </div>
      </div>
    </main>
  );
}
