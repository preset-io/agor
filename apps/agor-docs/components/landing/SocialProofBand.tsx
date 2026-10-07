'use client';

import { Outfit } from 'next/font/google';
import { Fragment } from 'react';
import { trackEvent } from '../../lib/analytics';
import styles from './SocialProofBand.module.css';

/*
 * Home-page quote section (design handoff "testimonial quote section", 4f):
 * one or two pull quotes from a single source, side by side with a gradient
 * divider, under a "Takeaways from <source>" label. Quotes are verbatim; two
 * quotes from one source stay separate (never spliced with an ellipsis), and
 * words we supply go in [brackets]. Bold/accented words are our emphasis.
 * Attribute to the publication and link it; no company logos without
 * permission.
 */

// Only this section uses Outfit, so it loads here (home page only).
const outfit = Outfit({ subsets: ['latin'], weight: ['200', '700'], display: 'swap' });

/** The decorative opening mark on each quote. */
const QUOTE_MARK = '“';

type Segment = string | { bold: string } | { accent: string; tone: 'gradient' | 'blue' };

interface ProofSource {
  id: string;
  /** Shown in the label: "Takeaways from the <name>". */
  name: string;
  href: string;
  /** One or two quotes, each a list of text segments. */
  quotes: Segment[][];
}

const SOURCE: ProofSource = {
  id: 'redhat-taming-agent-beast',
  name: 'Red Hat Blog',
  href: 'https://www.redhat.com/en/blog/taming-agent-beast-monolithic-prompt-modular-agentic-workflow',
  quotes: [
    [
      'The agent doesn’t need to remember what it did last time; the ',
      { bold: 'board' },
      ' tells it what to do ',
      { accent: 'now.', tone: 'gradient' },
    ],
    [
      '[The pipeline] reduces triage time from ',
      { bold: 'hours' },
      ' to ',
      { accent: 'minutes.', tone: 'blue' },
    ],
  ],
};

function renderSegment(segment: Segment, key: number) {
  if (typeof segment === 'string') return segment;
  if ('bold' in segment) {
    return (
      <strong key={key} className={styles.em}>
        {segment.bold}
      </strong>
    );
  }
  return (
    <strong
      key={key}
      className={`${styles.em} ${segment.tone === 'gradient' ? styles.emGradient : styles.emBlue}`}
    >
      {segment.accent}
    </strong>
  );
}

export function SocialProofBand() {
  const { quotes } = SOURCE;
  return (
    <section
      className={`${styles.section} ${outfit.className}`}
      aria-label="What people say about Agor"
      data-reveal
    >
      <p className={styles.label}>
        <span className={styles.labelRule} aria-hidden="true" />
        <span>
          Takeaways from the{' '}
          <a
            href={SOURCE.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('social_proof_click', { source: SOURCE.id })}
          >
            {SOURCE.name}
          </a>
        </span>
      </p>
      <div className={styles.row}>
        {/* Cells sit directly in the table row: quote, divider, quote. */}
        {quotes.map((segments, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list; quotes never reorder.
          <Fragment key={index}>
            {index > 0 ? <div className={styles.divider} aria-hidden="true" /> : null}
            <div className={styles.cell}>
              <blockquote
                cite={SOURCE.href}
                className={`${styles.quote} ${index === 0 ? styles.toneTeal : styles.toneBlue}`}
              >
                <span className={styles.mark} aria-hidden="true">
                  {QUOTE_MARK}
                </span>
                <p className={styles.text}>{segments.map(renderSegment)}</p>
              </blockquote>
            </div>
          </Fragment>
        ))}
      </div>
    </section>
  );
}
