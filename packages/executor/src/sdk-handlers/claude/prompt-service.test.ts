/**
 * Tests that ClaudePromptService uses the per-session sdk_idle_timeout_ms
 * from model_config when constructing SDKMessageProcessor — for both the
 * streaming (promptSessionStreaming) and non-streaming (promptSession) paths.
 */

import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal stub types
type StubSession = {
  session_id: string;
  sdk_session_id?: string;
  model_config?: { sdk_idle_timeout_ms?: number };
};

// Capture constructor args passed to SDKMessageProcessor
const processorCalls: Array<{ idleTimeoutMs: number }> = [];
const processorInstances: Array<{
  process: ReturnType<typeof vi.fn>;
  hasTimedOut: ReturnType<typeof vi.fn>;
}> = [];
let queryMessages: Array<Record<string, unknown>> = [];
let queryWaitsForRelease = false;
let lastReleaseInput: ReturnType<typeof vi.fn> | undefined;

vi.mock('./message-processor.js', () => {
  return {
    // Must use `function` (not arrow) so vitest 4.x can call it with `new`.
    SDKMessageProcessor: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
      opts: { idleTimeoutMs: number }
    ) {
      const process = vi.fn().mockImplementation(async (msg: { type?: string }) => {
        if (msg.type === 'result') {
          return [
            { type: 'result', raw_sdk_message: msg },
            { type: 'end', reason: 'result' },
          ];
        }
        return [];
      });
      const hasTimedOut = vi.fn().mockReturnValue(false);
      processorCalls.push({ idleTimeoutMs: opts.idleTimeoutMs });
      processorInstances.push({ process, hasTimedOut });
      this.process = process;
      this.hasTimedOut = hasTimedOut;
      this.getState = vi.fn().mockReturnValue({
        messageCount: 0,
        lastActivityTime: Date.now(),
        idleTimeoutMs: opts.idleTimeoutMs,
      });
    }),
  };
});

// Stub out heavy core imports that pull in db/orm dependencies.
vi.mock('@agor/core/db', () => ({ shortId: (id: string) => id.slice(0, 8) }));

// Return a fresh empty generator on every call so tests don't share state.
vi.mock('./query-builder.js', () => ({
  setupQuery: vi.fn().mockImplementation(async () => {
    let releaseInputResolve: (() => void) | undefined;
    const releaseInputPromise = new Promise<void>((resolve) => {
      releaseInputResolve = resolve;
    });
    const query = (async function* () {
      for (const msg of queryMessages) {
        yield msg;
      }
      if (queryWaitsForRelease) {
        await releaseInputPromise;
      }
    })() as AsyncGenerator<Record<string, unknown>> & {
      releaseInput: ReturnType<typeof vi.fn>;
      getContextUsage: ReturnType<typeof vi.fn>;
    };
    query.releaseInput = vi.fn(() => releaseInputResolve?.());
    lastReleaseInput = query.releaseInput;
    query.getContextUsage = vi
      .fn()
      .mockResolvedValue({ totalTokens: 0, maxTokens: 200000, percentage: 0 });

    return {
      query,
      getStderr: vi.fn().mockReturnValue(''),
    };
  }),
}));

describe('ClaudePromptService sdk_idle_timeout_ms', () => {
  let sessionsRepo: { findById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    processorCalls.length = 0;
    processorInstances.length = 0;
    queryMessages = [];
    queryWaitsForRelease = false;
    lastReleaseInput = undefined;
    sessionsRepo = { findById: vi.fn() };
  });

  async function runStreaming(session: StubSession) {
    const { ClaudePromptService } = await import('./prompt-service.js');
    const svc = new ClaudePromptService(undefined as never, sessionsRepo as never);
    sessionsRepo.findById.mockResolvedValue(session);
    for await (const _ of svc.promptSessionStreaming(session.session_id as SessionID, 'test')) {
      // consume
    }
  }

  async function runNonStreaming(session: StubSession) {
    const { ClaudePromptService } = await import('./prompt-service.js');
    const svc = new ClaudePromptService(undefined as never, sessionsRepo as never);
    sessionsRepo.findById.mockResolvedValue(session);
    return svc.promptSession(session.session_id as SessionID, 'test');
  }

  describe('streaming path (promptSessionStreaming)', () => {
    it('uses DEFAULT (300000) when session has no sdk_idle_timeout_ms', async () => {
      await runStreaming({ session_id: 'sess-a', model_config: undefined });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(300000);
    });

    it('uses session sdk_idle_timeout_ms when set (e.g. 900000 for Opus extended thinking)', async () => {
      await runStreaming({ session_id: 'sess-b', model_config: { sdk_idle_timeout_ms: 900000 } });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(900000);
    });

    it('uses minimum valid value (30000) without falling back to default', async () => {
      await runStreaming({ session_id: 'sess-c', model_config: { sdk_idle_timeout_ms: 30000 } });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(30000);
    });

    it('clamps invalid low and high values before constructing the processor', async () => {
      await runStreaming({ session_id: 'sess-low', model_config: { sdk_idle_timeout_ms: 1 } });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(30000);

      processorCalls.length = 0;
      await runStreaming({
        session_id: 'sess-high',
        model_config: { sdk_idle_timeout_ms: 9_999_999 },
      });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(3600000);
    });

    it('processes a newly arrived SDK message instead of rejecting it with a stale timeout check', async () => {
      queryMessages = [{ type: 'stream_event', event: { type: 'message_start' } }];

      await runStreaming({ session_id: 'sess-msg', model_config: { sdk_idle_timeout_ms: 30000 } });

      expect(processorInstances[0]?.process).toHaveBeenCalledTimes(1);
      expect(processorInstances[0]?.hasTimedOut).not.toHaveBeenCalled();
    });
  });

  describe('non-streaming path (promptSession)', () => {
    it('uses DEFAULT (300000) when session has no sdk_idle_timeout_ms', async () => {
      await runNonStreaming({ session_id: 'sess-d', model_config: undefined });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(300000);
    });

    it('uses session sdk_idle_timeout_ms when set (e.g. 900000)', async () => {
      await runNonStreaming({
        session_id: 'sess-e',
        model_config: { sdk_idle_timeout_ms: 900000 },
      });
      expect(processorCalls[0]?.idleTimeoutMs).toBe(900000);
    });

    it('releases the held SDK input after a successful result', async () => {
      queryWaitsForRelease = true;
      queryMessages = [
        {
          type: 'result',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      ];

      const result = await runNonStreaming({
        session_id: 'sess-f',
        model_config: { sdk_idle_timeout_ms: 30000 },
      });

      expect(lastReleaseInput).toHaveBeenCalledTimes(1);
      expect(result.inputTokens).toBe(1);
      expect(result.outputTokens).toBe(2);
    });
  });
});
