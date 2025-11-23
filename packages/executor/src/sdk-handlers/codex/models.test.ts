import { describe, expect, it } from 'vitest';
import { getCodexContextWindowLimit } from './models.js';

describe('getCodexContextWindowLimit', () => {
  const defaultLimit = getCodexContextWindowLimit();

  it('returns expected limits for known Codex-compatible models', () => {
    const cases: Array<{ model: string; expected: number }> = [
      { model: 'gpt-5.1-codex', expected: defaultLimit },
      { model: 'gpt-5.1-codex-mini', expected: defaultLimit },
      { model: 'gpt-5.1', expected: defaultLimit },
      { model: 'gpt-5-codex', expected: defaultLimit },
      { model: 'gpt-5-codex-mini', expected: defaultLimit },
      { model: 'gpt-5', expected: defaultLimit },
      { model: 'gpt-4o', expected: 128_000 },
      { model: 'gpt-4o-mini', expected: 64_000 },
    ];

    for (const { model, expected } of cases) {
      expect(getCodexContextWindowLimit(model)).toBe(expected);
    }
  });

  it('uses base model limit when version suffix is present', () => {
    expect(getCodexContextWindowLimit('gpt-5-codex-2024')).toBe(
      getCodexContextWindowLimit('gpt-5-codex')
    );
    expect(getCodexContextWindowLimit('gpt-4o-2024')).toBe(getCodexContextWindowLimit('gpt-4o'));
  });

  it('falls back to default limit for unknown models', () => {
    expect(getCodexContextWindowLimit('unknown-model')).toBe(defaultLimit);
    expect(getCodexContextWindowLimit('gpt-3-codex')).toBe(defaultLimit);
  });

  it('handles model identifiers case-insensitively', () => {
    expect(getCodexContextWindowLimit('GPT-4O')).toBe(128_000);
    expect(getCodexContextWindowLimit('GpT-5-CoDeX')).toBe(defaultLimit);
  });

  it('returns default limit when model is undefined or null', () => {
    expect(getCodexContextWindowLimit()).toBe(defaultLimit);
    expect(getCodexContextWindowLimit(undefined)).toBe(defaultLimit);
    expect(getCodexContextWindowLimit(null as unknown as string | undefined)).toBe(defaultLimit);
  });
});
