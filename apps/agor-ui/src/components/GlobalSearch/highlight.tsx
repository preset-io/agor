import type React from 'react';

/**
 * Wrap any substring matching a search token in `<mark>` for hit highlighting.
 * Case-insensitive, multi-token aware (single regex alternation).
 *
 * Returns plain text when:
 *   - the text is empty/undefined
 *   - tokens list is empty after sanitization (recents view, all-whitespace input)
 *
 * Only used on fields the row actually renders (title, secondary line).
 * Highlighting on fields that aren't visible — e.g. a hit in `branch.notes`
 * showing up inside a session row — would require snippet extraction, which
 * is V2 territory.
 */
export function highlightTokens(
  text: string | undefined | null,
  tokens: string[],
  markStyle?: React.CSSProperties
): React.ReactNode {
  if (!text) return text ?? '';
  // Sanitize + sort longest-first so overlapping tokens (e.g. ["ag", "agor"])
  // greedy-match the longer alternative. Regex alternation otherwise tries
  // branches left-to-right and would stop at "ag" inside "agor".
  const sanitized = tokens
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (sanitized.length === 0) return text;
  // Escape regex specials so a query containing `(foo)` doesn't try to
  // capture-group anything.
  const escaped = sanitized.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  if (parts.length === 1) return text;
  // String.split with a capture group yields alternating non-match (even
  // index) and match (odd index) parts. Key combines ordinal + content so
  // React's reconciler stays stable across token-list changes (the list
  // shape is stable per (text, tokens) tuple anyway).
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: split() yields a positionally-stable array; ordinal is required because the same token text can repeat (e.g. "foo foo").
      <mark key={`m${i}:${part}`} style={markStyle}>
        {part}
      </mark>
    ) : (
      part
    )
  );
}
