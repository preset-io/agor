import type { SDKResultMessage } from '@agor/core/sdk';
import { describe, expect, it } from 'vitest';
import { aggregateClaudeResults } from './result-aggregation.js';

function result(
  uuid: string,
  inputTokens: number,
  cumulativeInputTokens: number,
  cumulativeOutputTokens: number,
  cumulativeCost: number
): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: null,
    total_cost_usd: cumulativeCost,
    usage: {
      input_tokens: inputTokens,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
    },
    modelUsage: {
      sonnet: {
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 3,
        webSearchRequests: 0,
        costUSD: cumulativeCost,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    uuid,
    session_id: 'sdk-session',
  };
}

describe('aggregateClaudeResults', () => {
  it('sums per-turn fields without double-counting cumulative accounting', () => {
    const aggregate = aggregateClaudeResults([
      result('parent', 10, 10, 2, 0.01),
      result('continuation', 20, 30, 4, 0.03),
    ]);

    expect(aggregate.uuid).toBe('continuation');
    expect(aggregate.usage).toMatchObject({
      input_tokens: 30,
      output_tokens: 4,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 8,
    });
    expect(aggregate.modelUsage.sonnet).toMatchObject({
      inputTokens: 30,
      outputTokens: 4,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      costUSD: 0.03,
    });
    expect(aggregate).toMatchObject({
      duration_ms: 20,
      duration_api_ms: 16,
      num_turns: 2,
      total_cost_usd: 0.03,
    });
  });

  it('preserves terminal model identity and pricing metadata', () => {
    const parent = result('parent', 10, 10, 2, 0.01);
    const continuation = result('continuation', 20, 30, 4, 0.03);
    continuation.modelUsage.sonnet = {
      ...continuation.modelUsage.sonnet,
      thinkingTokens: 1,
      canonicalModel: 'claude-sonnet-5',
      provider: 'firstParty',
      costBasis: 'list',
    };

    expect(aggregateClaudeResults([parent, continuation]).modelUsage.sonnet).toMatchObject({
      thinkingTokens: 1,
      canonicalModel: 'claude-sonnet-5',
      provider: 'firstParty',
      costBasis: 'list',
    });
  });

  it('does not let a zeroed terminal error erase prior cumulative accounting', () => {
    const success = result('parent', 10, 10, 2, 0.01);
    const crash = result('crash', 0, 0, 0, 0);
    crash.subtype = 'error_during_execution';
    crash.is_error = true;
    crash.modelUsage = {};

    const aggregate = aggregateClaudeResults([success, crash]);

    expect(aggregate.uuid).toBe('crash');
    expect(aggregate.subtype).toBe('error_during_execution');
    expect(aggregate.total_cost_usd).toBe(0.01);
    expect(aggregate.modelUsage.sonnet).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });
});
