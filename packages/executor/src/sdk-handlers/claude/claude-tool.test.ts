import type { SessionID, TaskID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opentelemetry/semantic-conventions', () => ({}));
vi.mock('@agor/core/sdk', () => ({
  Claude: { query: vi.fn() },
}));

import { ClaudeTool } from './claude-tool.js';

const sessionId = 'session-123' as SessionID;
const taskId = 'task-456' as TaskID;

describe('ClaudeTool permission_denied handling (#2063)', () => {
  let messagesRepo: any;
  let sessionsRepo: any;
  let messagesService: any;
  let mockPromptService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    messagesRepo = {
      findBySessionId: vi.fn().mockResolvedValue([]),
    };

    sessionsRepo = {
      findById: vi.fn().mockResolvedValue({
        session_id: sessionId,
        sdk_session_id: 'sdk-session-789',
      }),
      update: vi.fn().mockResolvedValue({}),
    };

    messagesService = {
      create: vi.fn().mockImplementation((msg) => Promise.resolve(msg)),
    };

    mockPromptService = {
      promptSessionStreaming: vi.fn(),
    };
  });

  function createTool() {
    const tool = new ClaudeTool(messagesRepo, sessionsRepo, 'test-key', messagesService);
    (tool as any).promptService = mockPromptService;
    return tool;
  }

  describe('permission_denied surfaces error tool_results without failing the parent turn (#2063)', () => {
    it('writes error tool_results on subagent permission_denied but does not set hadError', async () => {
      mockPromptService.promptSessionStreaming.mockImplementation(async function* () {
        yield {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_denied_bash',
          agentId: 'subagent-42',
          parentToolUseId: 'toolu_parent_agent_call',
          message: 'Command refused by policy',
          is_error: true,
        };
        yield {
          type: 'result',
          raw_sdk_message: { type: 'result', subtype: 'success' },
        };
      });

      const tool = createTool();
      const result = await tool.executePromptWithStreaming(sessionId, 'Test prompt', taskId);

      expect(result.hadError).toBeFalsy();

      const createdMessages = messagesService.create.mock.calls.map((call: any[]) => call[0]);
      const toolResults = createdMessages.filter(
        (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
      );

      const deniedToolResult = toolResults.find((m: any) =>
        m.content.some((b: any) => b.tool_use_id === 'toolu_denied_bash' && b.is_error === true)
      );
      expect(deniedToolResult).toBeDefined();

      const parentToolResult = toolResults.find((m: any) =>
        m.content.some(
          (b: any) => b.tool_use_id === 'toolu_parent_agent_call' && b.is_error === true
        )
      );
      expect(parentToolResult).toBeDefined();
    });

    it('writes error tool_result even when parent tool_use_id cannot be correlated', async () => {
      mockPromptService.promptSessionStreaming.mockImplementation(async function* () {
        yield {
          type: 'permission_denied',
          toolName: 'Bash',
          toolUseId: 'toolu_denied_bash',
          agentId: 'unknown-subagent',
          message: 'Command refused',
          is_error: true,
        };
        yield {
          type: 'result',
          raw_sdk_message: { type: 'result', subtype: 'success' },
        };
      });

      const tool = createTool();
      const result = await tool.executePromptWithStreaming(sessionId, 'Test prompt', taskId);

      expect(result.hadError).toBeFalsy();

      const createdMessages = messagesService.create.mock.calls.map((call: any[]) => call[0]);
      const toolResults = createdMessages.filter(
        (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
      );

      const deniedToolResult = toolResults.find((m: any) =>
        m.content.some((b: any) => b.tool_use_id === 'toolu_denied_bash' && b.is_error === true)
      );
      expect(deniedToolResult).toBeDefined();
    });

    it('does not set hadError when subagent turn succeeds without denial', async () => {
      mockPromptService.promptSessionStreaming.mockImplementation(async function* () {
        yield {
          type: 'result',
          raw_sdk_message: { type: 'result', subtype: 'success' },
        };
      });

      const tool = createTool();
      const result = await tool.executePromptWithStreaming(sessionId, 'Test prompt', taskId);

      expect(result.hadError).toBeFalsy();
    });
  });
});
