import { describe, expect, it } from 'vitest';
import { extractGeminiTokenUsage } from './usage.js';

describe('extractGeminiTokenUsage', () => {
  it('should extract token usage from Gemini usageMetadata', () => {
    const usageMetadata = {
      promptTokenCount: 150,
      candidatesTokenCount: 75,
      totalTokenCount: 225,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 150,
      output_tokens: 75,
      cache_read_tokens: undefined,
      total_tokens: 225,
    });
  });

  it('should handle camelCase field names', () => {
    const usageMetadata = {
      promptTokenCount: 200,
      candidatesTokenCount: 100,
      totalTokenCount: 300,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: undefined,
      total_tokens: 300,
    });
  });

  it('should handle cached content tokens', () => {
    const usageMetadata = {
      promptTokenCount: 150,
      candidatesTokenCount: 75,
      totalTokenCount: 225,
      cachedContentTokenCount: 50,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 150,
      output_tokens: 75,
      cache_read_tokens: 50,
      total_tokens: 225,
    });
  });

  it('should handle snake_case field names', () => {
    const usageMetadata = {
      prompt_token_count: 100,
      candidates_token_count: 50,
      total_token_count: 150,
      cached_content_token_count: 25,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 25,
      total_tokens: 150,
    });
  });

  it('should return undefined for null/undefined input', () => {
    expect(extractGeminiTokenUsage(null)).toBeUndefined();
    expect(extractGeminiTokenUsage(undefined)).toBeUndefined();
  });

  it('should return undefined for non-object input', () => {
    expect(extractGeminiTokenUsage('string')).toBeUndefined();
    expect(extractGeminiTokenUsage(123)).toBeUndefined();
    expect(extractGeminiTokenUsage([])).toBeUndefined();
  });

  it('should return undefined when no valid token fields exist', () => {
    const usageMetadata = {
      someOtherField: 'value',
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toBeUndefined();
  });

  it('should compute total tokens when not provided', () => {
    const usageMetadata = {
      promptTokenCount: 150,
      candidatesTokenCount: 75,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 150,
      output_tokens: 75,
      cache_read_tokens: undefined,
      total_tokens: 225,
    });
  });

  it('should handle partial token data', () => {
    const usageMetadata = {
      promptTokenCount: 100,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: undefined,
      cache_read_tokens: undefined,
      total_tokens: 100,
    });
  });

  it('should handle Agor-format field names', () => {
    const usageMetadata = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 25,
      total_tokens: 175,
    };

    const result = extractGeminiTokenUsage(usageMetadata);

    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 25,
      total_tokens: 175,
    });
  });
});
