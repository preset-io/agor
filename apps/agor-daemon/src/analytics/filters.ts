export type FilterMode = 'passthrough' | 'denylist' | 'allowlist';

export interface EventFilter {
  mode: FilterMode;
  patterns: string[]; // Regex patterns
}

/**
 * Production denylist - filters noisy events
 */
export const PRODUCTION_DENYLIST: EventFilter = {
  mode: 'denylist',
  patterns: [
    '^health-monitor\\.', // Health checks
    '^terminals\\.', // Terminal events (very chatty)
    '\\.find$', // List operations (can be noisy)
    '^context\\.', // Context file browsing
  ],
};

/**
 * Check if event should be filtered
 */
export function shouldFilterEvent(eventName: string, filter: EventFilter): boolean {
  if (filter.mode === 'passthrough') {
    return false; // No filtering
  }

  const matches = filter.patterns.some(pattern => new RegExp(pattern).test(eventName));

  if (filter.mode === 'denylist') {
    return matches; // Filter if matches
  }

  if (filter.mode === 'allowlist') {
    return !matches; // Filter if doesn't match
  }

  return false;
}
