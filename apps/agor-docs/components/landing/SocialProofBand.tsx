'use client';

import type { ReactNode } from 'react';
import { trackEvent } from '../../lib/analytics';
import styles from './SocialProofBand.module.css';

/**
 * Home-page quote band, right under the hero: what people building with Agor
 * have written about it. Quotes are verbatim; a supporting line is a separate
 * quote from the same source (never spliced into the main one), and words we
 * supply go in [brackets]. Attribute to the publication and link the source;
 * no company logos without permission.
 */
/** A highlighted word in a quote (emphasis is ours; the words are theirs). */
function Hi({ children }: { children: ReactNode }) {
  return <span className={styles.hi}>{children}</span>;
}

interface ProofQuote {
  id: string;
  quote: ReactNode;
  /** A second, separate verbatim line from the same source, e.g. an outcome. */
  support?: ReactNode;
  source: string;
  href: string;
}

const QUOTES: ProofQuote[] = [
  {
    id: 'redhat-taming-agent-beast',
    quote: (
      <>
        The agent doesn’t need to remember what it did last time; the board tells it what to do{' '}
        <Hi>now</Hi>.
      </>
    ),
    support: (
      <>
        [The pipeline] reduces triage time from <Hi>hours</Hi> to <Hi>minutes</Hi>.
      </>
    ),
    source: 'Red Hat Blog',
    href: 'https://www.redhat.com/en/blog/taming-agent-beast-monolithic-prompt-modular-agentic-workflow',
  },
];

export function SocialProofBand() {
  return (
    <section className={styles.band} aria-label="What people say about Agor" data-reveal>
      {QUOTES.map((item) => (
        <figure key={item.id} className={styles.figure}>
          <blockquote cite={item.href} className={styles.quote}>
            <p>“{item.quote}”</p>
            {item.support ? <p className={styles.support}>“{item.support}”</p> : null}
          </blockquote>
          <figcaption className={styles.caption}>
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.source}
              onClick={() =>
                trackEvent('social_proof_click', { quote: item.id, source: item.source })
              }
            >
              {item.source} <span aria-hidden="true">→</span>
            </a>
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
