import { describe, expect, it, vi } from 'vitest';
import {
  buildCursorAssistantContent,
  executeCursorTask,
  normalizeCursorToolInput,
  normalizeCursorToolName,
  reportCursorActivity,
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

  it.each([
    { type: 'system' },
    { type: 'user' },
    { type: 'status', status: 'CREATING' },
    { type: 'status', status: 'RUNNING' },
  ])('keeps Cursor initialization as startup activity %#', (event) => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, event as never);
    expect(onActivity).toHaveBeenCalledWith({ type: 'sdk_started', detail: event.type });
  });

  it.each([
    { type: 'assistant' },
    { type: 'thinking' },
    { type: 'task' },
    { type: 'usage' },
    { type: 'status', status: 'FINISHED' },
  ])('recognizes meaningful Cursor progress %#', (event) => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, event as never);
    expect(onActivity).toHaveBeenCalledWith({ type: 'progress', detail: event.type });
  });

  it('maps Cursor tool calls to an identified operation lifecycle', () => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, {
      type: 'tool_call',
      call_id: 'call-1',
      name: 'run_terminal_cmd',
      status: 'running',
      args: { cmd: 'pnpm test' },
    } as never);
    reportCursorActivity(onActivity, {
      type: 'tool_call',
      call_id: 'call-1',
      name: 'run_terminal_cmd',
      status: 'completed',
      args: { cmd: 'pnpm test' },
    } as never);
    expect(onActivity.mock.calls).toEqual([
      [{ type: 'operation_started', id: 'call-1', kind: 'Bash' }],
      [{ type: 'operation_finished', id: 'call-1', outcome: 'completed' }],
    ]);
  });

  it('keeps unreviewed Cursor request events fail-open', () => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, { type: 'request' } as never);
    expect(onActivity).toHaveBeenCalledWith({ type: 'unknown_activity', detail: 'request' });
  });

  it('fails before launch when Cursor cannot enforce the requested permission mode', async () => {
    await expect(
      executeCursorTask({
        client: {} as never,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: 'test',
        permissionMode: 'default',
        abortController: new AbortController(),
      })
    ).resolves.toMatchObject({
      result: 'failure',
      failureCause: 'interaction_unavailable',
    });
  });
});
