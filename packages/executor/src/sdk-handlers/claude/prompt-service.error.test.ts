import { generateId } from '@agor/core';
import { asMCPExternalError } from '@agor/core/mcp';
import type { SDKMessage, SDKResultMessage } from '@agor/core/sdk';
import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';
import { AgorSetupError, ClaudeExecutionError, MESSAGES } from './claude-error.js';
import type { ProcessedEvent } from './message-processor.js';
import { ClaudePromptService } from './prompt-service.js';
import { setupQuery } from './query-builder.js';

vi.mock('./query-builder.js', () => ({ setupQuery: vi.fn() }));
const sessionId = generateId() as SessionID;

function rawResult(
  subtype: SDKResultMessage['subtype'] = 'success',
  isError = false
): SDKResultMessage {
  return {
    type: 'result',
    subtype,
    is_error: isError,
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 1,
    result: 'Invalid API key SECRET',
    errors: ['Invalid API key SECRET'],
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    uuid: generateId(),
    session_id: 'sdk-session',
  } as unknown as SDKResultMessage;
}

function queryWith(messages: SDKMessage[], error?: unknown) {
  const iterator = (async function* () {
    yield* messages;
    if (error) throw error;
  })();
  const next = vi.fn(iterator.next.bind(iterator));
  iterator.next = next;
  const query = {
    [Symbol.asyncIterator]: () => iterator,
    releaseInput: vi.fn(),
    getContextUsage: vi
      .fn()
      .mockResolvedValue({ totalTokens: 15, maxTokens: 200000, percentage: 0.0075 }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn(),
    return: vi.fn(async (value?: unknown) => iterator.return(value as never)),
  };
  vi.mocked(setupQuery).mockResolvedValue({
    query,
    resolvedModel: 'claude',
    getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
  });
  return { query, next };
}

function service() {
  const sessions = {
    findById: vi.fn().mockResolvedValue({ sdk_session_id: 'sdk-session' }),
    update: vi.fn(),
  };
  const promptService = new ClaudePromptService({} as never, sessions as never);
  promptService.logger = { error: vi.fn() };
  return { promptService, sessions };
}

async function collect(promptService: ClaudePromptService) {
  const events: ProcessedEvent[] = [];
  for await (const event of promptService.promptSessionStreaming(sessionId, 'test'))
    events.push(event);
  return events;
}

describe('Claude provider failure boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['streaming', 'non-streaming'] as const)(
    'normalizes SDK iterator exceptions in %s',
    async (mode) => {
      const raw = Object.assign(
        new Error('Claude Code returned an error result: Invalid API key'),
        { errorClass: 'error_result' }
      );
      const { query } = queryWith([], raw);
      const { promptService } = service();
      await expect(
        mode === 'streaming'
          ? collect(promptService)
          : promptService.promptSession(sessionId, 'test')
      ).rejects.toMatchObject({
        category: 'authentication',
        message: MESSAGES.authentication,
        cause: raw,
      });
      expect(query.releaseInput).toHaveBeenCalled();
      expect(query.return).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    'success',
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
  ] as const)(
    'diagnoses %s results without consuming a subsequent exception or losing usage',
    async (subtype) => {
      const raw = rawResult(subtype, true);
      const { query, next } = queryWith([raw], new Error('late process failure SECRET'));
      const { promptService } = service();
      const events = await collect(promptService);
      const result = events.find((event) => event.type === 'result');
      expect(result?.type).toBe('result');
      if (result?.type !== 'result') throw new Error('missing result');
      expect(result.failure).toBeInstanceOf(ClaudeExecutionError);
      expect(result.failure?.category).toBe(
        subtype === 'error_max_turns'
          ? 'turn_limit'
          : subtype === 'error_max_budget_usd'
            ? 'budget_limit'
            : 'authentication'
      );
      expect(result.failure).not.toBeInstanceOf(MissingCredentialError);
      expect(result.raw_sdk_message.usage).toEqual(raw.usage);
      expect(result.raw_sdk_message.total_cost_usd).toBe(raw.total_cost_usd);
      expect(next).toHaveBeenCalledTimes(1);
      expect(query.return).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(promptService.logger.error).mock.calls)).not.toContain(
        'SECRET'
      );
    }
  );

  it('uses the same result diagnosis in the legacy non-streaming API and closes stdin', async () => {
    const { query, next } = queryWith(
      [rawResult('error_max_turns', true)],
      new Error('late error')
    );
    const { promptService } = service();
    await expect(promptService.promptSession(sessionId, 'test')).rejects.toMatchObject({
      category: 'turn_limit',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(query.releaseInput).toHaveBeenCalledTimes(1);
    expect(query.return).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupQuery).mock.calls[0]?.[3]?.resume).toBe(false);
  });

  it('does not fail a result when context usage rejects', async () => {
    const { query } = queryWith([rawResult()]);
    query.getContextUsage.mockRejectedValue(new Error('socket closed SECRET'));
    const { promptService } = service();
    const events = await collect(promptService);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(events.some((event) => event.type === 'context_usage')).toBe(false);
    expect(query.releaseInput).toHaveBeenCalledTimes(1);
    expect(query.return).toHaveBeenCalledTimes(1);
  });

  it('preserves the original provider failure when teardown rejects', async () => {
    const { query } = queryWith([], new Error('Invalid API key'));
    query.return.mockRejectedValue(new Error('cleanup failed'));
    await expect(collect(service().promptService)).rejects.toMatchObject({
      category: 'authentication',
    });
  });

  it('does not classify session persistence failures as provider auth errors', async () => {
    const raw = rawResult();
    raw.session_id = 'new-sdk-session';
    const { query } = queryWith([raw]);
    const { promptService, sessions } = service();
    sessions.findById.mockResolvedValue({ sdk_session_id: undefined });
    const localError = new Error('Invalid API key: Agor control-plane access revoked SECRET');
    sessions.update.mockRejectedValue(localError);
    await expect(collect(promptService)).rejects.toBe(localError);
    expect(query.return).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(promptService.logger.error).mock.calls)).not.toContain(
      'SECRET'
    );
  });

  it('closes the SDK query if loading session metadata fails', async () => {
    const { query, next } = queryWith([]);
    const { promptService, sessions } = service();
    const localError = new Error('Agor RPC unavailable');
    sessions.findById.mockRejectedValue(localError);
    await expect(collect(promptService)).rejects.toBe(localError);
    expect(next).not.toHaveBeenCalled();
    expect(query.return).toHaveBeenCalledTimes(1);
  });

  it.each([
    new AgorSetupError('Working directory unavailable'),
    new Error('Invalid API key: Agor RPC'),
    new MissingCredentialError('No scoped credential'),
  ])('preserves setup/preflight failure identity', async (error) => {
    vi.mocked(setupQuery).mockRejectedValue(error);
    const { promptService } = service();
    await expect(collect(promptService)).rejects.toBe(error);
    await expect(promptService.promptSession(sessionId, 'test')).rejects.toBe(error);
  });

  it('preserves genuine MCP error identity', async () => {
    const mcp = asMCPExternalError(new Error('secret'), {
      stage: 'oauth',
      category: 'provider_rejected',
    });
    queryWith([], mcp);
    await expect(collect(service().promptService)).rejects.toBe(mcp);
  });

  it.each(['iterator', 'setup'] as const)('preserves SDK cancellation from %s', async (where) => {
    const abort = Object.assign(new Error('stop'), { errorClass: 'aborted' });
    queryWith([], abort);
    if (where === 'setup') vi.mocked(setupQuery).mockRejectedValue(abort);
    const { promptService } = service();
    expect(await collect(promptService)).toEqual([{ type: 'stopped' }]);
    // Use a fresh iterator so the legacy path sees the abort, not an exhausted stream.
    queryWith([], abort);
    if (where === 'setup') vi.mocked(setupQuery).mockRejectedValue(abort);
    expect(await promptService.promptSession(sessionId, 'test')).toEqual({
      messages: [],
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
