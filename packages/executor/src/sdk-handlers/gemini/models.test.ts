import { describe, expect, it } from 'vitest';
import { GEMINI_CONTEXT_LIMITS, type GeminiModel, getGeminiContextWindowLimit } from './models.js';

describe('getGeminiContextWindowLimit', () => {
  const knownModels: GeminiModel[] = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ];
  const defaultLimit = GEMINI_CONTEXT_LIMITS['gemini-2.5-flash'];

  describe('known models', () => {
    for (const model of knownModels) {
      it(`returns configured limit for ${model}`, () => {
        const result = getGeminiContextWindowLimit(model);
        const expectedLimit = GEMINI_CONTEXT_LIMITS[model];

        expect(result).toBe(expectedLimit);
      });
    }
  });

  it('handles versioned model identifiers', () => {
    const result = getGeminiContextWindowLimit('gemini-2.5-pro-001');
    const expectedLimit = GEMINI_CONTEXT_LIMITS['gemini-2.5-pro'];

    expect(result).toBe(expectedLimit);
  });

  it('falls back to default when model is unknown', () => {
    const result = getGeminiContextWindowLimit('gemini-unknown-model');
    expect(result).toBe(defaultLimit);
  });

  it('treats model names case-insensitively', () => {
    const result = getGeminiContextWindowLimit('GEMINI-2.5-FLASH');
    expect(result).toBe(defaultLimit);
  });

  it('returns default limit when model is undefined', () => {
    const result = getGeminiContextWindowLimit();
    expect(result).toBe(defaultLimit);
  });

  it('returns default limit when model is null', () => {
    const result = getGeminiContextWindowLimit(null as unknown as string);
    expect(result).toBe(defaultLimit);
  });
});
