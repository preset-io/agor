/**
 * Tests that ClaudePromptService uses the per-session sdk_idle_timeout_ms
 * from model_config when constructing SDKMessageProcessor.
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
        getState: vi.fn().mockReturnValue({ messageCount: 0, lastActivityTime: Date.now(), idleTimeoutMs: opts.idleTimeoutMs }),
      };
    }),
  };
});

vi.mock('./query-builder.js', () => ({
  setupQuery: vi.fn().mockResolvedValue({
    query: (async function* () {})(),
    getStderr: vi.fn().mockReturnValue(''),
  }),
}));

describe('ClaudePromptService sdk_idle_timeout_ms', () => {
  let sessionsRepo: {
    findById: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    processorCalls.length = 0;
    sessionsRepo = {
      findById: vi.fn(),
    };
  });

  async function runStreamingPrompt(session: StubSession) {
    // Dynamically import after mocks are set up
    const { ClaudePromptService } = await import('./prompt-service.js');

    const svc = new ClaudePromptService(
      undefined as never, // messagesRepo
      sessionsRepo as never,
    );

    sessionsRepo.findById.mockResolvedValue(session);

    // Drain the generator
    const gen = svc.promptSessionStreaming(
      session.session_id as SessionID,
      'test prompt',
    );
    for await (const _ of gen) { /* consume */ }
  }

  it('uses DEFAULT_IDLE_TIMEOUT_MS (300000) when session has no sdk_idle_timeout_ms', async () => {
    await runStreamingPrompt({
      session_id: 'sess-default',
      model_config: undefined,
    });
    expect(processorCalls[0]?.idleTimeoutMs).toBe(300000);
  });

  it('uses session sdk_idle_timeout_ms when set (e.g. 900000 for Opus extended thinking)', async () => {
    await runStreamingPrompt({
      session_id: 'sess-custom',
      model_config: { sdk_idle_timeout_ms: 900000 },
    });
    expect(processorCalls[0]?.idleTimeoutMs).toBe(900000);
  });

  it('falls back to default when sdk_idle_timeout_ms is explicitly undefined', async () => {
    await runStreamingPrompt({
      session_id: 'sess-explicit-undef',
      model_config: { sdk_idle_timeout_ms: undefined },
    });
    expect(processorCalls[0]?.idleTimeoutMs).toBe(300000);
  });
});
