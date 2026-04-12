import { describe, expect, it } from 'vitest';
import type { AgorClient } from '../../services/feathers-client.js';
import {
  computeCodexContextWindowFromPreviousTask,
  inferCodexContextWindowFromRunningTotals,
} from './context-window-fallback.js';

describe('inferCodexContextWindowFromRunningTotals', () => {
  it('uses current snapshot when there is no previous task', () => {
    const result = inferCodexContextWindowFromRunningTotals({
      type: 'turn.completed',
      usage: {
        input_tokens: 15_120,
        output_tokens: 240,
      },
    });

    expect(result).toBe(15_360);
  });

  it('uses input-token delta for running totals and adds output tokens', () => {
    const result = inferCodexContextWindowFromRunningTotals(
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
    const result = inferCodexContextWindowFromRunningTotals(
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
    expect(inferCodexContextWindowFromRunningTotals(undefined)).toBeUndefined();
    expect(
      inferCodexContextWindowFromRunningTotals({ usage: { output_tokens: 123 } })
    ).toBeUndefined();
  });
});

describe('computeCodexContextWindowFromPreviousTask', () => {
  it('queries latest tasks without $ne filter and uses previous task row', async () => {
    const find = async ({ query }: { query: Record<string, unknown> }) => {
      expect(query.$limit).toBe(2);
      expect(query.$sort).toEqual({ created_at: -1 });
      expect('task_id' in query).toBe(false);

      return {
        data: [
          {
            task_id: 'current-task',
            raw_sdk_response: { usage: { input_tokens: 30_000, output_tokens: 10 } },
          },
          {
            task_id: 'previous-task',
            raw_sdk_response: { usage: { input_tokens: 15_000, output_tokens: 50 } },
          },
        ],
      };
    };

    const client = {
      service: () => ({ find }),
    } as unknown as AgorClient;

    const result = await computeCodexContextWindowFromPreviousTask(
      client,
      'session' as any,
      'current-task' as any,
      { usage: { input_tokens: 30_000, output_tokens: 200 } }
    );

    expect(result).toBe(15_200);
  });
});
