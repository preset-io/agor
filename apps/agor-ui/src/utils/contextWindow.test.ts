import type { Task } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  getContextWindowGradient,
  getContextWindowPercentage,
  resolveContextWindowPercentage,
  selectLatestContextWindow,
} from './contextWindow';

const colors = { normal: 'normal', warning: 'warning', critical: 'critical' };

describe('contextWindow utils', () => {
  it('clamps percentage to 100 when usage exceeds limit', () => {
    expect(getContextWindowPercentage(600_000, 100_000)).toBe(100);
  });

  it('clamps percentage to 0 for invalid values', () => {
    expect(getContextWindowPercentage(Number.NaN, 100_000)).toBe(0);
    expect(getContextWindowPercentage(1_000, 0)).toBe(0);
  });

  it('builds a bounded gradient for over-limit usage', () => {
    const gradient = getContextWindowGradient(600_000, 100_000, undefined, colors);
    expect(gradient).toBe('linear-gradient(to right, critical 100%, transparent 100%)');
  });

  it('does not build a gradient when context usage is unavailable despite a known limit', () => {
    expect(getContextWindowGradient(undefined, 1_000_000, undefined, colors)).toBeUndefined();
    expect(getContextWindowGradient(0, 1_000_000, undefined, colors)).toBeUndefined();
  });

  it('prefers the snapshot percentage over raw used/limit when provided', () => {
    // Authoritative snapshot says 0% (e.g. Codex baseline-adjusted) — must
    // win over the raw 50% the ratio would produce.
    expect(
      resolveContextWindowPercentage(50_000, 100_000, {
        totalTokens: 50_000,
        maxTokens: 100_000,
        percentage: 0,
      })
    ).toBe(0);
  });

  it('keeps the gradient in lockstep with the snapshot percentage', () => {
    const gradient = getContextWindowGradient(
      50_000,
      100_000,
      { totalTokens: 50_000, maxTokens: 100_000, percentage: 0 },
      colors
    );
    // Green (0% bucket), 0% fill
    expect(gradient).toBe('linear-gradient(to right, normal 0%, transparent 0%)');
  });
});

describe('selectLatestContextWindow', () => {
  const projection = {
    task_id: 'turn-9',
    computed_context_window: 50_000,
    model: 'synthetic-model',
    duration_ms: 1200,
    normalized_sdk_response: {
      tokenUsage: { inputTokens: 50_000, outputTokens: 1, totalTokens: 50_001 },
      contextWindowLimit: 200_000,
      contextUsageSnapshot: { totalTokens: 50_000, maxTokens: 180_000, percentage: 28 },
    },
  };
  const loaded = { task_id: 'turn-9', raw_sdk_response: { modelUsage: {} } } as unknown as Task;

  it('keeps the indicator after its turn left the loaded transcript', () => {
    expect(selectLatestContextWindow(projection, [], 'claude-code')).toEqual({
      used: 50_000,
      limit: 180_000,
      taskMetadata: {
        model: 'synthetic-model',
        duration_ms: 1200,
        agentic_tool: 'claude-code',
        raw_sdk_response: undefined,
        normalized_sdk_response: projection.normalized_sdk_response,
      },
    });
  });

  it('offers the raw SDK breakdown while the turn is loaded', () => {
    expect(
      selectLatestContextWindow(projection, [loaded], 'claude-code')?.taskMetadata.raw_sdk_response
    ).toBe(loaded.raw_sdk_response);
  });

  it('shows nothing without a projection or an agentic tool', () => {
    expect(selectLatestContextWindow(undefined, [loaded], 'claude-code')).toBeNull();
    expect(selectLatestContextWindow(projection, [loaded], undefined)).toBeNull();
  });
});
