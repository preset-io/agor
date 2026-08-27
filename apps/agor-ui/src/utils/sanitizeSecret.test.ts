import { describe, expect, it } from 'vitest';
import { sanitizeSecretValue } from './sanitizeSecret';

describe('sanitizeSecretValue', () => {
  it('strips leading and trailing whitespace', () => {
    expect(sanitizeSecretValue('  sk-ant-oat01-abc123  ')).toBe('sk-ant-oat01-abc123');
  });

  it('strips whitespace embedded mid-string, e.g. from a wrapped terminal paste', () => {
    expect(sanitizeSecretValue('sk-ant-oat01-abc\n123-def456')).toBe('sk-ant-oat01-abc123-def456');
  });

  it('strips tabs and runs of consecutive whitespace characters', () => {
    expect(sanitizeSecretValue('sk-ant\t\t-oat01   -abc123')).toBe('sk-ant-oat01-abc123');
  });

  it('leaves an already-clean token unchanged', () => {
    expect(sanitizeSecretValue('sk-ant-oat01-abc123')).toBe('sk-ant-oat01-abc123');
  });

  it('returns an empty string unchanged', () => {
    expect(sanitizeSecretValue('')).toBe('');
  });

  it('reduces a whitespace-only string to empty', () => {
    expect(sanitizeSecretValue('   \n\t  ')).toBe('');
  });
});
