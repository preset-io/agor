import { describe, expect, it } from 'vitest';
import { detectPrimaryIpv4, resolveHostIpAddress } from './host-ip.js';

describe('resolveHostIpAddress', () => {
  it('returns config override verbatim when provided', () => {
    expect(resolveHostIpAddress('10.0.0.42')).toBe('10.0.0.42');
  });

  it('trims whitespace on config override', () => {
    expect(resolveHostIpAddress('  192.168.1.1  ')).toBe('192.168.1.1');
  });

  it('ignores empty/whitespace-only overrides and falls back to detection', () => {
    // Cannot assert specific value (depends on test host), but result should be
    // undefined or a string — never the empty override.
    const result = resolveHostIpAddress('   ');
    if (result !== undefined) {
      expect(result).not.toBe('   ');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('falls back to autodetect when override is undefined', () => {
    // Same as calling detectPrimaryIpv4 directly.
    expect(resolveHostIpAddress(undefined)).toBe(detectPrimaryIpv4());
  });
});

describe('detectPrimaryIpv4', () => {
  it('returns either a valid IPv4 string or undefined', () => {
    const result = detectPrimaryIpv4();
    if (result !== undefined) {
      expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      // Must not be loopback or link-local.
      expect(result).not.toMatch(/^127\./);
      expect(result).not.toMatch(/^169\.254\./);
    }
  });
});
