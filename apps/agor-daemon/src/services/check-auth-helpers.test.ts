/**
 * Tests for `isRealAuthSource` — the helper `check-auth.ts`'s
 * `hasAuthSignal` check uses to decide whether an `AccountInfo` source field
 * indicates a real credential.
 *
 * Regression coverage for a live-repro bug: against a genuinely
 * credential-less container, the Claude Agent SDK's `accountInfo()`
 * resolved with `tokenSource: 'none'` (a literal string sentinel, not
 * `undefined`) — a plain truthy check on that field reported "authenticated"
 * for a session with zero real credentials, which made the Connect-AI empty
 * state's per-viewer live check (`MissingCredentialPanel`, which calls this
 * same `check-auth` service) show "you're already connected" instead of the
 * actionable CTA for a user with no credential at all.
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
