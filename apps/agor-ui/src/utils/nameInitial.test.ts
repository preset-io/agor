import { describe, expect, it } from 'vitest';
import { nameInitial } from './nameInitial';

describe('nameInitial', () => {
  it('returns the first letter uppercased', () => {
    expect(nameInitial('abhi')).toBe('A');
    expect(nameInitial('Max')).toBe('M');
  });

  it('trims leading whitespace before picking the initial', () => {
    expect(nameInitial('  zoe')).toBe('Z');
  });

  it('falls back to ? for missing or empty names', () => {
    expect(nameInitial(undefined)).toBe('?');
    expect(nameInitial(null)).toBe('?');
    expect(nameInitial('')).toBe('?');
    expect(nameInitial('   ')).toBe('?');
  });

  it('keeps a full emoji grapheme intact', () => {
    expect(nameInitial('🦄 unicorn')).toBe('🦄');
  });

  it('handles combining-character graphemes', () => {
    expect(nameInitial('éric')).toBe('É');
  });

  it('works for email-style fallbacks', () => {
    expect(nameInitial('abhi@svix.com')).toBe('A');
  });
});
