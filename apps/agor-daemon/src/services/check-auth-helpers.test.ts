/**
 * Tests for `isRealAuthSource`. Regression coverage for the `tokenSource:
 * 'none'` sentinel: a plain truthy check on that field reported
 * "authenticated" for a credential-less session, hiding the Connect-AI CTA.
 */

import { describe, expect, it } from 'vitest';
import { isRealAuthSource } from './check-auth-helpers';

describe('isRealAuthSource', () => {
  it('treats the literal "none" sentinel as no signal', () => {
    expect(isRealAuthSource('none')).toBe(false);
  });

  it('is case-insensitive for the sentinel', () => {
    expect(isRealAuthSource('None')).toBe(false);
    expect(isRealAuthSource('NONE')).toBe(false);
  });

  it('treats undefined and empty string as no signal', () => {
    expect(isRealAuthSource(undefined)).toBe(false);
    expect(isRealAuthSource('')).toBe(false);
  });

  it('treats a real source value as a signal', () => {
    expect(isRealAuthSource('oauth')).toBe(true);
    expect(isRealAuthSource('api-key')).toBe(true);
    expect(isRealAuthSource('anthropic-console')).toBe(true);
  });
});
