import { Fragment, type ReactNode } from 'react';
import styles from './LandingPage.module.css';

/**
 * Homepage hero A/B test arms — four distinct messaging theses (not just
 * copy tweaks), each mapped to a different buyer, tested at its own
 * canonical URL against the unchanged "/" kitchen-sink homepage. Register
 * (infra-forward vs. relatable/outcome language) intentionally varies by
 * audience per the messaging thread; everything below the hero is shared
 * and unchanged so the test isolates the hero thesis, not the page.
 *
 * Exp 2 (Aug 2026) — problem-sell vs. solution-sell framing test. Each of
 * the two Phase-1 conversion winners gained a counterpart page, so the
 * theme is held constant while only the framing varies. Pairing:
 * /not-alone <-> /not-alone-problem hold the collaboration theme;
 * /costs-under-control <-> /costs-under-control-solution hold the
 * cost / no-lock-in theme. Page column below is the /<slug> route.
 *
 * | Page | Variant key | Framing | Changed |
 * | --- | --- | --- | --- |
 * | not-alone | technical-collaboration | solution | sub-only¹ |
 * | not-alone-problem | technical-collaboration-problem | problem | new |
 * | costs-under-control | cost-control | problem | reframed² |
 * | costs-under-control-solution | cost-control-solution | solution | new |
 *
 * ¹ headline unchanged (proven high-converting); only subheadline changed.
 * ² reframed to vendor lock-in + spend; dropped the old "governance,
 *   observability, model agnosticism" line.
 */
export type HeroVariantKey =
  | 'technical-collaboration'
  // Exp 2 framing variant — problem-sell counterpart to
  // technical-collaboration (solution-sell), for the messaging A/B test.
  | 'technical-collaboration-problem'
  | 'governance'
  | 'business-builders'
  | 'outcomes'
  // Wild cards — not mapped to a specific buyer persona like the four
  // above; punchier, more provocative taglines testing whether register
  // alone (not audience targeting) moves the needle.
  | 'multiplayer'
  | 'selfware'
  | 'dev-team'
  | 'cost-control'
  // Exp 2 framing variant — solution-sell counterpart to cost-control
  // (problem-sell), for the messaging A/B test.
  | 'cost-control-solution'
  // Shelved (not a hit in review) — copy kept here rather than deleted so
  // it can be reinstated cheaply if wanted later. Has no routed page; add
  // back a content/agentify-everyone.mdx stub (see git history for the
  // prior one) to bring it back live.
  | 'agentify';

export interface HeroVariant {
  /**
   * Headline (h1). Supports {white-highlight} and [blue-highlight] markup,
   * plus \n for an author-chosen line break (desktop-and-up only — see
   * .heroForcedBreak in LandingPage.module.css; narrow viewports fall back
   * to normal wrapping so a long authored line can't overflow).
   */
  headline: string;
  /** Sub-headline (h2). Same {white}/[blue]/\n markup. */
  subheadline: string;
  ctaLabel: string;
}

export const HERO_VARIANTS: Record<HeroVariantKey, HeroVariant> = {
  'technical-collaboration': {
    headline: 'Raise a team\nof [AI teammates]',
    subheadline: '{Build} together on one [multiplayer canvas]. No lonely {terminals}.',
    ctaLabel: 'Start building together',
  },
  // Exp 2 framing variant — problem-sell counterpart to
  // technical-collaboration (solution-sell) above.
  'technical-collaboration-problem': {
    headline: 'Your AI coding agents\nare working [alone]',
    subheadline: 'Bring every session onto one [board] your whole team can see.',
    ctaLabel: 'Start building together',
  },
  governance: {
    headline: '[AI teammates] for\nyour entire business',
    subheadline: 'Control {spend}, {access}, & {collaboration}.',
    ctaLabel: 'Govern your AI rollout',
  },
  'business-builders': {
    headline: 'Give every team\nan [AI teammate]',
    subheadline: 'Not just *another* AI {tool}.',
    ctaLabel: 'Design a team with us',
  },
  outcomes: {
    headline: '[AI teammates]\nthat get things *done*',
    subheadline: 'Hand off work, get it *finished*. Right where {you} work.',
    ctaLabel: 'See what it can do',
  },
  multiplayer: {
    headline: 'AI is finally [multiplayer]',
    subheadline: 'Make productivity a {team} sport.',
    ctaLabel: 'Ready to play?',
  },
  selfware: {
    headline: 'Selfware doesn’t [scale]',
    subheadline: 'AI for teams that want *results* rather than a *project*.',
    ctaLabel: 'Multiply your growth',
  },
  'dev-team': {
    headline: 'Enable your entire [dev team]',
    subheadline: '{Multiplayer}-powered planning and development.',
    ctaLabel: 'Enable your dev team',
  },
  'cost-control': {
    headline: 'Locked into one vendor.\n[Locked into their price.]',
    subheadline: 'Run [any model] across multiple agents, while keeping {spend} in check.',
    ctaLabel: 'Control your AI costs',
  },
  // Exp 2 framing variant — solution-sell counterpart to cost-control
  // (problem-sell) above.
  'cost-control-solution': {
    headline: 'AI costs under control.\nNo [frontier lock-in].',
    subheadline: 'Run {Claude}, {Codex}, {Gemini} & {Copilot}. Switch models anytime.',
    ctaLabel: 'Control your AI costs',
  },
  // Shelved — see HeroVariantKey comment above. Not routed to a live page.
  agentify: {
    headline: 'Agentify ~~Everything~~ [Everyone]',
    subheadline: 'Superpowers for {AI enablers}. Superagents for {business users}.',
    ctaLabel: 'Agentify your team',
  },
};

// {word} → bold ink highlight (.headingStrong), [word] → teal/sky gradient
// highlight (.headingAccent), ~~word~~ → struck-through/dimmed (.headingStrike,
// for "crossing out" a word being replaced), *word* → italic (.headingItalic,
// a quieter emphasis than the two highlight colors) — parsed generically
// here since these lines carry more than the usual one-accent-phrase-per-
// heading convention. \n → author-chosen <br/>.
const HIGHLIGHT_PATTERN = /\{([^}]+)\}|\[([^\]]+)\]|~~([^~]+)~~|\*([^*]+)\*/g;

function parseHighlights(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(HIGHLIGHT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    const [, strong, accent, strike, italic] = match;
    if (strong !== undefined) {
      nodes.push(
        <span key={`${keyPrefix}-${key++}`} className={styles.headingStrong}>
          {strong}
        </span>
      );
    } else if (accent !== undefined) {
      nodes.push(
        <span key={`${keyPrefix}-${key++}`} className={styles.headingAccent}>
          {accent}
        </span>
      );
    } else if (strike !== undefined) {
      nodes.push(
        <span key={`${keyPrefix}-${key++}`} className={styles.headingStrike}>
          {strike}
        </span>
      );
    } else if (italic !== undefined) {
      nodes.push(
        <span key={`${keyPrefix}-${key++}`} className={styles.headingItalic}>
          {italic}
        </span>
      );
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function HighlightedText({ text }: { text: string }): ReactNode {
  const lines = text.split('\n');

  return (
    <>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed, ordered split of static copy
        <Fragment key={index}>
          {index > 0 && <br />}
          {parseHighlights(line, String(index))}
        </Fragment>
      ))}
    </>
  );
}
