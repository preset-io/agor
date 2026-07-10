import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  promptService: vi.fn(function MockCodexPromptService() {}),
}));

vi.mock('./prompt-service.js', () => ({ CodexPromptService: mocks.promptService }));

import { CodexTool } from './codex-tool.js';

describe('CodexTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the executor runtime to CodexPromptService', () => {
    const messagesRepo = {} as never;
    const sessionsRepo = {} as never;
    const runtime = { pulse: vi.fn() };

    new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      undefined,
      'api-key',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      runtime
    );

    expect(mocks.promptService).toHaveBeenCalledOnce();
    expect(mocks.promptService.mock.calls[0]?.at(-1)).toBe(runtime);
  });
});
