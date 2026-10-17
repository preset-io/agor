import { asMCPExternalError, MCPExternalError } from '@agor/core/mcp';
import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./query-builder.js', () => ({
  setupQuery: vi.fn(),
}));

import { AgorSetupError, ClaudeExecutionError, MESSAGES } from './claude-error.js';
import { ClaudePromptService } from './prompt-service.js';
import { setupQuery } from './query-builder.js';

const mockSetupQuery = vi.mocked(setupQuery);
const testSessionId = '01a144e0-408d-7138-9233-93e79ee8bc7e' as SessionID;

function createQueryMock(throwError: unknown) {
  return {
    query: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(throwError);
          },
        };
      },
      releaseInput: vi.fn(),
      getContextUsage: vi
        .fn()
        .mockResolvedValue({ totalTokens: 10, maxTokens: 200_000, percentage: 0.005 }),
      interrupt: vi.fn().mockResolvedValue(undefined),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    },
    getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
    refreshMcp: undefined,
  };
}

describe('ClaudePromptService error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('regression (Issue #3120): preserves Claude SDK failures instead of masking as "The MCP operation failed"', async () => {
    const sdkError = Object.assign(
      new Error('Claude Code returned an error result: Invalid API key · Fix external API key'),
      { errorClass: 'error_result' }
    );
    mockSetupQuery.mockResolvedValue(createQueryMock(sdkError) as never);

    const service = new ClaudePromptService();
    const generator = service.promptSessionStreaming(testSessionId, 'test prompt');

    await expect(generator.next()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ClaudeExecutionError);
      const claudeErr = err as ClaudeExecutionError;
      expect(claudeErr.message).not.toContain('The MCP operation failed');
      expect(claudeErr.message).toBe(MESSAGES.authentication);
      expect(claudeErr.category).toBe('authentication');
      expect(claudeErr.cause).toBe(sdkError);
      return true;
    });
  });

  it('passes through genuine MCPExternalError unchanged by identity', async () => {
    const mcpError = asMCPExternalError(new Error('oauth token request failed'), {
      stage: 'oauth',
      category: 'provider_rejected',
    });
    mockSetupQuery.mockResolvedValue(createQueryMock(mcpError) as never);

    const service = new ClaudePromptService();
    const generator = service.promptSessionStreaming(testSessionId, 'test prompt');

    await expect(generator.next()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBe(mcpError);
      expect(err).toBeInstanceOf(MCPExternalError);
      return true;
    });
  });

  it('does not fail stream when getContextUsage rejects', async () => {
    const releaseInput = vi.fn();
    const mockResultEvent = {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: 'turn completed successfully',
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      uuid: 'test-uuid',
      session_id: 'sdk-session',
    };

    let done = false;
    const queryObj = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (!done) {
              done = true;
              return Promise.resolve({ value: mockResultEvent, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
      releaseInput,
      getContextUsage: vi.fn().mockRejectedValue(new Error('context usage socket dropped')),
      interrupt: vi.fn().mockResolvedValue(undefined),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    };

    mockSetupQuery.mockResolvedValue({
      query: queryObj as never,
      getStderrMetadata: () => ({ hasStderr: false, byteLength: 0 }),
      refreshMcp: undefined,
    } as never);

    const service = new ClaudePromptService();
    const events: Array<{ type: string }> = [];

    for await (const event of service.promptSessionStreaming(testSessionId, 'test prompt')) {
      events.push(event as { type: string });
    }

    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'context_usage')).toHaveLength(0);
    expect(releaseInput).toHaveBeenCalledTimes(1);
  });

  it('cleanup rejection does not mask original error', async () => {
    const returnSpy = vi.fn().mockRejectedValue(new Error('cleanup socket already closed'));
    const originalError = Object.assign(new Error('Invalid API key'), {
      errorClass: 'error_result',
    });
    const queryMock = createQueryMock(originalError);
    queryMock.query.return = returnSpy;
    mockSetupQuery.mockResolvedValue(queryMock as never);

    const service = new ClaudePromptService();
    const generator = service.promptSessionStreaming(testSessionId, 'test prompt');

    await expect(generator.next()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ClaudeExecutionError);
      expect((err as ClaudeExecutionError).category).toBe('authentication');
      expect((err as ClaudeExecutionError).cause).toBe(originalError);
      return true;
    });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces AgorSetupError unmasked in both promptSessionStreaming and promptSession', async () => {
    const setupErr = new AgorSetupError(
      'Working directory for this session is unavailable. The branch may not be initialized.'
    );
    mockSetupQuery.mockRejectedValue(setupErr);

    const service = new ClaudePromptService();

    // 1. Streaming
    const generator = service.promptSessionStreaming(testSessionId, 'test prompt');
    await expect(generator.next()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBe(setupErr);
      expect((err as Error).message).not.toContain('/');
      return true;
    });

    // 2. Non-streaming
    await expect(service.promptSession(testSessionId, 'test prompt')).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBe(setupErr);
        expect((err as Error).message).not.toContain('/');
        return true;
      }
    );
  });

  it('handles Claude SDK abort without throwing: yields stopped in streaming, returns in non-streaming', async () => {
    const sdkAbort = Object.assign(new Error('Claude Code process aborted by user'), {
      telemetryMessage: 'Claude Code process aborted by user',
      errorClass: 'aborted',
    });
    mockSetupQuery.mockResolvedValue(createQueryMock(sdkAbort) as never);

    const service = new ClaudePromptService();

    // Streaming yields { type: 'stopped' } and finishes cleanly
    const events: Array<{ type: string }> = [];
    for await (const event of service.promptSessionStreaming(testSessionId, 'test prompt')) {
      events.push(event as { type: string });
    }
    expect(events).toEqual([{ type: 'stopped' }]);

    // Non-streaming returns partial result cleanly
    const result = await service.promptSession(testSessionId, 'test prompt');
    expect(result).toEqual({ messages: [], inputTokens: 0, outputTokens: 0 });
  });

  it('handles standard MCP AbortError (name: "AbortError") cleanly in streaming', async () => {
    const mcpAbort = new Error('Operation aborted');
    mcpAbort.name = 'AbortError';
    mockSetupQuery.mockResolvedValue(createQueryMock(mcpAbort) as never);

    const service = new ClaudePromptService();
    const events: Array<{ type: string }> = [];
    for await (const event of service.promptSessionStreaming(testSessionId, 'test prompt')) {
      events.push(event as { type: string });
    }
    expect(events).toEqual([{ type: 'stopped' }]);
  });

  it('logs failure via console.error with category and message when setupQuery rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockSetupQuery.mockRejectedValue(new Error('Working directory unavailable'));
      const service = new ClaudePromptService();
      await expect(
        service.promptSessionStreaming(testSessionId, 'test prompt').next()
      ).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(
        '❌ Query setup failed:',
        expect.objectContaining({
          category: expect.any(String),
          message: expect.any(String),
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs AgorSetupError with setup_error category when setupQuery rejects with AgorSetupError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockSetupQuery.mockRejectedValue(
        new AgorSetupError('Working directory for this session is unavailable.')
      );
      const service = new ClaudePromptService();
      await expect(
        service.promptSessionStreaming(testSessionId, 'test prompt').next()
      ).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(
        '❌ Query setup failed:',
        expect.objectContaining({
          category: 'setup_error',
          message: 'Working directory for this session is unavailable.',
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
