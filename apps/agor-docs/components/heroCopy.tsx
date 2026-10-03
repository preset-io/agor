import { type CSSProperties, Fragment, type ReactNode } from 'react';
import styles from './LandingPage.module.css';

export interface HeroCopy {
  /**
   * Headline (h1). Supports {white-highlight} and [blue-highlight] markup,
   * plus \n for an author-chosen line break (desktop-and-up only — see
   * .heroForcedBreak in LandingPage.module.css; narrow viewports fall back
   * to normal wrapping so a long authored line can't overflow).
   */
  headline: string;
  /** Sub-headline (h2). Same {white}/[blue]/\n markup. */
  subheadline: string;
}

// Category-led hero (PMM v4: Multiplayer AI first), with the "Not Alone"
// problem carried into the subhead. HOME_HERO_PROBLEM is the A/B alternate.
export const HOME_HERO: HeroCopy = {
  headline: '[Multiplayer AI]\nis here',
  subheadline:
    'Your agents shouldn’t work alone. Bring every session onto one [board] your whole ^team^ can see.',
};

// A/B candidate (not wired up yet): keeps the tested "Not Alone" problem
// headline, widened past "coding", with the category in the subhead.
export const HOME_HERO_PROBLEM: HeroCopy = {
  headline: 'Your AI agents\nare working [alone]',
  subheadline: 'Agor is {Multiplayer AI}: bring your team and agents together on one live board.',
};

// {word} → bold ink highlight (.headingStrong), [word] → teal/sky gradient
// highlight (.headingAccent), ~~word~~ → struck-through/dimmed (.headingStrike,
// for "crossing out" a word being replaced), *word* → italic (.headingItalic,
// a quieter emphasis than the two highlight colors), ^word^ → plain text
// whose letters can do a wave (.waveWord; the home page's cursor troupe
// cues it) — parsed generically
// here since these lines carry more than the usual one-accent-phrase-per-
// heading convention. \n → author-chosen <br/>.
const HIGHLIGHT_PATTERN = /\{([^}]+)\}|\[([^\]]+)\]|~~([^~]+)~~|\*([^*]+)\*|\^([^^]+)\^/g;

function parseHighlights(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(HIGHLIGHT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    const [, strong, accent, strike, italic, wave] = match;
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
    } else if (wave !== undefined) {
      nodes.push(
        <span key={`${keyPrefix}-${key++}`} className={styles.waveWord} data-wave-word="">
          {[...wave].map((letter, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: letters of a fixed word
            <span key={i} style={{ '--i': i, '--n': wave.length } as CSSProperties}>
              {letter}
            </span>
          ))}
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
