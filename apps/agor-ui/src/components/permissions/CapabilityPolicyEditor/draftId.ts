import type { UUID } from '@agor/core/types';

let nextDraftId = 0;

/**
 * Browser-safe identity for unsaved permission rows.
 *
 * This intentionally does not pretend to be a persistence ID generator. The
 * A monotonic UUID-shaped value is sufficient for React row identity. The
 * daemon accepts it as the stable entry identifier if the form is saved.
 */
export function makeCapabilityPolicyDraftId(): UUID {
  nextDraftId += 1;
  return `f0000000-0000-4000-8000-${String(nextDraftId).padStart(12, '0')}` as UUID;
}
