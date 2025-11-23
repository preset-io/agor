import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeminiSdkResponse } from '../../types/sdk-response.js';
import * as modelsModule from './models.js';
import { DEFAULT_GEMINI_MODEL, getGeminiContextWindowLimit } from './models.js';
import { GeminiNormalizer } from './normalizer.js';

describe('GeminiNormalizer', () => {
  const normalizer = new GeminiNormalizer();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes complete usage metadata', () => {
    const event = {
      value: {
        usageMetadata: {
          promptTokenCount: 180,
          candidatesTokenCount: 60,
          cachedContentTokenCount: 25,
        },
      },
    } as GeminiSdkResponse;

    const normalized = normalizer.normalize(event);

    expect(normalized.tokenUsage).toEqual({
      inputTokens: 180,
      outputTokens: 60,
      totalTokens: 240,
      cacheReadTokens: 25,
      cacheCreationTokens: 0,
    });
    expect(normalized.contextWindowLimit).toBe(getGeminiContextWindowLimit(DEFAULT_GEMINI_MODEL));
    expect(normalized.primaryModel).toBe(DEFAULT_GEMINI_MODEL);
    expect(normalized.durationMs).toBeUndefined();
  });

  it('defaults missing usage metadata to zeros', () => {
    const event = {
      value: {},
    } as GeminiSdkResponse;

    const normalized = normalizer.normalize(event);

    expect(normalized.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('handles undefined event value without throwing', () => {
    const event = {} as GeminiSdkResponse;

    const normalized = normalizer.normalize(event);

    expect(normalized.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('computes totals from input and output tokens even when SDK total differs', () => {
    const event = {
      value: {
        usageMetadata: {
          promptTokenCount: 250,
          candidatesTokenCount: 120,
          totalTokenCount: 999, // SDK reported total differs; normalizer sums input + output
        },
      },
    } as GeminiSdkResponse;

    const normalized = normalizer.normalize(event);

    expect(normalized.tokenUsage.totalTokens).toBe(370);
    expect(normalized.tokenUsage.inputTokens).toBe(250);
    expect(normalized.tokenUsage.outputTokens).toBe(120);
    expect(normalized.tokenUsage.cacheReadTokens).toBe(0);
  });

  it('falls back to zero for missing token counts', () => {
    const event = {
      value: {
        usageMetadata: {
          candidatesTokenCount: 75,
        },
      },
    } as GeminiSdkResponse;

    const normalized = normalizer.normalize(event);

    expect(normalized.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 75,
      totalTokens: 75,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('uses context window limit lookup for the default model', () => {
    const contextWindowLimit = 2048;
    const spy = vi
      .spyOn(modelsModule, 'getGeminiContextWindowLimit')
      .mockReturnValue(contextWindowLimit);

    const event = {
      value: {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        },
      },
    } as GeminiSdkResponse;

    const normalized = normalizer.normalize(event);

    expect(spy).toHaveBeenCalledWith(DEFAULT_GEMINI_MODEL);
    expect(normalized.contextWindowLimit).toBe(contextWindowLimit);
  });
});
