import { tokenizeSearchQuery } from '@agor-live/client';

export const DEFAULT_HIGHLIGHT_MIN_TERM_LENGTH = 2;

export function getHighlightTerms(
  query: string,
  minLength = DEFAULT_HIGHLIGHT_MIN_TERM_LENGTH
): string[] {
  const normalized = query.trim().toLowerCase();
  const terms = uniqueTerms(tokenizeSearchQuery(query).filter((part) => part.length >= minLength));
  const allWords = normalized.split(/\s+/).filter(Boolean);

  if (
    normalized.length >= minLength &&
    allWords.length > 0 &&
    allWords.every((word) => word.length >= minLength) &&
    !terms.includes(normalized)
  ) {
    terms.unshift(normalized);
  }

  return terms.sort((a, b) => b.length - a.length);
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    if (!seen.has(term)) {
      seen.add(term);
      unique.push(term);
    }
  }
  return unique;
}
