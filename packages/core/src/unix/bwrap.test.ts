import { describe, expect, it } from 'vitest';
import { bwrapHasSafeSetupPathResolution } from './bwrap';

describe('bwrap security baseline', () => {
  it('requires the 0.12 setup-path fix', () => {
    expect(bwrapHasSafeSetupPathResolution('bubblewrap 0.8.0')).toBe(false);
    expect(bwrapHasSafeSetupPathResolution('bubblewrap 0.11.2')).toBe(false);
    expect(bwrapHasSafeSetupPathResolution('bubblewrap 0.12.0')).toBe(true);
    expect(bwrapHasSafeSetupPathResolution('bubblewrap 0.12.1-1~deb13u1')).toBe(true);
    expect(bwrapHasSafeSetupPathResolution('bubblewrap 1.0.0')).toBe(true);
    expect(bwrapHasSafeSetupPathResolution('unknown')).toBe(false);
  });
});
