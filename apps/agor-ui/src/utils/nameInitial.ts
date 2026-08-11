/**
 * First grapheme of a display name, uppercased — the emoji-free avatar glyph.
 * Falls back to '?' for missing/empty names.
 */
export function nameInitial(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return '?';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(trimmed)
      [Symbol.iterator]()
      .next();
    if (!first.done) return first.value.segment.toUpperCase();
  }
  return trimmed.charAt(0).toUpperCase();
}
