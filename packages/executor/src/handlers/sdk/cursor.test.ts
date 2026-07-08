import { TaskRuntimeEventKind, TaskRuntimePhase } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  TaskRuntimeVitalsReporter,
  wrapStreamingCallbacksWithRuntimeVitals,
} from '../../runtime-vitals.js';
import {
  buildCursorAssistantContent,
  handleCursorEvent,
  normalizeCursorToolInput,
  normalizeCursorToolName,
} from './cursor.js';

describe('Cursor SDK handler helpers', () => {
  it('persists thinking before assistant text', () => {
    expect(
      buildCursorAssistantContent({
        thinkingText: 'Reasoning trace',
        text: 'Final answer',
      })
    ).toEqual([
      { type: 'thinking', text: 'Reasoning trace' },
      { type: 'text', text: 'Final answer' },
    ]);
  });

  it('does not persist a thinking block that duplicates the final answer', () => {
    expect(
      buildCursorAssistantContent({
        thinkingText: 'Hello!  How can I help you today?',
        text: 'Hello! How can I help you today?',
      })
    ).toEqual([{ type: 'text', text: 'Hello! How can I help you today?' }]);
  });

  it('normalizes shell commands for existing Bash tool widgets', () => {
    const input = normalizeCursorToolInput({
      type: 'tool_call',
      call_id: 'call-1',
      name: 'run_terminal_cmd',
      status: 'running',
      args: { cmd: 'pnpm check' },
    } as never);

    expect(normalizeCursorToolName('run_terminal_cmd')).toBe('Bash');
    expect(input).toMatchObject({
      command: 'pnpm check',
      cursor_tool_name: 'run_terminal_cmd',
      status: 'running',
    });
  });

  it('normalizes file paths for existing file tool widgets', () => {
    const input = normalizeCursorToolInput({
      type: 'tool_call',
      call_id: 'call-2',
      name: 'edit',
      status: 'completed',
      args: { path: 'packages/executor/src/handlers/sdk/cursor.ts' },
    } as never);

    expect(normalizeCursorToolName('edit')).toBe('Edit');
    expect(input).toMatchObject({
      file_path: 'packages/executor/src/handlers/sdk/cursor.ts',
      cursor_tool_name: 'edit',
      status: 'completed',
    });
  });

  it('reports sanitized assistant and tool runtime vitals from parsed events', async () => {
    const patches: Array<{ id: string; data: Record<string, unknown> }> = [];
    const messages = new Map<string, Record<string, unknown>>();
    const client = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
              patches.push({ id, data });
              return { task_id: id, ...data };
            }),
          };
        }
        if (name === 'messages') {
          return {
            create: vi.fn(async (data: Record<string, unknown>) => {
              messages.set(String(data.message_id), data);
              return data;
            }),
            patch: vi.fn(async (id: string, data: Record<string, unknown>) => {
              messages.set(id, { ...(messages.get(id) ?? {}), ...data });
              return messages.get(id);
            }),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;
    const reporter = new TaskRuntimeVitalsReporter({
      client,
      taskId: 'task-1',
      toolName: 'cursor',
      minPatchIntervalMs: 0,
    });
    let firstAgentEventRecorded = false;
    const recordFirstAgentEvent = async () => {
      if (firstAgentEventRecorded) return;
      firstAgentEventRecorded = true;
      await reporter.record(TaskRuntimeEventKind.FIRST_AGENT_EVENT, {
        source: 'sdk',
        phase: TaskRuntimePhase.RUNNING,
        meaningful: true,
        forceFlush: true,
      });
    };

    const callbacks = wrapStreamingCallbacksWithRuntimeVitals(
      {
        onStreamStart: vi.fn(async () => undefined),
        onStreamChunk: vi.fn(async () => undefined),
        onStreamEnd: vi.fn(async () => undefined),
        onStreamError: vi.fn(async () => undefined),
        onThinkingStart: vi.fn(async () => undefined),
        onThinkingChunk: vi.fn(async () => undefined),
        onThinkingEnd: vi.fn(async () => undefined),
      },
      reporter
    );

    const baseArgs = {
      client,
      callbacks,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      assistantMessageId: 'assistant-1' as never,
      model: 'cursor-model',
      getNextIndex: () => 1,
      toolCallMessageIds: [] as never[],
      toolCallMessageIdsByCallId: new Map(),
      completedToolCallIds: new Set<string>(),
      getAssistantText: () => '',
      setAssistantText: vi.fn(),
      getThinkingText: () => '',
      setThinkingText: vi.fn(),
      isAssistantStreamStarted: () => false,
      setAssistantStreamStarted: vi.fn(),
      ensureAssistantMessageIndex: () => 1,
      isThinkingStarted: () => false,
      setThinkingStarted: vi.fn(),
      vitalsReporter: reporter,
      recordFirstAgentEvent,
    };

    await handleCursorEvent({
      ...baseArgs,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      } as never,
    });
    await handleCursorEvent({
      ...baseArgs,
      event: {
        type: 'tool_call',
        call_id: 'call-1',
        name: 'run_terminal_cmd',
        status: 'running',
        args: { cmd: 'echo secret-token' },
      } as never,
    });
    await handleCursorEvent({
      ...baseArgs,
      event: {
        type: 'tool_call',
        call_id: 'call-1',
        name: 'run_terminal_cmd',
        status: 'completed',
        args: { cmd: 'echo secret-token' },
        result: 'secret-output',
      } as never,
    });

    const terminalVitals = await reporter.terminalSnapshot(TaskRuntimeEventKind.TURN_COMPLETED, {
      source: 'sdk',
      phase: TaskRuntimePhase.COMPLETED,
    });

    expect(terminalVitals.recent_events?.map((event) => event.kind)).toEqual([
      TaskRuntimeEventKind.FIRST_AGENT_EVENT,
      TaskRuntimeEventKind.STREAM_START,
      TaskRuntimeEventKind.TOOL_START,
      TaskRuntimeEventKind.TOOL_COMPLETE,
      TaskRuntimeEventKind.TURN_COMPLETED,
    ]);
    expect(terminalVitals.active_tool).toBeNull();
    expect(terminalVitals.recent_events?.[2]).toMatchObject({
      tool_name: 'Bash',
      tool_use_id: 'call-1',
    });
    expect(JSON.stringify(terminalVitals)).not.toContain('secret');
  });
});
