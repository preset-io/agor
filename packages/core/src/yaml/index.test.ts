import { describe, expect, it } from 'vitest';
import { dump, load } from './index';

describe('YAML compatibility and merge-work limits', () => {
  it('preserves empty configuration and YAML merge semantics', () => {
    expect(load('')).toBeUndefined();
    expect(
      load('defaults: &defaults { port: 3030 }\ndaemon: { <<: *defaults, host: localhost }')
    ).toEqual({ defaults: { port: 3030 }, daemon: { port: 3030, host: 'localhost' } });
  });

  it('preserves quoted string values without converting other scalars', () => {
    const config = { label: 'true', enabled: true, port: 3030, missing: null };
    const serialized = dump(config, { quotingType: '"', forceQuotes: true });
    expect(serialized).toContain('label: "true"');
    expect(load(serialized)).toEqual(config);
  });

  it('rejects oversized sequences of empty merge sources', () => {
    const source = `sources: &sources [${Array(101).fill('{}').join(', ')}]\ntarget: { <<: *sources }`;
    expect(() => load(source)).toThrow('abnormal merge sequence size');
  });

  it('counts empty merge sources against the total work budget', () => {
    // Small deterministic regression for GHSA-2883-xcg3-v3hh, not a timing test
    // or a large DoS payload. Each sequence stays below the per-merge cap.
    const source = 'sources: &sources [{}, {}]\ntargets:\n  - <<: *sources\n  - <<: *sources\n';
    // @types/js-yaml predates the runtime's maxTotalMergeKeys option.
    const options = { filename: 'merge-budget.yaml', maxTotalMergeKeys: 3 };
    expect(() => load(source, options)).toThrow('merge keys exceeded maxTotalMergeKeys (3)');
    const exactBudget = { ...options, maxTotalMergeKeys: 4 };
    expect(load(source, exactBudget)).toEqual({
      sources: [{}, {}],
      targets: [{}, {}],
    });
  });
});
