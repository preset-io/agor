import type { Task } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveCodexTaskCostUsd,
  estimateCodexTaskCostUsd,
  findCodexCcusageSession,
  previousCodexCostsAreReliable,
} from './ccusage.js';

function buildTask(overrides: Partial<Task['normalized_sdk_response']> = {}) {
  return {
    task_id: crypto.randomUUID(),
    normalized_sdk_response: {
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      ...overrides,
    },
  } as Pick<Task, 'task_id' | 'normalized_sdk_response'>;
}

describe('findCodexCcusageSession', () => {
  it('matches rollout-style session filenames by sdk session id suffix', () => {
    const session = findCodexCcusageSession(
      {
        sessions: [
          {
            sessionId: '/workspace/api/2026/05/29/rollout-1717000000-thread-abc123.jsonl',
            costUSD: 1.25,
          },
        ],
      },
      'thread-abc123'
    );

    expect(session?.costUSD).toBe(1.25);
  });

  it('matches canonical flat filenames too', () => {
    const session = findCodexCcusageSession(
      {
        sessions: [
          {
            sessionId: '/home/max/.codex/sessions/thread-flat-123.jsonl',
            costUSD: 2,
          },
        ],
      },
      'thread-flat-123'
    );

    expect(session?.costUSD).toBe(2);
  });
});

describe('previousCodexCostsAreReliable', () => {
  it('requires prior token-bearing tasks to have a stored cost', () => {
    expect(
      previousCodexCostsAreReliable([
        buildTask({ costUsd: 0.5 }),
        buildTask({ costUsd: undefined }),
      ])
    ).toBe(false);
  });

  it('ignores zero-usage legacy tasks', () => {
    expect(
      previousCodexCostsAreReliable([
        buildTask({ costUsd: 0.5 }),
        buildTask({
          costUsd: undefined,
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
      ])
    ).toBe(true);
  });
});

describe('deriveCodexTaskCostUsd', () => {
  it('subtracts prior stored task costs from the cumulative ccusage session cost', () => {
    const delta = deriveCodexTaskCostUsd(1.4, [
      buildTask({ costUsd: 0.4 }),
      buildTask({ costUsd: 0.6 }),
    ]);

    expect(delta).toBeCloseTo(0.4, 10);
  });

  it('returns undefined when prior task costs are incomplete', () => {
    const delta = deriveCodexTaskCostUsd(1.4, [
      buildTask({ costUsd: 0.4 }),
      buildTask({ costUsd: undefined }),
    ]);

    expect(delta).toBeUndefined();
  });

  it('returns undefined for meaningful negative deltas', () => {
    const delta = deriveCodexTaskCostUsd(0.2, [buildTask({ costUsd: 0.4 })]);

    expect(delta).toBeUndefined();
  });
});

describe('estimateCodexTaskCostUsd', () => {
  it('parses ccusage JSON and returns the current-task delta', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        sessions: [
          {
            sessionId: '/home/max/.codex/sessions/thread-flat-123.jsonl',
            costUSD: 1.4,
          },
        ],
      }),
    });

    const delta = await estimateCodexTaskCostUsd({
      sdkSessionId: 'thread-flat-123',
      previousTasks: [buildTask({ costUsd: 0.4 }), buildTask({ costUsd: 0.6 })],
      execFileImpl,
    });

    expect(delta).toBeCloseTo(0.4, 10);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('fails open when ccusage execution throws', async () => {
    const execFileImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      estimateCodexTaskCostUsd({
        sdkSessionId: 'thread-flat-123',
        previousTasks: [],
        execFileImpl,
      })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[codex] ccusage cost estimation failed:')
    );

    warnSpy.mockRestore();
  });
});
