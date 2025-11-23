import { describe, expect, it } from 'vitest';
import { extractCodexTokenUsage } from './usage.js';

describe('extractCodexTokenUsage', () => {
  it('returns undefined for non-object payloads', () => {
    expect(extractCodexTokenUsage(undefined)).toBeUndefined();
    expect(extractCodexTokenUsage(null)).toBeUndefined();
    expect(extractCodexTokenUsage('tokens')).toBeUndefined();
  });

  it('maps core fields from Codex usage payload', () => {
    const result = extractCodexTokenUsage({
      input_tokens: 1200,
      output_tokens: 800,
      cached_input_tokens: 300,
      total_tokens: 2000,
    });

    expect(result).toEqual({
      input_tokens: 1200,
      output_tokens: 800,
      cache_read_tokens: 300,
      total_tokens: 2000,
    });
  });

  it('derives total tokens when SDK omits it', () => {
    const result = extractCodexTokenUsage({
      input_tokens: 1500,
      output_tokens: 500,
    });

    expect(result?.total_tokens).toBe(2000);
  });

  it('supports camelCase variants from SDK typings', () => {
    const result = extractCodexTokenUsage({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 25,
    });

    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 25,
      total_tokens: 150,
    });
  });
});
