import { describe, expect, it, vi } from 'vitest';
import type { ProcessedEvent } from './message-processor.js';
import { autoResumeOnRateLimit, MAX_RATE_LIMIT_RETRIES } from './rate-limit-retry.js';
import {
  accumulateResultUsage,
  applyAccumulatedUsage,
  emptyRetryUsageAccumulator,
} from './usage-aggregation.js';

type Any = any;

function resultEvent(raw: Any): ProcessedEvent {
  return { type: 'result', raw_sdk_message: raw } as ProcessedEvent;
}

const blockedTurn = (resetsAt?: number) =>
  async function* (): AsyncGenerator<ProcessedEvent> {
    yield { type: 'rate_limit', status: 'rejected', resetsAt } as ProcessedEvent;
    yield resultEvent({
      subtype: 'success',
      terminal_reason: 'blocking_limit',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
      duration_ms: 100,
    });
  };

const completedTurn = () =>
  async function* (): AsyncGenerator<ProcessedEvent> {
    yield {
      type: 'complete',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    } as ProcessedEvent;
    yield resultEvent({
      subtype: 'success',
      terminal_reason: 'completed',
      usage: { input_tokens: 20, output_tokens: 8 },
      total_cost_usd: 0.02,
      duration_ms: 200,
    });
  };

/** Sequence the given per-turn generators; the last one repeats if exhausted. */
function turnRunner(turns: Array<() => AsyncGenerator<ProcessedEvent>>) {
  let call = 0;
  return () => {
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    return turn();
  };
}

async function drain(gen: AsyncGenerator<ProcessedEvent>): Promise<ProcessedEvent[]> {
  const out: ProcessedEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('autoResumeOnRateLimit', () => {
  it('waits then resumes a blocked turn and emits the completed result as final', async () => {
    const sleep = vi.fn(async () => ({ aborted: false }));
    const events = await drain(
      autoResumeOnRateLimit(turnRunner([blockedTurn(), completedTurn()]), { prompt: 'go', sleep })
    );

    expect(events.map((e) => e.type)).toEqual([
      'rate_limit',
      'intermediate_result',
      'rate_limit_retry',
      'complete',
      'result',
    ]);
    const final = events.find((e) => e.type === 'result') as Extract<
      ProcessedEvent,
      { type: 'result' }
    >;
    expect((final.raw_sdk_message as Any).terminal_reason).toBe('completed');
    expect(events.some((e) => e.type === 'rate_limit_retry_exhausted')).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('never re-issues a turn that completed normally', async () => {
    const sleep = vi.fn(async () => ({ aborted: false }));
    const events = await drain(
      autoResumeOnRateLimit(turnRunner([completedTurn()]), { prompt: 'go', sleep })
    );
    expect(events.map((e) => e.type)).toEqual(['complete', 'result']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the retry cap and announces exhaustion', async () => {
    const sleep = vi.fn(async () => ({ aborted: false }));
    const events = await drain(
      autoResumeOnRateLimit(turnRunner([blockedTurn()]), { prompt: 'go', sleep })
    );

    expect(events.filter((e) => e.type === 'rate_limit_retry')).toHaveLength(
      MAX_RATE_LIMIT_RETRIES
    );
    expect(events.filter((e) => e.type === 'rate_limit_retry_exhausted')).toHaveLength(1);
    // The final blocked result is still surfaced (task goes idle, not lost).
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES);
  });

  it('stops cleanly when the wait is interrupted by a cancel', async () => {
    const sleep = vi.fn(async () => ({ aborted: true }));
    const events = await drain(
      autoResumeOnRateLimit(turnRunner([blockedTurn(), completedTurn()]), { prompt: 'go', sleep })
    );

    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    // No resumed turn ran, so no completed final result.
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('preserves a throttled invocation usage on the stopped outcome when cancelled mid-wait', async () => {
    const sleep = vi.fn(async () => ({ aborted: true })); // cancel during the first wait
    const events = await drain(
      autoResumeOnRateLimit(turnRunner([blockedTurn(), completedTurn()]), { prompt: 'go', sleep })
    );

    // The completed-but-throttled invocation is surfaced before the stop.
    const idxIntermediate = events.findIndex((e) => e.type === 'intermediate_result');
    const idxStopped = events.findIndex((e) => e.type === 'stopped');
    expect(idxIntermediate).toBeGreaterThanOrEqual(0);
    expect(idxStopped).toBeGreaterThan(idxIntermediate);
    expect(events.some((e) => e.type === 'result')).toBe(false);

    // Mirror claude-tool's accounting reducer over the event stream.
    let usageAcc = emptyRetryUsageAccumulator();
    let lastIntermediateRaw: Any;
    let rawSdkResponse: Any;
    let wasStopped = false;
    for (const e of events) {
      if (e.type === 'intermediate_result') {
        usageAcc = accumulateResultUsage(usageAcc, e.raw_sdk_message);
        lastIntermediateRaw = e.raw_sdk_message;
      } else if (e.type === 'result') {
        usageAcc = accumulateResultUsage(usageAcc, e.raw_sdk_message);
        rawSdkResponse = applyAccumulatedUsage(e.raw_sdk_message, usageAcc);
      } else if (e.type === 'stopped') {
        wasStopped = true;
        if (lastIntermediateRaw && !rawSdkResponse) {
          rawSdkResponse = applyAccumulatedUsage(lastIntermediateRaw, usageAcc);
        }
      }
    }

    expect(wasStopped).toBe(true);
    // The throttled invocation's usage/cost/duration survive onto the stopped payload...
    expect(rawSdkResponse.usage.input_tokens).toBe(10);
    expect(rawSdkResponse.usage.output_tokens).toBe(5);
    expect(rawSdkResponse.total_cost_usd).toBeCloseTo(0.01);
    expect(rawSdkResponse.duration_ms).toBe(100);
    // ...counted exactly once (blockedTurn had input_tokens: 10, not doubled to 20).
  });
});

describe('usage aggregation', () => {
  it('sums cost/duration/tokens across invocations and applies them to the final result', () => {
    let acc = emptyRetryUsageAccumulator();
    acc = accumulateResultUsage(acc, {
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
      duration_ms: 100,
      duration_api_ms: 90,
      modelUsage: { 'claude-opus': { inputTokens: 10, outputTokens: 5, contextWindow: 200_000 } },
    } as Any);
    acc = accumulateResultUsage(acc, {
      usage: { input_tokens: 20, output_tokens: 8 },
      total_cost_usd: 0.02,
      duration_ms: 200,
      duration_api_ms: 150,
      modelUsage: { 'claude-opus': { inputTokens: 20, outputTokens: 8, contextWindow: 200_000 } },
    } as Any);

    expect(acc.totalCostUsd).toBeCloseTo(0.03);
    expect(acc.durationMs).toBe(300);
    expect(acc.usage.input_tokens).toBe(30);
    expect(acc.usage.output_tokens).toBe(13);
    // contextWindow is a fixed window size — max, not summed.
    expect(acc.modelUsage['claude-opus'].contextWindow).toBe(200_000);
    expect(acc.modelUsage['claude-opus'].inputTokens).toBe(30);

    const final = applyAccumulatedUsage(
      { subtype: 'success', terminal_reason: 'completed', usage: { input_tokens: 20 } } as Any,
      acc
    ) as Any;
    expect(final.terminal_reason).toBe('completed');
    expect(final.total_cost_usd).toBeCloseTo(0.03);
    expect(final.usage.input_tokens).toBe(30);
    expect(final.duration_ms).toBe(300);
  });

  it('sums every billable field of the complete SDK usage shape and maxes capacities', () => {
    // Complete ModelUsage (all required SDK fields) + full top-level usage.
    const invocation = (n: number) => ({
      subtype: 'success',
      terminal_reason: n === 2 ? 'completed' : 'blocking_limit',
      total_cost_usd: 0.01 * n,
      duration_ms: 100 * n,
      duration_api_ms: 80 * n,
      usage: {
        input_tokens: 10 * n,
        output_tokens: 5 * n,
        cache_creation_input_tokens: 2 * n,
        cache_read_input_tokens: 3 * n,
        server_tool_use: { web_fetch_requests: n, web_search_requests: 2 * n },
        service_tier: 'standard',
      },
      modelUsage: {
        'claude-opus': {
          inputTokens: 10 * n,
          outputTokens: 5 * n,
          cacheReadInputTokens: 3 * n,
          cacheCreationInputTokens: 2 * n,
          webSearchRequests: 2 * n,
          costUSD: 0.01 * n,
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
        },
      },
    });

    let acc = emptyRetryUsageAccumulator();
    acc = accumulateResultUsage(acc, invocation(1) as Any);
    acc = accumulateResultUsage(acc, invocation(2) as Any);

    // Additive fields summed (n=1 + n=2 => x3 of the base).
    expect(acc.usage.input_tokens).toBe(30);
    expect(acc.usage.cache_creation_input_tokens).toBe(6);
    expect(acc.usage.cache_read_input_tokens).toBe(9);
    expect(acc.usage.server_tool_use.web_fetch_requests).toBe(3);
    expect(acc.usage.server_tool_use.web_search_requests).toBe(6);
    expect(acc.totalCostUsd).toBeCloseTo(0.03);
    expect(acc.durationApiMs).toBe(240);
    const mu = acc.modelUsage['claude-opus'];
    expect(mu.webSearchRequests).toBe(6);
    expect(mu.costUSD).toBeCloseTo(0.03);
    // Capacity fields maxed, not summed.
    expect(mu.contextWindow).toBe(200_000);
    expect(mu.maxOutputTokens).toBe(64_000);

    const final = applyAccumulatedUsage(invocation(2) as Any, acc) as Any;
    // Structural fields from the final result are preserved, not dropped.
    expect(final.usage.service_tier).toBe('standard');
    expect(final.usage.server_tool_use.web_search_requests).toBe(6);
    expect(final.modelUsage['claude-opus'].maxOutputTokens).toBe(64_000);
    expect(final.total_cost_usd).toBeCloseTo(0.03);
  });

  it('is a no-op-equivalent for a single invocation (no retries)', () => {
    let acc = emptyRetryUsageAccumulator();
    const raw = {
      subtype: 'success',
      usage: { input_tokens: 42, output_tokens: 7 },
      total_cost_usd: 0.05,
      duration_ms: 123,
    };
    acc = accumulateResultUsage(acc, raw as Any);
    const final = applyAccumulatedUsage(raw as Any, acc) as Any;
    expect(final.total_cost_usd).toBeCloseTo(0.05);
    expect(final.usage.input_tokens).toBe(42);
    expect(final.duration_ms).toBe(123);
  });
});
