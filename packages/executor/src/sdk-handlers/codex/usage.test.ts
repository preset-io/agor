import { describe, expect, it } from 'vitest';
import {
  CODEX_BASELINE_OVERHEAD_TOKENS,
  codexUsedPercentage,
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

describe('codexUsedPercentage', () => {
  // Lock the production formula via explicit table cases instead of a test
  // helper that re-implements the math (which would tautologically pass any
  // bug introduced in the helper).
  const cases: Array<{ used: number; window: number; expected: number; note: string }> = [
    { used: 0, window: 200_000, expected: 0, note: 'zero usage' },
    { used: 12_000, window: 272_000, expected: 0, note: 'exactly at baseline' },
    // 50_000 - 12_000 = 38_000; 200_000 - 12_000 = 188_000; round(38000/188000)
    { used: 50_000, window: 200_000, expected: 20, note: 'mid range' },
    // 215_000 - 12_000 = 203_000; 258_400 - 12_000 = 246_400; round(203000/246400)
    { used: 215_000, window: 258_400, expected: 82, note: 'near saturation' },
    { used: 500_000, window: 200_000, expected: 100, note: 'over-limit clamp' },
    {
      used: 50_000,
      window: CODEX_BASELINE_OVERHEAD_TOKENS,
      expected: 0,
      note: 'degenerate window',
    },
    { used: 50_000, window: 0, expected: 0, note: 'zero window' },
  ];

  for (const { used, window, expected, note } of cases) {
    it(`${note}: codexUsedPercentage(${used}, ${window}) === ${expected}`, () => {
      expect(codexUsedPercentage(used, window)).toBe(expected);
    });
  }
});

describe('extractCodexContextSnapshotFromEvent', () => {
  it('uses last_token_usage (current occupancy), NOT total_token_usage (lifetime cumulative)', () => {
    // Regression: previously we read total_token_usage.total_tokens, which is
    // the lifetime sum across every internal model API call in the thread.
    // For tool-heavy sessions that easily exceeds the model context window
    // and produces nonsensical >100% usage on even the first user turn.
    // Codex CLI's TUI uses last_token_usage.total_tokens (the most recent
    // single API call's tokens, which equals current context occupancy
    // because every API call sees the assembled transcript).
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 11_500,
            cached_input_tokens: 8_000,
            output_tokens: 500,
            total_tokens: 12_000,
          },
          total_token_usage: {
            input_tokens: 850_000,
            output_tokens: 150_000,
            total_tokens: 1_000_000, // lifetime cumulative — must be ignored
          },
          model_context_window: 272_000,
        },
      },
    });

    // Pulls from last_token_usage, not total_token_usage.
    expect(result?.totalTokens).toBe(12_000);
    expect(result?.maxTokens).toBe(272_000);
    // Baseline-adjusted percentage (used == baseline → 0%).
    expect(result?.percentage).toBe(0);
  });

  it('applies the Codex baseline-adjusted percentage formula', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 50_000 },
          model_context_window: 200_000,
        },
      },
    });

    expect(result?.totalTokens).toBe(50_000);
    expect(result?.percentage).toBe(20);
  });

  it('clamps percentage to 100 for over-limit usage', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 500_000 },
          model_context_window: 200_000,
        },
      },
    });

    expect(result?.totalTokens).toBe(500_000);
    expect(result?.maxTokens).toBe(200_000);
    expect(result?.percentage).toBe(100);
  });

  it('handles the auto-compaction marker (input=0, output=0, total=<new baseline>)', () => {
    // Codex emits a special token_count event at the moment of auto-compact
    // where input/output are zero but total_tokens carries the post-compact
    // context size. Observed in a real session JSONL on disk during the
    // bug investigation. Our extractor must report the post-compact size as
    // the current occupancy (not 0).
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 10_040,
          },
          total_token_usage: { total_tokens: 13_320_903 },
          model_context_window: 258_400,
        },
      },
    });

    expect(result?.totalTokens).toBe(10_040);
    expect(result?.maxTokens).toBe(258_400);
    expect(result?.percentage).toBe(0); // 10_040 ≤ 12_000 baseline → 0%
  });

  it('falls back to total_token_usage only when last_token_usage is absent (legacy payloads)', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 25_000 },
          model_context_window: 200_000,
        },
      },
    });

    // Fallback path: still works, but value is the cumulative — log site can
    // warn if a regression. (Not great, but better than 0 for legacy events.)
    expect(result?.totalTokens).toBe(25_000);
    expect(result?.percentage).toBe(7); // (25k-12k)/(200k-12k) ≈ 6.9 → 7
  });

  it('returns 0% when the window is at or below the baseline overhead', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 5_000 },
          model_context_window: CODEX_BASELINE_OVERHEAD_TOKENS, // degenerate
        },
      },
    });

    expect(result?.percentage).toBe(0);
  });

  it('accepts camelCase field variants (defensive — supported in code)', () => {
    const result = extractCodexContextSnapshotFromEvent({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          lastTokenUsage: { totalTokens: 50_000 },
          totalTokenUsage: { totalTokens: 850_000 },
          modelContextWindow: 200_000,
        },
      },
    });

    expect(result?.totalTokens).toBe(50_000);
    expect(result?.maxTokens).toBe(200_000);
    expect(result?.percentage).toBe(20);
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
    // Missing both last_token_usage and total_token_usage → undefined
    expect(
      extractCodexContextSnapshotFromEvent({
        type: 'event_msg',
        payload: { type: 'token_count', info: { model_context_window: 200_000 } },
      })
    ).toBeUndefined();
  });
});
