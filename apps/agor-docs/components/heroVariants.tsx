import type { ReactNode } from 'react';
import styles from './LandingPage.module.css';

/**
 * Homepage hero A/B test arms — four distinct messaging theses (not just
 * copy tweaks), each mapped to a different buyer, tested at its own
 * canonical URL against the unchanged "/" kitchen-sink homepage. Register
 * (infra-forward vs. relatable/outcome language) intentionally varies by
 * audience per the messaging thread; everything below the hero is shared
 * and unchanged so the test isolates the hero thesis, not the page.
 */
export type HeroVariantKey =
  | 'technical-collaboration'
  | 'governance'
  | 'business-builders'
  | 'outcomes';

export interface HeroVariant {
  /** Headline (h1). Supports {white-highlight} and [blue-highlight] markup. */
  headline: string;
  /** Sub-headline (h2). Same {white}/[blue] markup. */
  subheadline: string;
  ctaLabel: string;
}

export const HERO_VARIANTS: Record<HeroVariantKey, HeroVariant> = {
  'technical-collaboration': {
    headline: 'Raise a {team} of AI teammates.',
    subheadline: '{Build} together, [learn] together, not alone in a terminal.',
    ctaLabel: 'See your team build together',
  },
  governance: {
    headline: 'AI teammates built for [company-wide rollout], not just a {sandbox}.',
    subheadline: '{Spend}, {access}, and oversight, handled from day one.',
    ctaLabel: 'See it govern your rollout',
  },
  'business-builders': {
    headline: 'Give every team an AI teammate, not just another AI [tool].',
    subheadline: 'Reachable in {Slack} or [email], no orchestration skill required.',
    ctaLabel: 'Design your first teammate with us',
  },
  outcomes: {
    headline: 'AI teammates that get it {done}.',
    subheadline: 'Hand off the {work}, get it back [finished], right where you work.',
    ctaLabel: 'See what you could hand off',
  },
};

// {word} → bold ink highlight (.headingStrong), [word] → teal/sky gradient
// highlight (.headingAccent) — same two treatments used site-wide, just
// parsed generically here since these lines carry more than the usual
// one-accent-phrase-per-heading convention.
const HIGHLIGHT_PATTERN = /\{([^}]+)\}|\[([^\]]+)\]/g;

export function HighlightedText({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(HIGHLIGHT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    const [, strong, accent] = match;
    if (strong !== undefined) {
      nodes.push(
        <span key={key++} className={styles.headingStrong}>
          {strong}
        </span>
      );
    } else if (accent !== undefined) {
      nodes.push(
        <span key={key++} className={styles.headingAccent}>
          {accent}
        </span>
      );
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
}
