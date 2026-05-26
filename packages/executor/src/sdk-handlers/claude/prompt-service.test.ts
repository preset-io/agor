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

vi.mock('./message-processor.js', () => {
  return {
    SDKMessageProcessor: vi.fn().mockImplementation((opts: { idleTimeoutMs: number }) => {
      processorCalls.push({ idleTimeoutMs: opts.idleTimeoutMs });
      return {
        process: vi.fn().mockResolvedValue([]),
        hasTimedOut: vi.fn().mockReturnValue(false),
        getState: vi.fn().mockReturnValue({
          messageCount: 0,
          lastActivityTime: Date.now(),
          idleTimeoutMs: opts.idleTimeoutMs,
        }),
      };
    }),
  };
});

// Return a fresh empty generator on every call so tests don't share state.
vi.mock('./query-builder.js', () => ({
  setupQuery: vi.fn().mockImplementation(async () => ({
    query: (async function* () {})(),
    getStderr: vi.fn().mockReturnValue(''),
    releaseInput: vi.fn(),
    getContextUsage: vi
      .fn()
      .mockResolvedValue({ totalTokens: 0, maxTokens: 200000, percentage: 0 }),
  })),
}));

describe('ClaudePromptService sdk_idle_timeout_ms', () => {
  let sessionsRepo: { findById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    processorCalls.length = 0;
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
    await svc.promptSession(session.session_id as SessionID, 'test');
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
  });
});
