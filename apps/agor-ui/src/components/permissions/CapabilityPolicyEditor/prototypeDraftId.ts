import type { UUID } from '@agor/core/types';

let nextPrototypeId = 0;

/**
 * Browser-safe identity for local-only prototype rows.
 *
 * This intentionally does not pretend to be a persistence ID generator. The
 * demo is often served over an HTTP LAN URL where `crypto.randomUUID()` is not
 * available, so a monotonic UUID-shaped value is sufficient for React draft
 * identity and is never sent to the daemon.
 */
export function makePrototypeDraftId(): UUID {
  nextPrototypeId += 1;
  return `f0000000-0000-4000-8000-${String(nextPrototypeId).padStart(12, '0')}` as UUID;
}
