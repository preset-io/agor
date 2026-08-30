import { describe, expect, it } from 'vitest';
import { filterOpenCodeReasoningEffortLevels } from './reasoning-effort.js';

describe('filterOpenCodeReasoningEffortLevels', () => {
  it('returns recognized variant keys in canonical order without reading their values', () => {
    expect(
      filterOpenCodeReasoningEffortLevels({
        max: { apiKey: 'must-not-cross' },
        minimal: {},
        low: false,
        none: {},
        arbitrary: {},
      })
    ).toEqual(['low', 'max']);
  });

  it('distinguishes unknown input from a known empty variant map', () => {
    expect(filterOpenCodeReasoningEffortLevels(undefined)).toBeUndefined();
    expect(filterOpenCodeReasoningEffortLevels(null)).toBeUndefined();
    expect(filterOpenCodeReasoningEffortLevels([])).toBeUndefined();
    expect(filterOpenCodeReasoningEffortLevels({ none: {}, minimal: {} })).toEqual([]);
  });
});
