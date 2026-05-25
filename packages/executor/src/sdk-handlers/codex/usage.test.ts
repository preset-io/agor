import { describe, expect, it } from 'vitest';
import {
  extractCodexContextSnapshotFromEvent,
  extractCodexContextWindowUsage,
  extractCodexTokenUsage,
} from './usage.js';

describe('extractCodexTokenUsage', () => {
  it('returns undefined for non-object payloads', () => {
    expect(extractCodexTokenUsage(undefined)).toBeUndefined();
    expect(extractCodexTokenUsage(null)).toBeUndefined();
    expect(extractCodexTokenUsage('tokens')).toBeUndefined();
  });

  it('maps the realistic @openai/codex-sdk Usage shape and derives total_tokens', () => {
    // Matches the actual TurnCompletedEvent.usage shape in @openai/codex-sdk >= 0.133:
    // input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens.
    // The SDK does NOT emit total_tokens — we derive it from input + output.
    // reasoning_output_tokens is a SUBSET of output_tokens (Responses API), so it
    // must NOT be added to the total.
    const result = extractCodexTokenUsage({
      input_tokens: 1200,
      cached_input_tokens: 300,
      output_tokens: 800,
      reasoning_output_tokens: 200,
    });

    expect(result).toEqual({
      input_tokens: 1200,
      output_tokens: 800,
      cache_read_tokens: 300,
      total_tokens: 2000, // input + output; reasoning_output_tokens is NOT added
    });
  });

  it('respects an explicit total_tokens when provided (legacy)', () => {
    const result = extractCodexTokenUsage({
      input_tokens: 1200,
      output_tokens: 800,
      cached_input_tokens: 300,
      total_tokens: 2000,
    });

    expect(result?.total_tokens).toBe(2000);
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

describe('extractCodexContextWindowUsage', () => {
  it('uses input tokens directly (cached tokens are already included)', () => {
    const result = extractCodexContextWindowUsage({
      type: 'turn.completed',
      usage: {
        input_tokens: 42_000,
        cached_input_tokens: 8_000,
        output_tokens: 1_500,
      },
    });

    expect(result).toBe(42_000);
  });

  it('supports direct usage payloads and camelCase keys', () => {
    const result = extractCodexContextWindowUsage({
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 900,
    });

    expect(result).toBe(10_000);
  });

  it('matches observed Codex payloads without double-counting cache', () => {
    const result = extractCodexContextWindowUsage({
      type: 'turn.completed',
      usage: {
        input_tokens: 30_918,
        cached_input_tokens: 15_488,
        output_tokens: 184,
      },
    });

    expect(result).toBe(30_918);
  });

  it('falls back to total - output when input is unavailable', () => {
    const result = extractCodexContextWindowUsage({
      type: 'turn.completed',
      usage: {
        total_tokens: 65_432,
        output_tokens: 1_432,
      },
    });

    expect(result).toBe(64_000);
  });

  it('falls back to total tokens when only total is available (legacy)', () => {
    const result = extractCodexContextWindowUsage({
      type: 'turn.completed',
      usage: {
        total_tokens: 65_432,
      },
    });

    expect(result).toBe(65_432);
  });

  it('returns undefined for invalid payloads', () => {
    expect(extractCodexContextWindowUsage(undefined)).toBeUndefined();
    expect(extractCodexContextWindowUsage(null)).toBeUndefined();
    expect(extractCodexContextWindowUsage('bad')).toBeUndefined();
    expect(extractCodexContextWindowUsage({ usage: { output_tokens: 123 } })).toBeUndefined();
  });
});

describe('extractCodexContextSnapshotFromEvent', () => {
  it('extracts total usage + model context window from token_count event_msg', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            total_tokens: 210_000,
          },
          last_token_usage: {
            total_tokens: 12_000,
          },
          model_context_window: 272_000,
        },
      },
    });

    expect(result).toEqual({
      totalTokens: 210_000,
      maxTokens: 272_000,
      percentage: 77,
    });
  });

  it('clamps percentage to 100 for over-limit totals', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            total_tokens: 1_000_000,
          },
          model_context_window: 272_000,
        },
      },
    });

    expect(result).toEqual({
      totalTokens: 1_000_000,
      maxTokens: 272_000,
      percentage: 100,
    });
  });

  it('returns undefined for non-token_count or malformed events', () => {
    expect(extractCodexContextSnapshotFromEvent(undefined)).toBeUndefined();
    expect(extractCodexContextSnapshotFromEvent({ type: 'turn.completed' })).toBeUndefined();
    expect(
      extractCodexContextSnapshotFromEvent({
        type: 'event_msg',
        payload: { type: 'other' },
      })
    ).toBeUndefined();
  });
});
