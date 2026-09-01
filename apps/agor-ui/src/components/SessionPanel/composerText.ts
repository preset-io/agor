/** Append without trimming, selecting, or replacing any existing draft text. */
export function appendComposerText(existing: string, inserted: string): string {
  if (!existing) return inserted;
  return `${existing}${/\s$/.test(existing) ? '' : ' '}${inserted}`;
}
