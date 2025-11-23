import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexSdkResponse } from '../../types/sdk-response.js';
import * as models from './models.js';
import { CodexNormalizer } from './normalizer.js';

function buildTurnCompletedEvent(overrides: Partial<CodexSdkResponse> = {}): CodexSdkResponse {
  return {
    type: 'turn.completed',
    ...overrides,
  } as CodexSdkResponse;
}

function buildUsage(overrides: Record<string, number | undefined> = {}): CodexSdkResponse['usage'] {
  return {
    input_tokens: overrides.input_tokens,
    output_tokens: overrides.output_tokens,
    cached_input_tokens: overrides.cached_input_tokens,
    total_tokens: overrides.total_tokens,
  } as CodexSdkResponse['usage'];
}

describe('CodexNormalizer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gracefully handles events without usage data', () => {
    const normalizer = new CodexNormalizer();
    const event = buildTurnCompletedEvent({ usage: undefined });

    const result = normalizer.normalize(event);

    expect(result.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(result.contextWindowLimit).toBe(
      models.getCodexContextWindowLimit(models.DEFAULT_CODEX_MODEL)
    );
    expect(result.primaryModel).toBe(models.DEFAULT_CODEX_MODEL);
    expect(result.durationMs).toBeUndefined();
  });

  it('maps usage statistics and derives total tokens', () => {
    const normalizer = new CodexNormalizer();
    const event = buildTurnCompletedEvent({
      usage: buildUsage({
        input_tokens: 1_200,
        output_tokens: 800,
        cached_input_tokens: 300,
      }),
    });

    const result = normalizer.normalize(event);

    expect(result.tokenUsage).toEqual({
      inputTokens: 1_200,
      outputTokens: 800,
      totalTokens: 2_000,
      cacheReadTokens: 300,
      cacheCreationTokens: 0,
    });
    expect(result.primaryModel).toBe(models.DEFAULT_CODEX_MODEL);
  });

  it('defaults missing usage fields to zero', () => {
    const normalizer = new CodexNormalizer();
    const event = buildTurnCompletedEvent({
      usage: buildUsage({}),
    });

    const result = normalizer.normalize(event);

    expect(result.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('uses context window limit lookup for the default model', () => {
    const contextWindowLimit = 123_456;
    const lookupSpy = vi
      .spyOn(models, 'getCodexContextWindowLimit')
      .mockReturnValue(contextWindowLimit);

    const normalizer = new CodexNormalizer();
    const event = buildTurnCompletedEvent({
      usage: buildUsage({
        input_tokens: 10,
        output_tokens: 20,
        cached_input_tokens: 5,
      }),
    });

    const result = normalizer.normalize(event);

    expect(lookupSpy).toHaveBeenCalledWith(models.DEFAULT_CODEX_MODEL);
    expect(result.contextWindowLimit).toBe(contextWindowLimit);
    expect(result.tokenUsage.totalTokens).toBe(30);
  });
});
