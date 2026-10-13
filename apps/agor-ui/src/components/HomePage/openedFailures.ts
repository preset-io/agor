/** Per-user localStorage key for failures opened from Needs you. */
export const OPENED_FAILURES_KEY = 'home-opened-failures';

/** Opened failure → the run it showed (server clock) and when it was opened; a bare number is the older click-time form. */
export type OpenedFailure = number | { run: number; at: number };
export const NO_OPENED_FAILURES: Record<string, OpenedFailure> = {};
const openedField = (entry: unknown, field: 'run' | 'at'): number => {
  if (typeof entry === 'number') return entry;
  const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[field] : 0;
  return typeof value === 'number' ? value : 0;
};
export const openedAt = (entry: OpenedFailure) => openedField(entry, 'at');
// A stored container that isn't a plain object (null, a list, a number) reads as empty.
export const asOpenedFailures = (stored: unknown): Record<string, OpenedFailure> =>
  stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, OpenedFailure>)
    : NO_OPENED_FAILURES;
/** Session id → the run the person last opened, as the Home buckets selector takes it. */
export const openedRunsOf = (stored: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(asOpenedFailures(stored)).map(([id, entry]) => [id, openedField(entry, 'run')])
  );
