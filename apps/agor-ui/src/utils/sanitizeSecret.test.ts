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

  it('strips zero-width and invisible characters a rich-text paste can leave behind', () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const zwnj = String.fromCodePoint(0x200c);
    const zwj = String.fromCodePoint(0x200d);
    const wordJoiner = String.fromCodePoint(0x2060);
    const bom = String.fromCodePoint(0xfeff);

    expect(sanitizeSecretValue(`sk-ant-oat01-abc${zeroWidthSpace}123-def456`)).toBe(
      'sk-ant-oat01-abc123-def456'
    );
    expect(sanitizeSecretValue(`sk-ant-oat01-abc${zwnj}123-def456`)).toBe(
      'sk-ant-oat01-abc123-def456'
    );
    expect(sanitizeSecretValue(`sk-ant-oat01-abc${zwj}123-def456`)).toBe(
      'sk-ant-oat01-abc123-def456'
    );
    expect(sanitizeSecretValue(`sk-ant-oat01-abc${wordJoiner}123-def456`)).toBe(
      'sk-ant-oat01-abc123-def456'
    );
    expect(sanitizeSecretValue(`${bom}sk-ant-api03-clean`)).toBe('sk-ant-api03-clean');
  });
});
