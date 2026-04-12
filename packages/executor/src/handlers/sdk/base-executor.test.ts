import { describe, expect, it } from 'vitest';
import { estimateCodexContextWindowFromRunningTotals } from './base-executor.js';

describe('estimateCodexContextWindowFromRunningTotals', () => {
  it('uses current snapshot when there is no previous task', () => {
    const result = estimateCodexContextWindowFromRunningTotals({
      type: 'turn.completed',
      usage: {
        input_tokens: 15_120,
        output_tokens: 240,
      },
    });

    expect(result).toBe(15_360);
  });

  it('uses input-token delta for running totals and adds output tokens', () => {
    const result = estimateCodexContextWindowFromRunningTotals(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 30_900,
          output_tokens: 800,
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 15_600,
          output_tokens: 700,
        },
      }
    );

    expect(result).toBe(16_100);
  });

  it('falls back to current snapshot when running totals reset', () => {
    const result = estimateCodexContextWindowFromRunningTotals(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 9_800,
          output_tokens: 250,
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 120_000,
          output_tokens: 400,
        },
      }
    );

    expect(result).toBe(10_050);
  });

  it('returns undefined for invalid current payloads', () => {
    expect(estimateCodexContextWindowFromRunningTotals(undefined)).toBeUndefined();
    expect(
      estimateCodexContextWindowFromRunningTotals({ usage: { output_tokens: 123 } })
    ).toBeUndefined();
  });
});
